import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fabricEventContentDigest, fabricSigningInput, receiveSteelFabricEventV1 } from "../src/fabric-interoperability.mjs";
import { authenticateFabricReceiverAcknowledgement, createFabricReceiverAcknowledgement, fabricReceiverAcknowledgementDigest } from "../src/fabric-negotiation-ack.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const NOW = Date.parse("2026-11-26T17:00:00.000Z");
const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, "../migrations/0003_fabric_interoperability.sql");
const receiptMigrationPath = join(here, "../migrations/0008_fabric_receiver_receipts.sql");

test("PostgreSQL Fabric inbox enforces atomic idempotency, monotonic source sequence and causal parents", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const schema = `kratt_wave3_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 2 });
  let poolA;
  let poolB;
  let poolRestart;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    poolA = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
    poolB = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
    const migration = await readFile(migrationPath, "utf8");
    const receiptMigration = await readFile(receiptMigrationPath, "utf8");
    await poolA.query(migration);
    await poolA.query(migration);
    await poolA.query(receiptMigration);
    await poolA.query(receiptMigration);
    await poolA.query("CREATE TABLE handler_receipts(event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL)");
    await poolA.query("CREATE TABLE kratt_cancelled_tasks(task_id TEXT PRIMARY KEY, cancelled_at TIMESTAMPTZ NOT NULL, actor_id TEXT NOT NULL)");
    async function waitForAdvisoryLockWait() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND query ILIKE $2", ["Lock", "%pg_advisory_xact_lock%"]);
        if (waiting.rows[0].count > 0) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("EXPECTED_ADVISORY_LOCK_WAIT_NOT_OBSERVED");
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trustedKey = {
      source_node: "steel-node", key_id: "steel-key-wave3", public_key: publicKey,
      status: "ACTIVE", valid_from: "2026-01-01T00:00:00.000Z"
    };
    const receiverKeys = generateKeyPairSync("ed25519");
    const receiverSigningIdentity = { node_id: "kratt-node", key_id: "kratt-ack-key-wave3", public_key: receiverKeys.publicKey, status: "ACTIVE" };
    const policy = {
      source_node: trustedKey.source_node, key_id: trustedKey.key_id, status: "ACTIVE",
      destinations: ["kratt-node"], allowed_event_types: ["factory.task.accepted"],
      allowed_scope: ["repository.read", "evidence.read"], revision: "wave3-test-policy"
    };
    const makeEvent = ({ id, sequence, parent = null, scope = ["repository.read"], issuedAt = new Date(NOW - 1_000).toISOString(), taskId = `task-${id}` }) => {
      const event = {
        protocol: "3XT-FABRIC/1", event_id: id, event_type: "factory.task.accepted",
        source_node: trustedKey.source_node, destination_node: "kratt-node", source_revision: "a".repeat(40),
        correlation_id: "wave3-correlation", parent_event_id: parent, sequence,
        issued_at: issuedAt, expires_at: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
        scope, payload_reference: null, evidence_references: [], key_id: trustedKey.key_id,
        payload: { task_id: taskId, status: "accepted" }, content_digest: "0".repeat(64), signature: ""
      };
      event.content_digest = fabricEventContentDigest(event);
      event.signature = sign(null, Buffer.from(fabricSigningInput(event), "utf8"), privateKey).toString("base64");
      return event;
    };
    const deps = (handler, attempt = 1, overrides = {}) => ({
      localNodeId: "kratt-node",
      deliveryAttempt: attempt,
      resolveReceiverSigningIdentity: async nodeId => nodeId === "kratt-node" ? receiverSigningIdentity : null,
      revalidateAuthorization: async () => policy,
      createAcknowledgement: context => createFabricReceiverAcknowledgement({
        event: context.event, receiverNode: "kratt-node",
        policyRevision: context.authorization.policy_revision, deliveryAttempt: context.deliveryAttempt,
        result: context.ackResult,
        resolveSigningIdentity: async nodeId => nodeId === "kratt-node" ? receiverSigningIdentity : null,
        sign: async ({ message }) => sign(null, Buffer.from(message, "utf8"), receiverKeys.privateKey),
        now: () => NOW
      }),
      resolveTrustedKey: async (sourceNode, keyId) => sourceNode === trustedKey.source_node && keyId === trustedKey.key_id ? trustedKey : null,
      resolveNodePolicy: async () => policy,
      now: () => NOW,
      handler: handler ?? (async (canonical, tx) => {
        await tx.client.query("INSERT INTO handler_receipts(event_id,event_type) VALUES($1,$2)", [canonical.identity.event_id, canonical.identity.event_type]);
        return "stored";
      }),
      ...overrides
    });

    const first = makeEvent({ id: "fabric-db-1", sequence: 1 });
    const accepted = await receiveSteelFabricEventV1(poolA, JSON.stringify(first), deps());
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.value.duplicate, false);
    assert.equal(accepted.value.outcome, "ACCEPTED");
    assert.equal(accepted.value.acknowledgement.delivery_attempt, 1);

    const duplicate = await receiveSteelFabricEventV1(poolB, JSON.stringify(first), deps());
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
    assert.equal(duplicate.value.duplicate, true);
    assert.deepEqual(duplicate.value.acknowledgement, accepted.value.acknowledgement);
    assert.equal(duplicate.value.result, "stored");

    const secondAttempt = await receiveSteelFabricEventV1(poolB, JSON.stringify(first), deps(undefined, 2));
    assert.equal(secondAttempt.ok, true, JSON.stringify(secondAttempt));
    assert.equal(secondAttempt.value.duplicate, true);
    assert.equal(secondAttempt.value.acknowledgement.delivery_attempt, 2);
    assert.equal(secondAttempt.value.acknowledgement.result, "DUPLICATE");
    assert.notEqual(secondAttempt.value.acknowledgement.ack_id, accepted.value.acknowledgement.ack_id);
    const replayedSecondAttempt = await receiveSteelFabricEventV1(poolA, JSON.stringify(first), deps(undefined, 2));
    assert.deepEqual(replayedSecondAttempt.value.acknowledgement, secondAttempt.value.acknowledgement);
    const verifiedAck = await authenticateFabricReceiverAcknowledgement(replayedSecondAttempt.value.acknowledgement, {
      expectedReceiverNode: "kratt-node", expectedPolicyRevision: "wave3-test-policy",
      resolveTrustedKey: async (nodeId, keyId) => nodeId === "kratt-node" && keyId === receiverSigningIdentity.key_id ? receiverSigningIdentity : null,
      now: () => NOW
    });
    assert.equal(verifiedAck.ok, true, JSON.stringify(verifiedAck));
    const wrongReceiverKey = generateKeyPairSync("ed25519");
    const corruptedStoredAck = await receiveSteelFabricEventV1(poolB, JSON.stringify(first), deps(undefined, 1, {
      resolveReceiverSigningIdentity: async () => ({ ...receiverSigningIdentity, public_key: wrongReceiverKey.publicKey })
    }));
    assert.equal(corruptedStoredAck.ok, false);
    assert.equal(corruptedStoredAck.code, "RECEIVER_ACK_INVALID");
    const verifiedAfterSignerRecovery = await receiveSteelFabricEventV1(poolB, JSON.stringify(first), deps());
    assert.deepEqual(verifiedAfterSignerRecovery.value.acknowledgement, accepted.value.acknowledgement);
    const replayAfterExpiry = await receiveSteelFabricEventV1(poolB, JSON.stringify(first), {
      ...deps(undefined, 2), now: () => Date.parse(first.expires_at) + 1
    });
    assert.equal(replayAfterExpiry.ok, true, JSON.stringify(replayAfterExpiry));
    assert.deepEqual(replayAfterExpiry.value.acknowledgement, replayedSecondAttempt.value.acknowledgement);
    const forgedAck = { ...accepted.value.acknowledgement, ack_id: "ack:forged", delivery_attempt: 99, receiver_node: "attacker-node", content_digest: "" };
    forgedAck.content_digest = fabricReceiverAcknowledgementDigest(forgedAck);
    await assert.rejects(poolA.query(
      "INSERT INTO kratt_fabric_inbound_acknowledgements(event_id,delivery_attempt,ack_id,content_digest,ack_json,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [first.event_id, forgedAck.delivery_attempt, forgedAck.ack_id, forgedAck.content_digest, JSON.stringify(forgedAck), new Date(NOW).toISOString()]
    ), /KRATT_FABRIC_INBOUND_ACK_IDENTITY_MISMATCH/);
    const conflictingReplay = { ...first, payload: { task_id: "changed-task", status: "accepted" }, content_digest: "0".repeat(64), signature: "" };
    conflictingReplay.content_digest = fabricEventContentDigest(conflictingReplay);
    conflictingReplay.signature = sign(null, Buffer.from(fabricSigningInput(conflictingReplay), "utf8"), privateKey).toString("base64");
    const conflictResult = await receiveSteelFabricEventV1(poolB, JSON.stringify(conflictingReplay), deps());
    assert.equal(conflictResult.ok, false);
    assert.equal(conflictResult.code, "EVENT_REPLAY_OR_CONFLICT");

    const parent = makeEvent({ id: "fabric-db-parent", sequence: 2 });
    const parentResult = await receiveSteelFabricEventV1(poolB, JSON.stringify(parent), deps());
    assert.equal(parentResult.ok, true, JSON.stringify(parentResult));
    const child = makeEvent({ id: "fabric-db-child", sequence: 3, parent: parent.event_id });
    const childResult = await receiveSteelFabricEventV1(poolA, JSON.stringify(child), deps());
    assert.equal(childResult.ok, true, JSON.stringify(childResult));

    const stale = makeEvent({ id: "fabric-db-stale", sequence: 2 });
    const staleResult = await receiveSteelFabricEventV1(poolA, JSON.stringify(stale), deps());
    assert.equal(staleResult.ok, false);
    assert.equal(staleResult.code, "EVENT_REPLAY_OR_CONFLICT");

    const missingParent = makeEvent({ id: "fabric-db-orphan", sequence: 4, parent: "fabric-db-not-present" });
    const orphanResult = await receiveSteelFabricEventV1(poolA, JSON.stringify(missingParent), deps());
    assert.equal(orphanResult.code, "CAUSAL_PARENT_MISSING");

    const gap = makeEvent({ id: "fabric-db-gap", sequence: 5, parent: child.event_id });
    const gapResult = await receiveSteelFabricEventV1(poolB, JSON.stringify(gap), deps());
    assert.equal(gapResult.ok, true, JSON.stringify(gapResult));
    assert.equal(gapResult.value.sequence_gap, true);

    const concurrent = makeEvent({ id: "fabric-db-race", sequence: 6, parent: gap.event_id });
    const race = await Promise.all([
      receiveSteelFabricEventV1(poolA, JSON.stringify(concurrent), deps()),
      receiveSteelFabricEventV1(poolB, JSON.stringify(concurrent), deps())
    ]);
    assert.ok(race.every(result => result.ok), JSON.stringify(race));
    assert.equal(race.filter(result => result.value.duplicate === false).length, 1, JSON.stringify(race));
    assert.equal(race.filter(result => result.value.duplicate === true).length, 1, JSON.stringify(race));
    assert.deepEqual(race[0].value.acknowledgement, race[1].value.acknowledgement);

    const retryAfterHandlerFault = makeEvent({ id: "fabric-db-retry", sequence: 7, parent: concurrent.event_id });
    const failed = await receiveSteelFabricEventV1(poolA, JSON.stringify(retryAfterHandlerFault), deps(async () => { throw new Error("simulated handler fault"); }));
    assert.equal(failed.code, "EVENT_HANDLER_FAILED");
    const retried = await receiveSteelFabricEventV1(poolB, JSON.stringify(retryAfterHandlerFault), deps());
    assert.equal(retried.ok, true, JSON.stringify(retried));
    const ackFailureEvent = makeEvent({ id: "fabric-db-ack-retry", sequence: 8, parent: retryAfterHandlerFault.event_id });
    const failedAck = await receiveSteelFabricEventV1(poolA, JSON.stringify(ackFailureEvent), {
      ...deps(), createAcknowledgement: async () => ({ ok: false, code: "ACK_SIGNING_FAILED" })
    });
    assert.equal(failedAck.ok, false);
    assert.equal(failedAck.code, "RECEIVER_ACK_CREATION_FAILED");
    const rolledBack = await poolA.query("SELECT count(*)::int AS count FROM kratt_fabric_event_inbox WHERE event_id=$1", [ackFailureEvent.event_id]);
    assert.equal(rolledBack.rows[0].count, 0);
    const ackRetried = await receiveSteelFabricEventV1(poolB, JSON.stringify(ackFailureEvent), deps());
    assert.equal(ackRetried.ok, true, JSON.stringify(ackRetried));
    const serializationEvent = makeEvent({ id: "fabric-db-result-serialization", sequence: 9, parent: ackFailureEvent.event_id });
    let resultGetterCalls = 0;
    const unserializable = await receiveSteelFabricEventV1(poolA, JSON.stringify(serializationEvent), deps(async (canonical, tx) => {
      await tx.client.query("INSERT INTO handler_receipts(event_id,event_type) VALUES($1,$2)", [canonical.identity.event_id, canonical.identity.event_type]);
      const result = {};
      Object.defineProperty(result, "secret", { enumerable: true, get() { resultGetterCalls++; return "not-safe"; } });
      return result;
    }));
    assert.equal(unserializable.ok, false);
    assert.equal(unserializable.code, "EVENT_RESULT_NOT_SERIALIZABLE");
    assert.equal(resultGetterCalls, 0);
    const serializationRollback = await poolA.query("SELECT count(*)::int AS inbox_count FROM kratt_fabric_event_inbox WHERE event_id=$1", [serializationEvent.event_id]);
    const handlerRollback = await poolA.query("SELECT count(*)::int AS handler_count FROM handler_receipts WHERE event_id=$1", [serializationEvent.event_id]);
    assert.equal(serializationRollback.rows[0].inbox_count, 0);
    assert.equal(handlerRollback.rows[0].handler_count, 0);
    const serializationRetry = await receiveSteelFabricEventV1(poolB, JSON.stringify(serializationEvent), deps());
    assert.equal(serializationRetry.ok, true, JSON.stringify(serializationRetry));

    const policyRaceEvent = makeEvent({ id: "fabric-db-policy-revision-race", sequence: 10 });
    let policyRaceHandlerCalls = 0;
    const policyRace = await receiveSteelFabricEventV1(poolA, JSON.stringify(policyRaceEvent), deps(async () => { policyRaceHandlerCalls++; return "must-not-run"; }, 1, {
      revalidateAuthorization: async () => ({ ...policy, revision: "wave3-policy-revoked-during-ingress" })
    }));
    assert.equal(policyRace.ok, false);
    assert.equal(policyRace.code, "AUTHORIZATION_REVISION_CHANGED");
    assert.equal(policyRaceHandlerCalls, 0);
    const policyRaceNotStored = await poolA.query("SELECT count(*)::int AS count FROM kratt_fabric_event_inbox WHERE event_id=$1", [policyRaceEvent.event_id]);
    assert.equal(policyRaceNotStored.rows[0].count, 0);

    const expiredUnprocessed = makeEvent({ id: "fabric-db-expired-new", sequence: 10, issuedAt: new Date(NOW - 120_000).toISOString() });
    const expiredResult = await receiveSteelFabricEventV1(poolA, JSON.stringify(expiredUnprocessed), { ...deps(), now: () => NOW });
    assert.equal(expiredResult.ok, false);
    assert.equal(expiredResult.code, "EVENT_EXPIRED");
    const expiredNotStored = await poolA.query("SELECT count(*)::int AS count FROM kratt_fabric_event_inbox WHERE event_id=$1", [expiredUnprocessed.event_id]);
    assert.equal(expiredNotStored.rows[0].count, 0);
    // Cancellation owns the shared task lock first: ingress waits, then observes cancellation and never runs the handler.
    const cancellationWins = makeEvent({ id: "fabric-db-cancel-wins", sequence: 10 });
    const cancelFirstClient = await poolA.connect();
    await cancelFirstClient.query("BEGIN");
    await cancelFirstClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [cancellationWins.payload.task_id]);
    await cancelFirstClient.query("INSERT INTO kratt_cancelled_tasks(task_id,cancelled_at,actor_id) VALUES($1,$2,$3)", [cancellationWins.payload.task_id,new Date(NOW).toISOString(),"operator-cancel-first"]);
    const cancelWinsPending = receiveSteelFabricEventV1(poolB, JSON.stringify(cancellationWins), deps());
    await waitForAdvisoryLockWait();
    await cancelFirstClient.query("COMMIT");
    cancelFirstClient.release();
    const cancelWinsResult = await cancelWinsPending;
    assert.equal(cancelWinsResult.ok, false);
    assert.equal(cancelWinsResult.code, "TASK_CANCELLED");
    const cancelWinsStored = await poolA.query("SELECT count(*)::int AS count FROM kratt_fabric_event_inbox WHERE event_id=$1", [cancellationWins.event_id]);
    assert.equal(cancelWinsStored.rows[0].count, 0);

    // Ingress owns the task lock first: cancellation is serialized behind its handler/receipt/ACK commit.
    const ingressWins = makeEvent({ id: "fabric-db-ingress-wins", sequence: 10 });
    let releaseHandler;
    let handlerEnteredResolve;
    const handlerEntered = new Promise(resolve => { handlerEnteredResolve = resolve; });
    const handlerGate = new Promise(resolve => { releaseHandler = resolve; });
    const ingressPending = receiveSteelFabricEventV1(poolA, JSON.stringify(ingressWins), deps(async (canonical, tx) => {
      await tx.client.query("INSERT INTO handler_receipts(event_id,event_type) VALUES($1,$2)", [canonical.identity.event_id,canonical.identity.event_type]);
      handlerEnteredResolve();
      await handlerGate;
      return "accepted-before-cancellation";
    }));
    await handlerEntered;
    const cancelAfterClient = await poolB.connect();
    await cancelAfterClient.query("BEGIN");
    const cancelAfterPending = cancelAfterClient.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ingressWins.payload.task_id]);
    await waitForAdvisoryLockWait();
    releaseHandler();
    const ingressWinsResult = await ingressPending;
    assert.equal(ingressWinsResult.ok, true, JSON.stringify(ingressWinsResult));
    await cancelAfterPending;
    await cancelAfterClient.query("INSERT INTO kratt_cancelled_tasks(task_id,cancelled_at,actor_id) VALUES($1,$2,$3)", [ingressWins.payload.task_id,new Date(NOW).toISOString(),"operator-cancel-after"]);
    await cancelAfterClient.query("COMMIT");
    cancelAfterClient.release();
    const replayAfterCancel = await receiveSteelFabricEventV1(poolB, JSON.stringify(ingressWins), deps());
    assert.equal(replayAfterCancel.ok, true, JSON.stringify(replayAfterCancel));
    assert.equal(replayAfterCancel.value.duplicate, true);
    assert.deepEqual(replayAfterCancel.value.acknowledgement, ingressWinsResult.value.acknowledgement);

    const longTaskId = "task-" + "x".repeat(170);
    const longTaskEvent = makeEvent({ id: "fabric-db-long-task-id", sequence: 11, taskId: longTaskId });
    const longTaskResult = await receiveSteelFabricEventV1(poolA, JSON.stringify(longTaskEvent), deps());
    assert.equal(longTaskResult.ok, true, JSON.stringify(longTaskResult));
    assert.equal(longTaskResult.value.duplicate, false);

    // A fresh connection pool has no in-memory receiver state; the database alone restores the ACK and result.
    poolRestart = new Pool({ connectionString, max: 2, options: "-c search_path=" + schema });
    const beforeRestartReplay = await poolRestart.query("SELECT count(*)::int AS count FROM handler_receipts");
    const restartReplay = await receiveSteelFabricEventV1(poolRestart, JSON.stringify(first), deps());
    assert.equal(restartReplay.ok, true, JSON.stringify(restartReplay));
    assert.equal(restartReplay.value.duplicate, true);
    assert.deepEqual(restartReplay.value.acknowledgement, accepted.value.acknowledgement);
    const afterRestartReplay = await poolRestart.query("SELECT count(*)::int AS count FROM handler_receipts");
    assert.equal(afterRestartReplay.rows[0].count, beforeRestartReplay.rows[0].count);

    const counts = await poolA.query("SELECT (SELECT count(*)::int FROM kratt_fabric_event_inbox) AS inbox_count, (SELECT count(*)::int FROM handler_receipts) AS handler_count, (SELECT count(*)::int FROM kratt_fabric_receiver_receipts) AS receipt_count, (SELECT count(*)::int FROM kratt_fabric_inbound_acknowledgements) AS ack_count");
    assert.equal(counts.rows[0].inbox_count, 10);
    assert.equal(counts.rows[0].handler_count, 10);
    assert.equal(counts.rows[0].receipt_count, 10);
    assert.equal(counts.rows[0].ack_count, 11);
    await assert.rejects(poolA.query("UPDATE kratt_fabric_receiver_receipts SET processed_at=processed_at WHERE event_id=$1", [first.event_id]), /KRATT_FABRIC_RECEIVER_RECEIPT_APPEND_ONLY/);
    await assert.rejects(poolA.query("TRUNCATE TABLE kratt_fabric_inbound_acknowledgements"), /KRATT_FABRIC_LEDGER_TRUNCATE_FORBIDDEN/);
    await assert.rejects(poolA.query("UPDATE kratt_fabric_inbound_acknowledgements SET created_at=created_at WHERE event_id=$1", [first.event_id]), /KRATT_FABRIC_INBOUND_ACK_APPEND_ONLY/);
    await assert.rejects(poolA.query("UPDATE kratt_fabric_event_inbox SET destination_node=$2 WHERE event_id=$1", [first.event_id, "elsewhere"]), /KRATT_FABRIC_EVENT_INBOX_APPEND_ONLY/);
    await assert.rejects(poolA.query("DELETE FROM kratt_fabric_event_inbox WHERE event_id=$1", [first.event_id]), /KRATT_FABRIC_EVENT_INBOX_APPEND_ONLY/);
    await assert.rejects(poolA.query("UPDATE kratt_fabric_source_heads SET last_sequence=1 WHERE source_node=$1", [trustedKey.source_node]), /KRATT_FABRIC_SOURCE_HEAD_TRANSITION_INVALID/);
  } finally {
    await poolA?.end();
    await poolB?.end();
    await poolRestart?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
