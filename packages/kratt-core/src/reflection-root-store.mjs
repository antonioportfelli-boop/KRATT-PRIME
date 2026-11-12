import { createHash } from "node:crypto";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ROOT_KEYS = new Set(["nodes", "edges", "metadata"]);
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_DELTA_BYTES = 131072;
const MAX_OPERATIONS = 256;

function canonical(value, active = new WeakSet(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`ROOT_NON_FINITE_NUMBER:${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object" || active.has(value)) throw new TypeError(`ROOT_NON_CANONICAL_VALUE:${path}`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`ROOT_ARRAY_SHAPE_INVALID:${path}`);
      const items = [];
      for (let i = 0; i < value.length; i += 1) {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d || !("value" in d) || !d.enumerable) throw new TypeError(`ROOT_ARRAY_ITEM_INVALID:${path}`);
        items.push(canonical(d.value, active, `${path}[${i}]`));
      }
      return `[${items.join(",")}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`ROOT_OBJECT_PROTOTYPE_INVALID:${path}`);
    const keys = Reflect.ownKeys(value);
    if (keys.some(k => typeof k !== "string" || FORBIDDEN_KEYS.has(k))) throw new TypeError(`ROOT_OBJECT_KEY_INVALID:${path}`);
    return `{${keys.sort().map(k => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d || !("value" in d) || !d.enumerable) throw new TypeError(`ROOT_ACCESSOR_REJECTED:${path}.${k}`);
      return `${JSON.stringify(k)}:${canonical(d.value, active, `${path}.${k}`)}`;
    }).join(",")}}`;
  } finally { active.delete(value); }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function cloneJson(value) {
  return JSON.parse(canonical(value));
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function rootDocumentValid(document) {
  return document && typeof document === "object" && !Array.isArray(document) &&
    Object.keys(document).length === ROOT_KEYS.size &&
    Object.keys(document).every(key => ROOT_KEYS.has(key)) &&
    Array.isArray(document.nodes) && Array.isArray(document.edges) &&
    document.metadata && typeof document.metadata === "object" && !Array.isArray(document.metadata);
}

function pointerParts(pointer) {
  if (typeof pointer !== "string" || pointer.length < 2 || pointer.length > 1024 || !pointer.startsWith("/")) {
    throw new TypeError("ROOT_DELTA_POINTER_INVALID");
  }
  const parts = pointer.slice(1).split("/").map(part => {
    if (/~(?![01])/.test(part)) throw new TypeError("ROOT_DELTA_POINTER_ESCAPE_INVALID");
    const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (FORBIDDEN_KEYS.has(decoded)) throw new TypeError("ROOT_DELTA_POINTER_FORBIDDEN_KEY");
    return decoded;
  });
  if (!ROOT_KEYS.has(parts[0])) throw new TypeError("ROOT_DELTA_PATH_OUTSIDE_MUTABLE_ROOT");
  if (parts.length < 2) throw new TypeError("ROOT_DELTA_ROOT_COLLECTION_REPLACEMENT_FORBIDDEN");
  return parts;
}

function arrayIndex(part, length, allowAppend) {
  if (allowAppend && part === "-") return length;
  if (!/^(0|[1-9][0-9]*)$/.test(part)) throw new TypeError("ROOT_DELTA_ARRAY_INDEX_INVALID");
  const index = Number(part);
  if (!Number.isSafeInteger(index) || index > length || (!allowAppend && index >= length)) {
    throw new TypeError("ROOT_DELTA_ARRAY_INDEX_OUT_OF_RANGE");
  }
  return index;
}

function applyOperation(document, operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation) ||
      !["add", "replace", "remove"].includes(operation.op) ||
      Object.keys(operation).some(key => !["op", "path", "value"].includes(key)) ||
      (operation.op === "remove" ? Object.hasOwn(operation, "value") : !Object.hasOwn(operation, "value"))) {
    throw new TypeError("ROOT_DELTA_OPERATION_INVALID");
  }
  const parts = pointerParts(operation.path);
  let parent = document;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, part)) throw new TypeError("ROOT_DELTA_PARENT_NOT_FOUND");
    parent = parent[part];
  }
  const leaf = parts.at(-1);
  if (!parent || typeof parent !== "object") throw new TypeError("ROOT_DELTA_PARENT_INVALID");
  if (Array.isArray(parent)) {
    const index = arrayIndex(leaf, parent.length, operation.op === "add");
    if (operation.op === "add") parent.splice(index, 0, cloneJson(operation.value));
    else if (operation.op === "replace") {
      if (index >= parent.length) throw new TypeError("ROOT_DELTA_TARGET_NOT_FOUND");
      parent[index] = cloneJson(operation.value);
    } else {
      if (index >= parent.length) throw new TypeError("ROOT_DELTA_TARGET_NOT_FOUND");
      parent.splice(index, 1);
    }
  } else {
    if (Object.getPrototypeOf(parent) !== Object.prototype && Object.getPrototypeOf(parent) !== null) throw new TypeError("ROOT_DELTA_PARENT_PROTOTYPE_INVALID");
    if (operation.op === "add") {
      if (Object.hasOwn(parent, leaf)) throw new TypeError("ROOT_DELTA_ADD_TARGET_EXISTS");
      parent[leaf] = cloneJson(operation.value);
    } else if (operation.op === "replace") {
      if (!Object.hasOwn(parent, leaf)) throw new TypeError("ROOT_DELTA_TARGET_NOT_FOUND");
      parent[leaf] = cloneJson(operation.value);
    } else {
      if (!Object.hasOwn(parent, leaf)) throw new TypeError("ROOT_DELTA_TARGET_NOT_FOUND");
      delete parent[leaf];
    }
  }
}

