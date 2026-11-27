import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const EVENT_TYPES = new Set([
  "authorization.allowed", "authorization.denied", "authorization.blocked",
  "dispatch.intent_committed", "dispatch.completed", "dispatch.failed",
  "dispatch.cancelled", "queue.rejected", "lease.fenced", "evidence.verification_failed",
]);
const OUTCOMES = new Set(["allowed", "denied", "blocked", "completed", "failed", "cancelled", "rejected"]);
const SAFE_REASONS = /^[A-Z0-9_:-]{1,96}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const EVENT_CAPACITY = 512;

const clampDuration = value => Number.isFinite(value) && value >= 0 ? Math.min(value, 86_400_000) : 0;
const safeIdentifier = value => typeof value === "string" && ID.test(value) ? value : "unknown";

function normalizeLabels(labels = {}) {
  try {
    if (!labels || typeof labels !== "object" || Array.isArray(labels)) return null;
    const keys = Object.keys(labels);
    if (keys.some(key => !["component", "outcome", "reason"].includes(key))) return null;
    return {
      component: safeIdentifier(labels.component ?? "kratt"),
      outcome: OUTCOMES.has(labels.outcome) ? labels.outcome : "blocked",
      reason: typeof labels.reason === "string" && SAFE_REASONS.test(labels.reason) ? labels.reason : "UNSPECIFIED",
    };
  } catch { return null; }
}

/**
 * Bounded operational telemetry, never authorization or durable-audit authority.
 * Sink work is isolated from caller outcomes: async rejections are consumed and
 * pending sink promises are capped. A synchronous sink must itself be non-blocking;
 * JavaScript cannot pre-empt a synchronous callback running on the event loop.
 */
export function createSecurityTelemetry({ sink = () => {}, now = () => new Date().toISOString(), maxSeries = 256, maxPendingSinks = 64 } = {}) {
  if (typeof sink !== "function" || typeof now !== "function" ||
      !Number.isSafeInteger(maxSeries) || maxSeries < 1 || maxSeries > 4096 ||
      !Number.isSafeInteger(maxPendingSinks) || maxPendingSinks < 1 || maxPendingSinks > 1024) {
    throw new TypeError("SECURITY_TELEMETRY_CONFIGURATION_INVALID");
  }

  const counters = new Map();
  const latency = new Map();
  const ring = new Array(EVENT_CAPACITY);
  let ringStart = 0;
  let ringSize = 0;
  let eventsRecorded = 0;
  let eventRingDropped = 0;
  let sinkCalls = 0;
  let sinkFailures = 0;
  let sinkDropped = 0;
  let pendingSinks = 0;
  let sinkDurationMsTotal = 0;
  let sinkDurationMsMax = 0;

  function increment(name, labels = {}, value = 1) {
    try {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_.]{1,95}$/.test(name) || !Number.isSafeInteger(value) || value < 1) return false;
      const safe = normalizeLabels(labels);
      if (!safe) return false;
      const key = `${name}|${safe.component}|${safe.outcome}|${safe.reason}`;
      if (!counters.has(key) && counters.size >= maxSeries) return false;
      counters.set(key, (counters.get(key) ?? 0) + value);
      return true;
    } catch { return false; }
  }

  function observe(name, durationMs, labels = {}) {
    try {
      if (typeof name !== "string" || !/^[a-z][a-z0-9_.]{1,95}$/.test(name) || !Number.isFinite(durationMs) || durationMs < 0) return false;
      const safe = normalizeLabels(labels);
      if (!safe) return false;
      const key = `${name}|${safe.component}|${safe.outcome}|${safe.reason}`;
      if (!latency.has(key) && latency.size >= maxSeries) return false;
      const item = latency.get(key) ?? { count: 0, sumMs: 0, maxMs: 0 };
      const duration = clampDuration(durationMs);
      item.count += 1;
      item.sumMs += duration;
      item.maxMs = Math.max(item.maxMs, duration);
      latency.set(key, item);
      return true;
    } catch { return false; }
  }

  function recordSecurityEvent(event) {
    try {
      if (!event || typeof event !== "object" || Array.isArray(event) ||
          !EVENT_TYPES.has(event.name) || !ID.test(event.correlationId ?? "") ||
          !OUTCOMES.has(event.outcome) || !SAFE_REASONS.test(event.reason ?? "")) return false;
      let timestamp;
      try { timestamp = now(); } catch { return false; }
      if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return false;

      const safeEvent = Object.freeze({
        eventId: randomUUID(), timestamp, name: event.name, correlationId: event.correlationId,
        component: safeIdentifier(event.component ?? "kratt"), outcome: event.outcome,
        reason: event.reason, durationMs: event.durationMs === undefined ? null : clampDuration(event.durationMs),
      });
      if (ringSize < EVENT_CAPACITY) {
        ring[(ringStart + ringSize) % EVENT_CAPACITY] = safeEvent;
        ringSize += 1;
      } else {
        ring[ringStart] = safeEvent;
        ringStart = (ringStart + 1) % EVENT_CAPACITY;
        eventRingDropped += 1;
      }
      eventsRecorded += 1;

      if (pendingSinks >= maxPendingSinks) {
        sinkDropped += 1;
        return true;
      }

      const started = performance.now();
      sinkCalls += 1;
      try {
        const result = sink(safeEvent);
        const duration = clampDuration(performance.now() - started);
        sinkDurationMsTotal += duration;
        sinkDurationMsMax = Math.max(sinkDurationMsMax, duration);
        if (result !== null && result !== undefined && (typeof result === "object" || typeof result === "function")) {
          let then;
          try { then = result.then; } catch { sinkFailures += 1; return true; }
          if (typeof then === "function") {
            pendingSinks += 1;
            Promise.resolve(result).then(
              () => { pendingSinks -= 1; },
              () => { pendingSinks -= 1; sinkFailures += 1; },
            );
          }
        }
      } catch {
        sinkFailures += 1;
        const duration = clampDuration(performance.now() - started);
        sinkDurationMsTotal += duration;
        sinkDurationMsMax = Math.max(sinkDurationMsMax, duration);
      }
      return true;
    } catch {
      return false;
    }
  }

  function snapshot() {
    const recentSecurityEvents = [];
    for (let index = 0; index < ringSize; index += 1) recentSecurityEvents.push(ring[(ringStart + index) % EVENT_CAPACITY]);
    return Object.freeze({
      counters: Object.freeze([...counters.entries()].map(([key, value]) => Object.freeze({ key, value }))),
      latency: Object.freeze([...latency.entries()].map(([key, value]) => Object.freeze({
        key, ...value, meanMs: value.count ? value.sumMs / value.count : 0,
      }))),
      recentSecurityEvents: Object.freeze(recentSecurityEvents),
      diagnostics: Object.freeze({
        eventsRecorded, eventRingCapacity: EVENT_CAPACITY, eventRingSize: ringSize, eventRingDropped,
        sinkCalls, sinkFailures, sinkDropped, pendingSinks, maxPendingSinks,
        sinkDurationMsTotal, sinkDurationMsMax,
      }),
    });
  }

  function timed(name, labels, operation) {
    if (typeof operation !== "function") throw new TypeError("TELEMETRY_OPERATION_REQUIRED");
    return async (...args) => {
      const started = performance.now();
      try {
        const result = await operation(...args);
        observe(name, performance.now() - started, labels);
        return result;
      } catch (error) {
        observe(name, performance.now() - started, { ...labels, outcome: "failed", reason: "OPERATION_FAILED" });
        throw error;
      }
    };
  }

  return Object.freeze({ increment, observe, recordSecurityEvent, snapshot, timed });
}
