import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteCommandStore } from "../src/sqlite-command-store.mjs";

const at = "2026-11-18T15:00:00.000Z";
const actor = "operator-01";
const taskId = "task-sqlite-01";
const key = "kratt:task-sqlite-01:" + "a".repeat(64);
const intent = () => ({
  schema_version: "kratt-audit/v1",
  event_id: "intent-event-01",
  event_type: "dispatch.intent_committed",
  created_at: at,
  actor_id: actor,
  task_id: taskId,
  provider: "github",
  operation: "repository.write",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
  decision_id: "decision-01",
  idempotency_key: key,
});
const outcome = (eventType = "dispatch.completed") => ({
  schema_version: "kratt-audit/v1",
  event_id: "outcome-event-01",
  event_type: eventType,
  created_at: "2026-11-18T15:00:01.000Z",
  actor_id: actor,
  task_id: taskId,
  provider: "github",
  operation: "repository.write",
  idempotency_key: key,
  result: { status: eventType === "dispatch.completed" ? "completed" : "failed" },
});
const denial = () => ({
  schema_version: "kratt-audit/v1",
  event_id: "denial-event-01",
  event_type: "authorization.denied",
  created_at: at,
  actor_id: actor,
  task_id: taskId,
  decision: "DENY",
  reason: "POLICY_DENIED",
});

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "kratt-command-store-"));
  const path = join(directory, "commands.sqlite");
  const db = new DatabaseSync(path);
  try { run(createSqliteCommandStore(db), db); }
  finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("commits intent and audit atomically and rejects duplicate idempotency keys", () => withStore((store) => {
  assert.equal(store.commitAuthorizedIntent({ idempotencyKey: key, taskId, record: intent() }), true);
  assert.equal(store.commitAuthorizedIntent({ idempotencyKey: key, taskId, record: { ...intent(), event_id: "intent-event-02" } }), false);
  assert.equal(store.listAuditEvents().length, 1);
  assert.equal(store.verifyAuditChain().ok, true);
}));

test("refuses to commit an intent after the task cancellation is recorded", () => withStore((store) => {
  assert.equal(store.cancelTask({ taskId, actorId: actor, at }), true);
  assert.equal(store.commitAuthorizedIntent({ idempotencyKey: key, taskId, record: intent() }), false);
  assert.equal(store.listAuditEvents().length, 1);
  assert.equal(store.listAuditEvents()[0].record.event_type, "task.cancelled");
}));

test("appends a completion outcome only for a committed intent", () => withStore((store) => {
  assert.equal(store.appendOutcome({ idempotencyKey: key, record: outcome() }), false);
  assert.equal(store.commitAuthorizedIntent({ idempotencyKey: key, taskId, record: intent() }), true);
  assert.equal(store.appendOutcome({ idempotencyKey: key, record: outcome() }), true);
  assert.equal(store.appendOutcome({ idempotencyKey: key, record: outcome() }), false);
  assert.equal(store.listAuditEvents().map(x => x.record.event_type).join(","), "dispatch.intent_committed,dispatch.completed");
  assert.equal(store.verifyAuditChain().ok, true);
}));

test("appends denial records to the same tamper-evident audit chain", () => withStore((store) => {
  assert.equal(store.appendDecision(denial()), true);
  assert.equal(store.verifyAuditChain().ok, true);
  assert.equal(store.listAuditEvents()[0].record.reason, "POLICY_DENIED");
}));

test("audit table rejects update and delete mutations", () => withStore((store, db) => {
  assert.equal(store.appendDecision(denial()), true);
  assert.throws(() => db.prepare("UPDATE kratt_audit_events SET event_type = 'tampered' WHERE sequence = 1").run(), /KRATT_AUDIT_APPEND_ONLY/);
  assert.throws(() => db.prepare("DELETE FROM kratt_audit_events WHERE sequence = 1").run(), /KRATT_AUDIT_APPEND_ONLY/);
}));

test("audit hash-chain verification detects out-of-band tampering", () => withStore((store, db) => {
  assert.equal(store.appendDecision(denial()), true);
  db.exec("DROP TRIGGER kratt_audit_no_update");
  db.prepare("UPDATE kratt_audit_events SET record_json = ? WHERE sequence = 1").run("{}");
  assert.deepEqual(store.verifyAuditChain(), { ok: false, count: 1, broken_sequence: 1 });
}));

test("rejects malformed records and invalid query bounds", () => withStore((store) => {
  assert.equal(store.appendDecision({ ...denial(), schema_version: "unknown" }), false);
  assert.equal(store.commitAuthorizedIntent({ idempotencyKey: "not-a-key", taskId, record: intent() }), false);
  assert.throws(() => store.listAuditEvents({ limit: 1001 }), /AUDIT_QUERY_INVALID/);
  assert.equal(store.listAuditEvents().length, 0);
}));

test("does not leave an intent behind if its audit append fails", () => withStore((store, db) => {
  db.prepare("INSERT INTO kratt_audit_events (sequence,event_id,event_type,created_at,record_json,previous_hash,hash) VALUES (1,?,?,?,?,?,?)")
    .run("intent-event-01","dispatch.intent_committed",at,"{}", "0".repeat(64), "f".repeat(64));
  assert.equal(store.commitAuthorizedIntent({ idempotencyKey: key, taskId, record: intent() }), false);
  const intentCount = db.prepare("SELECT COUNT(*) AS count FROM kratt_dispatch_intents").get().count;
  assert.equal(Number(intentCount), 0);
}));