export function createRootSnapshot(document, { version = 0, createdAt = new Date().toISOString() } = {}) {
  if (!rootDocumentValid(document) || !Number.isSafeInteger(version) || version < 0 ||
      typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
    throw new TypeError("ROOT_SNAPSHOT_INPUT_INVALID");
  }
  const state = cloneJson(document);
  const digest = sha256(canonical(state));
  return freezeDeep({
    schemaVersion: "kratt-root-snapshot/v1",
    version,
    digest,
    document: state,
    createdAt,
  });
}

export function verifyReflectionRootBackup(backup, { validateDocument = () => true } = {}) {
  try {
    if (!backup || typeof backup !== "object" || Array.isArray(backup) ||
        backup.schemaVersion !== "kratt-reflection-root-backup/v1" ||
        typeof backup.backupDigest !== "string" || typeof validateDocument !== "function" ||
        !Array.isArray(backup.appliedProposals) || !Array.isArray(backup.audit) ||
        !Array.isArray(backup.migrations) || typeof backup.createdAt !== "string" ||
        !Number.isFinite(Date.parse(backup.createdAt))) return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_SHAPE_INVALID" });
    const payload = { ...backup };
    delete payload.backupDigest;
    if (sha256(canonical(payload)) !== backup.backupDigest) return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_DIGEST_INVALID" });
    const snapshot = backup.snapshot;
    if (!snapshot || snapshot.schemaVersion !== "kratt-root-snapshot/v1" ||
        !rootDocumentValid(snapshot.document) || !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 ||
        !Number.isFinite(Date.parse(snapshot.createdAt)) ||
        createRootSnapshot(snapshot.document, { version: snapshot.version, createdAt: snapshot.createdAt }).digest !== snapshot.digest ||
        validateDocument(snapshot.document) !== true) return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_SNAPSHOT_INVALID" });

    let previous = null, sequence = 0;
    const eventIds = new Set(), eventHashes = new Set();
    for (const row of backup.audit) {
      sequence += 1;
      if (!row || !row.event || row.event.sequence !== sequence ||
          row.event.previousHash !== previous || row.previousHash !== previous ||
          typeof row.event.eventId !== "string" || eventIds.has(row.event.eventId) ||
          typeof row.hash !== "string" || row.event.hash !== row.hash || eventHashes.has(row.hash)) {
        return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_AUDIT_CHAIN_INVALID" });
      }
      const body = { ...row.event };
      delete body.hash;
      if (sha256(canonical(body)) !== row.hash) return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_AUDIT_HASH_INVALID" });
      eventIds.add(row.event.eventId);
      eventHashes.add(row.hash);
      previous = row.hash;
    }
    const proposalIds = new Set(), decisionIds = new Set();
    for (const row of backup.appliedProposals) {
      if (!row || typeof row.proposal_id !== "string" || typeof row.proposal_digest !== "string" ||
          typeof row.decision_id !== "string" || proposalIds.has(row.proposal_id) || decisionIds.has(row.decision_id) ||
          !Number.isSafeInteger(Number(row.applied_root_version)) || Number(row.applied_root_version) < 1 ||
          Number(row.applied_root_version) > snapshot.version || !DIGEST.test(row.applied_root_digest) ||
          typeof row.applied_at !== "string" || !Number.isFinite(Date.parse(row.applied_at))) {
        return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_APPLIED_PROPOSAL_INVALID" });
      }
      proposalIds.add(row.proposal_id);
      decisionIds.add(row.decision_id);
    }
    if (!backup.migrations.some(row => row?.version === "001_root_cas_v1" && typeof row.appliedAt === "string" && Number.isFinite(Date.parse(row.appliedAt)))) {
      return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_MIGRATION_INVALID" });
    }
    return Object.freeze({ ok: true, auditCount: sequence, appliedProposalCount: proposalIds.size });
  } catch {
    return Object.freeze({ ok: false, reason: "REFLECTION_BACKUP_VERIFY_FAILED" });
  }
}

