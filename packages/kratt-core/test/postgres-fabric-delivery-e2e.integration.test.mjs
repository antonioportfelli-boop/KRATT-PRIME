import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTaskDigest } from "../src/policy.mjs";
import { createPostgresOutboxStore } from "../src/postgres-outbox-store.mjs";
import { createPostgresFabricTrustRegistry } from "../src/postgres-fabric-trust-registry.mjs";
import { createSteelFabricOutboundAdapter } from "../src/fabric-outbound-adapter.mjs";
import { createPostgresFabricAcknowledgementStore } from "../src/postgres-fabric-ack-store.mjs";
import { createFabricReceiverAcknowledgement, processFabricReceiverAcknowledgement } from "../src/fabric-negotiation-ack.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "../migrations");
const NOW = Date.parse("2026-11-26T12:00:00.000Z");

test("PostgreSQL 16 completes an authorized Fabric outbound intent through fenced delivery and authenticated receiver ACK", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const schema = "kratt_wave3_fabric_e2e_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString, max: 2 });
  let pool;
  try {
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({ connectionString, max: 8, options: "-c search_path=" + schema });
    for (const name of [
      "0001_postgres_outbox.sql",
      "0004_fabric_outbound.sql",
      "0005_fabric_trust_registry.sql",
      "0006_outbox_delivery_reliability.sql",
      "0007_fabric_receiver_acknowledgements.sql",
      "0009_fabric_ack_outbox_reconciliation.sql"
    ]) {
      const sql = await readFile(join(migrationDir, name), "utf8");
      await pool.query(sql);
    }

    const sourceKeys = generateKeyPairSync("ed25519");
    const receiverKeys = generateKeyPairSync("ed25519");
    const trust = createPostgresFabricTrustRegistry(pool, {
      clock: () => new Date(NOW),
      localNodeId: "kratt-node",
      authorizeAdmin: async ({ actorId }) => actorId === "operator-01"
    });
    for (const node of [
      { nodeId: "kratt-node", repositoryFullName: "antonioportfelli-boop/KRATT-PRIME", revision: "b".repeat(40) },
      { nodeId: "steel-node", repositoryFullName: "3XTRINITY/KRATT-PRIME", revision: "a".repeat(40) }
    ]) {
      assert.equal((await trust.registerNode({
        nodeId: node.nodeId, repositoryFullName: node.repositoryFullName,
        repositoryRevision: node.revision, actorId: "operator-01"
      })).ok, true);
    }

    const trustedKeys = [
      {
        nodeId: "kratt-node", keyId: "kratt-source-key-01",
        publicKeyPem: sourceKeys.publicKey.export({ type: "spki", format: "pem" })
      },
      {
        nodeId: "steel-node", keyId: "steel-ack-key-01",
        publicKeyPem: receiverKeys.publicKey.export({ type: "spki", format: "pem" })
      }
    ];
    for (const key of trustedKeys) {
      assert.equal((await trust.registerKey({
        nodeId: key.nodeId, keyId: key.keyId, publicKeyPem: key.publicKeyPem,
        validFrom: "2026-01-01T00:00:00.000Z",
        signUntil: "2027-01-01T00:00:00.000Z",
        actorId: "operator-01"
      })).ok, true);
      assert.equal((await trust.transitionKey({
        nodeId: key.nodeId, keyId: key.keyId, nextStatus: "ACTIVE",
        actorId: "operator-01", reason: "activate isolated end-to-end test key"
      })).ok, true);
    }
    assert.equal((await trust.upsertPolicy({
      nodeId: "kratt-node",
      destinationNode: "steel-node",
      eventType: "factory.task.requested",
      allowedScope: ["repository.read", "evidence.read"],
      maxTtlMs: 300_000,
      approvalProvider: "fabric",
      approvalAuthority: "fabric.publish",
      keyId: "kratt-source-key-01",
      actorId: "operator-01"
    })).ok, true);

    const task = {
      schema_version: "kratt-prime/v0.1",
      task_id: "task-fabric-e2e-01",
      actor: "operator-01",
      action: "repository.write",
      target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
      constraints: { provider: "fabric", branch: "feature/wp-03-9" },
      required_evidence: [],
      created_at: "2026-11-26T11:55:00.000Z",
      requested_authority: ["fabric.publish"],
      status: "PENDING"
    };
    const taskDigest = canonicalTaskDigest(task);
    const idempotencyKey = "kratt:" + task.task_id + ":" + taskDigest.slice(7);
    const approval = {
      schema_version: "kratt-prime/v0.1",
      approval_id: "approval-fabric-e2e-01",
      task_id: task.task_id,
      actor: task.actor,
      provider: "fabric",
      operation: task.action,
      target: task.target,
      request_digest: taskDigest,
      key_id: "approval-key-e2e-01",
      nonce: "approval-nonce-e2e-01",
      issued_at: "2026-11-26T11:59:00.000Z",
      expires_at: "2026-11-26T12:04:00.000Z",
      decision: "APPROVE",
      approved_by: "approver-01",
      authority: "fabric.publish",
      signature: "test-approval-verified-by-injected-governance"
    };

    const outbox = createPostgresOutboxStore(pool, { clock: () => new Date(NOW) });
    const outbound = createSteelFabricOutboundAdapter({
      outboxStore: outbox,
      sourceNode: "kratt-node",
      resolveSourceRevision: () => trust.resolveSourceRevision(),
      resolveOutboundPolicy: input => trust.resolveOutboundPolicy(input),
      resolveSigningIdentity: () => trust.resolveActiveSigningIdentity({ keyId: "kratt-source-key-01" }),
      sign: async ({ message }) => sign(null, Buffer.from(message, "utf8"), sourceKeys.privateKey).toString("base64"),
      verifyApproval: async (candidate, binding) =>
        candidate.signature === approval.signature &&
        candidate.request_digest === taskDigest &&
        binding.request_digest === taskDigest &&
        binding.provider === "fabric" &&
        binding.authority === "fabric.publish",
      resolvePayload: async () => ({ task_id: task.task_id, operation: task.action }),
      resolveEvidenceReferences: async () => ["evidence:approval-e2e-01"],
      resolveCorrelationId: async () => "corr-fabric-e2e-01",
      now: () => NOW
    });

    const published = await outbound.publish({
      task, principal: { id: task.actor }, approval, idempotencyKey,
      eventType: "factory.task.requested"
    });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(published.value.queued, true);
    assert.equal(published.value.duplicate, false);
    assert.equal(published.value.policy_revision, "p1");

    const persisted = await pool.query(
      "SELECT o.outbox_id,o.status,o.attempts,e.event_id,e.source_node,e.destination_node," +
      "e.source_sequence,e.content_digest,e.ack_policy_revision,e.event_json " +
      "FROM kratt_dispatch_outbox o JOIN kratt_fabric_outbound_events e USING(idempotency_key) " +
      "WHERE o.idempotency_key=$1",
      [idempotencyKey]
    );
    assert.equal(persisted.rowCount, 1);
    const record = persisted.rows[0];
    assert.equal(record.status, "PENDING");
    assert.equal(record.attempts, 0);
    assert.equal(record.ack_policy_revision, "p1");
    assert.equal(record.event_json.event_id, published.value.event.event_id);

    const claimed = (await outbox.claimOutbox({
      workerId: "worker-fabric-e2e", limit: 5, leaseSeconds: 60
    })).find(item => item.outbox_id === record.outbox_id);
    assert.ok(claimed, "the committed outbound intent should be claimable");
    const deliveryStarted = await outbox.beginOutboxDelivery({
      outboxId: record.outbox_id, leaseToken: claimed.lease_token, workerId: "worker-fabric-e2e"
    });
    assert.equal(deliveryStarted.ok, true, JSON.stringify(deliveryStarted));
    assert.equal(deliveryStarted.duplicate, false);

    const receiverIdentity = await trust.resolveTrustedKey("steel-node", "steel-ack-key-01");
    const acknowledgement = await createFabricReceiverAcknowledgement({
      event: record.event_json,
      receiverNode: "steel-node",
      policyRevision: record.ack_policy_revision,
      deliveryAttempt: Number(claimed.delivery_attempt_sequence),
      result: "ACCEPTED",
      resolveSigningIdentity: async () => receiverIdentity,
      sign: async ({ message }) => sign(null, Buffer.from(message, "utf8"), receiverKeys.privateKey),
      now: () => NOW
    });
    assert.equal(acknowledgement.ok, true, JSON.stringify(acknowledgement));

    const acknowledgementStore = createPostgresFabricAcknowledgementStore(pool, {
      clock: () => new Date(NOW),
      lockTrustedReceiverKey: (client, nodeId, keyId, ack, nowMs) =>
        trust.lockTrustedReceiverAcknowledgementIdentity(client, nodeId, keyId, ack, nowMs)
    });
    const applied = await processFabricReceiverAcknowledgement({
      acknowledgement: acknowledgement.value,
      expectedReceiverNode: "steel-node",
      acknowledgementStore,
      outboxId: record.outbox_id,
      leaseToken: claimed.lease_token
    });
    assert.equal(applied.ok, true, JSON.stringify(applied));
    assert.equal(applied.value.status, "ACCEPTED");
    assert.equal(applied.value.outbox_status, "DONE");

    const terminal = await pool.query(
      "SELECT i.status AS intent_status,o.status AS outbox_status," +
      "(SELECT count(*)::int FROM kratt_fabric_receiver_acknowledgements a WHERE a.outbox_id=o.outbox_id) AS ack_count " +
      "FROM kratt_dispatch_intents i JOIN kratt_dispatch_outbox o USING(idempotency_key) WHERE o.outbox_id=$1",
      [record.outbox_id]
    );
    assert.deepEqual(terminal.rows[0], {
      intent_status: "COMPLETED", outbox_status: "DONE", ack_count: 1
    });
    const audit = await pool.query(
      "SELECT count(*)::int AS count FROM kratt_audit_events WHERE event_type='fabric.receiver_ack.confirmed' AND record_json->>'outbox_id'=$1",
      [record.outbox_id]
    );
    assert.equal(audit.rows[0].count, 1);
  } finally {
    await pool?.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => undefined);
    await admin.end();
  }
});
