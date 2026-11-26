import { createHash, createPublicKey } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ACTOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TOKEN = /^[a-z][a-z0-9._:-]{0,127}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ZERO_HASH = "0".repeat(64);

const fail = (code, detail) => ({ ok: false, code, ...(detail ? { detail } : {}) });
const ok = value => ({ ok: true, value });

function strictUtcMillis(value) {
  if (typeof value !== "string") return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(value);
  if (!m) return null;
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return null;
  try { return new Date(t).toISOString() === m[1] + "." + (m[2] ?? "").padEnd(3, "0") + "Z" ? t : null; }
  catch { return null; }
}
function iso(value) {
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function safeList(value) {
  return Array.isArray(value) && value.length >= 1 && value.length <= 64 &&
    value.every(item => typeof item === "string" && TOKEN.test(item)) &&
    new Set(value).size === value.length;
}
function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError("AUDIT_RECORD_NOT_JSON");
  const keys = Object.keys(value).sort();
  return "{" + keys.map(key => JSON.stringify(key) + ":" + stableJson(value[key])).join(",") + "}";
}
function publicKeyDescriptor(pem) {
  if (typeof pem !== "string" || pem.length > 8192 || !pem.includes("-----BEGIN PUBLIC KEY-----") || /PRIVATE KEY/.test(pem)) return null;
  try {
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== "ed25519") return null;
    const canonical = key.export({ type: "spki", format: "pem" }).toString();
    const fingerprint = createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
    return { pem: canonical, fingerprint };
  } catch { return null; }
}

