import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPostgresFabricTrustRegistry } from "../src/postgres-fabric-trust-registry.mjs";
import { receiveSteelFabricEventV1, fabricEventContentDigest, fabricSigningInput } from "../src/fabric-interoperability.mjs";
import { createFabricReceiverAcknowledgement } from "../src/fabric-negotiation-ack.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationDir = join(here, "../migrations");
const NOW = "2026-11-26T11:59:59.000Z";
const STEEL_COMMIT = "1978fa37d5df7bfa6cb2a3ba64480307492893d5";
const KRATT_COMMIT = "dabb19d26cc20b23f6a25f5360a2b474acc11447";

test("PostgreSQL trust registry governs pinned nodes, public-key lifecycle, exact policy and immutable audit", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const schema = "kratt_wave3_trust_" + randomUUID().replaceAll("-", "");
  const admin = new Pool({ connectionString, max: 2 });
  let pool;
  try {
    await admin.query("CREATE SCHEMA " + schema);
    pool = new Pool({ connectionString, max: 6, options: "-c search_path=" + schema });
    const inboxMigration = await readFile(join(migrationDir, "0003_fabric_interoperability.sql"), "utf8");
    const trustMigration = await readFile(join(migrationDir, "0005_fabric_trust_registry.sql"), "utf8");
    const receiptMigration = await readFile(join(migrationDir, "0008_fabric_receiver_receipts.sql"), "utf8");
    await pool.query(inboxMigration);
    await pool.query(trustMigration);
    await pool.query(trustMigration);
    await pool.query(receiptMigration);
    await pool.query("CREATE TABLE kratt_cancelled_tasks(task_id TEXT PRIMARY KEY, cancelled_at TIMESTAMPTZ NOT NULL, actor_id TEXT NOT NULL)");

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const receiverKeyPair = generateKeyPairSync("ed25519");
    const receiverPublicKeyPem = receiverKeyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const registry = createPostgresFabricTrustRegistry(pool, {
      clock: () => new Date(NOW), localNodeId: "kratt-node",
      authorizeAdmin: async ({ actorId }) => actorId === "security-admin"
    });
    assert.equal((await registry.registerNode({
      nodeId: "steel-node", repositoryFullName: "3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP-",
      repositoryRevision: STEEL_COMMIT, actorId: "security-admin"
    })).ok, true);
    assert.equal((await registry.registerNode({
      nodeId: "kratt-node", repositoryFullName: "antonioportfelli-boop/KRATT-PRIME",
      repositoryRevision: KRATT_COMMIT, actorId: "security-admin"
    })).ok, true);
    const receiverKeyPending = await registry.registerKey({
      nodeId: "kratt-node", keyId: "kratt-ack-key-01", publicKeyPem: receiverPublicKeyPem,
      validFrom: "2026-01-01T00:00:00.000Z", signUntil: "2027-01-01T00:00:00.000Z", actorId: "security-admin"
    });
    assert.equal(receiverKeyPending.ok, true, JSON.stringify(receiverKeyPending));
    const receiverKeyActivated = await registry.transitionKey({
      nodeId: "kratt-node", keyId: "kratt-ack-key-01", nextStatus: "ACTIVE",
      actorId: "security-admin", reason: "activate local receiver ACK verification key"
    });
    assert.equal(receiverKeyActivated.ok, true, JSON.stringify(receiverKeyActivated));

    assert.equal((await registry.registerKey({
      nodeId: "steel-node", keyId: "steel-key-01", publicKeyPem, actorId: "untrusted-user"
    })).code, "ADMIN_DENIED");
    const pending = await registry.registerKey({
      nodeId: "steel-node", keyId: "steel-key-01", publicKeyPem, validFrom: "2026-01-01T00:00:00.000Z",
      signUntil: "2027-01-01T00:00:00.000Z", actorId: "security-admin"
    });
    assert.equal(pending.ok, true, JSON.stringify(pending));
    assert.equal(pending.value.status, "PENDING");
    assert.equal((await registry.resolveTrustedKey("steel-node", "steel-key-01")).status, "PENDING");
    const activated = await registry.transitionKey({
      nodeId: "steel-node", keyId: "steel-key-01", nextStatus: "ACTIVE",
      actorId: "security-admin", reason: "initial verified public-key enrollment"
    });
    assert.equal(activated.ok, true, JSON.stringify(activated));
    assert.equal((await registry.resolveTrustedKey("steel-node", "steel-key-01")).status, "ACTIVE");

    const firstPolicy = await registry.upsertPolicy({
      nodeId: "steel-node", destinationNode: "kratt-node", eventType: "factory.task.accepted",
      allowedScope: ["repository.read", "evidence.read"], maxTtlMs: 60000,
      approvalProvider: "fabric", approvalAuthority: "fabric.receive", keyId: "steel-key-01",
      actorId: "security-admin"
    });
    assert.equal(firstPolicy.ok, true, JSON.stringify(firstPolicy));
    assert.equal(firstPolicy.value.policy_version, 1);
    await pool.query("CREATE TABLE handler_receipts(event_id TEXT PRIMARY KEY)");
    async function waitForTrustKeyUpdateWait() {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const waiting = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND query ILIKE $2", ["Lock", "%kratt_fabric_trusted_keys%"]);
        if (waiting.rows[0].count > 0) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("EXPECTED_TRUST_KEY_REVOCATION_WAIT_NOT_OBSERVED");
    }

    function makeEvent({ id, sequence, revision = STEEL_COMMIT, scope = ["repository.read"], issuedAt = "2026-11-26T11:59:00.000Z", expiresAt = "2026-11-26T12:00:00.000Z" }) {
      const body = {
        protocol: "3XT-FABRIC/1", event_id: id, event_type: "factory.task.accepted",
        source_node: "steel-node", destination_node: "kratt-node", source_revision: revision,
        correlation_id: "trust-registry-correlation", parent_event_id: null, sequence,
        issued_at: issuedAt, expires_at: expiresAt, scope, payload_reference: null,
        evidence_references: [], key_id: "steel-key-01", payload: { task_id: id, state: "accepted" },
        content_digest: "0".repeat(64), signature: ""
      };
      body.content_digest = fabricEventContentDigest(body);
      body.signature = sign(null, Buffer.from(fabricSigningInput(body), "utf8"), privateKey).toString("base64");
      return body;
    }
    const deps = {
      localNodeId: "kratt-node", resolveTrustedKey: registry.resolveTrustedKey,
      resolveNodePolicy: registry.resolveNodePolicy, now: () => Date.parse(NOW),
      handler: async (canonical, tx) => {
        await tx.client.query("INSERT INTO handler_receipts(event_id) VALUES($1)", [canonical.identity.event_id]);
        return "stored";
      }
    };

    const event1 = makeEvent({ id: "trust-accepted-001", sequence: 1 });
    const first = await receiveSteelFabricEventV1(pool, JSON.stringify(event1), deps);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.value.duplicate, false);
    const duplicate = await receiveSteelFabricEventV1(pool, JSON.stringify(event1), deps);
    assert.equal(duplicate.ok, true, JSON.stringify(duplicate));
    assert.equal(duplicate.value.duplicate, true);

    const wrongRevision = makeEvent({ id: "trust-wrong-revision", sequence: 2, revision: "a".repeat(40) });
    assert.equal((await receiveSteelFabricEventV1(pool, JSON.stringify(wrongRevision), deps)).code, "SOURCE_NOT_AUTHORIZED");

    const outOfScope = makeEvent({ id: "trust-out-of-scope", sequence: 2, scope: ["repository.write"] });
    assert.equal((await receiveSteelFabricEventV1(pool, JSON.stringify(outOfScope), deps)).code, "SCOPE_NOT_AUTHORIZED");

    const ttlTooLong = makeEvent({ id: "trust-ttl-too-long", sequence: 2, expiresAt: "2026-11-26T12:01:01.000Z" });
    assert.equal((await receiveSteelFabricEventV1(pool, JSON.stringify(ttlTooLong), deps)).code, "EVENT_TTL_NOT_AUTHORIZED");

    const secondPolicy = await registry.upsertPolicy({
      nodeId: "steel-node", destinationNode: "kratt-node", eventType: "factory.task.accepted",
      allowedScope: ["repository.read"], maxTtlMs: 30000, approvalProvider: "fabric",
      approvalAuthority: "fabric.receive", keyId: "steel-key-01", actorId: "security-admin"
    });
    assert.equal(secondPolicy.ok, true, JSON.stringify(secondPolicy));
    assert.equal(secondPolicy.value.policy_version, 2);
    const reduced = makeEvent({ id: "trust-policy-reduced", sequence: 2, scope: ["evidence.read"] });
    assert.equal((await receiveSteelFabricEventV1(pool, JSON.stringify(reduced), deps)).code, "SCOPE_NOT_AUTHORIZED");

    const retired = await registry.transitionKey({
      nodeId: "steel-node", keyId: "steel-key-01", nextStatus: "VERIFY_ONLY",
      actorId: "security-admin", reason: "key rotation", verifyUntil: "2026-12-26T12:00:00.000Z"
    });
    assert.equal(retired.ok, true, JSON.stringify(retired));
    assert.equal((await registry.resolveTrustedKey("steel-node", "steel-key-01")).status, "VERIFY_ONLY");
    const afterRetirement = makeEvent({
      id: "trust-verify-only-accepted", sequence: 2, scope: ["repository.read"],
      issuedAt: "2026-11-26T11:59:45.000Z", expiresAt: "2026-11-26T12:00:15.000Z"
    });
    const verifiedOnly = await receiveSteelFabricEventV1(pool, JSON.stringify(afterRetirement), deps);
    assert.equal(verifiedOnly.ok, true, JSON.stringify(verifiedOnly));

    // Receiver signing-key revocation waits behind the same transaction that protects
    // the destination-side ACK verification/signing identity.
    const receiverKeyRaceEvent = makeEvent({
      id: "trust-receiver-key-revocation-race", sequence: 3, scope: ["repository.read"],
      issuedAt: "2026-11-26T11:59:45.000Z", expiresAt: "2026-11-26T12:00:15.000Z"
    });
    let releaseReceiverKeyHandler;
    let receiverKeyHandlerEnteredResolve;
    const receiverKeyHandlerEntered = new Promise(resolve => { receiverKeyHandlerEnteredResolve = resolve; });
    const receiverKeyHandlerGate = new Promise(resolve => { releaseReceiverKeyHandler = resolve; });
    const receiverKeyLockDeps = {
      ...deps,
      deliveryAttempt: 1,
      revalidateAuthorization: ({ client, event, authenticatedKey, authorization, now }) => registry.lockInboundAuthorization(client, {
        event, authenticatedKey, expectedPolicyRevision: authorization.policy_revision, nowMs: now
      }),
      lockReceiverSigningIdentity: (client, nodeId, keyId, acknowledgement, now) =>
        registry.lockReceiverSigningIdentity(client, nodeId, keyId, acknowledgement, now),
      createAcknowledgement: context => createFabricReceiverAcknowledgement({
        event: context.event, receiverNode: "kratt-node", policyRevision: context.authorization.policy_revision,
        deliveryAttempt: context.deliveryAttempt, result: context.ackResult,
        resolveSigningIdentity: async () => registry.resolveActiveSigningIdentity({ keyId: "kratt-ack-key-01" }),
        sign: async ({ message }) => sign(null, Buffer.from(message, "utf8"), receiverKeyPair.privateKey),
        now: () => Date.parse(NOW)
      }),
      handler: async (canonical, tx) => {
        await tx.client.query("INSERT INTO handler_receipts(event_id) VALUES($1)", [canonical.identity.event_id]);
        receiverKeyHandlerEnteredResolve();
        await receiverKeyHandlerGate;
        return "accepted-before-receiver-key-revocation";
      }
    };
    const receiverKeyReceive = receiveSteelFabricEventV1(pool, JSON.stringify(receiverKeyRaceEvent), receiverKeyLockDeps);
    await receiverKeyHandlerEntered;
    const receiverKeyRevocation = registry.transitionKey({
      nodeId: "kratt-node", keyId: "kratt-ack-key-01", nextStatus: "REVOKED",
      actorId: "security-admin", reason: "serialize local receiver key revocation behind in-flight ingress"
    });
    await waitForTrustKeyUpdateWait();
    releaseReceiverKeyHandler();
    const receiverKeyReceiveResult = await receiverKeyReceive;
    assert.equal(receiverKeyReceiveResult.ok, true, JSON.stringify(receiverKeyReceiveResult));
    assert.equal(receiverKeyReceiveResult.value.acknowledgement.result, "ACCEPTED");
    assert.equal(receiverKeyReceiveResult.value.acknowledgement.key_id, "kratt-ack-key-01");
    const receiverKeyRevocationResult = await receiverKeyRevocation;
    assert.equal(receiverKeyRevocationResult.ok, true, JSON.stringify(receiverKeyRevocationResult));

    // The inbound transaction holds the source trusted key and active policy rows FOR SHARE.
    // A concurrent source-key revocation waits until the accepted event and receipt commit.
    const lockedEvent = makeEvent({
      id: "trust-lock-revocation-race", sequence: 4, scope: ["repository.read"],
      issuedAt: "2026-11-26T11:59:45.000Z", expiresAt: "2026-11-26T12:00:15.000Z"
    });
    let releaseLockedHandler;
    let lockedHandlerEnteredResolve;
    const lockedHandlerEntered = new Promise(resolve => { lockedHandlerEnteredResolve = resolve; });
    const lockedHandlerGate = new Promise(resolve => { releaseLockedHandler = resolve; });
    const lockedDeps = {
      ...deps,
      revalidateAuthorization: ({ client, event, authenticatedKey, authorization, now }) => registry.lockInboundAuthorization(client, {
        event, authenticatedKey, expectedPolicyRevision: authorization.policy_revision, nowMs: now
      }),
      handler: async (canonical, tx) => {
        await tx.client.query("INSERT INTO handler_receipts(event_id) VALUES($1)", [canonical.identity.event_id]);
        lockedHandlerEnteredResolve();
        await lockedHandlerGate;
        return "accepted-before-key-revocation";
      }
    };
    const lockedReceive = receiveSteelFabricEventV1(pool, JSON.stringify(lockedEvent), lockedDeps);
    await lockedHandlerEntered;
    const revocationPending = registry.transitionKey({
      nodeId: "steel-node", keyId: "steel-key-01", nextStatus: "REVOKED",
      actorId: "security-admin", reason: "serialize revocation after in-flight authorized receiver transaction"
    });
    await waitForTrustKeyUpdateWait();
    releaseLockedHandler();
    const lockedReceiveResult = await lockedReceive;
    assert.equal(lockedReceiveResult.ok, true, JSON.stringify(lockedReceiveResult));
    const revocationResult = await revocationPending;
    assert.equal(revocationResult.ok, true, JSON.stringify(revocationResult));

    const invalidReactivation = await registry.transitionKey({
      nodeId: "steel-node", keyId: "steel-key-01", nextStatus: "ACTIVE",
      actorId: "security-admin", reason: "retired key cannot be reactivated"
    });
    assert.equal(invalidReactivation.code, "TRUST_KEY_TRANSITION_INVALID");
    const afterRevoke = makeEvent({ id: "trust-after-revoke", sequence: 5 });
    assert.equal((await receiveSteelFabricEventV1(pool, JSON.stringify(afterRevoke), deps)).code, "KEY_REVOKED");

    const audit = await registry.verifyAuditChain();
    assert.equal(audit.ok, true, JSON.stringify(audit));
    assert.ok(audit.value.events >= 9);
    await assert.rejects(
      pool.query("UPDATE kratt_fabric_trust_audit SET action='FORGED' WHERE sequence=1"),
      /KRATT_FABRIC_TRUST_AUDIT_APPEND_ONLY/
    );
    await assert.rejects(
      pool.query("DELETE FROM kratt_fabric_trusted_keys WHERE node_id='steel-node' AND key_id='steel-key-01'"),
      /KRATT_FABRIC_TRUST_KEY_APPEND_ONLY/
    );
    const counts = await pool.query(
      "SELECT (SELECT count(*)::int FROM kratt_fabric_event_inbox) AS inbox_count," +
      "(SELECT count(*)::int FROM handler_receipts) AS handler_count"
    );
    assert.equal(counts.rows[0].inbox_count, 4);
    assert.equal(counts.rows[0].handler_count, 4);
  } finally {
    if (pool) await pool.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE").catch(() => undefined);
    await admin.end();
  }
});