/** Restore a verified logical backup into an empty SQLite database only. */
export function restoreSqliteReflectionRootBackup(database, backup, {
  verifyProposal,
  now = () => new Date().toISOString(),
  validateDocument = () => true,
} = {}) {
  if (!database || typeof database.prepare !== "function" || typeof database.exec !== "function" ||
      typeof verifyProposal !== "function" || typeof now !== "function" || typeof validateDocument !== "function") {
    throw new TypeError("REFLECTION_BACKUP_RESTORE_ADAPTERS_REQUIRED");
  }
  const verified = verifyReflectionRootBackup(backup, { validateDocument });
  if (!verified.ok) throw new TypeError(verified.reason);
  const table = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kratt_reflection_root'").get();
  if (table) {
    const existing = database.prepare("SELECT 1 AS present FROM kratt_reflection_root WHERE singleton=1").get();
    if (existing) throw new Error("REFLECTION_BACKUP_RESTORE_TARGET_NOT_EMPTY");
  }
  const store = createSqliteReflectionRootStore(database, {
    initialSnapshot: backup.snapshot,
    verifyProposal,
    now,
    validateDocument,
  });
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec("DELETE FROM kratt_reflection_audit; DELETE FROM kratt_reflection_applied_proposals; DELETE FROM kratt_reflection_schema_migrations;");
    const insertAudit = database.prepare("INSERT INTO kratt_reflection_audit(sequence,event_id,event_json,previous_hash,event_hash) VALUES(?,?,?,?,?)");
    for (const row of backup.audit) insertAudit.run(row.event.sequence, row.event.eventId, canonical(row.event), row.previousHash, row.hash);
    const insertApplied = database.prepare("INSERT INTO kratt_reflection_applied_proposals(proposal_id,proposal_digest,decision_id,applied_root_version,applied_root_digest,applied_at) VALUES(?,?,?,?,?,?)");
    for (const row of backup.appliedProposals) insertApplied.run(row.proposal_id, row.proposal_digest, row.decision_id, row.applied_root_version, row.applied_root_digest, row.applied_at);
    const insertMigration = database.prepare("INSERT INTO kratt_reflection_schema_migrations(version,applied_at) VALUES(?,?)");
    for (const row of backup.migrations) insertMigration.run(row.version, row.appliedAt);
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  }
  return store;
}

export function validateRootDelta(delta) {
  try {
    if (!delta || typeof delta !== "object" || Array.isArray(delta) ||
        Object.keys(delta).length !== 2 || delta.schemaVersion !== "kratt-root-delta/v1" ||
        !Array.isArray(delta.operations) || delta.operations.length < 1 || delta.operations.length > MAX_OPERATIONS) {
      return Object.freeze({ ok: false, reason: "ROOT_DELTA_SCHEMA_INVALID" });
    }
    const encoded = canonical(delta);
    if (Buffer.byteLength(encoded, "utf8") > MAX_DELTA_BYTES) return Object.freeze({ ok: false, reason: "ROOT_DELTA_SIZE_LIMIT" });
    for (const op of delta.operations) {
      if (!op || typeof op !== "object" || Array.isArray(op) ||
          !["add", "replace", "remove"].includes(op.op) ||
          Object.keys(op).some(key => !["op", "path", "value"].includes(key)) ||
          (op.op === "remove" ? Object.hasOwn(op, "value") : !Object.hasOwn(op, "value"))) {
        return Object.freeze({ ok: false, reason: "ROOT_DELTA_OPERATION_INVALID" });
      }
      pointerParts(op.path);
      if (op.op !== "remove") canonical(op.value);
    }
    return Object.freeze({ ok: true, digest: sha256(encoded) });
  } catch (error) {
    return Object.freeze({ ok: false, reason: error instanceof Error ? error.message : "ROOT_DELTA_INVALID" });
  }
}

