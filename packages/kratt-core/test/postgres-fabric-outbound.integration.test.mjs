import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPostgresOutboxStore } from "../src/postgres-outbox-store.mjs";
import { canonicalTaskDigest } from "../src/policy.mjs";
import { createSteelFabricOutboundAdapter } from "../src/fabric-outbound-adapter.mjs";
import { authenticateSteelFabricEventV1 } from "../src/fabric-interoperability.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "../migrations");

test("PostgreSQL outbound Fabric reservations are idempotent and commit signed events with authorized outbox intent", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const schema = `kratt_wave3_outbound_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 2 });
  let poolA;
  let poolB;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    poolA = new Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
    poolB = new Pool({ connectionString, max: 5, options: `-c search_path=${schema}` });
    const baseMigration = await readFile(join(migrationDir, "0001_postgres_outbox.sql"), "utf8");
    const outboundMigration = await readFile(join(migrationDir, "0004_fabric_outbound.sql"), "utf8");
    await poolA.query(baseMigration);
    await poolA.query(outboundMigration);
    await poolA.query(outboundMigration);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const identity = {
      source_node: "kratt-node", key_id: "kratt-fabric-key-01",
      status: "ACTIVE", public_key: publicKey
    };
    const task = {
      schema_version: "kratt-prime/v0.1",
      task_id: "task-fabric-pg-01",
      actor: "operator-01",
      action: "repository.write",
      target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
      constraints: { provider: "fabric", branch: "feature/wave3" },
      required_evidence: [],
      created_at: "2026-11-26T11:55:00.000Z",
      requested_authority: ["fabric.publish"],
      status: "PENDING"
    };
    const taskDigest = canonicalTaskDigest(task);
    const idempotencyKey = `kratt:${task.task_id}:${taskDigest.slice(7)}`;
    const approval = {
      approval_id: "approval-fabric-pg-01", task_id: task.task_id, actor: task.actor,
      provider: "fabric", operation: task.action, target: task.target, request_digest: taskDigest,
      key_id: "approval-key-01", nonce: "approval-nonce-pg-01",
      issued_at: "2026-11-26T11:59:00.000Z", expires_at: "2026-11-26T12:04:00.000Z",
      decision: "APPROVE", authority: "fabric.publish", signature: "test-signed-approval"
    };
    const policy = {
      status: "ACTIVE", source_node: "kratt-node", destination_node: "steel-node",
      revision: "pg-policy-1", approval_provider: "fabric", approval_authority: "fabric.publish",
      allowed_event_types: ["factory.task.requested"],
      scope_by_event_type: { "factory.task.requested": ["repository.read", "evidence.read"] },
      max_ttl_ms: 300_000, key_id: identity.key_id
    };
    const makeAdapter = pool => {
      const store = createPostgresOutboxStore(pool, { clock: () => new Date("2026-11-26T12:00:00.000Z") });
      return createSteelFabricOutboundAdapter({
        outboxStore: store,
        sourceNode: "kratt-node",
        resolveSourceRevision: async () => "b".repeat(40),
        resolveOutboundPolicy: async () => policy,
        resolveSigningIdentity: async () => identity,
        sign: async ({ message }) => sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64"),
        verifyApproval: async (artifact, binding) => artifact.signature === approval.signature &&
          binding.request_digest === taskDigest && binding.authority === "fabric.publish",
        resolvePayload: async () => ({ task_id: task.task_id, action: task.action, state: "queued" }),
        resolveEvidenceReferences: async () => ["evidence:verified-001"],
        resolveCorrelationId: async () => "corr-fabric-pg-001",
        now: () => Date.parse("2026-11-26T12:00:00.000Z")
      });
    };
    const adapterA = makeAdapter(poolA);
    const adapterB = makeAdapter(poolB);
    const [parallelA, parallelB] = await Promise.all([
      adapterA.publish({ task, principal: { id: task.actor }, approval, idempotencyKey, eventType: "factory.task.requested" }),
      adapterB.publish({ task, principal: { id: task.actor }, approval, idempotencyKey, eventType: "factory.task.requested" })
    ]);
    assert.equal(parallelA.ok, true, JSON.stringify(parallelA));
    assert.equal(parallelB.ok, true, JSON.stringify(parallelB));
    assert.equal([parallelA.value, parallelB.value].filter(value => value.duplicate === false).length, 1);
    assert.equal([parallelA.value, parallelB.value].filter(value => value.duplicate === true).length, 1);
    const event = parallelA.value.event;
    assert.equal(event.sequence, 1);
    assert.equal(event.destination_node, "steel-node");
    assert.deepEqual(event.scope, ["repository.read", "evidence.read"]);
    assert.equal((await authenticateSteelFabricEventV1(event, {
      resolveTrustedKey: async () => ({ ...identity, status: "ACTIVE" }),
      now: () => Date.parse("2026-11-26T12:00:00.000Z")
    })).ok, true);

    const counts = await poolA.query(`SELECT
      (SELECT count(*)::int FROM kratt_dispatch_intents) AS intent_count,
      (SELECT count(*)::int FROM kratt_dispatch_outbox) AS outbox_count,
      (SELECT count(*)::int FROM kratt_fabric_outbound_events) AS fabric_count,
      (SELECT status FROM kratt_dispatch_outbox WHERE idempotency_key=$1) AS outbox_status,
      (SELECT attempts FROM kratt_dispatch_outbox WHERE idempotency_key=$1) AS attempts`, [idempotencyKey]);
    assert.equal(counts.rows[0].intent_count, 1);
    assert.equal(counts.rows[0].outbox_count, 1);
    assert.equal(counts.rows[0].fabric_count, 1);
    assert.equal(counts.rows[0].outbox_status, "PENDING");
    assert.equal(counts.rows[0].attempts, 0, "no worker claimed or dispatched the message");

    const storeA = createPostgresOutboxStore(poolA);
    const storeB = createPostgresOutboxStore(poolB);
    const requestDigest = "c".repeat(64);
    const [reservationA, reservationB] = await Promise.all([
      storeA.reserveFabricSequence({ sourceNode: "kratt-node", idempotencyKey: `kratt:${task.task_id}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, requestDigest }),
      storeB.reserveFabricSequence({ sourceNode: "kratt-node", idempotencyKey: `kratt:${task.task_id}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, requestDigest })
    ]);
    assert.equal(reservationA.ok, true, JSON.stringify(reservationA));
    assert.equal(reservationB.ok, true, JSON.stringify(reservationB));
    assert.equal(reservationA.sequence, 2);
    assert.equal(reservationB.sequence, 2);
    const conflicting = await storeA.reserveFabricSequence({
      sourceNode: "kratt-node",
      idempotencyKey: `kratt:${task.task_id}:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`,
      requestDigest: "d".repeat(64)
    });
    assert.equal(conflicting.ok, false);
    assert.equal(conflicting.reason, "FABRIC_SEQUENCE_REQUEST_CONFLICT");

    await assert.rejects(
      poolA.query("UPDATE kratt_fabric_outbound_events SET destination_node='other' WHERE event_id=$1", [event.event_id]),
      /KRATT_FABRIC_OUTBOUND_EVENTS_APPEND_ONLY/
    );
    await assert.rejects(
      poolA.query("UPDATE kratt_fabric_outbound_sequences SET request_digest=$1 WHERE idempotency_key=$2", ["e".repeat(64), idempotencyKey]),
      /KRATT_FABRIC_OUTBOUND_EVENTS_APPEND_ONLY/
    );
    await assert.rejects(
      poolA.query("UPDATE kratt_fabric_outbound_heads SET last_sequence=0 WHERE source_node='kratt-node'"),
      /KRATT_FABRIC_OUTBOUND_HEAD_TRANSITION_INVALID/
    );
  } finally {
    await poolA?.end();
    await poolB?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
