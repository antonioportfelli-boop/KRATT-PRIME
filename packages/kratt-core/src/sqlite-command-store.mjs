import { createHash, randomBytes } from "node:crypto";

const AUDIT_SCHEMA = "kratt-audit/v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const EVENT_TYPE = /^[a-z][a-z0-9]*(?:\.[a-z0-9_-]+){1,5}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ZERO_HASH = "0".repeat(64);

function plainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableJson(value, depth = 0, seen = new WeakSet()) {
  if (depth > 12) throw new TypeError("AUDIT_RECORD_TOO_DEEP");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== "object" || seen.has(value)) throw new TypeError("AUDIT_RECORD_NOT_JSON");
  seen.add(value);
  let output;
  if (Array.isArray(value)) {
    output = "[" + value.map(item => stableJson(item, depth + 1, seen)).join(",") + "]";
  } else {
    if (!plainObject(value)) throw new TypeError("AUDIT_RECORD_NOT_PLAIN");
    const keys = Reflect.ownKeys(value);
    if (keys.length > 128 || keys.some(key => typeof key !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(key))) throw new TypeError("AUDIT_RECORD_KEYS_INVALID");
    const entries = keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("AUDIT_ACCESSOR_REJECTED");
      return JSON.stringify(key) + ":" + stableJson(descriptor.value, depth + 1, seen);
    });
    output = "{" + entries.join(",") + "}";
  }
  seen.delete(value);
  return output;
}

function validateAuditRecord(record) {
  if (!plainObject(record)) return false;
  const keys = Reflect.ownKeys(record);
  if (keys.some(key => typeof key !== "string" || !Object.hasOwn(Object.getOwnPropertyDescriptor(record, key) ?? {}, "value"))) return false;
  if (record.schema_version !== AUDIT_SCHEMA ||
      typeof record.event_id !== "string" || !ID.test(record.event_id) ||
      typeof record.event_type !== "string" || !EVENT_TYPE.test(record.event_type) ||
      typeof record.created_at !== "string" || !ISO_UTC.test(record.created_at) ||
      !Number.isFinite(Date.parse(record.created_at)) ||
      typeof record.actor_id !== "string" || !ID.test(record.actor_id) ||
      typeof record.task_id !== "string" || !ID.test(record.task_id)) return false;
  try { return Buffer.byteLength(stableJson(record), "utf8") <= 32_768; }
  catch { return false; }
}

function hashEntry(sequence, previousHash, recordJson) {
  return createHash("sha256")
    .update(String(sequence) + "\n" + previousHash + "\n" + recordJson, "utf8")
    .digest("hex");
}

function runTransaction(database, work) {
  let active = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    active = true;
    const result = work();
    if (result !== true) {
      database.exec("ROLLBACK");
      active = false;
      return false;
    }
    database.exec("COMMIT");
    active = false;
    return true;
  } catch {
    if (active) {
      try { database.exec("ROLLBACK"); } catch { /* preserve fail-closed result */ }
    }
    return false;
  }
}

/**
 * Durable SQLite command/audit store for a single-host KRATT runtime.
 *
 * Use Node DatabaseSync or better-sqlite3. The database file must live on
 * durable local storage. Multi-host deployments need a shared transactional
 * adapter implementing the same public methods.
 */