function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object" || proposal.schemaVersion !== "kratt-telegram-reflection-proposal/v1" ||
      proposal.status !== "PROPOSAL_ONLY" || proposal.applyStatus !== "NOT_APPLIED" ||
      typeof proposal.proposalId !== "string" || typeof proposal.decisionId !== "string" ||
      typeof proposal.requestId !== "string" || typeof proposal.claimId !== "string" ||
      !DIGEST.test(proposal.targetDigest) || !DIGEST.test(proposal.evidenceSnapshotDigest) ||
      !DIGEST.test(proposal.expectedRootDigest) || !DIGEST.test(proposal.rootDeltaDigest) ||
      !DIGEST.test(proposal.proposalDigest) || !Number.isSafeInteger(proposal.expectedRootVersion) ||
      proposal.expectedRootVersion < 0) return false;
  const delta = validateRootDelta(proposal.rootDelta);
  if (!delta.ok || delta.digest !== proposal.rootDeltaDigest) return false;
  const payload = { ...proposal };
  delete payload.proposalId;
  delete payload.proposalDigest;
  return sha256(canonical(payload)) === proposal.proposalDigest &&
    proposal.proposalId === `reflection-proposal:${proposal.proposalDigest.slice(7)}`;
}

/**
 * SQLite-backed single-host Reflection Matrix root.
 *
 * RootDelta V1 is a restricted JSON-Patch subset (add/replace/remove) over
 * /nodes, /edges and /metadata. Applying a proposal requires a synchronous,
 * trusted verifyProposal callback that re-checks the durable architect
 * decision/signature. This callback is deliberately mandatory; proposal
 * envelopes alone are not authorization.
 */
