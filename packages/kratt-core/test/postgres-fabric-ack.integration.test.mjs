import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, generateKeyPairSync, sign, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FABRIC_RECEIVER_ACK_PROTOCOL,
  fabricReceiverAcknowledgementDigest,
  fabricReceiverAcknowledgementSigningInput,
  processFabricReceiverAcknowledgement
} from "../src/fabric-negotiation-ack.mjs";
import { createPostgresOutboxStore } from "../src/postgres-outbox-store.mjs";
import { createPostgresFabricAcknowledgementStore } from "../src/postgres-fabric-ack-store.mjs";
import { createPostgresFabricTrustRegistry } from "../src/postgres-fabric-trust-registry.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse("2026-11-26T17:00:00.000Z");
const receiverKeys = generateKeyPairSync("ed25519");
const receiverIdentity = {
  node_id: "steel-node", key_id: "steel-receiver-key", status: "ACTIVE",
  public_key: receiverKeys.publicKey, valid_from: "2026-01-01T00:00:00.000Z"
};
let sequence = 0;

function makeAck(event, attempt, result = "ACCEPTED", suffix = "one", overrides = {}) {
  const ack = {
    protocol: FABRIC_RECEIVER_ACK_PROTOCOL,
    ack_id: "ack:" + suffix,
    event_id: event.event_id,
    source_node: event.source_node,
    receiver_node: event.destination_node,
    source_sequence: event.sequence,
    event_digest: event.content_digest,
    delivery_attempt: Number(attempt),
    result,
    policy_revision: event.ackPolicyRevision ?? "steel-policy-7",
    issued_at: "2026-11-26T17:00:00.000Z",
    key_id: receiverIdentity.key_id,
    content_digest: "",
    signature: "",
    ...overrides
  };
  ack.content_digest = fabricReceiverAcknowledgementDigest(ack);
  ack.signature = sign(null, Buffer.from(fabricReceiverAcknowledgementSigningInput(ack)), receiverKeys.privateKey).toString("base64");
  return ack;
}

