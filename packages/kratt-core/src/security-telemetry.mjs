import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const EVENT_TYPES = new Set([
  "authorization.allowed",
  "authorization.denied",
  "authorization.blocked",
  "dispatch.intent_committed",
  "dispatch.completed",
  "dispatch.failed",
  "dispatch.cancelled",
  "queue.rejected",
  "lease.fenced",
  "evidence.verification_failed",
]);

const OUTCOMES = new Set(["allowed", "denied", "blocked", "completed", "failed", "cancelled", "rejected"]);
const SAFE_REASONS = /^[A-Z0-9_:-]{1,96}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function clampDuration(value) {
  return Number.isFinite(value) && value >= 0 ? Math.min(value, 86_400_000) : 0;
}

function safeIdentifier(value) {
  return typeof value === "string" && ID.test(value) ? value : "unknown";
}

/**
 * Dependency-free bounded-cardinality telemetry.
 * Sink failures must never change an authorization decision.
 * Never pass secret material or raw request bodies into this API.
 */
export function createSecurityTelemetry({ sink = () => {}, now = () => new Date().toISOString(), maxSeries = 256 } = {}) {
  if (typeof sink !== "function" || typeof now !== "function" ||
      !Number.isSafeInteger(maxSeries) || maxSeries < 1 || maxSeries > 4096)
    throw new TypeError("SECURITY_TELEMETRY_CONFIGURATION_INVALID");

  const counters = new Map();
  const latency = new Map();
  const eventRing = [];
  const maxEvents = 512;

  function increment(name, labels = {}, value = 1) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_.]{1,95}$/.test(name) ||
        !Number.isSafeInteger(value) || value < 1) return false;
    const keys = Object.keys(labels).sort();
    if (keys.some(key => !["component", "outcome", "reason"].includes(key))) return false;
    const safe = {
      component: safeIdentifier(labels.component ?? "kratt"),
      outcome: OUTCOMES.has(labels.outcome) ? labels.outcome : "blocked",
      reason: typeof labels.reason === "string" && SAFE_REASONS.test(labels.reason) ? labels.reason : "UNSPECIFIED",
    };
    const key = `${name}|${safe.component}|${safe.outcome}|${safe.reason}`;
    if (!counters.has(key) && counters.size >= maxSeries) return false;
    counters.set(key, (counters.get(key) ?? 0) + value);
    return true;
  }

  function observe(name, durationMs, labels = {}) {
    if (typeof name !== "string" || !/^[a-z][a-z0-9_.]{1,95}$/.test(name) ||
        !Number.isFinite(durationMs) || durationMs < 0) return false;
    const keys = Object.keys(labels).sort();
    if (keys.some(key => !["component", "outcome", "reason"].includes(key))) return false;
    const safe = {
      component: safeIdentifier(labels.component ?? "kratt"),
      outcome: OUTCOMES.has(labels.outcome) ? labels.outcome : "blocked",
      reason: typeof labels.reason === "string" && SAFE_REASONS.test(labels.reason) ? labels.reason : "UNSPECIFIED",
    };
    const key = `${name}|${safe.component}|${safe.outcome}|${safe.reason}`;
    if (!latency.has(key) && latency.size >= maxSeries) return false;
    const current = latency.get(key) ?? { count: 0, sumMs: 0, maxMs: 0 };
    current.count += 1;
    current.sumMs += clampDuration(durationMs);
    current.maxMs = Math.max(current.maxMs, clampDuration(durationMs));
    latency.set(key, current);
    return true;
  }

  function recordSecurityEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event) ||
        !EVENT_TYPES.has(event.name) || !ID.test(event.correlationId ?? "") ||
        !OUTCOMES.has(event.outcome) || !SAFE_REASONS.test(event.reason ?? "")) return false;
    const timestamp = now();
    if (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) return false;
    const safeEvent = Object.freeze({
      eventId: randomUUID(),
      timestamp,
      name: event.name,
      correlationId: event.correlationId,
      component: safeIdentifier(event.component ?? "kratt"),
      outcome: event.outcome,
      reason: event.reason,
      durationMs: event.durationMs === undefined ? null : clampDuration(event.durationMs),
    });
    if (eventRing.length === maxEvents) eventRing.shift();
    eventRing.push(safeEvent);
    try { sink(safeEvent); } catch { /* telemetry is deliberately non-authoritative */ }
    return true;
  }

  function snapshot() {
    return Object.freeze({
      counters: Object.freeze([...counters.entries()].map(([key, value]) => Object.freeze({ key, value }))),
      latency: Object.freeze([...latency.entries()].map(([key, value]) => Object.freeze({
        key, ...value, meanMs: value.count ? value.sumMs / value.count : 0,
      }))),
      recentSecurityEvents: Object.freeze([...eventRing]),
    });
  }

  function timed(name, labels, operation) {
    if (typeof operation !== "function") throw new TypeError("TELEMETRY_OPERATION_REQUIRED");
    return async (...args) => {
      const started = performance.now();
      try {
        const result = await operation(...args);
        const durationMs = performance.now() - started;
        observe(name, durationMs, labels);
        return result;
      } catch (error) {
        observe(name, performance.now() - started, { ...labels, outcome: "failed", reason: "OPERATION_FAILED" });
        throw error;
      }
    };
  }

  return Object.freeze({ increment, observe, recordSecurityEvent, snapshot, timed });
}