export function createSqliteReflectionRootStore(database, {
  initialSnapshot,
  verifyProposal,
  now = () => new Date().toISOString(),
  validateDocument = () => true,
} = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function" ||
      typeof verifyProposal !== "function" || typeof now !== "function" || typeof validateDocument !== "function") {
    throw new TypeError("REFLECTION_ROOT_STORE_ADAPTERS_REQUIRED");
  }
  if (initialSnapshot && (!rootDocumentValid(initialSnapshot.document) || validateDocument(initialSnapshot.document) !== true)) throw new TypeError("REFLECTION_ROOT_INITIAL_SNAPSHOT_INVALID");
  database.exec(`
    CREATE TABLE IF NOT EXISTS kratt_reflection_root (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      version INTEGER NOT NULL,
      digest TEXT NOT NULL,
      document_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kratt_reflection_applied_proposals (
      proposal_id TEXT PRIMARY KEY,
      proposal_digest TEXT NOT NULL,
      decision_id TEXT NOT NULL UNIQUE,
      applied_root_version INTEGER NOT NULL,
      applied_root_digest TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kratt_reflection_audit (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL,
      previous_hash TEXT,
      event_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS kratt_reflection_schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const getRow = database.prepare("SELECT version,digest,document_json,updated_at FROM kratt_reflection_root WHERE singleton=1");
  const insertRoot = database.prepare("INSERT OR IGNORE INTO kratt_reflection_root(singleton,version,digest,document_json,updated_at) VALUES(1,?,?,?,?)");
  const updateRoot = database.prepare("UPDATE kratt_reflection_root SET version=?,digest=?,document_json=?,updated_at=? WHERE singleton=1 AND version=? AND digest=?");
  const getApplied = database.prepare("SELECT proposal_digest,applied_root_version,applied_root_digest,applied_at FROM kratt_reflection_applied_proposals WHERE proposal_id=?");
  const insertApplied = database.prepare("INSERT INTO kratt_reflection_applied_proposals(proposal_id,proposal_digest,decision_id,applied_root_version,applied_root_digest,applied_at) VALUES(?,?,?,?,?,?)");
  const lastAudit = database.prepare("SELECT sequence,event_hash FROM kratt_reflection_audit ORDER BY sequence DESC LIMIT 1");
  const insertAudit = database.prepare("INSERT INTO kratt_reflection_audit(sequence,event_id,event_json,previous_hash,event_hash) VALUES(?,?,?,?,?)");
  const insertMigration = database.prepare("INSERT OR IGNORE INTO kratt_reflection_schema_migrations(version,applied_at) VALUES(?,?)");
  const getMigrations = database.prepare("SELECT version,applied_at FROM kratt_reflection_schema_migrations ORDER BY version");

  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); database.exec("COMMIT"); return result; }
    catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }
  function audit(event) {
    const previous = lastAudit.get();
    const sequence = Number(previous?.sequence ?? 0) + 1;
    const body = { ...event, sequence, previousHash: previous?.event_hash ?? null };
    const eventHash = sha256(canonical(body));
    insertAudit.run(sequence, event.eventId, canonical({ ...body, hash: eventHash }), body.previousHash, eventHash);
  }
  function readSnapshot() {
    const row = getRow.get();
    if (!row) return null;
    const document = JSON.parse(row.document_json);
    if (!rootDocumentValid(document) || validateDocument(document) !== true || sha256(canonical(document)) !== row.digest) throw new Error("REFLECTION_ROOT_STORAGE_INTEGRITY_FAILURE");
    return createRootSnapshot(document, { version: Number(row.version), createdAt: row.updated_at });
  }

  transaction(() => {
    const migrationAt = now();
    if (typeof migrationAt !== "string" || !Number.isFinite(Date.parse(migrationAt))) throw new Error("REFLECTION_ROOT_MIGRATION_CLOCK_INVALID");
    insertMigration.run("001_root_cas_v1", migrationAt);
    if (!getRow.get()) {
      if (!initialSnapshot) throw new Error("REFLECTION_ROOT_INITIAL_SNAPSHOT_REQUIRED");
      const seed = createRootSnapshot(initialSnapshot.document, { version: initialSnapshot.version ?? 0, createdAt: initialSnapshot.createdAt ?? now() });
      if (validateDocument(seed.document) !== true) throw new Error("REFLECTION_ROOT_ONTOLOGY_VALIDATION_FAILED");
      insertRoot.run(seed.version, seed.digest, canonical(seed.document), seed.createdAt);
      audit({ eventId: `root-seed:${seed.digest}`, type: "REFLECTION_ROOT_INITIALIZED", rootVersion: seed.version, rootDigest: seed.digest, occurredAt: seed.createdAt });
    }
  });

  function getSnapshot() {
    try { return Object.freeze({ status: "OK", snapshot: readSnapshot() }); }
    catch { return Object.freeze({ status: "ERROR", reason: "REFLECTION_ROOT_READ_FAILED" }); }
  }

  function applyProposal(proposal) {
    try {
      return transaction(() => {
        if (!validateProposal(proposal)) return Object.freeze({ status: "DENY", reason: "REFLECTION_PROPOSAL_INVALID" });
        const replay = getApplied.get(proposal.proposalId);
        if (replay) {
          if (replay.proposal_digest !== proposal.proposalDigest) return Object.freeze({ status: "BLOCKED", reason: "REFLECTION_PROPOSAL_ID_CONFLICT" });
          return Object.freeze({
            status: "ALREADY_APPLIED",
            appliedRootVersion: Number(replay.applied_root_version),
            appliedRootDigest: replay.applied_root_digest,
            appliedAt: replay.applied_at,
          });
        }
        const snapshot = readSnapshot();
        if (snapshot.version !== proposal.expectedRootVersion || snapshot.digest !== proposal.expectedRootDigest) {
          return Object.freeze({ status: "STALE", reason: "REFLECTION_ROOT_CAS_MISMATCH", currentRootVersion: snapshot.version, currentRootDigest: snapshot.digest });
        }
        let verified = false;
        try { verified = verifyProposal(proposal, snapshot) === true; } catch { verified = false; }
        if (!verified) return Object.freeze({ status: "DENY", reason: "REFLECTION_PROPOSAL_ARCHITECT_SIGNATURE_INVALID" });

        const validated = validateRootDelta(proposal.rootDelta);
        if (!validated.ok) return Object.freeze({ status: "DENY", reason: validated.reason });
        const nextDocument = cloneJson(snapshot.document);
        try {
          for (const operation of proposal.rootDelta.operations) applyOperation(nextDocument, operation);
        } catch {
          return Object.freeze({ status: "DENY", reason: "REFLECTION_ROOT_DELTA_APPLICATION_INVALID" });
        }
        if (!rootDocumentValid(nextDocument) || validateDocument(nextDocument) !== true) return Object.freeze({ status: "DENY", reason: "REFLECTION_ROOT_RESULT_INVALID" });
        const appliedAt = now();
        if (typeof appliedAt !== "string" || !Number.isFinite(Date.parse(appliedAt))) throw new Error("REFLECTION_ROOT_CLOCK_INVALID");
        const next = createRootSnapshot(nextDocument, { version: snapshot.version + 1, createdAt: appliedAt });
        if (Number(updateRoot.run(next.version, next.digest, canonical(next.document), appliedAt, snapshot.version, snapshot.digest).changes) !== 1) {
          return Object.freeze({ status: "STALE", reason: "REFLECTION_ROOT_CAS_MISMATCH" });
        }
        insertApplied.run(proposal.proposalId, proposal.proposalDigest, proposal.decisionId, next.version, next.digest, appliedAt);
        audit({
          eventId: `reflection-applied:${proposal.proposalId}`,
          type: "REFLECTION_ROOT_DELTA_APPLIED",
          proposalId: proposal.proposalId,
          proposalDigest: proposal.proposalDigest,
          decisionId: proposal.decisionId,
          requestId: proposal.requestId,
          previousRootVersion: snapshot.version,
          previousRootDigest: snapshot.digest,
          appliedRootVersion: next.version,
          appliedRootDigest: next.digest,
          occurredAt: appliedAt,
        });
        return Object.freeze({ status: "APPLIED", appliedRootVersion: next.version, appliedRootDigest: next.digest, appliedAt });
      });
    } catch {
      return Object.freeze({ status: "ERROR", reason: "REFLECTION_ROOT_TRANSACTION_FAILED" });
    }
  }

  function listAudit() {
    return database.prepare("SELECT event_json,event_hash,previous_hash FROM kratt_reflection_audit ORDER BY sequence").all().map(row => ({
      event: JSON.parse(row.event_json), hash: row.event_hash, previousHash: row.previous_hash,
    }));
  }
  function verifyAudit() {
    try {
      let previous = null, sequence = 0;
      for (const row of listAudit()) {
        sequence += 1;
        if (row.event.sequence !== sequence || row.event.previousHash !== previous || row.previousHash !== previous) return Object.freeze({ ok: false, sequence });
        const body = { ...row.event };
        delete body.hash;
        if (sha256(canonical(body)) !== row.hash || row.event.hash !== row.hash) return Object.freeze({ ok: false, sequence });
        previous = row.hash;
      }
      return Object.freeze({ ok: true, count: sequence, head: previous });
    } catch { return Object.freeze({ ok: false, reason: "REFLECTION_AUDIT_VERIFY_FAILED" }); }
  }

  function listMigrations() {
    return getMigrations.all().map(row => Object.freeze({ version: row.version, appliedAt: row.applied_at }));
  }

  function exportBackup() {
    const current = getSnapshot();
    const auditIntegrity = verifyAudit();
    const createdAt = now();
    if (current.status !== "OK" || !auditIntegrity.ok ||
        typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
      return Object.freeze({ status: "ERROR", reason: "REFLECTION_BACKUP_EXPORT_FAILED" });
    }
    const appliedProposals = database.prepare("SELECT proposal_id,proposal_digest,decision_id,applied_root_version,applied_root_digest,applied_at FROM kratt_reflection_applied_proposals ORDER BY applied_root_version,proposal_id").all();
    const payload = {
      schemaVersion: "kratt-reflection-root-backup/v1",
      createdAt,
      snapshot: current.snapshot,
      appliedProposals,
      audit: listAudit(),
      migrations: listMigrations(),
    };
    const backup = { ...payload, backupDigest: sha256(canonical(payload)) };
    return Object.freeze({ status: "OK", backup: freezeDeep(backup) });
  }

  return Object.freeze({ getSnapshot, applyProposal, listAudit, verifyAudit, listMigrations, exportBackup });
}
