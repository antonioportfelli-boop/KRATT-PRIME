import { createHash } from "node:crypto";

const KINDS = new Set(["SOURCE", "SEGMENT", "CLAIM", "EVIDENCE", "CONTRADICTION", "DECISION", "BRANCH_RUN", "REFLECTION_NOTE", "AGENT_STATE"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function canonical(value, active = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("MEMORY_NON_FINITE_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object" || active.has(value)) throw new TypeError("MEMORY_VALUE_INVALID");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("MEMORY_ARRAY_INVALID");
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("MEMORY_ARRAY_ITEM_INVALID");
        items.push(canonical(descriptor.value, active));
      }
      return `[${items.join(",")}]`;
    }
    if (!plain(value)) throw new TypeError("MEMORY_OBJECT_INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))) throw new TypeError("MEMORY_KEY_INVALID");
    return `{${keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("MEMORY_ACCESSOR_INVALID");
      return `${JSON.stringify(key)}:${canonical(descriptor.value, active)}`;
    }).join(",")}}`;
  } finally { active.delete(value); }
}
const hash = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function validateRecord(record) {
  if (!plain(record) || Object.keys(record).sort().join("|") !== [
    "createdAt", "id", "kind", "parentId", "payload", "provenance", "schemaVersion", "scope",
  ].join("|")) return false;
  if (record.schemaVersion !== "kratt-memory-record/v1" ||
      typeof record.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(record.id) ||
      !KINDS.has(record.kind) ||
      !(record.parentId === null || (typeof record.parentId === "string" && record.parentId.length > 0)) ||
      typeof record.createdAt !== "string" || !ISO_UTC.test(record.createdAt) || !Number.isFinite(Date.parse(record.createdAt)) ||
      !plain(record.scope) || !DIGEST.test(record.scope.rootDigest) ||
      !Number.isSafeInteger(record.scope.rootVersion) || record.scope.rootVersion < 0 ||
      !plain(record.provenance) || !Array.isArray(record.provenance.sourceIds) ||
      !Array.isArray(record.provenance.evidenceIds) || !plain(record.payload)) return false;
  try { canonical(record); return true; } catch { return false; }
}