/** PostgreSQL-backed trust registry. It stores public keys only, never signing secrets. */
export function createPostgresFabricTrustRegistry(pool, { clock = () => new Date(), authorizeAdmin, localNodeId } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw new TypeError("FABRIC_TRUST_POSTGRES_POOL_REQUIRED");
  if (typeof clock !== "function" || typeof authorizeAdmin !== "function") throw new TypeError("FABRIC_TRUST_ADMIN_GATE_AND_CLOCK_REQUIRED");
  if (localNodeId !== undefined && !ID.test(localNodeId)) throw new TypeError("FABRIC_TRUST_LOCAL_NODE_INVALID");

  function nowIso() {
    const value = iso(clock());
    if (!value) throw new TypeError("FABRIC_TRUST_CLOCK_INVALID");
    return value;
  }
  async function transact(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      if (result && result.ok === false) { await client.query("ROLLBACK"); return result; }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
  async function permitted(action, actorId, detail) {
    if (!ACTOR.test(actorId ?? "")) return false;
    try { return await authorizeAdmin({ action, actorId, detail }) === true; }
    catch { return false; }
  }
  async function appendAudit(client, input) {
    const head = await client.query("SELECT last_sequence,last_hash FROM kratt_fabric_trust_audit_head WHERE singleton=TRUE FOR UPDATE");
    if (head.rowCount !== 1) throw new Error("FABRIC_TRUST_AUDIT_HEAD_MISSING");
    const sequence = Number(head.rows[0].last_sequence) + 1;
    const previousHash = head.rows[0].last_hash;
    const createdAt = nowIso();
    const record = {
      sequence, action: input.action, actor_id: input.actorId, node_id: input.nodeId,
      key_id: input.keyId ?? null, policy_version: input.policyVersion ?? null,
      detail: input.detail ?? {}, created_at: createdAt
    };
    const encoded = stableJson(record);
    const hash = createHash("sha256").update(String(sequence) + "\n" + previousHash + "\n" + encoded, "utf8").digest("hex");
    await client.query(
      "INSERT INTO kratt_fabric_trust_audit(sequence,action,actor_id,node_id,key_id,policy_version,record_json,previous_hash,record_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [sequence, input.action, input.actorId, input.nodeId, input.keyId ?? null, input.policyVersion ?? null, encoded, previousHash, hash, createdAt]
    );
    await client.query("UPDATE kratt_fabric_trust_audit_head SET last_sequence=$1,last_hash=$2 WHERE singleton=TRUE", [sequence, hash]);
    return { sequence, hash };
  }

  async function registerNode({ nodeId, repositoryFullName, repositoryRevision, actorId } = {}) {
    if (!ID.test(nodeId ?? "") || !REPOSITORY.test(repositoryFullName ?? "") || !SHA1.test(repositoryRevision ?? "")) return fail("TRUST_NODE_INPUT_INVALID");
    if (!await permitted("NODE_REGISTER", actorId, { nodeId, repositoryFullName, repositoryRevision })) return fail("ADMIN_DENIED");
    try {
      return await transact(async client => {
        const old = await client.query("SELECT repository_full_name,repository_revision,status FROM kratt_fabric_trusted_nodes WHERE node_id=$1 FOR UPDATE", [nodeId]);
        if (old.rowCount) {
          const row = old.rows[0];
          return row.repository_full_name === repositoryFullName && row.repository_revision === repositoryRevision
            ? ok({ duplicate: true, node_id: nodeId, status: row.status }) : fail("TRUST_NODE_CONFLICT");
        }
        const inserted = await client.query(
          "INSERT INTO kratt_fabric_trusted_nodes(node_id,repository_full_name,repository_revision,status) VALUES($1,$2,$3,'ACTIVE') RETURNING node_id,status",
          [nodeId, repositoryFullName, repositoryRevision]
        );
        await appendAudit(client, { action: "NODE_REGISTERED", actorId, nodeId,
          detail: { repository_full_name: repositoryFullName, repository_revision: repositoryRevision } });
        return ok({ duplicate: false, ...inserted.rows[0] });
      });
    } catch (error) { if (error?.code === "23505") return fail("TRUST_NODE_CONFLICT"); throw error; }
  }

  async function setNodeStatus({ nodeId, status, actorId, reason } = {}) {
    if (!ID.test(nodeId ?? "") || !["ACTIVE", "DISABLED"].includes(status) || typeof reason !== "string" || reason.trim().length < 3 || reason.length > 256) return fail("TRUST_NODE_STATUS_INPUT_INVALID");
    if (!await permitted("NODE_STATUS_CHANGE", actorId, { nodeId, status, reason })) return fail("ADMIN_DENIED");
    return transact(async client => {
      const old = await client.query("SELECT status FROM kratt_fabric_trusted_nodes WHERE node_id=$1 FOR UPDATE", [nodeId]);
      if (old.rowCount !== 1) return fail("TRUST_NODE_NOT_FOUND");
      if (old.rows[0].status === status) return ok({ duplicate: true, node_id: nodeId, status });
      await client.query("UPDATE kratt_fabric_trusted_nodes SET status=$2,updated_at=$3 WHERE node_id=$1", [nodeId, status, nowIso()]);
      await appendAudit(client, { action: status === "DISABLED" ? "NODE_DISABLED" : "NODE_ENABLED", actorId, nodeId,
        detail: { previous_status: old.rows[0].status, reason } });
      return ok({ duplicate: false, node_id: nodeId, status });
    });
  }

  async function updateNodeRevision({ nodeId, repositoryRevision, actorId, reason } = {}) {
    if (!ID.test(nodeId ?? "") || !SHA1.test(repositoryRevision ?? "") || typeof reason !== "string" || reason.trim().length < 3 || reason.length > 256) return fail("TRUST_NODE_REVISION_INPUT_INVALID");
    if (!await permitted("NODE_REVISION_CHANGE", actorId, { nodeId, repositoryRevision, reason })) return fail("ADMIN_DENIED");
    return transact(async client => {
      const old = await client.query("SELECT status,repository_revision FROM kratt_fabric_trusted_nodes WHERE node_id=$1 FOR UPDATE", [nodeId]);
      if (old.rowCount !== 1) return fail("TRUST_NODE_NOT_FOUND");
      if (old.rows[0].status !== "DISABLED") return fail("TRUST_NODE_MUST_BE_DISABLED_FOR_REVISION_CHANGE");
      if (old.rows[0].repository_revision === repositoryRevision) return ok({ duplicate: true, node_id: nodeId, repository_revision: repositoryRevision });
      await client.query("UPDATE kratt_fabric_trusted_nodes SET repository_revision=$2,updated_at=$3 WHERE node_id=$1", [nodeId, repositoryRevision, nowIso()]);
      await appendAudit(client, { action: "NODE_REVISION_CHANGED", actorId, nodeId,
        detail: { previous_revision: old.rows[0].repository_revision, repository_revision: repositoryRevision, reason } });
      return ok({ duplicate: false, node_id: nodeId, repository_revision: repositoryRevision });
    });
  }

  async function registerKey({ nodeId, keyId, publicKeyPem, validFrom, signUntil = null, actorId } = {}) {
    if (!ID.test(nodeId ?? "") || !ID.test(keyId ?? "") || !ACTOR.test(actorId ?? "")) return fail("TRUST_KEY_INPUT_INVALID");
    const descriptor = publicKeyDescriptor(publicKeyPem);
    const from = validFrom === undefined ? nowIso() : validFrom;
    const fromMs = strictUtcMillis(from);
    const untilMs = signUntil === null ? null : strictUtcMillis(signUntil);
    if (!descriptor || fromMs === null || (signUntil !== null && (untilMs === null || untilMs <= fromMs))) return fail("TRUST_KEY_MATERIAL_OR_WINDOW_INVALID");
    if (!await permitted("KEY_REGISTER", actorId, { nodeId, keyId, fingerprint: descriptor.fingerprint })) return fail("ADMIN_DENIED");
    try {
      return await transact(async client => {
        const node = await client.query("SELECT status FROM kratt_fabric_trusted_nodes WHERE node_id=$1 FOR SHARE", [nodeId]);
        if (node.rowCount !== 1) return fail("TRUST_NODE_NOT_FOUND");
        const inserted = await client.query(
          "INSERT INTO kratt_fabric_trusted_keys(node_id,key_id,public_key_pem,public_key_fingerprint,status,valid_from,sign_until,created_by) VALUES($1,$2,$3,$4,'PENDING',$5,$6,$7) ON CONFLICT(node_id,key_id) DO NOTHING RETURNING node_id,key_id,status,public_key_fingerprint",
          [nodeId, keyId, descriptor.pem, descriptor.fingerprint, from, signUntil, actorId]
        );
        if (inserted.rowCount !== 1) return fail("TRUST_KEY_CONFLICT");
        await appendAudit(client, { action: "KEY_REGISTERED", actorId, nodeId, keyId,
          detail: { fingerprint: descriptor.fingerprint, status: "PENDING", valid_from: from, sign_until: signUntil } });
        return ok({ duplicate: false, ...inserted.rows[0] });
      });
    } catch (error) { if (error?.code === "23505") return fail("TRUST_KEY_CONFLICT"); throw error; }
  }

  async function transitionKey({ nodeId, keyId, nextStatus, actorId, reason, verifyUntil = null } = {}) {
    if (!ID.test(nodeId ?? "") || !ID.test(keyId ?? "") || !["ACTIVE", "VERIFY_ONLY", "REVOKED"].includes(nextStatus) ||
        typeof reason !== "string" || reason.trim().length < 3 || reason.length > 256) return fail("TRUST_KEY_TRANSITION_INPUT_INVALID");
    const at = nowIso();
    const verifyMs = verifyUntil === null ? null : strictUtcMillis(verifyUntil);
    if (nextStatus === "VERIFY_ONLY" && (verifyMs === null || verifyMs < Date.parse(at))) return fail("TRUST_KEY_VERIFY_WINDOW_REQUIRED");
    if (verifyUntil !== null && verifyMs === null) return fail("TRUST_KEY_VERIFY_WINDOW_INVALID");
    if (!await permitted("KEY_STATUS_CHANGE", actorId, { nodeId, keyId, nextStatus, reason, verifyUntil })) return fail("ADMIN_DENIED");
    return transact(async client => {
      const old = await client.query("SELECT status FROM kratt_fabric_trusted_keys WHERE node_id=$1 AND key_id=$2 FOR UPDATE", [nodeId, keyId]);
      if (old.rowCount !== 1) return fail("TRUST_KEY_NOT_FOUND");
      const prior = old.rows[0].status;
      const allowed = (prior === "PENDING" && ["ACTIVE", "REVOKED"].includes(nextStatus)) ||
        (prior === "ACTIVE" && ["VERIFY_ONLY", "REVOKED"].includes(nextStatus)) ||
        (prior === "VERIFY_ONLY" && nextStatus === "REVOKED");
      if (!allowed) return fail("TRUST_KEY_TRANSITION_INVALID");
      if (nextStatus === "VERIFY_ONLY") {
        await client.query("UPDATE kratt_fabric_trusted_keys SET status='VERIFY_ONLY',retired_at=$3,verify_until=$4,updated_at=$3 WHERE node_id=$1 AND key_id=$2", [nodeId, keyId, at, verifyUntil]);
      } else if (nextStatus === "REVOKED") {
        await client.query("UPDATE kratt_fabric_trusted_keys SET status='REVOKED',revoked_at=$3,updated_at=$3 WHERE node_id=$1 AND key_id=$2", [nodeId, keyId, at]);
      } else {
        await client.query("UPDATE kratt_fabric_trusted_keys SET status='ACTIVE',updated_at=$3 WHERE node_id=$1 AND key_id=$2", [nodeId, keyId, at]);
      }
      await appendAudit(client, { action: nextStatus === "REVOKED" ? "KEY_REVOKED" : nextStatus === "VERIFY_ONLY" ? "KEY_RETIRED" : "KEY_ACTIVATED",
        actorId, nodeId, keyId, detail: { previous_status: prior, next_status: nextStatus, reason, verify_until: verifyUntil } });
      return ok({ previous_status: prior, status: nextStatus, node_id: nodeId, key_id: keyId });
    });
  }

  async function upsertPolicy({
    nodeId, destinationNode, eventType, allowedScope, maxTtlMs = 86400000,
    approvalProvider = "fabric", approvalAuthority = "fabric.publish", keyId = null, actorId
  } = {}) {
    if (!ID.test(nodeId ?? "") || !ID.test(destinationNode ?? "") || !TOKEN.test(eventType ?? "") || !safeList(allowedScope) ||
        !Number.isSafeInteger(maxTtlMs) || maxTtlMs < 1000 || maxTtlMs > 86400000 ||
        !ID.test(approvalProvider ?? "") || !TOKEN.test(approvalAuthority ?? "") || (keyId !== null && !ID.test(keyId ?? ""))) {
      return fail("TRUST_POLICY_INPUT_INVALID");
    }
    const detail = { nodeId, destinationNode, eventType, allowedScope, maxTtlMs, approvalProvider, approvalAuthority, keyId };
    if (!await permitted("POLICY_UPSERT", actorId, detail)) return fail("ADMIN_DENIED");
    try {
      return await transact(async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["fabric-trust-policy:" + nodeId + ":" + destinationNode + ":" + eventType]);
        const nodes = await client.query("SELECT node_id,status FROM kratt_fabric_trusted_nodes WHERE node_id=ANY($1::text[]) FOR SHARE", [[nodeId, destinationNode]]);
        if (nodes.rowCount !== 2 || nodes.rows.some(row => row.status !== "ACTIVE")) return fail("TRUST_POLICY_NODE_NOT_ACTIVE");
        if (keyId !== null) {
          const key = await client.query("SELECT status FROM kratt_fabric_trusted_keys WHERE node_id=$1 AND key_id=$2 FOR SHARE", [nodeId, keyId]);
          if (key.rowCount !== 1 || !["ACTIVE", "VERIFY_ONLY"].includes(key.rows[0].status)) return fail("TRUST_POLICY_KEY_NOT_USABLE");
        }
        const current = await client.query(
          "SELECT policy_version FROM kratt_fabric_trust_policies WHERE node_id=$1 AND destination_node=$2 AND event_type=$3 AND status='ACTIVE' FOR UPDATE",
          [nodeId, destinationNode, eventType]
        );
        const at = nowIso();
        if (current.rowCount === 1) {
          const oldVersion = Number(current.rows[0].policy_version);
          await client.query("UPDATE kratt_fabric_trust_policies SET status='DISABLED',disabled_at=$4 WHERE node_id=$1 AND destination_node=$2 AND event_type=$3 AND policy_version=$5",
            [nodeId, destinationNode, eventType, at, oldVersion]);
          await appendAudit(client, { action: "POLICY_DISABLED", actorId, nodeId, policyVersion: oldVersion,
            detail: { destination_node: destinationNode, event_type: eventType, reason: "superseded" } });
        }
        const max = await client.query("SELECT COALESCE(MAX(policy_version),0)::int AS version FROM kratt_fabric_trust_policies WHERE node_id=$1 AND destination_node=$2 AND event_type=$3",
          [nodeId, destinationNode, eventType]);
        const version = Number(max.rows[0].version) + 1;
        await client.query(
          "INSERT INTO kratt_fabric_trust_policies(node_id,destination_node,event_type,policy_version,allowed_scope,max_ttl_ms,approval_provider,approval_authority,key_id,status,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE',$10)",
          [nodeId, destinationNode, eventType, version, allowedScope, maxTtlMs, approvalProvider, approvalAuthority, keyId, actorId]
        );
        await appendAudit(client, { action: "POLICY_CREATED", actorId, nodeId, policyVersion: version,
          detail: { destination_node: destinationNode, event_type: eventType, allowed_scope: allowedScope, max_ttl_ms: maxTtlMs,
            approval_provider: approvalProvider, approval_authority: approvalAuthority, key_id: keyId } });
        return ok({ node_id: nodeId, destination_node: destinationNode, event_type: eventType, policy_version: version });
      });
    } catch (error) { if (error?.code === "23505") return fail("TRUST_POLICY_CONFLICT"); throw error; }
  }

  async function resolveTrustedKey(sourceNode, keyId) {
    if (!ID.test(sourceNode ?? "") || !ID.test(keyId ?? "")) return null;
    const q = await pool.query(
      "SELECT k.node_id,k.key_id,k.public_key_pem,k.public_key_fingerprint,k.status,k.valid_from,k.sign_until,k.retired_at,k.verify_until,k.revoked_at,n.status AS node_status " +
      "FROM kratt_fabric_trusted_keys k JOIN kratt_fabric_trusted_nodes n ON n.node_id=k.node_id WHERE k.node_id=$1 AND k.key_id=$2",
      [sourceNode, keyId]
    );
    if (q.rowCount !== 1 || q.rows[0].node_status !== "ACTIVE") return null;
    const r = q.rows[0];
    return {
      source_node: r.node_id, key_id: r.key_id, public_key: r.public_key_pem,
      fingerprint: r.public_key_fingerprint, status: r.status, valid_from: iso(r.valid_from),
      ...(r.sign_until ? { sign_until: iso(r.sign_until) } : {}),
      ...(r.retired_at ? { retired_at: iso(r.retired_at) } : {}),
      ...(r.verify_until ? { verify_until: iso(r.verify_until) } : {}),
      ...(r.revoked_at ? { revoked_at: iso(r.revoked_at) } : {})
    };
  }

  async function resolveNodePolicy(sourceNode, authenticatedKey, event) {
    if (!event || sourceNode !== event.source_node || authenticatedKey?.source_node !== sourceNode ||
        authenticatedKey?.key_id !== event.key_id || !ID.test(sourceNode ?? "")) return null;
    const issued = strictUtcMillis(event.issued_at);
    const now = Date.parse(nowIso());
    if (issued === null || !Number.isFinite(now)) return null;
    const q = await pool.query(
      "SELECT n.repository_revision,p.policy_version,p.allowed_scope,p.max_ttl_ms,p.approval_provider,p.approval_authority,p.key_id," +
      "k.status AS key_status,k.valid_from,k.sign_until,k.retired_at,k.verify_until " +
      "FROM kratt_fabric_trusted_nodes n JOIN kratt_fabric_trust_policies p ON p.node_id=n.node_id " +
      "JOIN kratt_fabric_trusted_keys k ON k.node_id=n.node_id AND k.key_id=$2 " +
      "WHERE n.node_id=$1 AND n.status='ACTIVE' AND n.repository_revision=$3 AND p.destination_node=$4 AND p.event_type=$5 " +
      "AND p.status='ACTIVE' AND (p.key_id IS NULL OR p.key_id=k.key_id)",
      [sourceNode, event.key_id, event.source_revision, event.destination_node, event.event_type]
    );
    if (q.rowCount !== 1) return null;
    const r = q.rows[0];
    const validFrom = Date.parse(iso(r.valid_from));
    if (!Number.isFinite(validFrom) || issued < validFrom) return null;
    if (r.key_status === "ACTIVE") {
      const signUntil = r.sign_until ? Date.parse(iso(r.sign_until)) : null;
      if (signUntil !== null && issued > signUntil) return null;
    } else if (r.key_status === "VERIFY_ONLY") {
      const retired = r.retired_at ? Date.parse(iso(r.retired_at)) : NaN;
      const verifyUntil = r.verify_until ? Date.parse(iso(r.verify_until)) : NaN;
      if (!Number.isFinite(retired) || !Number.isFinite(verifyUntil) || issued > retired || now > verifyUntil) return null;
    } else return null;
    return {
      source_node: sourceNode, status: "ACTIVE", destinations: [event.destination_node],
      allowed_event_types: [event.event_type], allowed_scope: r.allowed_scope,
      key_id: event.key_id, revision: "r" + event.source_revision + ":p" + r.policy_version,
      max_ttl_ms: Number(r.max_ttl_ms)
    };
  }

  /**
   * Revalidate and hold the exact inbound trust decision until the caller's transaction commits.
   * This shares the policy lock key used by upsertPolicy and row-locks source/destination nodes,
   * signing key and active policy so node disablement, key revocation and policy replacement
   * serialize against the receiver's business transaction.
   */
  /**
   * Lock the exact local receiver signing key used by a persisted ACK until the surrounding
   * transaction commits. ACTIVE keys can verify new ACKs; VERIFY_ONLY keys can only verify
   * ACKs issued before retirement and before the verification window expires.
   */
  /**
   * Lock the exact trusted remote receiver key used to authenticate an inbound ACK.
   * The caller must retain this transaction until the ACK and terminal-state writes commit.
   */
  async function lockTrustedReceiverAcknowledgementIdentity(client, nodeId, keyId, acknowledgement, nowMs = Date.parse(nowIso())) {
    if (!client || typeof client.query !== "function" || !ID.test(nodeId ?? "") ||
        !ID.test(keyId ?? "") || acknowledgement?.receiver_node !== nodeId ||
        acknowledgement?.key_id !== keyId || !Number.isFinite(nowMs))
      return fail("TRUST_ACK_KEY_LOCK_INPUT_INVALID");
    const issuedAt = strictUtcMillis(acknowledgement.issued_at);
    if (issuedAt === null) return fail("TRUST_ACK_TIME_INVALID");
    try {
      const q = await client.query(
        "SELECT n.status AS node_status,k.node_id,k.key_id,k.public_key_pem,k.public_key_fingerprint," +
        "k.status,k.valid_from,k.sign_until,k.retired_at,k.verify_until " +
        "FROM kratt_fabric_trusted_nodes n JOIN kratt_fabric_trusted_keys k ON k.node_id=n.node_id " +
        "WHERE n.node_id=$1 AND k.key_id=$2 FOR SHARE OF n,k",
        [nodeId, keyId]
      );
      if (q.rowCount !== 1 || q.rows[0].node_status !== "ACTIVE")
        return fail("TRUST_ACK_RECEIVER_UNAVAILABLE");
      const row = q.rows[0];
      const validFrom = strictUtcMillis(iso(row.valid_from));
      if (validFrom === null || issuedAt < validFrom) return fail("TRUST_ACK_KEY_TIME_INVALID");
      if (row.status === "ACTIVE") {
        const signUntil = row.sign_until ? strictUtcMillis(iso(row.sign_until)) : null;
        if (row.sign_until && (signUntil === null || issuedAt > signUntil))
          return fail("TRUST_ACK_KEY_SIGN_WINDOW_CLOSED");
      } else if (row.status === "VERIFY_ONLY") {
        const retiredAt = row.retired_at ? strictUtcMillis(iso(row.retired_at)) : null;
        const verifyUntil = row.verify_until ? strictUtcMillis(iso(row.verify_until)) : null;
        if (retiredAt === null || verifyUntil === null || issuedAt > retiredAt || nowMs > verifyUntil)
          return fail("TRUST_ACK_KEY_VERIFY_WINDOW_CLOSED");
      } else {
        return fail("TRUST_ACK_KEY_UNTRUSTED");
      }
      return ok({
        node_id: row.node_id, node_status: row.node_status,
        key_id: row.key_id, public_key: row.public_key_pem,
        fingerprint: row.public_key_fingerprint, status: row.status,
        valid_from: iso(row.valid_from),
        ...(row.sign_until ? { sign_until: iso(row.sign_until) } : {}),
        ...(row.retired_at ? { retired_at: iso(row.retired_at) } : {}),
        ...(row.verify_until ? { verify_until: iso(row.verify_until) } : {})
      });
    } catch {
      return fail("TRUST_ACK_KEY_LOCK_UNAVAILABLE");
    }
  }

  async function lockReceiverSigningIdentity(client, nodeId, keyId, acknowledgement, nowMs = Date.parse(nowIso())) {
    if (!client || typeof client.query !== "function" || !ID.test(nodeId ?? "") ||
        !ID.test(keyId ?? "") || acknowledgement?.receiver_node !== nodeId ||
        acknowledgement?.key_id !== keyId || !Number.isFinite(nowMs))
      return fail("TRUST_RECEIVER_KEY_LOCK_INPUT_INVALID");
    const issuedAt = strictUtcMillis(acknowledgement.issued_at);
    if (issuedAt === null) return fail("TRUST_RECEIVER_ACK_TIME_INVALID");
    try {
      const q = await client.query(
        "SELECT n.status AS node_status,k.node_id,k.key_id,k.public_key_pem,k.public_key_fingerprint," +
        "k.status,k.valid_from,k.sign_until,k.retired_at,k.verify_until " +
        "FROM kratt_fabric_trusted_nodes n JOIN kratt_fabric_trusted_keys k ON k.node_id=n.node_id " +
        "WHERE n.node_id=$1 AND k.key_id=$2 FOR SHARE OF n,k",
        [nodeId,keyId]
      );
      if (q.rowCount !== 1 || q.rows[0].node_status !== "ACTIVE") return fail("TRUST_RECEIVER_KEY_UNAVAILABLE");
      const row = q.rows[0];
      const validFrom = strictUtcMillis(iso(row.valid_from));
      if (validFrom === null || issuedAt < validFrom) return fail("TRUST_RECEIVER_KEY_TIME_INVALID");
      if (row.status === "ACTIVE") {
        const signUntil = row.sign_until ? strictUtcMillis(iso(row.sign_until)) : null;
        if (row.sign_until && (signUntil === null || issuedAt > signUntil)) return fail("TRUST_RECEIVER_KEY_SIGN_WINDOW_CLOSED");
      } else if (row.status === "VERIFY_ONLY") {
        const retiredAt = row.retired_at ? strictUtcMillis(iso(row.retired_at)) : null;
        const verifyUntil = row.verify_until ? strictUtcMillis(iso(row.verify_until)) : null;
        if (retiredAt === null || verifyUntil === null || issuedAt > retiredAt || nowMs > verifyUntil)
          return fail("TRUST_RECEIVER_KEY_VERIFY_WINDOW_CLOSED");
      } else return fail("TRUST_RECEIVER_KEY_UNAVAILABLE");
      return ok({
        node_id: row.node_id, node_status: row.node_status, key_id: row.key_id,
        public_key: row.public_key_pem, fingerprint: row.public_key_fingerprint, status: row.status,
        valid_from: iso(row.valid_from), ...(row.sign_until ? { sign_until: iso(row.sign_until) } : {}),
        ...(row.retired_at ? { retired_at: iso(row.retired_at) } : {}),
        ...(row.verify_until ? { verify_until: iso(row.verify_until) } : {})
      });
    } catch { return fail("TRUST_RECEIVER_KEY_LOCK_UNAVAILABLE"); }
  }

  async function lockInboundAuthorization(client, { event, authenticatedKey, expectedPolicyRevision, nowMs = Date.parse(nowIso()) } = {}) {
    if (!client || typeof client.query !== "function" || !event ||
        event.source_node !== authenticatedKey?.source_node || event.key_id !== authenticatedKey?.key_id ||
        !ID.test(event.source_node ?? "") || !ID.test(event.destination_node ?? "") ||
        !TOKEN.test(event.event_type ?? "") || !ID.test(expectedPolicyRevision ?? "") || !Number.isFinite(nowMs))
      return fail("TRUST_INGRESS_REVALIDATION_INPUT_INVALID");
    const issued = strictUtcMillis(event.issued_at);
    if (issued === null) return fail("TRUST_INGRESS_EVENT_TIME_INVALID");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "fabric-trust-policy:" + event.source_node + ":" + event.destination_node + ":" + event.event_type
      ]);
      const q = await client.query(
        "SELECT n.status AS source_node_status,n.repository_revision," +
        "d.status AS destination_node_status," +
        "k.status AS key_status,k.public_key_fingerprint,k.valid_from,k.sign_until,k.retired_at,k.verify_until," +
        "p.policy_version,p.allowed_scope,p.max_ttl_ms,p.key_id AS policy_key_id,p.status AS policy_status " +
        "FROM kratt_fabric_trusted_nodes n " +
        "JOIN kratt_fabric_trusted_nodes d ON d.node_id=$2 " +
        "JOIN kratt_fabric_trusted_keys k ON k.node_id=n.node_id AND k.key_id=$3 " +
        "JOIN kratt_fabric_trust_policies p ON p.node_id=n.node_id AND p.destination_node=d.node_id " +
        "WHERE n.node_id=$1 AND n.repository_revision=$4 AND n.status='ACTIVE' " +
        "AND d.status='ACTIVE' AND p.event_type=$5 AND p.status='ACTIVE' " +
        "AND (p.key_id IS NULL OR p.key_id=k.key_id) " +
        "FOR SHARE OF n,d,k,p",
        [event.source_node,event.destination_node,event.key_id,event.source_revision,event.event_type]
      );
      if (q.rowCount !== 1) return fail("TRUST_INGRESS_POLICY_OR_NODE_CHANGED");
      // Hold receiver-side public keys through this transaction so ACK creation/replay
      // cannot race an ACTIVE -> VERIFY_ONLY/REVOKED transition.
      const receiverKeys = await client.query(
        "SELECT key_id FROM kratt_fabric_trusted_keys WHERE node_id=$1 AND status = ANY($2::text[]) FOR SHARE",
        [event.destination_node, ["ACTIVE", "VERIFY_ONLY"]]
      );
      const row = q.rows[0];
      if (row.key_status === "REVOKED" || row.key_status === "PENDING" ||
          !["ACTIVE", "VERIFY_ONLY"].includes(row.key_status)) return fail("TRUST_INGRESS_KEY_NOT_USABLE");
      const validFrom = Date.parse(iso(row.valid_from));
      if (!Number.isFinite(validFrom) || issued < validFrom) return fail("TRUST_INGRESS_KEY_TIME_INVALID");
      if (row.key_status === "ACTIVE") {
        const signUntil = row.sign_until ? Date.parse(iso(row.sign_until)) : null;
        if (signUntil !== null && issued > signUntil) return fail("TRUST_INGRESS_KEY_SIGN_WINDOW_CLOSED");
      } else {
        const retired = row.retired_at ? Date.parse(iso(row.retired_at)) : NaN;
        const verifyUntil = row.verify_until ? Date.parse(iso(row.verify_until)) : NaN;
        if (!Number.isFinite(retired) || !Number.isFinite(verifyUntil) || issued > retired || nowMs > verifyUntil)
          return fail("TRUST_INGRESS_KEY_VERIFY_WINDOW_CLOSED");
      }
      const revision = "r" + event.source_revision + ":p" + row.policy_version;
      if (revision !== expectedPolicyRevision) return fail("TRUST_INGRESS_POLICY_REVISION_CHANGED");
      return ok({ policy: {
        source_node: event.source_node, status: "ACTIVE", destinations: [event.destination_node],
        allowed_event_types: [event.event_type], allowed_scope: row.allowed_scope,
        key_id: event.key_id, revision, max_ttl_ms: Number(row.max_ttl_ms)
      }, key_status: row.key_status, policy_revision: revision, receiver_key_locks: receiverKeys.rowCount });
    } catch {
      return fail("TRUST_INGRESS_REVALIDATION_UNAVAILABLE");
    }
  }

  async function resolveOutboundPolicy({ task, eventType } = {}) {
    if (!localNodeId || !task?.target || typeof task.target.resource_id !== "string" || !TOKEN.test(eventType ?? "")) return null;
    const q = await pool.query(
      "SELECT p.destination_node,p.event_type,p.policy_version,p.allowed_scope,p.max_ttl_ms,p.approval_provider,p.approval_authority,p.key_id,n.repository_full_name " +
      "FROM kratt_fabric_trust_policies p JOIN kratt_fabric_trusted_nodes s ON s.node_id=p.node_id " +
      "JOIN kratt_fabric_trusted_nodes n ON n.node_id=p.destination_node " +
      "WHERE p.node_id=$1 AND p.event_type=$2 AND p.status='ACTIVE' AND s.status='ACTIVE' AND n.status='ACTIVE'",
      [localNodeId, eventType]
    );
    const target = task.target.resource_id.toLowerCase();
    const matches = q.rows.filter(r => {
      const full = r.repository_full_name.toLowerCase();
      const short = full.split("/").at(-1);
      return [r.destination_node.toLowerCase(), full, short].includes(target);
    });
    if (matches.length !== 1) return null;
    const r = matches[0];
    return {
      status: "ACTIVE", source_node: localNodeId, destination_node: r.destination_node,
      revision: "p" + r.policy_version, approval_provider: r.approval_provider, approval_authority: r.approval_authority,
      allowed_event_types: [eventType], scope_by_event_type: { [eventType]: r.allowed_scope },
      max_ttl_ms: Number(r.max_ttl_ms), ...(r.key_id ? { key_id: r.key_id } : {})
    };
  }

  async function resolveActiveSigningIdentity({ keyId } = {}) {
    if (!localNodeId || !ID.test(keyId ?? "")) return null;
    const now = Date.parse(nowIso());
    const q = await pool.query(
      "SELECT k.node_id,k.key_id,k.public_key_pem,k.public_key_fingerprint,k.valid_from,k.sign_until " +
      "FROM kratt_fabric_trusted_keys k JOIN kratt_fabric_trusted_nodes n ON n.node_id=k.node_id " +
      "WHERE k.node_id=$1 AND k.key_id=$2 AND k.status='ACTIVE' AND n.status='ACTIVE'",
      [localNodeId, keyId]
    );
    if (q.rowCount !== 1) return null;
    const r = q.rows[0];
    const validFrom = Date.parse(iso(r.valid_from));
    const signUntil = r.sign_until ? Date.parse(iso(r.sign_until)) : null;
    if (now < validFrom || (signUntil !== null && now > signUntil)) return null;
    return {
      source_node: r.node_id, key_id: r.key_id, status: "ACTIVE", public_key: r.public_key_pem,
      fingerprint: r.public_key_fingerprint, valid_from: iso(r.valid_from),
      ...(r.sign_until ? { sign_until: iso(r.sign_until) } : {})
    };
  }

  async function resolveSourceRevision(nodeId = localNodeId) {
    if (!ID.test(nodeId ?? "")) return null;
    const q = await pool.query("SELECT repository_revision FROM kratt_fabric_trusted_nodes WHERE node_id=$1 AND status='ACTIVE'", [nodeId]);
    return q.rowCount === 1 ? q.rows[0].repository_revision : null;
  }

  async function verifyAuditChain() {
    const [rows, head] = await Promise.all([
      pool.query("SELECT sequence,record_json,previous_hash,record_hash FROM kratt_fabric_trust_audit ORDER BY sequence"),
      pool.query("SELECT last_sequence,last_hash FROM kratt_fabric_trust_audit_head WHERE singleton=TRUE")
    ]);
    if (head.rowCount !== 1) return fail("TRUST_AUDIT_HEAD_MISSING");
    let previous = ZERO_HASH;
    let sequence = 0;
    for (const row of rows.rows) {
      sequence += 1;
      if (Number(row.sequence) !== sequence || row.previous_hash !== previous) return fail("TRUST_AUDIT_CHAIN_INVALID");
      const expected = createHash("sha256").update(String(sequence) + "\n" + previous + "\n" + row.record_json, "utf8").digest("hex");
      if (expected !== row.record_hash) return fail("TRUST_AUDIT_HASH_INVALID");
      previous = row.record_hash;
    }
    if (Number(head.rows[0].last_sequence) !== sequence || head.rows[0].last_hash !== previous) return fail("TRUST_AUDIT_HEAD_MISMATCH");
    return ok({ valid: true, events: sequence, last_hash: previous });
  }

  return Object.freeze({
    registerNode, setNodeStatus, updateNodeRevision, registerKey, transitionKey, upsertPolicy,
    resolveTrustedKey, resolveNodePolicy, lockInboundAuthorization, lockReceiverSigningIdentity,
    lockTrustedReceiverAcknowledgementIdentity, resolveOutboundPolicy, resolveActiveSigningIdentity,
    resolveSourceRevision, verifyAuditChain
  });
}