export function createSqliteCommandStore(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("SQLITE_DATABASE_SYNC_REQUIRED");
  }

  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS kratt_dispatch_intents (
      idempotency_key TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('INTENT_COMMITTED','COMPLETED','FAILED')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS kratt_dispatch_intents_task_idx
      ON kratt_dispatch_intents(task_id);
    CREATE TABLE IF NOT EXISTS kratt_cancelled_tasks (
      task_id TEXT PRIMARY KEY,
      cancelled_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS kratt_dispatch_delivery_starts (
      idempotency_key TEXT PRIMARY KEY REFERENCES kratt_dispatch_intents(idempotency_key),
      task_id TEXT NOT NULL,
      delivery_token TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS kratt_dispatch_delivery_starts_task_idx
      ON kratt_dispatch_delivery_starts(task_id);
    CREATE TRIGGER IF NOT EXISTS kratt_delivery_starts_no_update
      BEFORE UPDATE ON kratt_dispatch_delivery_starts
      BEGIN SELECT RAISE(ABORT, 'KRATT_DELIVERY_START_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS kratt_delivery_starts_no_delete
      BEFORE DELETE ON kratt_dispatch_delivery_starts
      BEGIN SELECT RAISE(ABORT, 'KRATT_DELIVERY_START_APPEND_ONLY'); END;
    CREATE TABLE IF NOT EXISTS kratt_audit_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      record_json TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      hash TEXT NOT NULL UNIQUE
    );
    CREATE TRIGGER IF NOT EXISTS kratt_audit_no_update
      BEFORE UPDATE ON kratt_audit_events
      BEGIN SELECT RAISE(ABORT, 'KRATT_AUDIT_APPEND_ONLY'); END;
    CREATE TRIGGER IF NOT EXISTS kratt_audit_no_delete
      BEFORE DELETE ON kratt_audit_events
      BEGIN SELECT RAISE(ABORT, 'KRATT_AUDIT_APPEND_ONLY'); END;
  `);

  const latestAudit = database.prepare(
    "SELECT sequence, hash FROM kratt_audit_events ORDER BY sequence DESC LIMIT 1"
  );
  const insertAudit = database.prepare(
    "INSERT INTO kratt_audit_events (sequence,event_id,event_type,created_at,record_json,previous_hash,hash) VALUES (?,?,?,?,?,?,?)"
  );
  const cancelledTask = database.prepare(
    "SELECT task_id FROM kratt_cancelled_tasks WHERE task_id = ?"
  );
  const insertIntent = database.prepare(
    "INSERT OR IGNORE INTO kratt_dispatch_intents (idempotency_key,task_id,status,created_at,updated_at) VALUES (?,?, 'INTENT_COMMITTED', ?, ?)"
  );
  const findIntent = database.prepare(
    "SELECT idempotency_key,task_id,status,created_at,updated_at FROM kratt_dispatch_intents WHERE idempotency_key = ?"
  );
  const updateIntentStatus = database.prepare(
    "UPDATE kratt_dispatch_intents SET status = ?, updated_at = ? WHERE idempotency_key = ? AND status = 'INTENT_COMMITTED'"
  );
  const insertDeliveryStart = database.prepare(
    "INSERT OR IGNORE INTO kratt_dispatch_delivery_starts (idempotency_key,task_id,delivery_token,started_at) VALUES (?,?,?,?)"
  );
  const findDeliveryStart = database.prepare(
    "SELECT idempotency_key,task_id,delivery_token,started_at FROM kratt_dispatch_delivery_starts WHERE idempotency_key = ?" 
  );
  const deliveryStartedForTask = database.prepare(
    "SELECT idempotency_key FROM kratt_dispatch_delivery_starts WHERE task_id = ? LIMIT 1"
  );
  const insertCancelled = database.prepare(
    "INSERT OR IGNORE INTO kratt_cancelled_tasks (task_id,cancelled_at) VALUES (?,?)"
  );
  const readAudit = database.prepare(
    "SELECT sequence,event_id,event_type,created_at,record_json,previous_hash,hash FROM kratt_audit_events WHERE sequence > ? ORDER BY sequence LIMIT ?"
  );
  const readAllAudit = database.prepare(
    "SELECT sequence,event_id,event_type,created_at,record_json,previous_hash,hash FROM kratt_audit_events ORDER BY sequence"
  );

  function appendAuditRecord(record) {
    if (!validateAuditRecord(record)) return false;
    const recordJson = stableJson(record);
    const latest = latestAudit.get();
    const sequence = latest ? Number(latest.sequence) + 1 : 1;
    const previousHash = latest?.hash ?? ZERO_HASH;
    const hash = hashEntry(sequence, previousHash, recordJson);
    const result = insertAudit.run(
      sequence, record.event_id, record.event_type, record.created_at,
      recordJson, previousHash, hash
    );
    return Number(result.changes) === 1;
  }

  function appendDecision(record) {
    return runTransaction(database, () => appendAuditRecord(record));
  }

  function commitAuthorizedIntent({ idempotencyKey, taskId, record } = {}) {
    if (typeof idempotencyKey !== "string" || !/^kratt:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}:[a-f0-9]{64}$/.test(idempotencyKey) ||
        typeof taskId !== "string" || !ID.test(taskId) ||
        !validateAuditRecord(record) ||
        record.event_type !== "dispatch.intent_committed" ||
        record.task_id !== taskId || record.idempotency_key !== idempotencyKey) return false;

    return runTransaction(database, () => {
      if (cancelledTask.get(taskId)) return false;
      const inserted = insertIntent.run(idempotencyKey, taskId, record.created_at, record.created_at);
      if (Number(inserted.changes) !== 1) return false;
      return appendAuditRecord(record);
    });
  }

  function beginAuthorizedDelivery({ idempotencyKey, taskId, actorId, at } = {}) {
    if (typeof idempotencyKey !== "string" || !/^kratt:[A-Za-z0-9][A-Za-z0-9._:-]{0,191}:[a-f0-9]{64}$/.test(idempotencyKey) ||
        typeof taskId !== "string" || !ID.test(taskId) || typeof actorId !== "string" || !ID.test(actorId) ||
        typeof at !== "string" || !ISO_UTC.test(at) || !Number.isFinite(Date.parse(at))) {
      return { ok: false, reason: "DELIVERY_START_INPUT_INVALID" };
    }
    const deliveryToken = randomBytes(32).toString("hex");
    const tokenDigest = createHash("sha256").update(deliveryToken, "utf8").digest("hex");
    const eventId = "delivery-start:" + createHash("sha256").update(idempotencyKey, "utf8").digest("hex");
    const record = {
      schema_version: AUDIT_SCHEMA,
      event_id: eventId,
      event_type: "dispatch.delivery_started",
      created_at: at,
      actor_id: actorId,
      task_id: taskId,
      idempotency_key: idempotencyKey,
      delivery_token_digest: tokenDigest
    };
    const committed = runTransaction(database, () => {
      if (cancelledTask.get(taskId)) return false;
      const intent = findIntent.get(idempotencyKey);
      if (!intent || intent.task_id !== taskId || intent.status !== "INTENT_COMMITTED") return false;
      const inserted = insertDeliveryStart.run(idempotencyKey, taskId, deliveryToken, at);
      if (Number(inserted.changes) !== 1) return false;
      return appendAuditRecord(record);
    });
    return committed ? { ok: true, deliveryToken } : { ok: false, reason: "DELIVERY_START_DENIED_OR_DUPLICATE" };
  }

  function appendOutcome({ idempotencyKey, deliveryToken, record } = {}) {
    if (typeof idempotencyKey !== "string" ||
        typeof deliveryToken !== "string" || !/^[a-f0-9]{64}$/.test(deliveryToken) ||
        !validateAuditRecord(record) ||
        !["dispatch.completed", "dispatch.failed"].includes(record.event_type) ||
        record.idempotency_key !== idempotencyKey) return false;

    return runTransaction(database, () => {
      const intent = findIntent.get(idempotencyKey);
      const delivery = findDeliveryStart.get(idempotencyKey);
      if (!intent || intent.task_id !== record.task_id || intent.status !== "INTENT_COMMITTED" ||
          !delivery || delivery.task_id !== record.task_id || delivery.delivery_token !== deliveryToken) return false;
      if (!appendAuditRecord(record)) return false;
      const status = record.event_type === "dispatch.completed" ? "COMPLETED" : "FAILED";
      const updated = updateIntentStatus.run(status, record.created_at, idempotencyKey);
      return Number(updated.changes) === 1;
    });
  }

  function cancelTask({ taskId, actorId, at } = {}) {
    if (typeof taskId !== "string" || !ID.test(taskId) ||
        typeof actorId !== "string" || !ID.test(actorId) ||
        typeof at !== "string" || !ISO_UTC.test(at) || !Number.isFinite(Date.parse(at))) return false;
    const record = {
      schema_version: AUDIT_SCHEMA,
      event_id: "cancel:" + createHash("sha256").update(taskId + ":" + at).digest("hex"),
      event_type: "task.cancelled",
      created_at: at,
      actor_id: actorId,
      task_id: taskId,
    };
    return runTransaction(database, () => {
      if (deliveryStartedForTask.get(taskId)) return false;
      const inserted = insertCancelled.run(taskId, at);
      if (Number(inserted.changes) !== 1) return false;
      return appendAuditRecord(record);
    });
  }

  function listAuditEvents({ afterSequence = 0, limit = 100 } = {}) {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("AUDIT_QUERY_INVALID");
    }
    return readAudit.all(afterSequence, limit).map(row => ({
      sequence: Number(row.sequence),
      record: JSON.parse(row.record_json),
      previous_hash: row.previous_hash,
      hash: row.hash,
    }));
  }

  function verifyAuditChain() {
    const rows = readAllAudit.all();
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;
    for (const row of rows) {
      const sequence = Number(row.sequence);
      if (sequence !== expectedSequence || row.previous_hash !== previousHash ||
          hashEntry(sequence, previousHash, row.record_json) !== row.hash) {
        return { ok: false, count: rows.length, broken_sequence: sequence };
      }
      let record;
      try { record = JSON.parse(row.record_json); } catch {
        return { ok: false, count: rows.length, broken_sequence: sequence };
      }
      if (!validateAuditRecord(record) || record.event_id !== row.event_id ||
          record.event_type !== row.event_type || record.created_at !== row.created_at) {
        return { ok: false, count: rows.length, broken_sequence: sequence };
      }
      previousHash = row.hash;
      expectedSequence += 1;
    }
    return { ok: true, count: rows.length };
  }

  return Object.freeze({
    appendDecision,
    commitAuthorizedIntent,
    beginAuthorizedDelivery,
    appendOutcome,
    cancelTask,
    listAuditEvents,
    verifyAuditChain,
  });
}
