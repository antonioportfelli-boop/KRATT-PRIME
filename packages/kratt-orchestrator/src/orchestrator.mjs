import { createHash, randomUUID } from "node:crypto";

export const ADAPTER_STATES = Object.freeze([
  "DISCOVERED",
  "CONNECTED_UNVERIFIED",
  "VERIFIED_READ_ONLY",
  "WRITE_PENDING_APPROVAL",
  "WRITE_ENABLED",
  "DISABLED",
  "ERROR",
]);

const TRANSITIONS = Object.freeze({
  DISCOVERED: ["CONNECTED_UNVERIFIED", "DISABLED", "ERROR"],
  CONNECTED_UNVERIFIED: ["VERIFIED_READ_ONLY", "DISABLED", "ERROR"],
  VERIFIED_READ_ONLY: ["WRITE_PENDING_APPROVAL", "DISABLED", "ERROR"],
  WRITE_PENDING_APPROVAL: ["VERIFIED_READ_ONLY", "DISABLED", "ERROR"],
  WRITE_ENABLED: ["VERIFIED_READ_ONLY", "DISABLED", "ERROR"],
  DISABLED: ["DISCOVERED"],
  ERROR: ["DISCOVERED", "DISABLED"],
});

const READ_STATES = new Set(["VERIFIED_READ_ONLY", "WRITE_ENABLED"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function stable(value, active = new WeakSet(), path = "$") {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`NON_FINITE_NUMBER:${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError(`UNSUPPORTED_VALUE:${path}`);
  if (active.has(value)) throw new TypeError(`CIRCULAR_VALUE:${path}`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`ARRAY_SHAPE_INVALID:${path}`);
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`ARRAY_ITEM_INVALID:${path}[${index}]`);
        items.push(stable(descriptor.value, active, `${path}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`NON_PLAIN_OBJECT:${path}`);
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw new TypeError(`SYMBOL_KEY:${path}`);
    return `{${keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError(`OBJECT_FIELD_INVALID:${path}.${key}`);
      return `${JSON.stringify(key)}:${stable(descriptor.value, active, `${path}.${key}`)}`;
    }).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stable(value), "utf8").digest("hex")}`;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function result(status, reason, extra = {}) {
  return Object.freeze({ status, reason, ...extra });
}

/**
 * Local orchestration kernel.
 *
 * Adapter implementations are injected by the host. This module does not
 * create network connections, infer trust from connector names, or persist
 * credentials. All writes require a request-scoped approval verifier.
 */
export function createOrchestrator({ now = () => new Date().toISOString(), verifyApproval } = {}) {
  if (typeof now !== "function") throw new TypeError("TRUSTED_CLOCK_REQUIRED");

  const adapters = new Map();
  const implementations = new Map();
  const journal = [];
  const pending = new Map();
  const intakes = [];

  function emit(type, source, payload, correlationId = randomUUID()) {
    const occurredAt = now();
    if (typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
      throw new TypeError("TRUSTED_CLOCK_UNAVAILABLE");
    }
    const previousHash = journal.at(-1)?.hash ?? null;
    const event = {
      sequence: journal.length + 1,
      eventId: randomUUID(),
      correlationId,
      occurredAt,
      type,
      source,
      payloadDigest: digest(payload),
      previousHash,
    };
    event.hash = digest(event);
    journal.push(freeze(event));
    return event;
  }

  function registerAdapter(spec, implementation = {}) {
    if (!spec || typeof spec !== "object" || !ID.test(spec.id ?? "") ||
        typeof spec.name !== "string" || !spec.name.trim() ||
        !Array.isArray(spec.capabilities) ||
        !spec.capabilities.every(x => typeof x === "string" && ID.test(x)) ||
        !spec.permissions || typeof spec.permissions.read !== "boolean" ||
        typeof spec.permissions.write !== "boolean") {
      throw new TypeError("ADAPTER_DESCRIPTOR_INVALID");
    }
    if (adapters.has(spec.id)) throw new Error("ADAPTER_ALREADY_REGISTERED");
    if (implementation.read !== undefined && typeof implementation.read !== "function") {
      throw new TypeError("ADAPTER_READ_HANDLER_INVALID");
    }
    if (implementation.write !== undefined && typeof implementation.write !== "function") {
      throw new TypeError("ADAPTER_WRITE_HANDLER_INVALID");
    }

    const adapter = freeze({
      id: spec.id,
      name: spec.name.trim(),
      kind: spec.kind ?? "generic",
      capabilities: [...new Set(spec.capabilities)],
      permissions: { read: spec.permissions.read, write: spec.permissions.write },
      state: "DISCOVERED",
      registeredAt: now(),
      lastVerifiedAt: null,
      lastError: null,
    });
    adapters.set(adapter.id, adapter);
    implementations.set(adapter.id, implementation);
    emit("ADAPTER_REGISTERED", adapter.id, { name: adapter.name, capabilities: adapter.capabilities });
    return adapter;
  }

  function transitionAdapter(adapterId, nextState, evidence = null) {
    const current = adapters.get(adapterId);
    if (!current) return result("NOT_FOUND", "ADAPTER_NOT_REGISTERED");
    if (!ADAPTER_STATES.includes(nextState)) return result("DENY", "UNKNOWN_ADAPTER_STATE");
    if (nextState === "WRITE_ENABLED") {
      return result("DENY", "WRITE_ENABLEMENT_REQUIRES_REQUEST_BOUND_APPROVAL");
    }
    if (!TRANSITIONS[current.state].includes(nextState)) {
      return result("BLOCKED", "ILLEGAL_ADAPTER_STATE_TRANSITION", { currentState: current.state, requestedState: nextState });
    }
    if (nextState === "VERIFIED_READ_ONLY" && current.state === "CONNECTED_UNVERIFIED" &&
        (!evidence || evidence.verified !== true || typeof evidence.verifierId !== "string" || !evidence.verifierId.trim())) {
      return result("DENY", "TRUSTED_ADAPTER_VERIFICATION_REQUIRED");
    }
    const updated = freeze({
      ...current,
      state: nextState,
      lastVerifiedAt: nextState === "VERIFIED_READ_ONLY" ? now() : current.lastVerifiedAt,
      lastError: nextState === "ERROR" ? String(evidence?.reason ?? "ADAPTER_ERROR") : null,
    });
    adapters.set(adapterId, updated);
    emit("ADAPTER_STATE_CHANGED", adapterId, {
      previousState: current.state,
      nextState,
      verifierId: nextState === "VERIFIED_READ_ONLY" ? evidence.verifierId : null,
    });
    return result("OK", "ADAPTER_STATE_UPDATED", { adapter: updated });
  }

  async function executeRead({ adapterId, capability, input, correlationId = randomUUID() }) {
    const adapter = adapters.get(adapterId);
    if (!adapter) return result("NOT_FOUND", "ADAPTER_NOT_REGISTERED");
    if (!READ_STATES.has(adapter.state)) return result("BLOCKED", "ADAPTER_NOT_VERIFIED_READ_ONLY");
    if (!adapter.permissions.read || !adapter.capabilities.includes(capability)) {
      return result("DENY", "READ_CAPABILITY_NOT_GRANTED");
    }
    const handler = implementations.get(adapterId)?.read;
    if (typeof handler !== "function") return result("UNAVAILABLE", "READ_HANDLER_NOT_CONFIGURED");
    try {
      const output = await handler({ capability, input, correlationId });
      const provenance = freeze({
        adapterId,
        adapterState: adapter.state,
        capability,
        observedAt: now(),
        outputDigest: digest(output),
        correlationId,
      });
      emit("ADAPTER_READ_COMPLETED", adapterId, provenance, correlationId);
      return result("OK", "READ_COMPLETED", { output, provenance });
    } catch (error) {
      emit("ADAPTER_READ_FAILED", adapterId, { reason: "ADAPTER_HANDLER_FAILED" }, correlationId);
      return result("ERROR", "ADAPTER_HANDLER_FAILED");
    }
  }

  function requestWrite({ adapterId, capability, target, payload, actor, correlationId = randomUUID() }) {
    const adapter = adapters.get(adapterId);
    if (!adapter) return result("NOT_FOUND", "ADAPTER_NOT_REGISTERED");
    if (!adapter.permissions.write || !adapter.capabilities.includes(capability)) {
      return result("DENY", "WRITE_CAPABILITY_NOT_GRANTED");
    }
    if (adapter.state !== "VERIFIED_READ_ONLY") {
      return result("BLOCKED", "ADAPTER_NOT_IN_VERIFIED_STATE");
    }
    if (!target || typeof target !== "string" || !target.trim() || !ID.test(actor ?? "")) {
      return result("DENY", "WRITE_REQUEST_SCOPE_INVALID");
    }
    const requestId = randomUUID();
    const request = freeze({
      requestId,
      adapterId,
      capability,
      target,
      actor,
      payloadDigest: digest(payload),
      correlationId,
      requestedAt: now(),
      state: "PENDING_APPROVAL",
    });
    pending.set(requestId, { request, payload });
    const transitioned = transitionAdapter(adapterId, "WRITE_PENDING_APPROVAL");
    if (transitioned.status !== "OK") {
      pending.delete(requestId);
      return transitioned;
    }
    emit("WRITE_REQUESTED", adapterId, request, correlationId);
    return result("PENDING_APPROVAL", "REQUEST_BOUND_APPROVAL_REQUIRED", { request });
  }

  async function approveAndExecuteWrite({ requestId, approval }) {
    const item = pending.get(requestId);
    if (!item) return result("NOT_FOUND", "WRITE_REQUEST_NOT_FOUND");
    if (typeof verifyApproval !== "function") return result("DENY", "TRUSTED_APPROVAL_VERIFIER_UNAVAILABLE");

    const { request } = item;
    const binding = freeze({
      requestId: request.requestId,
      adapterId: request.adapterId,
      capability: request.capability,
      target: request.target,
      actor: request.actor,
      payloadDigest: request.payloadDigest,
      correlationId: request.correlationId,
    });
    let approved = false;
    try { approved = verifyApproval(approval, binding) === true; } catch { approved = false; }
    if (!approved) {
      pending.delete(requestId);
      transitionAdapter(request.adapterId, "VERIFIED_READ_ONLY");
      emit("WRITE_DENIED", request.adapterId, { requestId, reason: "APPROVAL_INVALID_OR_MISMATCHED" }, request.correlationId);
      return result("DENY", "APPROVAL_INVALID_OR_MISMATCHED");
    }

    const adapter = adapters.get(request.adapterId);
    const handler = implementations.get(request.adapterId)?.write;
    if (!adapter || adapter.state !== "WRITE_PENDING_APPROVAL" || typeof handler !== "function") {
      pending.delete(requestId);
      if (adapter?.state === "WRITE_PENDING_APPROVAL") transitionAdapter(request.adapterId, "VERIFIED_READ_ONLY");
      return result("BLOCKED", "WRITE_HANDLER_OR_STATE_UNAVAILABLE");
    }

    try {
      const output = await handler({
        capability: request.capability,
        target: request.target,
        payload: item.payload,
        approval,
        correlationId: request.correlationId,
      });
      pending.delete(requestId);
      transitionAdapter(request.adapterId, "VERIFIED_READ_ONLY");
      emit("WRITE_COMPLETED", request.adapterId, {
        requestId,
        target: request.target,
        outputDigest: digest(output),
      }, request.correlationId);
      return result("OK", "WRITE_COMPLETED", { output, requestId });
    } catch (error) {
      pending.delete(requestId);
      transitionAdapter(request.adapterId, "VERIFIED_READ_ONLY");
      emit("WRITE_FAILED", request.adapterId, { requestId, reason: "ADAPTER_HANDLER_FAILED" }, request.correlationId);
      return result("ERROR", "ADAPTER_HANDLER_FAILED");
    }
  }

  function recordLocalIntake({ label, sourceType, actor = "architect" } = {}) {
    const allowedSources = ["manual_url", "rss_atom", "json_csv", "telegram_pending"];
    if (typeof label !== "string" || !label.trim() || label.trim().length > 160 ||
        !allowedSources.includes(sourceType) || !ID.test(actor)) {
      return result("DENY", "LOCAL_INTAKE_REQUEST_INVALID");
    }
    const intake = freeze({
      intakeId: randomUUID(),
      label: label.trim(),
      sourceType,
      actor,
      receivedAt: now(),
      state: "RECEIVED_LOCAL",
      networkAccess: false,
    });
    intakes.push(intake);
    emit("LOCAL_INTAKE_RECORDED", "local-intake", intake);
    return result("OK", "LOCAL_INTAKE_RECORDED", { intake });
  }

  function snapshot() {
    return freeze({
      adapters: [...adapters.values()],
      pendingWrites: [...pending.values()].map(x => x.request),
      intakes: [...intakes],
      journal: [...journal],
      journalHead: journal.at(-1)?.hash ?? null,
    });
  }

  function verifyJournal() {
    let previousHash = null;
    for (let index = 0; index < journal.length; index += 1) {
      const event = journal[index];
      const { hash, ...body } = event;
      if (event.sequence !== index + 1 || event.previousHash !== previousHash || digest(body) !== hash) {
        return result("INVALID", "JOURNAL_INTEGRITY_FAILURE", { failedSequence: index + 1 });
      }
      previousHash = hash;
    }
    return result("OK", "JOURNAL_INTEGRITY_VERIFIED", { eventCount: journal.length, head: previousHash });
  }

  return Object.freeze({
    registerAdapter,
    transitionAdapter,
    executeRead,
    requestWrite,
    approveAndExecuteWrite,
    recordLocalIntake,
    snapshot,
    verifyJournal,
  });
}