test("PostgreSQL 16 binds signed receiver ACKs to event identity, attempt, lease fence and append-only receipt", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const schema = "kratt_wave3_ack_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString, max: 2 });
  let pool;
  let poolB;
  try {
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({ connectionString, max: 10, options: "-c search_path=" + schema });
    poolB = new Pool({ connectionString, max: 10, options: "-c search_path=" + schema });
    for (const path of [
      "../migrations/0001_postgres_outbox.sql",
      "../migrations/0004_fabric_outbound.sql",
      "../migrations/0005_fabric_trust_registry.sql",
      "../migrations/0006_outbox_delivery_reliability.sql",
      "../migrations/0007_fabric_receiver_acknowledgements.sql",
      "../migrations/0009_fabric_ack_outbox_reconciliation.sql"
    ]) {
      const sql = await readFile(join(here, path), "utf8");
      await pool.query(sql);
    }

    let clock = NOW;
    const trust = createPostgresFabricTrustRegistry(pool, {
      clock: () => new Date(clock), authorizeAdmin: async () => true
    });
    assert.equal((await trust.registerNode({
      nodeId: "steel-node", repositoryFullName: "3XTRINITY/STEEL",
      repositoryRevision: "a".repeat(40), actorId: "operator-01"
    })).ok, true);
    assert.equal((await trust.registerKey({
      nodeId: "steel-node", keyId: receiverIdentity.key_id,
      publicKeyPem: receiverKeys.publicKey.export({ type: "spki", format: "pem" }),
      validFrom: "2026-01-01T00:00:00.000Z", actorId: "operator-01"
    })).ok, true);
    assert.equal((await trust.transitionKey({
      nodeId: "steel-node", keyId: receiverIdentity.key_id, nextStatus: "ACTIVE",
      actorId: "operator-01", reason: "activate isolated test receiver key"
    })).ok, true);
    const outbox = createPostgresOutboxStore(pool, {
      clock: () => new Date(clock),
      authorizeReconciliation: async request => request.actorId === "operator-01" && request.evidenceDigest === "d".repeat(64)
    });
    const acknowledgements = createPostgresFabricAcknowledgementStore(pool, {
      clock: () => new Date(clock),
      lockTrustedReceiverKey: (client, nodeId, keyId, ack, nowMs) =>
        trust.lockTrustedReceiverAcknowledgementIdentity(client, nodeId, keyId, ack, nowMs)
    });
    const trustB = createPostgresFabricTrustRegistry(poolB, {
      clock: () => new Date(clock), authorizeAdmin: async () => true
    });
    const acknowledgementsB = createPostgresFabricAcknowledgementStore(poolB, {
      clock: () => new Date(clock),
      lockTrustedReceiverKey: (client, nodeId, keyId, ack, nowMs) =>
        trustB.lockTrustedReceiverAcknowledgementIdentity(client, nodeId, keyId, ack, nowMs)
    });

    async function seed(tag, ackPolicyRevision = "steel-policy-7") {
      const taskId = "task-ack-" + tag;
      const idempotencyKey = "kratt:" + taskId + ":" + createHash("sha256").update(tag, "utf8").digest("hex");
      const outboxId = "outbox:" + taskId;
      const event = {
        protocol: "3XT-FABRIC/1",
        event_id: "event:" + tag,
        event_type: "factory.task.requested",
        source_node: "kratt-node",
        destination_node: "steel-node",
        source_revision: "a".repeat(40),
        correlation_id: "correlation:" + tag,
        parent_event_id: null,
        sequence: ++sequence,
        issued_at: "2026-11-26T16:59:00.000Z",
        expires_at: "2026-11-26T18:00:00.000Z",
        scope: ["repository.read"],
        payload_reference: null,
        evidence_references: [],
        key_id: "kratt-fabric-key",
        payload: { task_id: taskId },
        content_digest: createHash("sha256").update("fabric-event:" + tag, "utf8").digest("hex"),
        signature: "test-fixture-only"
      };
      await pool.query(
        "INSERT INTO kratt_dispatch_intents(idempotency_key,task_id,actor_id,provider,operation,status,created_at) " +
        "VALUES($1,$2,'operator-01','fabric','fabric.publish','INTENT_COMMITTED',$3)",
        [idempotencyKey, taskId, new Date(clock).toISOString()]
      );
      await pool.query(
        "INSERT INTO kratt_dispatch_outbox(outbox_id,idempotency_key,provider,payload,status,available_at) " +
        "VALUES($1,$2,'fabric',$3::jsonb,'PENDING',$4)",
        [outboxId, idempotencyKey, JSON.stringify({ fabric_envelope: event }), new Date(clock).toISOString()]
      );
      await pool.query(
        "INSERT INTO kratt_fabric_outbound_heads(source_node,last_sequence) VALUES('kratt-node',$1) " +
        "ON CONFLICT(source_node) DO UPDATE SET last_sequence=EXCLUDED.last_sequence,updated_at=clock_timestamp()",
        [event.sequence]
      );
      await pool.query(
        "INSERT INTO kratt_fabric_outbound_sequences(source_node,idempotency_key,request_digest,source_sequence) VALUES('kratt-node',$1,$2,$3)",
        [idempotencyKey, "c".repeat(64), event.sequence]
      );
      await pool.query(
        "INSERT INTO kratt_fabric_outbound_events(event_id,idempotency_key,source_node,destination_node,source_sequence,key_id,content_digest,issued_at,expires_at,event_json,ack_policy_revision) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)",
        [event.event_id,idempotencyKey,event.source_node,event.destination_node,event.sequence,event.key_id,
          event.content_digest,event.issued_at,event.expires_at,JSON.stringify(event),ackPolicyRevision]
      );
      return { taskId, idempotencyKey, outboxId, event: { ...event, ackPolicyRevision }, ackPolicyRevision };
    }

    async function begin(item) {
      const claimed = await outbox.claimOutbox({ workerId: "worker-ack", limit: 10, leaseSeconds: 60 });
      const row = claimed.find(value => value.outbox_id === item.outboxId);
      assert.ok(row, "expected outbox row to be claimed");
      const started = await outbox.beginOutboxDelivery({ outboxId: item.outboxId, leaseToken: row.lease_token });
      assert.equal(started.ok, true, JSON.stringify(started));
      return row;
    }

    async function process(item, lease, ack, store = acknowledgements) {
      return processFabricReceiverAcknowledgement({
        acknowledgement: ack,
        expectedReceiverNode: "steel-node",
        expectedPolicyRevision: item.ackPolicyRevision,
        resolveTrustedKey: (nodeId, keyId) => trust.resolveTrustedKey(nodeId, keyId),
        acknowledgementStore: store,
        outboxId: item.outboxId,
        leaseToken: lease.lease_token,
        now: () => clock
      });
    }

    const accepted = await seed("accepted");
    const acceptedLease = await begin(accepted);
    const acceptedAck = makeAck(accepted.event, acceptedLease.delivery_attempt_sequence, "ACCEPTED", "accepted");
    const acceptedResult = await process(accepted, acceptedLease, acceptedAck);
    assert.equal(acceptedResult.ok, true, JSON.stringify(acceptedResult));
    assert.equal(acceptedResult.value.outbox_status, "DONE");
    assert.equal((await pool.query("SELECT status FROM kratt_dispatch_intents WHERE task_id=$1", [accepted.taskId])).rows[0].status, "COMPLETED");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM kratt_fabric_receiver_acknowledgements WHERE outbox_id=$1", [accepted.outboxId])).rows[0].n, 1);

    const exactDuplicate = await process(accepted, acceptedLease, acceptedAck, acknowledgementsB);
    assert.equal(exactDuplicate.ok, true);
    assert.equal(exactDuplicate.value.duplicate, true);
    const conflictingDuplicate = await process(accepted, acceptedLease,
      makeAck(accepted.event, acceptedLease.delivery_attempt_sequence, "ACCEPTED", "accepted-conflict"));
    assert.equal(conflictingDuplicate.code, "ACK_REPLAY_CONFLICT");

    const rejected = await seed("rejected");
    const rejectedLease = await begin(rejected);
    const rejectedResult = await process(rejected, rejectedLease,
      makeAck(rejected.event, rejectedLease.delivery_attempt_sequence, "REJECTED", "rejected"));
    assert.equal(rejectedResult.ok, true);
    assert.equal(rejectedResult.value.outbox_status, "RECONCILE");
    const rejectedRow = await pool.query("SELECT status,last_error_code FROM kratt_dispatch_outbox WHERE outbox_id=$1", [rejected.outboxId]);
    assert.equal(rejectedRow.rows[0].status, "RECONCILE");
    assert.equal(rejectedRow.rows[0].last_error_code, "RECEIVER_REJECTED");

    // A manual, evidence-backed retry resets the retry budget but never reuses an attempt identity.
    const manuallyRequeued = await outbox.reconcileOutbox({
      outboxId: rejected.outboxId,
      actorId: "operator-01",
      decision: "SAFE_TO_RETRY",
      evidenceDigest: "d".repeat(64),
      reason: "operator verified the receiver rejection and approved a bounded retry"
    });
    assert.equal(manuallyRequeued.ok, true, JSON.stringify(manuallyRequeued));
    const retryClaim = (await outbox.claimOutbox({ workerId: "worker-ack", limit: 10, leaseSeconds: 60 }))
      .find(row => row.outbox_id === rejected.outboxId);
    assert.ok(retryClaim);
    assert.equal(Number(retryClaim.delivery_attempt_sequence), Number(rejectedLease.delivery_attempt_sequence) + 1);
    assert.equal(Number(retryClaim.attempts), 1);
    assert.equal((await outbox.beginOutboxDelivery({ outboxId: rejected.outboxId, leaseToken: retryClaim.lease_token })).ok, true);
    const acceptedAfterRetry = await process(rejected, retryClaim,
      makeAck(rejected.event, retryClaim.delivery_attempt_sequence, "ACCEPTED", "accepted-after-retry"));
    assert.equal(acceptedAfterRetry.ok, true, JSON.stringify(acceptedAfterRetry));
    assert.equal(acceptedAfterRetry.value.outbox_status, "DONE");
    assert.deepEqual((await pool.query(
      "SELECT delivery_attempt,result FROM kratt_fabric_receiver_acknowledgements WHERE outbox_id=$1 ORDER BY delivery_attempt",
      [rejected.outboxId]
    )).rows.map(row => [Number(row.delivery_attempt), row.result]), [[1, "REJECTED"], [2, "ACCEPTED"]]);

    const policyBound = await seed("per-intent-policy-revision", "steel-policy-8");
    const policyBoundLease = await begin(policyBound);
    const policyBoundResult = await process(policyBound, policyBoundLease,
      makeAck(policyBound.event, policyBoundLease.delivery_attempt_sequence, "ACCEPTED", "policy-bound"));
    assert.equal(policyBoundResult.ok, true, JSON.stringify(policyBoundResult));
    assert.equal(policyBoundResult.value.outbox_status, "DONE");

    const unknown = await seed("unknown");
    const unknownLease = await begin(unknown);
    const unknownResult = await process(unknown, unknownLease,
      makeAck(unknown.event, unknownLease.delivery_attempt_sequence, "UNKNOWN", "unknown"));
    assert.equal(unknownResult.ok, true);
    assert.equal(unknownResult.value.outbox_status, "RECONCILE");
    assert.equal((await pool.query("SELECT status FROM kratt_dispatch_outbox WHERE outbox_id=$1", [unknown.outboxId])).rows[0].status, "RECONCILE");

    const mismatch = await seed("mismatch");
    const mismatchLease = await begin(mismatch);
    const wrongEventId = makeAck(mismatch.event, mismatchLease.delivery_attempt_sequence, "ACCEPTED", "wrong-event-id", {
      event_id: "event:forged"
    });
    const wrongEventIdResult = await process(mismatch, mismatchLease, wrongEventId);
    assert.equal(wrongEventIdResult.code, "ACK_EVENT_BINDING_MISMATCH");

    const wrongDigest = makeAck(mismatch.event, mismatchLease.delivery_attempt_sequence, "ACCEPTED", "wrong-digest", {
      event_digest: "f".repeat(64)
    });
    const mismatchResult = await process(mismatch, mismatchLease, wrongDigest);
    assert.equal(mismatchResult.code, "ACK_EVENT_BINDING_MISMATCH");
    const wrongPolicy = makeAck(mismatch.event, mismatchLease.delivery_attempt_sequence, "ACCEPTED", "wrong-policy", {
      policy_revision: "steel-policy-forged"
    });
    const wrongPolicyResult = await process(mismatch, mismatchLease, wrongPolicy);
    assert.equal(wrongPolicyResult.code, "ACK_POLICY_REVISION_MISMATCH");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM kratt_fabric_receiver_acknowledgements WHERE outbox_id=$1", [mismatch.outboxId])).rows[0].n, 0);

    // A receiver may acknowledge after the worker lease expires, but only the original
    // durable delivery-start token and monotonic attempt may resolve RECONCILE.
    const late = await seed("late-after-lease-expiry");
    const lateLease = await begin(late);
    clock += 61_000;
    assert.deepEqual(await outbox.claimOutbox({ workerId: "worker-recovery", limit: 10, leaseSeconds: 60 }), []);
    assert.equal((await pool.query("SELECT status FROM kratt_dispatch_outbox WHERE outbox_id=$1", [late.outboxId])).rows[0].status, "RECONCILE");

    const lateAck = makeAck(late.event, lateLease.delivery_attempt_sequence, "ACCEPTED", "late-accepted");
    const [lateAckResult, lateCancelResult] = await Promise.all([
      process(late, lateLease, lateAck),
      outbox.cancelTaskWithReason({ taskId: late.taskId, actorId: "operator-01" })
    ]);
    assert.equal(lateAckResult.ok, true, JSON.stringify(lateAckResult));
    assert.equal(lateAckResult.value.outbox_status, "DONE");
    assert.equal(lateCancelResult.ok, false, "cancellation must not overtake or undo a delivery that already started");
    assert.equal((await pool.query("SELECT status FROM kratt_dispatch_intents WHERE task_id=$1", [late.taskId])).rows[0].status, "COMPLETED");

    const cancelled = await seed("cancelled-before-start");
    const cancelClaim = (await outbox.claimOutbox({ workerId: "worker-ack", limit: 10, leaseSeconds: 60 })).find(row => row.outbox_id === cancelled.outboxId);
    assert.ok(cancelClaim);
    const cancelResult = await outbox.cancelTaskWithReason({ taskId: cancelled.taskId, actorId: "operator-01" });
    assert.equal(cancelResult.ok, true);
    const startAfterCancel = await outbox.beginOutboxDelivery({ outboxId: cancelled.outboxId, leaseToken: cancelClaim.lease_token });
    assert.equal(startAfterCancel.reason, "LEASE_LOST");
    const cancelledAck = makeAck(cancelled.event, cancelClaim.delivery_attempt_sequence, "ACCEPTED", "cancelled");
    const cancelledAckResult = await process(cancelled, cancelClaim, cancelledAck);
    assert.equal(cancelledAckResult.ok, true, JSON.stringify(cancelledAckResult));
    assert.equal(cancelledAckResult.value.late_ack, true);
    assert.equal(cancelledAckResult.value.outbox_status, "CANCELLED");
    const lateReplay = await process(cancelled, cancelClaim, cancelledAck);
    assert.equal(lateReplay.ok, true);
    assert.equal(lateReplay.value.duplicate, true);
    assert.equal(lateReplay.value.late_ack, true);
    const lateLedger = await pool.query(
      "SELECT count(*)::int AS n FROM kratt_fabric_late_acknowledgements WHERE outbox_id=$1", [cancelled.outboxId]
    );
    assert.equal(lateLedger.rows[0].n, 1);
    const cancelledPair = await pool.query(
      "SELECT o.status AS outbox_status,i.status AS intent_status FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i USING(idempotency_key) WHERE o.outbox_id=$1",
      [cancelled.outboxId]
    );
    assert.deepEqual(cancelledPair.rows[0], { outbox_status: "CANCELLED", intent_status: "CANCELLED" });

    assert.deepEqual(await outbox.claimOutbox({ workerId: "worker-ack", limit: 10, leaseSeconds: 60 }), []);
    await assert.rejects(
      pool.query("UPDATE kratt_fabric_receiver_acknowledgements SET result='UNKNOWN' WHERE ack_id=$1", [acceptedAck.ack_id]),
      /KRATT_FABRIC_RECEIVER_ACK_APPEND_ONLY/
    );
    await assert.rejects(
      pool.query("DELETE FROM kratt_fabric_receiver_acknowledgements WHERE ack_id=$1", [acceptedAck.ack_id]),
      /KRATT_FABRIC_RECEIVER_ACK_APPEND_ONLY/
    );
    await assert.rejects(
      pool.query("TRUNCATE TABLE kratt_fabric_late_acknowledgements"),
      /KRATT_FABRIC_ACK_LEDGER_TRUNCATE_FORBIDDEN/
    );

    const revoked = await seed("receiver-key-revoked");
    const revokedLease = await begin(revoked);
    const revokedAck = makeAck(revoked.event, revokedLease.delivery_attempt_sequence, "ACCEPTED", "revoked-key");
    assert.equal((await trust.transitionKey({
      nodeId: "steel-node", keyId: receiverIdentity.key_id, nextStatus: "REVOKED",
      actorId: "operator-01", reason: "revoke isolated test receiver key"
    })).ok, true);
    const revokedResult = await process(revoked, revokedLease, revokedAck);
    assert.equal(revokedResult.ok, false);
    assert.equal(revokedResult.code, "ACK_KEY_UNTRUSTED");
    assert.equal((await pool.query(
      "SELECT count(*)::int AS n FROM kratt_fabric_receiver_acknowledgements WHERE outbox_id=$1", [revoked.outboxId]
    )).rows[0].n, 0);
  } finally {
    await pool?.end();
    await poolB?.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => undefined);
    await admin.end();
  }
});
