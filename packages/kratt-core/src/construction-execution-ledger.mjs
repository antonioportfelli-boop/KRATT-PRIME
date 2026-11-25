import { createHash } from "node:crypto";

/**
 * Construction execution ledger v1.
 *
 * This is a deterministic workflow ledger, not an authorization engine.
 * The host remains responsible for trusted evidence, durable atomic storage,
 * lease/fencing enforcement, policy decisions and tool execution.
 */

export const EXECUTION_LEDGER_KEY = "construction.execution.v1";
export const EXECUTION_STATES = Object.freeze([
  "QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED"
]);

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 100;
const MAX_HISTORY = 1000;

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isPlain(value))
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  throw new TypeError("NON_CANONICAL_LEDGER_VALUE");
}

function hash(value) {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}
const validId = value => typeof value === "string" && ID.test(value);
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

function cloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function eventFor(record, transition, at, details = {}) {
  return {
    sequence: record.history.length + 1,
    from: record.state,
    to: transition,
    at,
    ...details
  };
}

function withEvent(record, event, fields = {}) {
  const next = { ...record, ...fields, state: event.to,
    revision: record.revision + 1, history: [...record.history, event] };
  const { record_digest: _old, ...unsigned } = next;
  return freezeDeep({ ...unsigned, record_digest: hash(unsigned) });
}

/** Build a deterministic key from immutable task identity and intent. */
export function deriveExecutionKey({ task_id, task_revision, task_digest, operation } = {}) {
  if (!validId(task_id) || !Number.isSafeInteger(task_revision) || task_revision < 0 ||
      !DIGEST.test(task_digest ?? "") || !validId(operation))
    return fail("EXECUTION_IDENTITY_INVALID");
  return { ok: true, execution_key: `exec-${hash({ task_id, task_revision, task_digest, operation }).slice(7, 55)}` };
}

/**
 * Create an execution record. A record may be persisted by an adapter implementing
 * open/readAll/put/verify; this module never assumes an adapter's atomicity.
 */
export function createExecutionRecord({
  task_id, task_revision, task_digest, operation, max_attempts = 3,
  now = () => new Date().toISOString()
} = {}) {
  const key = deriveExecutionKey({ task_id, task_revision, task_digest, operation });
  if (!key.ok) return key;
  if (!Number.isInteger(max_attempts) || max_attempts < 1 || max_attempts > MAX_ATTEMPTS)
    return fail("MAX_ATTEMPTS_INVALID");
  let createdAt;
  try { createdAt = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(createdAt)) return fail("EXECUTION_CLOCK_INVALID");
  const unsigned = {
    schema_version: "kratt-execution-ledger/v1",
    execution_key: key.execution_key, task_id, task_revision, task_digest, operation,
    state: "QUEUED", attempts: 0, max_attempts,
    revision: 0, created_at: createdAt, updated_at: createdAt,
    claim: null, result_digest: null, failure: null, history: []
  };
  return { ok: true, record: freezeDeep({ ...unsigned, record_digest: hash(unsigned) }) };
}

function validRecord(record) {
  if (!isPlain(record) || record.schema_version !== "kratt-execution-ledger/v1" ||
      !validId(record.execution_key) || !validId(record.task_id) || !validId(record.operation) ||
      !Number.isSafeInteger(record.task_revision) || record.task_revision < 0 ||
      !DIGEST.test(record.task_digest ?? "") || !EXECUTION_STATES.includes(record.state) ||
      !Number.isInteger(record.attempts) || record.attempts < 0 ||
      !Number.isInteger(record.max_attempts) || record.max_attempts < 1 ||
      record.attempts > record.max_attempts || !Number.isInteger(record.revision) ||
      !Array.isArray(record.history) || record.history.length !== record.revision ||
      record.history.length > MAX_HISTORY || !validTime(record.created_at) ||
      !validTime(record.updated_at) || typeof record.record_digest !== "string" ||
      !DIGEST.test(record.record_digest)) return false;
  const expected = deriveExecutionKey({
    task_id: record.task_id, task_revision: record.task_revision,
    task_digest: record.task_digest, operation: record.operation
  });
  if (!expected.ok || expected.execution_key !== record.execution_key) return false;
  const { record_digest, ...unsigned } = record;
  if (hash(unsigned) !== record_digest) return false;
  let previous = "QUEUED";
  for (let i = 0; i < record.history.length; i += 1) {
    const e = record.history[i];
    if (!isPlain(e) || e.sequence !== i + 1 || e.from !== previous ||
        !EXECUTION_STATES.includes(e.to) || !validTime(e.at)) return false;
    previous = e.to;
  }
  return previous === record.state;
}