/** Single-host SQLite typed memory with parent scopes and a hash-linked append-only journal. */
export function createSqliteTypedMemoryStore(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("TYPED_MEMORY_SQLITE_DATABASE_REQUIRED");
  }
  database.exec(`
    CREATE TABLE IF NOT EXISTS kratt_typed_memory (
      sequence INTEGER PRIMARY KEY,
      record_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL,
      record_digest TEXT NOT NULL,
      parent_id TEXT,
      root_digest TEXT NOT NULL,
      root_version INTEGER NOT NULL,
      previous_hash TEXT,
      entry_hash TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS kratt_typed_memory_parent_idx ON kratt_typed_memory(parent_id, sequence);
    CREATE INDEX IF NOT EXISTS kratt_typed_memory_kind_idx ON kratt_typed_memory(sequence);
  `);
  const getById = database.prepare("SELECT sequence,record_json,record_digest,parent_id,root_digest,root_version,previous_hash,entry_hash FROM kratt_typed_memory WHERE record_id=?");
  const last = database.prepare("SELECT sequence,entry_hash FROM kratt_typed_memory ORDER BY sequence DESC LIMIT 1");
  const insert = database.prepare("INSERT INTO kratt_typed_memory(sequence,record_id,record_json,record_digest,parent_id,root_digest,root_version,previous_hash,entry_hash) VALUES(?,?,?,?,?,?,?,?,?)");

  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); database.exec("COMMIT"); return result; }
    catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }

  function append(record) {
    try {
      if (!validateRecord(record)) return Object.freeze({ status: "DENY", reason: "TYPED_MEMORY_RECORD_INVALID" });
      const recordJson = canonical(record);
      const recordDigest = hash(recordJson);
      return transaction(() => {
        const existing = getById.get(record.id);
        if (existing) return existing.record_digest === recordDigest
          ? Object.freeze({ status: "ALREADY_EXISTS", sequence: Number(existing.sequence), digest: recordDigest })
          : Object.freeze({ status: "BLOCKED", reason: "TYPED_MEMORY_ID_CONFLICT" });
        if (record.parentId !== null) {
          const parent = getById.get(record.parentId);
          if (!parent) return Object.freeze({ status: "DENY", reason: "TYPED_MEMORY_PARENT_NOT_FOUND" });
          if (parent.root_digest !== record.scope.rootDigest || Number(parent.root_version) !== record.scope.rootVersion) {
            return Object.freeze({ status: "DENY", reason: "TYPED_MEMORY_PARENT_SCOPE_MISMATCH" });
          }
        }
        const previous = last.get();
        const sequence = Number(previous?.sequence ?? 0) + 1;
        const previousHash = previous?.entry_hash ?? null;
        const entryHash = hash(canonical({ sequence, recordDigest, previousHash }));
        insert.run(sequence, record.id, recordJson, recordDigest, record.parentId, record.scope.rootDigest,
          record.scope.rootVersion, previousHash, entryHash);
        return Object.freeze({ status: "APPENDED", sequence, digest: recordDigest, entryHash });
      });
    } catch {
      return Object.freeze({ status: "ERROR", reason: "TYPED_MEMORY_APPEND_FAILED" });
    }
  }

  function get(id) {
    const row = getById.get(id);
    if (!row) return null;
    return Object.freeze({
      sequence: Number(row.sequence),
      record: JSON.parse(row.record_json),
      recordDigest: row.record_digest,
      previousHash: row.previous_hash,
      entryHash: row.entry_hash,
    });
  }

  function list({ kind, parentId, limit = 100 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return Object.freeze([]);
    const rows = database.prepare(`
      SELECT sequence,record_json,record_digest,parent_id,root_digest,root_version,previous_hash,entry_hash
      FROM kratt_typed_memory ORDER BY sequence DESC LIMIT ?
    `).all(limit);
    return rows.filter(row => (!kind || JSON.parse(row.record_json).kind === kind) &&
      (parentId === undefined || row.parent_id === parentId)).reverse().map(row => Object.freeze({
        sequence: Number(row.sequence), record: JSON.parse(row.record_json), recordDigest: row.record_digest,
        previousHash: row.previous_hash, entryHash: row.entry_hash,
      }));
  }

  function verify() {
    try {
      const rows = database.prepare("SELECT sequence,record_id,record_json,record_digest,parent_id,root_digest,root_version,previous_hash,entry_hash FROM kratt_typed_memory ORDER BY sequence").all();
      let previousHash = null, sequence = 0;
      const seen = new Map();
      for (const row of rows) {
        sequence += 1;
        const record = JSON.parse(row.record_json);
        const recordDigest = hash(canonical(record));
        if (Number(row.sequence) !== sequence || !validateRecord(record) || record.id !== row.record_id ||
            recordDigest !== row.record_digest || row.previous_hash !== previousHash ||
            row.root_digest !== record.scope.rootDigest || Number(row.root_version) !== record.scope.rootVersion ||
            row.parent_id !== record.parentId) return Object.freeze({ ok: false, sequence });
        if (record.parentId !== null) {
          const parent = seen.get(record.parentId);
          if (!parent || parent.rootDigest !== record.scope.rootDigest || parent.rootVersion !== record.scope.rootVersion) {
            return Object.freeze({ ok: false, sequence, reason: "TYPED_MEMORY_PARENT_CHAIN_INVALID" });
          }
        }
        const expected = hash(canonical({ sequence, recordDigest, previousHash }));
        if (expected !== row.entry_hash) return Object.freeze({ ok: false, sequence });
        seen.set(record.id, { rootDigest: row.root_digest, rootVersion: Number(row.root_version) });
        previousHash = row.entry_hash;
      }
      return Object.freeze({ ok: true, count: sequence, head: previousHash });
    } catch {
      return Object.freeze({ ok: false, reason: "TYPED_MEMORY_VERIFY_FAILED" });
    }
  }

  return Object.freeze({ append, get, list, verify });
}
