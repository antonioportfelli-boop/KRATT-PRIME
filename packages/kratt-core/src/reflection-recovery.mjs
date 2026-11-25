import { createHash } from "node:crypto";
import { reflectConstructionTask } from "./reflection-engine.mjs";
import { verifyConstructionTask } from "./construction-protocol.mjs";

export const CONSTRUCTION_REFLECTION_RECORD_KEY = "construction.reflection.v1";
const RECORD_SCHEMA = "kratt-reflection-journal/v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new TypeError("NON_CANONICAL_REFLECTION_VALUE");
}
const hash = value => `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;

function normalizeObservations(observations) {
  if (!plain(observations) || !Array.isArray(observations.evidence)) throw new TypeError("REFLECTION_OBSERVATIONS_INVALID");
  const failedChecks = observations.failed_checks ?? [];
  if (!Array.isArray(failedChecks)) throw new TypeError("REFLECTION_OBSERVATIONS_INVALID");
  return {
    evidence: observations.evidence.map(item => {
      if (!plain(item)) throw new TypeError("REFLECTION_OBSERVATIONS_INVALID");
      return { evidence_id: item.evidence_id, requirement: item.requirement, result: item.result };
    }),
    failed_checks: [...failedChecks]
  };
}

function validateStore(store) {
  return Boolean(store && typeof store.open === "function" && typeof store.put === "function" &&
    typeof store.readAll === "function" && typeof store.verify === "function");
}

function validRecord(record) {
  if (!plain(record) || record.schema_version !== RECORD_SCHEMA ||
      !ID.test(record.idempotency_key ?? "") || !ID.test(record.task_id ?? "") ||
      !SHA256.test(record.task_digest ?? "") || !SHA256.test(record.observation_digest ?? "") ||
      !Number.isInteger(record.task_revision) || record.task_revision < 0 ||
      typeof record.created_at !== "string" || !Number.isFinite(Date.parse(record.created_at)) ||
      !plain(record.report) || typeof record.record_digest !== "string" || !SHA256.test(record.record_digest)) return false;
  const { record_digest, ...unsigned } = record;
  return hash(unsigned) === record_digest;
}

/**
 * Persist a reflection result in a PrimeStore-compatible append-only journal.
 * Observations must already have been provenance-verified by the trusted host.
 * This module never executes a follow-up proposal or authorizes repository writes.
 */
export async function recordConstructionReflection({ task, observations, store, now = () => new Date().toISOString() } = {}) {
  if (!validateStore(store)) return { ok: false, reason: "REFLECTION_STORE_REQUIRED" };
  const integrity = verifyConstructionTask(task);
  if (!integrity.ok) return { ok: false, reason: "TASK_INTEGRITY_INVALID", detail: integrity.reason };

  let normalized;
  try { normalized = normalizeObservations(observations); }
  catch { return { ok: false, reason: "REFLECTION_OBSERVATIONS_INVALID" }; }

  const reflected = reflectConstructionTask(task, normalized);
  if (!reflected.ok) return reflected;

  let createdAt;
  try { createdAt = now(); } catch { return { ok: false, reason: "REFLECTION_CLOCK_UNAVAILABLE" }; }
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))
    return { ok: false, reason: "REFLECTION_CLOCK_INVALID" };

  const observationDigest = hash(normalized);
  const idempotencyKey = `reflect-${hash({
    task_id: task.task_id,
    task_revision: task.revision,
    task_digest: integrity.task_digest,
    observation_digest: observationDigest
  }).slice(7, 55)}`;
  const unsigned = {
    schema_version: RECORD_SCHEMA,
    idempotency_key: idempotencyKey,
    task_id: task.task_id,
    task_digest: integrity.task_digest,
    task_revision: task.revision,
    observation_digest: observationDigest,
    created_at: createdAt,
    report: reflected.report
  };
  const record = Object.freeze({ ...unsigned, record_digest: hash(unsigned) });

  try {
    await store.open();
    const write = await store.put({
      idempotencyKey,
      key: CONSTRUCTION_REFLECTION_RECORD_KEY,
      value: record
    });
    if (write?.ok !== true) return { ok: false, reason: "REFLECTION_JOURNAL_APPEND_FAILED" };

    if (write.duplicate === true) {
      const entries = await store.readAll();
      const prior = entries.find(entry => entry?.id === idempotencyKey && entry?.key === CONSTRUCTION_REFLECTION_RECORD_KEY);
      if (!prior || !validRecord(prior.value) || prior.value.record_digest !== record.record_digest)
        return { ok: false, reason: "REFLECTION_IDEMPOTENCY_CONFLICT" };
      return { ok: true, duplicate: true, record: prior.value, report: prior.value.report };
    }

    return {
      ok: true,
      duplicate: false,
      sequence: write.sequence,
      journal_hash: write.hash,
      record,
      report: record.report
    };
  } catch {
    return { ok: false, reason: "REFLECTION_JOURNAL_UNAVAILABLE" };
  }
}

/** Verify the journal before returning recoverable reflection records. */
export async function recoverConstructionReflections({ store } = {}) {
  if (!validateStore(store)) return { ok: false, reason: "REFLECTION_STORE_REQUIRED" };
  try {
    await store.open();
    const verified = await store.verify();
    if (verified?.ok !== true || !Number.isSafeInteger(verified.count) ||
        typeof verified.headHash !== "string" || !/^[a-f0-9]{64}$/.test(verified.headHash))
      return { ok: false, reason: "REFLECTION_JOURNAL_INTEGRITY_FAILURE" };

    const entries = await store.readAll();
    if (!Array.isArray(entries) || entries.length !== verified.count)
      return { ok: false, reason: "REFLECTION_JOURNAL_COUNT_MISMATCH" };

    const records = [];
    const seen = new Set();
    for (const entry of entries) {
      if (entry?.key !== CONSTRUCTION_REFLECTION_RECORD_KEY) continue;
      if (!validRecord(entry.value) || entry.id !== entry.value.idempotency_key || seen.has(entry.id))
        return { ok: false, reason: "REFLECTION_RECORD_INVALID" };
      seen.add(entry.id);
      records.push(entry.value);
    }
    return { ok: true, records: Object.freeze(records), count: records.length, journal_head: verified.headHash };
  } catch {
    return { ok: false, reason: "REFLECTION_JOURNAL_INTEGRITY_FAILURE" };
  }
}