function validateRecord(record) {
  return validRecord(record) ? { ok: true } : fail("EXECUTION_RECORD_INVALID");
}

function validClaim(claim) {
  return isPlain(claim) && validId(claim.worker_id) && validId(claim.lease_id) &&
    Number.isSafeInteger(claim.fence) && claim.fence > 0 && validTime(claim.expires_at);
}

function checkClaim(record, claim, now) {
  if (!validClaim(claim)) return fail("CLAIM_INVALID");
  if (!record.claim || record.claim.worker_id !== claim.worker_id ||
      record.claim.lease_id !== claim.lease_id || record.claim.fence !== claim.fence)
    return fail("CLAIM_MISMATCH");
  if (Date.parse(claim.expires_at) <= Date.parse(now) ||
      Date.parse(record.claim.expires_at) <= Date.parse(now))
    return fail("CLAIM_EXPIRED");
  return { ok: true };
}

/**
 * Claim a queued/retryable execution. Fence is supplied by the authoritative
 * lease coordinator and must be strictly greater than the prior fence.
 */
export function claimExecution(record, claim, { now = () => new Date().toISOString() } = {}) {
  const valid = validateRecord(record);
  if (!valid.ok) return valid;
  if (!["QUEUED", "RETRY_WAIT"].includes(record.state))
    return fail("EXECUTION_NOT_CLAIMABLE", { state: record.state });
  if (record.attempts >= record.max_attempts) return fail("ATTEMPTS_EXHAUSTED");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  if (!validClaim(claim) || Date.parse(claim.expires_at) <= Date.parse(at))
    return fail("CLAIM_INVALID_OR_EXPIRED");
  const previousFence = record.claim?.fence ?? 0;
  if (claim.fence <= previousFence) return fail("STALE_FENCE");
  const event = eventFor(record, "CLAIMED", at, {
    worker_id: claim.worker_id, lease_id: claim.lease_id, fence: claim.fence
  });
  return { ok: true, record: withEvent(record, event, {
    attempts: record.attempts + 1, claim: { ...claim }, updated_at: at, failure: null
  }) };
}

export function startExecution(record, claim, { now = () => new Date().toISOString() } = {}) {
  const valid = validateRecord(record);
  if (!valid.ok) return valid;
  if (record.state !== "CLAIMED") return fail("EXECUTION_NOT_CLAIMED");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  const check = checkClaim(record, claim, at);
  if (!check.ok) return check;
  const event = eventFor(record, "RUNNING", at, {
    worker_id: claim.worker_id, lease_id: claim.lease_id, fence: claim.fence
  });
  return { ok: true, record: withEvent(record, event, { updated_at: at }) };
}

export function completeExecution(record, claim, resultDigest, {
  now = () => new Date().toISOString()
} = {}) {
  const valid = validateRecord(record);
  if (!valid.ok) return valid;
  if (record.state !== "RUNNING") return fail("EXECUTION_NOT_RUNNING");
  if (!DIGEST.test(resultDigest ?? "")) return fail("RESULT_DIGEST_INVALID");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  const check = checkClaim(record, claim, at);
  if (!check.ok) return check;
  const event = eventFor(record, "SUCCEEDED", at, {
    worker_id: claim.worker_id, lease_id: claim.lease_id, fence: claim.fence,
    result_digest: resultDigest
  });
  return { ok: true, record: withEvent(record, event, {
    updated_at: at, result_digest: resultDigest, claim: null, failure: null
  }) };
}

