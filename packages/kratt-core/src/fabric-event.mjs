/**
 * 3XT Fabric event envelope v1.
 *
 * This module validates structure and creates an immutable snapshot. It does
 * NOT authenticate a producer, verify signatures, authorize side effects, or
 * persist events. Those responsibilities remain with trusted adapters,
 * KRATT policy, and a durable event store respectively.
 */

export const FABRIC_EVENT_SCHEMA = "3xt-fabric-event/v1";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const EVENT_TYPE = /^[a-z][a-z0-9]*(?:\.[a-z0-9-]+){1,5}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TOP_LEVEL_KEYS = [
  "schema_version", "event_id", "event_type", "source", "occurred_at",
  "correlation_id", "causation_id", "sequence", "payload"
];

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactDataKeys(value, required) {
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !required.includes(key))) return false;
  if (required.some(key => !Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value");
  });
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validTimestamp(value) {
  return typeof value === "string" && ISO_UTC.test(value) &&
    Number.isFinite(Date.parse(value));
}

function isJsonValue(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 2048 || depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 512 &&
    value.every(item => isJsonValue(item, depth + 1, budget));
  if (!isPlainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128) return false;
  return keys.every(key => {
    if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") &&
      isJsonValue(descriptor.value, depth + 1, budget);
  });
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validate an untrusted event envelope. On success, return a deep-frozen
 * structured clone so later caller mutation cannot change the accepted value.
 */
export function validateFabricEvent(input) {
  const errors = [];
  if (!hasExactDataKeys(input, TOP_LEVEL_KEYS)) {
    return { ok: false, errors: ["EVENT_SHAPE_INVALID"] };
  }

  if (input.schema_version !== FABRIC_EVENT_SCHEMA) errors.push("EVENT_SCHEMA_UNSUPPORTED");
  if (!validId(input.event_id)) errors.push("EVENT_ID_INVALID");
  if (typeof input.event_type !== "string" || !EVENT_TYPE.test(input.event_type)) errors.push("EVENT_TYPE_INVALID");
  if (!hasExactDataKeys(input.source, ["node_id", "agent_id", "component"]) ||
      !validId(input.source.node_id) || !validId(input.source.agent_id) ||
      !validId(input.source.component)) errors.push("EVENT_SOURCE_INVALID");
  if (!validTimestamp(input.occurred_at)) errors.push("EVENT_TIMESTAMP_INVALID");
  if (!validId(input.correlation_id)) errors.push("EVENT_CORRELATION_INVALID");
  if (input.causation_id !== null && !validId(input.causation_id)) errors.push("EVENT_CAUSATION_INVALID");
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) errors.push("EVENT_SEQUENCE_INVALID");
  if (!isPlainObject(input.payload) || !isJsonValue(input.payload)) errors.push("EVENT_PAYLOAD_INVALID");

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: deepFreeze(structuredClone(input))
  };
}
