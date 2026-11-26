import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  claimExecution, createExecutionRecord, renewExecutionClaim,
  startExecution, validateExecutionRecord
} from "../src/construction-execution-ledger.mjs";

const taskDigest = "sha256:" + "a".repeat(64);
const resultDigest = "sha256:" + "b".repeat(64);
const initialTime = "2026-11-26T12:00:00.000Z";
const canonical = value => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
};
const claim = Object.freeze({
  worker_id: "worker-a",
  lease_id: "lease-a",
  fence: 1,
  expires_at: "2026-11-26T12:00:30.000Z"
});

function runningRecord() {
  const created = createExecutionRecord({
    task_id: "task-renewal-1",
    task_revision: 3,
    task_digest: taskDigest,
    operation: "build",
    now: () => initialTime
  });
  assert.equal(created.ok, true);
  const claimed = claimExecution(created.record, claim, {
    now: () => "2026-11-26T12:00:01.000Z"
  });
  assert.equal(claimed.ok, true);
  const started = startExecution(claimed.record, claim, {
    now: () => "2026-11-26T12:00:02.000Z"
  });
  assert.equal(started.ok, true);
  return started.record;
}

test("lease renewal appends an immutable same-state execution revision", () => {
  const record = runningRecord();
  const renewed = renewExecutionClaim(record, record.claim, "2026-11-26T12:01:00.000Z", {
    now: () => "2026-11-26T12:00:20.000Z"
  });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.record.state, "RUNNING");
  assert.equal(renewed.record.revision, record.revision + 1);
  assert.equal(renewed.record.last_fencing_token, record.last_fencing_token);
  assert.equal(renewed.record.claim.expires_at, "2026-11-26T12:01:00.000Z");
  assert.equal(renewed.record.history.at(-1).from, "RUNNING");
  assert.equal(renewed.record.history.at(-1).to, "RUNNING");
  assert.equal(renewed.record.history.at(-1).lease_renewed, true);
  assert.equal(validateExecutionRecord(renewed.record).ok, true);
  assert.equal(Object.isFrozen(renewed.record), true);
});

test("renewal rejects mismatched claims, expired claims and non-extending expiry", () => {
  const record = runningRecord();
  assert.equal(renewExecutionClaim(record, { ...record.claim, lease_id: "other-lease" },
    "2026-11-26T12:01:00.000Z", { now: () => "2026-11-26T12:00:20.000Z" }).reason, "CLAIM_MISMATCH");
  assert.equal(renewExecutionClaim(record, record.claim,
    "2026-11-26T12:01:00.000Z", { now: () => "2026-11-26T12:00:31.000Z" }).reason, "CLAIM_EXPIRED");
  assert.equal(renewExecutionClaim(record, record.claim,
    "2026-11-26T12:00:25.000Z", { now: () => "2026-11-26T12:00:20.000Z" }).reason, "LEASE_RENEWAL_EXPIRY_INVALID");
});

test("same-state heartbeat history remains fenced against a lower subsequent token", () => {
  const record = runningRecord();
  const renewed = renewExecutionClaim(record, record.claim, "2026-11-26T12:01:00.000Z", {
    now: () => "2026-11-26T12:00:20.000Z"
  });
  assert.equal(renewed.ok, true);
  const nextClaim = {
    worker_id: "worker-a", lease_id: "lease-a", fence: 1,
    expires_at: "2026-11-26T12:01:00.000Z"
  };
  const again = renewExecutionClaim(renewed.record, nextClaim, "2026-11-26T12:02:00.000Z", {
    now: () => "2026-11-26T12:00:40.000Z"
  });
  assert.equal(again.ok, true);
  assert.equal(again.record.last_fencing_token, 1);
  assert.equal(validateExecutionRecord(again.record).ok, true);
});


test("legacy v1 claimed records without historical lease-expiry fields remain readable", () => {
  const created = createExecutionRecord({
    task_id: "task-renewal-legacy",
    task_revision: 1,
    task_digest: taskDigest,
    operation: "build",
    now: () => initialTime
  });
  const claimed = claimExecution(created.record, {
    ...claim,
    expires_at: "2026-11-26T12:00:30.000Z"
  }, { now: () => "2026-11-26T12:00:01.000Z" });
  assert.equal(claimed.ok, true);
  const { record_digest: ignored, ...rawUnsigned } = claimed.record;
  const unsigned = structuredClone(rawUnsigned);
  delete unsigned.history[0].lease_expires_at;
  const legacy = {
    ...unsigned,
    record_digest: "sha256:" + createHash("sha256").update(canonical(unsigned), "utf8").digest("hex")
  };
  assert.equal(validateExecutionRecord(legacy).ok, true);
});