/** Fail an attempt. Retry is an explicit transition, never an automatic tool call. */
export function failExecution(record, claim, reason, {
  retryable = false, now = () => new Date().toISOString()
} = {}) {
  const valid = validateRecord(record);
  if (!valid.ok) return valid;
  if (!["CLAIMED", "RUNNING"].includes(record.state)) return fail("EXECUTION_NOT_ACTIVE");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
    return fail("FAILURE_REASON_INVALID");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  const check = checkClaim(record, claim, at);
  if (!check.ok) return check;
  const canRetry = retryable === true && record.attempts < record.max_attempts;
  const nextState = canRetry ? "RETRY_WAIT" : "FAILED";
  const event = eventFor(record, nextState, at, {
    worker_id: claim.worker_id, lease_id: claim.lease_id, fence: claim.fence,
    reason: reason.trim(), retryable: canRetry
  });
  return { ok: true, record: withEvent(record, event, {
    updated_at: at, claim: null, failure: { reason: reason.trim(), retryable: canRetry }
  }) };
}

export function cancelExecution(record, actor_id, reason, {
  now = () => new Date().toISOString()
} = {}) {
  const valid = validateRecord(record);
  if (!valid.ok) return valid;
  if (!validId(actor_id)) return fail("CANCEL_ACTOR_INVALID");
  if (TERMINAL.has(record.state)) return fail("EXECUTION_TERMINAL");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500)
    return fail("CANCEL_REASON_INVALID");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  const event = eventFor(record, "CANCELLED", at, { actor_id, reason: reason.trim() });
  return { ok: true, record: withEvent(record, event, {
    updated_at: at, claim: null, failure: null
  }) };
}

/**
 * Persist with an adapter supporting open/put/readAll/verify. Duplicate keys
 * must resolve to the byte-equivalent record or fail closed.
 */
export async function appendExecutionRecord(record, store) {
  const valid = validateRecord(record);
  if (!valid.ok) return valid;
  if (!store || typeof store.open !== "function" || typeof store.put !== "function" ||
      typeof store.readAll !== "function" || typeof store.verify !== "function")
    return fail("EXECUTION_STORE_REQUIRED");
  try {
    await store.open();
    const result = await store.put({
      idempotencyKey: record.execution_key,
      key: EXECUTION_LEDGER_KEY,
      value: record
    });
    if (result?.ok !== true) return fail("EXECUTION_APPEND_FAILED");
    if (result.duplicate === true) {
      const all = await store.readAll();
      const existing = all.find(x => x?.id === record.execution_key && x?.key === EXECUTION_LEDGER_KEY);
      if (!existing || !validRecord(existing.value) ||
          existing.value.record_digest !== record.record_digest)
        return fail("EXECUTION_IDEMPOTENCY_CONFLICT");
      return { ok: true, duplicate: true, record: existing.value };
    }
    return { ok: true, duplicate: false, sequence: result.sequence, journal_hash: result.hash };
  } catch {
    return fail("EXECUTION_STORE_UNAVAILABLE");
  }
}

/** Recover only records from a verified journal; no replay or dispatch occurs. */
export async function recoverExecutionRecords(store) {
  if (!store || typeof store.open !== "function" || typeof store.readAll !== "function" ||
      typeof store.verify !== "function") return fail("EXECUTION_STORE_REQUIRED");
  try {
    await store.open();
    const verified = await store.verify();
    if (verified?.ok !== true || !Number.isSafeInteger(verified.count) ||
        typeof verified.headHash !== "string" || !/^[a-f0-9]{64}$/.test(verified.headHash))
      return fail("EXECUTION_JOURNAL_INTEGRITY_FAILURE");
    const entries = await store.readAll();
    if (!Array.isArray(entries) || entries.length !== verified.count)
      return fail("EXECUTION_JOURNAL_COUNT_MISMATCH");
    const records = [];
    const seen = new Set();
    for (const entry of entries) {
      if (entry?.key !== EXECUTION_LEDGER_KEY) continue;
      if (!validRecord(entry.value) || entry.id !== entry.value.execution_key || seen.has(entry.id))
        return fail("EXECUTION_RECORD_INVALID");
      seen.add(entry.id);
      records.push(entry.value);
    }
    return { ok: true, records: Object.freeze(records), count: records.length, journal_head: verified.headHash };
  } catch {
    return fail("EXECUTION_JOURNAL_INTEGRITY_FAILURE");
  }
}
