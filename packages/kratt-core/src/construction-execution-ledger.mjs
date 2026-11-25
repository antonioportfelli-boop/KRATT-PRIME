import { createHash } from "node:crypto";

/**
 * Deterministic execution ledger.
 * It records workflow state only and never dispatches tools or external effects.
 */
export const EXECUTION_LEDGER_KEY = "construction.execution.v1";
export const EXECUTION_STATES = Object.freeze([
  "QUEUED", "CLAIMED", "RUNNING", "RETRY_WAIT", "SUCCEEDED", "FAILED", "CANCELLED"
]);

const NEXT = Object.freeze({
  QUEUED: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["RUNNING", "RETRY_WAIT", "FAILED", "CANCELLED"],
  RUNNING: ["SUCCEEDED", "RETRY_WAIT", "FAILED"],
  RETRY_WAIT: ["CLAIMED", "CANCELLED"],
  SUCCEEDED: [], FAILED: [], CANCELLED: []
});
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELLED"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MAX_ATTEMPTS = 100;
const MAX_HISTORY = 1000;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  throw new TypeError("NON_CANONICAL_LEDGER_VALUE");
}
const hash = value => `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
const validId = value => typeof value === "string" && ID.test(value);
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const fail = (reason, extra = {}) => ({ ok: false, reason, ...extra });

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

export function deriveExecutionKey({ task_id, task_revision, task_digest, operation } = {}) {
  if (!validId(task_id) || !Number.isSafeInteger(task_revision) || task_revision < 0 ||
      !DIGEST.test(task_digest ?? "") || !validId(operation)) return fail("EXECUTION_IDENTITY_INVALID");
  return { ok: true, execution_key: `exec-${hash({ task_id, task_revision, task_digest, operation }).slice(7, 55)}` };
}

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
    state: "QUEUED", attempts: 0, max_attempts, last_fencing_token: 0,
    revision: 0, created_at: createdAt, updated_at: createdAt,
    claim: null, result_digest: null, failure: null, history: []
  };
  return { ok: true, record: freezeDeep({ ...unsigned, record_digest: hash(unsigned) }) };
}

function validClaim(claim) {
  return plain(claim) && validId(claim.worker_id) && validId(claim.lease_id) &&
    Number.isSafeInteger(claim.fence) && claim.fence > 0 && validTime(claim.expires_at);
}

function validRecord(record) {
  if (!plain(record) || record.schema_version !== "kratt-execution-ledger/v1" ||
      !validId(record.execution_key) || !validId(record.task_id) || !validId(record.operation) ||
      !Number.isSafeInteger(record.task_revision) || record.task_revision < 0 ||
      !DIGEST.test(record.task_digest ?? "") || !EXECUTION_STATES.includes(record.state) ||
      !Number.isInteger(record.attempts) || record.attempts < 0 ||
      !Number.isInteger(record.max_attempts) || record.max_attempts < 1 ||
      record.attempts > record.max_attempts || !Number.isSafeInteger(record.last_fencing_token) ||
      record.last_fencing_token < 0 || !Number.isInteger(record.revision) ||
      !Array.isArray(record.history) || record.history.length !== record.revision ||
      record.history.length > MAX_HISTORY || !validTime(record.created_at) ||
      !validTime(record.updated_at) || !DIGEST.test(record.record_digest ?? "")) return false;
  const expected = deriveExecutionKey({
    task_id: record.task_id, task_revision: record.task_revision,
    task_digest: record.task_digest, operation: record.operation
  });
  if (!expected.ok || expected.execution_key !== record.execution_key) return false;
  const { record_digest, ...unsigned } = record;
  if (hash(unsigned) !== record_digest) return false;
  let previous = "QUEUED";
  let lastFence = 0;
  for (let i = 0; i < record.history.length; i += 1) {
    const event = record.history[i];
    if (!plain(event) || event.sequence !== i + 1 || event.from !== previous ||
        !NEXT[previous]?.includes(event.to) || !validTime(event.at)) return false;
    if (event.fence !== undefined) {
      if (!Number.isSafeInteger(event.fence) || event.fence < lastFence) return false;
      lastFence = event.fence;
    }
    previous = event.to;
  }
  if (previous !== record.state || lastFence !== record.last_fencing_token) return false;
  if (record.claim !== null && (!validClaim(record.claim) || record.claim.fence !== record.last_fencing_token)) return false;
  if (record.result_digest !== null && !DIGEST.test(record.result_digest)) return false;
  return true;
}

export function validateExecutionRecord(record) {
  return validRecord(record) ? { ok: true } : fail("EXECUTION_RECORD_INVALID");
}

function eventFor(record, to, at, details = {}) {
  return { sequence: record.history.length + 1, from: record.state, to, at, ...details };
}

function withEvent(record, event, fields = {}) {
  const next = { ...record, ...fields, state: event.to,
    revision: record.revision + 1, history: [...record.history, event] };
  const { record_digest: _old, ...unsigned } = next;
  return freezeDeep({ ...unsigned, record_digest: hash(unsigned) });
}

export function claimExecution(record, claim, { now = () => new Date().toISOString() } = {}) {
  if (!validRecord(record)) return fail("EXECUTION_RECORD_INVALID");
  if (!["QUEUED", "RETRY_WAIT"].includes(record.state)) return fail("EXECUTION_NOT_CLAIMABLE", { state: record.state });
  if (record.attempts >= record.max_attempts) return fail("ATTEMPTS_EXHAUSTED");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  if (!validClaim(claim) || Date.parse(claim.expires_at) <= Date.parse(at)) return fail("CLAIM_INVALID_OR_EXPIRED");
  if (claim.fence <= record.last_fencing_token) return fail("STALE_FENCE");
  const event = eventFor(record, "CLAIMED", at, {
    worker_id: claim.worker_id, lease_id: claim.lease_id, fence: claim.fence
  });
  return { ok: true, record: withEvent(record, event, {
    attempts: record.attempts + 1, last_fencing_token: claim.fence,
    claim: { ...claim }, updated_at: at, failure: null, result_digest: null
  }) };
}

function checkClaim(record, claim, now) {
  if (!validClaim(claim)) return fail("CLAIM_INVALID");
  if (!record.claim || record.claim.worker_id !== claim.worker_id ||
      record.claim.lease_id !== claim.lease_id || record.claim.fence !== claim.fence)
    return fail("CLAIM_MISMATCH");
  if (Date.parse(claim.expires_at) <= Date.parse(now) ||
      Date.parse(record.claim.expires_at) <= Date.parse(now)) return fail("CLAIM_EXPIRED");
  return { ok: true };
}

export function startExecution(record, claim, { now = () => new Date().toISOString() } = {}) {
  if (!validRecord(record)) return fail("EXECUTION_RECORD_INVALID");
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

export function completeExecution(record, claim, resultDigest, { now = () => new Date().toISOString() } = {}) {
  if (!validRecord(record)) return fail("EXECUTION_RECORD_INVALID");
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

export function failExecution(record, claim, reason, {
  retryable = false, now = () => new Date().toISOString()
} = {}) {
  if (!validRecord(record)) return fail("EXECUTION_RECORD_INVALID");
  if (!["CLAIMED", "RUNNING"].includes(record.state)) return fail("EXECUTION_NOT_ACTIVE");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500) return fail("FAILURE_REASON_INVALID");
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

export function cancelExecution(record, actorId, reason, {
  workerAcknowledged = false, now = () => new Date().toISOString()
} = {}) {
  if (!validRecord(record)) return fail("EXECUTION_RECORD_INVALID");
  if (!validId(actorId)) return fail("CANCEL_ACTOR_INVALID");
  if (!["QUEUED", "CLAIMED", "RETRY_WAIT", "RUNNING"].includes(record.state)) return fail("EXECUTION_TERMINAL");
  if (record.state === "RUNNING" && workerAcknowledged !== true) return fail("RUNNING_CANCELLATION_REQUIRES_WORKER_ACK");
  if (typeof reason !== "string" || !reason.trim() || reason.length > 500) return fail("CANCEL_REASON_INVALID");
  let at;
  try { at = now(); } catch { return fail("EXECUTION_CLOCK_UNAVAILABLE"); }
  if (!validTime(at)) return fail("EXECUTION_CLOCK_INVALID");
  const event = eventFor(record, "CANCELLED", at, {
    actor_id: actorId, reason: reason.trim(),
    ...(record.state === "RUNNING" ? { worker_acknowledged: true } : {})
  });
  return { ok: true, record: withEvent(record, event, { updated_at: at, claim: null, failure: null }) };
}

const versionId = record => `execv-${createHash("sha256").update(`${record.execution_key}:${record.revision}`).digest("hex").slice(0, 48)}`;
const sameIdentity = (a, b) => ["execution_key", "task_id", "task_revision", "task_digest", "operation", "max_attempts", "created_at"]
  .every(key => a[key] === b[key]);
const samePrefix = (a, b) => canonical(a.history) === canonical(b.history.slice(0, a.revision));

async function readVerifiedStore(store) {
  const verification = await store.verify();
  if (verification?.ok !== true || !Number.isSafeInteger(verification.count) ||
      typeof verification.headHash !== "string" || !/^[a-f0-9]{64}$/.test(verification.headHash))
    throw new Error("EXECUTION_JOURNAL_INTEGRITY_FAILURE");
  const entries = await store.readAll();
  if (!Array.isArray(entries) || entries.length !== verification.count) throw new Error("EXECUTION_JOURNAL_COUNT_MISMATCH");
  return entries;
}

/** Append every revision under its own deterministic idempotency key. */
export async function appendExecutionRecord(record, store) {
  if (!validRecord(record)) return fail("EXECUTION_RECORD_INVALID");
  if (!store || typeof store.open !== "function" || typeof store.put !== "function" ||
      typeof store.readAll !== "function" || typeof store.verify !== "function") return fail("EXECUTION_STORE_REQUIRED");
  try {
    await store.open();
    const entries = await readVerifiedStore(store);
    const priorEntries = entries.filter(entry => entry?.key === EXECUTION_LEDGER_KEY &&
      entry?.value?.execution_key === record.execution_key);
    const versions = new Map();
    for (const entry of priorEntries) {
      if (!validRecord(entry.value) || entry.id !== versionId(entry.value) || versions.has(entry.value.revision))
        return fail("EXECUTION_RECORD_INVALID");
      versions.set(entry.value.revision, entry.value);
    }
    const ordered = [...versions.values()].sort((a, b) => a.revision - b.revision);
    for (let i = 0; i < ordered.length; i += 1) {
      if (ordered[i].revision !== i) return fail("EXECUTION_REVISION_GAP");
      if (i > 0 && (!sameIdentity(ordered[i - 1], ordered[i]) || !samePrefix(ordered[i - 1], ordered[i])))
        return fail("EXECUTION_HISTORY_FORK");
    }
    const previous = ordered.at(-1);
    const current = versions.get(record.revision);
    if (current) {
      if (previous && previous.revision > record.revision) return fail("EXECUTION_REVISION_STALE");
      return current.record_digest === record.record_digest
        ? { ok: true, duplicate: true, record: current }
        : fail("EXECUTION_REVISION_CONFLICT");
    }
    if (!previous && record.revision !== 0) return fail("EXECUTION_REVISION_GAP");
    if (previous && (record.revision !== previous.revision + 1 || !sameIdentity(previous, record) ||
        !samePrefix(previous, record))) return fail("EXECUTION_REVISION_CONFLICT");

    const entryId = versionId(record);
    const stored = await store.put({ idempotencyKey: entryId, key: EXECUTION_LEDGER_KEY, value: record });
    if (stored?.ok !== true) return fail("EXECUTION_APPEND_FAILED");
    if (stored.duplicate === true) {
      const updated = await readVerifiedStore(store);
      const existing = updated.find(entry => entry?.id === entryId && entry?.key === EXECUTION_LEDGER_KEY);
      if (!existing || !validRecord(existing.value) || existing.value.record_digest !== record.record_digest)
        return fail("EXECUTION_IDEMPOTENCY_CONFLICT");
      return { ok: true, duplicate: true, record: existing.value };
    }
    return { ok: true, duplicate: false, sequence: stored.sequence, journal_hash: stored.hash, record };
  } catch { return fail("EXECUTION_STORE_UNAVAILABLE"); }
}

/** Recover latest valid revision per execution. No execution is replayed. */
export async function recoverExecutionRecords(store) {
  if (!store || typeof store.open !== "function" || typeof store.readAll !== "function" ||
      typeof store.verify !== "function") return fail("EXECUTION_STORE_REQUIRED");
  try {
    await store.open();
    const entries = await readVerifiedStore(store);
    const grouped = new Map();
    for (const entry of entries) {
      if (entry?.key !== EXECUTION_LEDGER_KEY) continue;
      if (!validRecord(entry.value) || entry.id !== versionId(entry.value)) return fail("EXECUTION_RECORD_INVALID");
      const versions = grouped.get(entry.value.execution_key) ?? [];
      versions.push(entry.value);
      grouped.set(entry.value.execution_key, versions);
    }
    const records = [];
    for (const versions of grouped.values()) {
      versions.sort((a, b) => a.revision - b.revision);
      for (let i = 0; i < versions.length; i += 1) {
        if (versions[i].revision !== i) return fail("EXECUTION_REVISION_GAP");
        if (i > 0 && (!sameIdentity(versions[i - 1], versions[i]) || !samePrefix(versions[i - 1], versions[i])))
          return fail("EXECUTION_HISTORY_FORK");
      }
      records.push(versions.at(-1));
    }
    return { ok: true, records: Object.freeze(records), count: records.length };
  } catch { return fail("EXECUTION_JOURNAL_INTEGRITY_FAILURE"); }
}
