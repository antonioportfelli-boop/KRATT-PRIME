import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresOutboxStore } from "../src/postgres-outbox-store.mjs";

const ZERO_HASH = "0".repeat(64);
const CORRELATION_ID = "corr-end-to-end-1";
const TASK_ID = "task-end-to-end-1";
const IDEMPOTENCY_KEY = "kratt:" + TASK_ID + ":" + "a".repeat(64);
const FIXED_NOW = new Date("2026-11-27T14:00:00.000Z");

function createFakePool() {
  const calls = [];
  const auditRecords = [];
  const intentRecord = {
    idempotency_key: IDEMPOTENCY_KEY,
    correlation_id: CORRELATION_ID,
    provider: "mock-provider",
    attempts: 1
  };
  const claimedRow = {
    outbox_id: "outbox-1",
    idempotency_key: IDEMPOTENCY_KEY,
    correlation_id: CORRELATION_ID,
    provider: "mock-provider",
    payload: { task: { task_id: TASK_ID } },
    attempts: 1,
    lease_token: "lease-token-1"
  };

  async function query(sql, values = []) {
    calls.push({ sql, values });
    const statement = sql.trim();

    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
      return { rowCount: 0, rows: [] };
    }
    if (statement.startsWith("SELECT pg_advisory_xact_lock")) {
      return { rowCount: 1, rows: [] };
    }
    if (statement.startsWith("INSERT INTO kratt_approval_nonces")) {
      return { rowCount: 1, rows: [{ key_id: values[0] }] };
    }
    if (statement.startsWith("SELECT task_id FROM kratt_cancelled_tasks")) {
      return { rowCount: 0, rows: [] };
    }
    if (statement.startsWith("INSERT INTO kratt_dispatch_intents")) {
      return { rowCount: 1, rows: [{ idempotency_key: values[0] }] };
    }
    if (statement.startsWith("INSERT INTO kratt_dispatch_outbox")) {
      return { rowCount: 1, rows: [{ outbox_id: values[0] }] };
    }
    if (statement.startsWith("SELECT sequence,hash FROM kratt_audit_head")) {
      return { rowCount: 1, rows: [{ sequence: auditRecords.length, hash: ZERO_HASH }] };
    }
    if (statement.startsWith("INSERT INTO kratt_audit_events")) {
      auditRecords.push(JSON.parse(values[4]));
      return { rowCount: 1, rows: [{ sequence: values[0] }] };
    }
    if (statement.startsWith("UPDATE kratt_audit_head")) {
      return { rowCount: 1, rows: [] };
    }
    if (statement.startsWith("SELECT idempotency_key,correlation_id,provider,attempts FROM kratt_dispatch_outbox")) {
      return { rowCount: 1, rows: [intentRecord] };
    }
    if (statement.startsWith("UPDATE kratt_dispatch_intents")) {
      return { rowCount: 1, rows: [{ idempotency_key: values[2] }] };
    }
    if (statement.startsWith("UPDATE kratt_dispatch_outbox")) {
      return { rowCount: 1, rows: [{ outbox_id: values[1] }] };
    }
    if (statement.startsWith("WITH picked AS")) {
      return { rowCount: 1, rows: [claimedRow] };
    }

    throw new Error("UNEXPECTED_SQL_IN_TEST: " + statement);
  }

  const client = { query, release() {} };
  const pool = { async connect() { return client; }, query };
  return { pool, calls, auditRecords, claimedRow };
}

const task = {
  task_id: TASK_ID,
  actor: "principal-1",
  action: "repo.write",
  constraints: { provider: "mock-provider" }
};
const principal = { id: "principal-1" };
const approval = {
  key_id: "approval-key-1",
  nonce: "nonce-1",
  approval_id: "approval-1",
  expires_at: "2026-11-27T15:00:00.000Z",
  request_digest: "b".repeat(64),
  signature_digest: "c".repeat(64)
};

test("PostgreSQL outbox preserves supplied correlation ID from intent through claim and durable outcome audit", async () => {
  const fixture = createFakePool();
  const store = createPostgresOutboxStore(fixture.pool, { clock: () => FIXED_NOW });

  const reserved = await store.reserveAuthorizedIntent({
    task,
    principal,
    approval,
    idempotencyKey: IDEMPOTENCY_KEY,
    correlationId: CORRELATION_ID
  });

  assert.equal(reserved.ok, true);
  const intentInsert = fixture.calls.find(call => call.sql.includes("INSERT INTO kratt_dispatch_intents"));
  const outboxInsert = fixture.calls.find(call => call.sql.includes("INSERT INTO kratt_dispatch_outbox"));
  assert.equal(intentInsert.values[2], CORRELATION_ID);
  assert.equal(outboxInsert.values[2], CORRELATION_ID);
  assert.equal(fixture.auditRecords[0].event_type, "dispatch.intent_committed");
  assert.equal(fixture.auditRecords[0].correlation_id, CORRELATION_ID);

  const claimed = await store.claimOutbox({ workerId: "worker-1", limit: 1, leaseSeconds: 60 });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].correlation_id, CORRELATION_ID);

  const finished = await store.finishOutbox({
    outboxId: claimed[0].outbox_id,
    leaseToken: claimed[0].lease_token,
    actorId: "system-1",
    taskId: TASK_ID,
    outcome: { status: "COMPLETED" }
  });
  assert.equal(finished.ok, true);
  const completionAudit = fixture.auditRecords.find(record => record.event_type === "dispatch.completed");
  assert.equal(completionAudit.correlation_id, CORRELATION_ID);
  assert.equal(completionAudit.task_id, TASK_ID);
});

test("PostgreSQL outbox uses task ID only as an explicit legacy correlation fallback", async () => {
  const fixture = createFakePool();
  const store = createPostgresOutboxStore(fixture.pool, { clock: () => FIXED_NOW });

  const result = await store.reserveAuthorizedIntent({
    task,
    principal,
    approval,
    idempotencyKey: IDEMPOTENCY_KEY
  });

  assert.equal(result.ok, true);
  const intentInsert = fixture.calls.find(call => call.sql.includes("INSERT INTO kratt_dispatch_intents"));
  const outboxInsert = fixture.calls.find(call => call.sql.includes("INSERT INTO kratt_dispatch_outbox"));
  assert.equal(intentInsert.values[2], TASK_ID);
  assert.equal(outboxInsert.values[2], TASK_ID);
  assert.equal(fixture.auditRecords[0].correlation_id, TASK_ID);
});

test("PostgreSQL outbox rejects malformed correlation ID before opening a transaction", async () => {
  const fixture = createFakePool();
  const store = createPostgresOutboxStore(fixture.pool, { clock: () => FIXED_NOW });

  const result = await store.reserveAuthorizedIntent({
    task,
    principal,
    approval,
    idempotencyKey: IDEMPOTENCY_KEY,
    correlationId: "bad correlation id"
  });

  assert.deepEqual(result, { ok: false, reason: "RESERVATION_INPUT_INVALID" });
  assert.equal(fixture.calls.length, 0);
});
