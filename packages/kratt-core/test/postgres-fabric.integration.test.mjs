import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fabricEventContentDigest, fabricSigningInput, receiveSteelFabricEventV1 } from "../src/fabric-interoperability.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, "../migrations/0003_fabric_interoperability.sql");

test("PostgreSQL Fabric inbox enforces atomic idempotency, monotonic source sequence and causal parents", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const schema = `kratt_wave3_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString, max: 2 });
  let poolA;
  let poolB;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    poolA = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
    poolB = new Pool({ connectionString, max: 4, options: `-c search_path=${schema}` });
    const migration = await readFile(migrationPath, "utf8");
    await poolA.query(migration);
    await poolA.query(migration);
    await poolA.query("CREATE TABLE handler_receipts(event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL)");

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const trustedKey = {
      source_node: "steel-node", key_id: "steel-key-wave3", public_key: publicKey,
      status: "ACTIVE", valid_from: "2026-01-01T00:00:00.000Z"
    };
    const policy = {
      source_node: trustedKey.source_node, key_id: trustedKey.key_id, status: "ACTIVE",
      destinations: ["kratt-node"], allowed_event_types: ["factory.task.accepted"],
      allowed_scope: ["repository.read", "evidence.read"], revision: "wave3-test-policy"
    };
    const makeEvent = ({ id, sequence, parent = null, scope = ["repository.read"], issuedAt = new Date(Date.now() - 1_000).toISOString() }) => {
      const event = {
        protocol: "3XT-FABRIC/1", event_id: id, event_type: "factory.task.accepted",
        source_node: trustedKey.source_node, destination_node: "kratt-node", source_revision: "a".repeat(40),
        correlation_id: "wave3-correlation", parent_event_id: parent, sequence,
        issued_at: issuedAt, expires_at: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
        scope, payload_reference: null, evidence_references: [], key_id: trustedKey.key_id,
        payload: { task_id: `task-${id}`, status: "accepted" }, content_digest: "0".repeat(64), signature: ""
      };
      event.content_digest = fabricEventContentDigest(event);
      event.signature = sign(null, Buffer.from(fabricSigningInput(event), "utf8"), privateKey).toString("base64");
      return event;
    };
    const deps = handler => ({
      localNodeId: "kratt-node",
      resolveTrustedKey: async (sourceNode, keyId) => sourceNode === trustedKey.source_node && keyId === trustedKey.key_id ? trustedKey : null,
      resolveNodePolicy: async () => policy,
      now: () => Date.now(),
      handler: handler ?? (async (canonical, tx) => {
        await tx.client.query("INSERT INTO handler_receipts(event_id,event_type) VALUES($1,$2)", [canonical.identity.event_id, canonical.identity.event_type]);
        return "stored";
      })
    });

    const first = makeEvent({ id: "fabric-db-1", sequence: 1 });
    const accepted = await receiveSteelFabricEventV1(poolA, JSON.stringify(first), deps());
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.value.duplicate, false);

    const duplicate = await receiveSteelFabricEventV1(poolB, JSON.stringify(first), deps());
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
    assert.equal(duplicate.value.duplicate, true);

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

    const retryAfterHandlerFault = makeEvent({ id: "fabric-db-retry", sequence: 7, parent: concurrent.event_id });
    const failed = await receiveSteelFabricEventV1(poolA, JSON.stringify(retryAfterHandlerFault), deps(async () => { throw new Error("simulated handler fault"); }));
    assert.equal(failed.code, "EVENT_HANDLER_FAILED");
    const retried = await receiveSteelFabricEventV1(poolB, JSON.stringify(retryAfterHandlerFault), deps());
    assert.equal(retried.ok, true, JSON.stringify(retried));

    const counts = await poolA.query("SELECT (SELECT count(*)::int FROM kratt_fabric_event_inbox) AS inbox_count, (SELECT count(*)::int FROM handler_receipts) AS handler_count");
    assert.equal(counts.rows[0].inbox_count, 6);
    assert.equal(counts.rows[0].handler_count, 6);
    await assert.rejects(poolA.query("UPDATE kratt_fabric_event_inbox SET destination_node='elsewhere' WHERE event_id=$1", [first.event_id]), /KRATT_FABRIC_EVENT_INBOX_APPEND_ONLY/);
    await assert.rejects(poolA.query("DELETE FROM kratt_fabric_event_inbox WHERE event_id=$1", [first.event_id]), /KRATT_FABRIC_EVENT_INBOX_APPEND_ONLY/);
    await assert.rejects(poolA.query("UPDATE kratt_fabric_source_heads SET last_sequence=1 WHERE source_node=$1", [trustedKey.source_node]), /KRATT_FABRIC_SOURCE_HEAD_TRANSITION_INVALID/);
  } finally {
    await poolA?.end();
    await poolB?.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
});
