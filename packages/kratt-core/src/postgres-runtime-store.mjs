import { createHash } from "node:crypto";

export const POSTGRES_RUNTIME_JOURNAL_SCHEMA = "kratt-runtime-journal/v1";
const HEAD_TABLE = "kratt_runtime_journal_head";
const ENTRY_TABLE = "kratt_runtime_journal_entries";
const GENESIS = "0".repeat(64);
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;

function normalizeJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 100_000 || depth > 32) throw new TypeError("RUNTIME_JOURNAL_VALUE_LIMIT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("RUNTIME_JOURNAL_NON_FINITE_NUMBER");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 20_000) throw new TypeError("RUNTIME_JOURNAL_ARRAY_LIMIT");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      throw new TypeError("RUNTIME_JOURNAL_ARRAY_SHAPE_INVALID");
    }
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("RUNTIME_JOURNAL_ARRAY_ACCESSOR_OR_HOLE");
      }
      result.push(normalizeJson(descriptor.value, depth + 1, budget));
    }
    return result;
  }
  if (!value || typeof value !== "object") throw new TypeError("RUNTIME_JOURNAL_VALUE_NOT_JSON");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("RUNTIME_JOURNAL_VALUE_NOT_PLAIN");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length > 2_048 || keys.some(key =>
    typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) {
    throw new TypeError("RUNTIME_JOURNAL_OBJECT_KEYS_INVALID");
  }
  const result = Object.create(null);
  for (const key of keys.sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError("RUNTIME_JOURNAL_ACCESSOR_REJECTED");
    }
    result[key] = normalizeJson(descriptor.value, depth + 1, budget);
  }
  return result;
}

function canonical(value) {
  return JSON.stringify(normalizeJson(value));
}
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const toSafeSequence = value => {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
};

function verifyRows(headRow, rows) {
  const headSequence = toSafeSequence(headRow?.sequence);
  const headHash = typeof headRow?.hash === "string" ? headRow.hash.trim() : "";
  if (headSequence === null || !HASH.test(headHash) || !Array.isArray(rows)) {
    throw new Error("POSTGRES_RUNTIME_JOURNAL_HEAD_INVALID");
  }
  let sequence = 0;
  let previousHash = GENESIS;
  const ids = new Set();
  const entries = [];
  for (const row of rows) {
    sequence += 1;
    const rowSequence = toSafeSequence(row.sequence);
    const id = row.entry_id;
    const key = row.record_key;
    const storedPrevious = typeof row.previous_hash === "string" ? row.previous_hash.trim() : "";
    const storedHash = typeof row.entry_hash === "string" ? row.entry_hash.trim() : "";
    if (rowSequence !== sequence || !KEY.test(id ?? "") || !KEY.test(key ?? "") ||
        ids.has(id) || storedPrevious !== previousHash || !HASH.test(storedHash)) {
      throw new Error("POSTGRES_RUNTIME_JOURNAL_LINK_INVALID");
    }
    let expected;
    try {
      expected = sha256(canonical({
        sequence, id, key, value: row.value, previousHash
      }));
    } catch {
      throw new Error("POSTGRES_RUNTIME_JOURNAL_VALUE_INVALID");
    }
    if (expected !== storedHash) throw new Error("POSTGRES_RUNTIME_JOURNAL_HASH_MISMATCH");
    ids.add(id);
    entries.push(Object.freeze({
      sequence, id, key, value: structuredClone(normalizeJson(row.value)), hash: storedHash
    }));
    previousHash = storedHash;
  }
  if (headSequence !== sequence || headHash !== previousHash) {
    throw new Error("POSTGRES_RUNTIME_JOURNAL_HEAD_MISMATCH");
  }
  return { entries, sequence, headHash };
}

async function readSnapshot(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const head = await client.query(
      "SELECT sequence, hash FROM " + HEAD_TABLE + " WHERE singleton = TRUE"
    );
    const rows = await client.query(
      "SELECT sequence, entry_id, record_key, value, previous_hash, entry_hash FROM " +
      ENTRY_TABLE + " ORDER BY sequence ASC"
    );
    if (head.rowCount !== 1) throw new Error("POSTGRES_RUNTIME_JOURNAL_NOT_MIGRATED");
    const snapshot = verifyRows(head.rows[0], rows.rows);
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function inTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    if (result?.ok === false) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

/**
 * PostgreSQL-backed implementation of the PrimeStore journal interface.
 *
 * Writers serialize on a singleton head row inside a database transaction.
 * The adapter requires migration 0002; it never performs DDL at startup.
 * It does not claim encryption-at-rest, backups, replication or exactly-once
 * external effects: those remain database/deployment responsibilities.
 */
export function createPostgresRuntimeStore(pool, { maxEntryBytes = 1_048_576 } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") throw new TypeError("POSTGRES_POOL_REQUIRED");
  if (!Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1_024 || maxEntryBytes > 16_777_216) {
    throw new TypeError("POSTGRES_RUNTIME_ENTRY_LIMIT_INVALID");
  }

  async function open() {
    const result = await pool.query(
      "SELECT sequence, hash FROM " + HEAD_TABLE + " WHERE singleton = TRUE"
    );
    if (result.rowCount !== 1) throw new Error("POSTGRES_RUNTIME_JOURNAL_NOT_MIGRATED");
    return store;
  }

  async function put({ idempotencyKey, key, value } = {}) {
    if (!KEY.test(idempotencyKey ?? "") || !KEY.test(key ?? "")) {
      throw new TypeError("STORE_KEY_INVALID");
    }
    const valueJson = canonical(value);
    if (Buffer.byteLength(valueJson, "utf8") > maxEntryBytes) {
      throw new TypeError("POSTGRES_RUNTIME_ENTRY_TOO_LARGE");
    }
    const normalizedValue = JSON.parse(valueJson);
    return inTransaction(pool, async client => {
      const head = await client.query(
        "SELECT sequence, hash FROM " + HEAD_TABLE + " WHERE singleton = TRUE FOR UPDATE"
      );
      if (head.rowCount !== 1) throw new Error("POSTGRES_RUNTIME_JOURNAL_NOT_MIGRATED");

      // Check after taking the singleton lock so concurrent writers cannot
      // both observe a missing idempotency key and append the same identity.
      const existing = await client.query(
        "SELECT sequence FROM " + ENTRY_TABLE + " WHERE entry_id = $1",
        [idempotencyKey]
      );
      if (existing.rowCount > 0) {
        return Object.freeze({ ok: true, duplicate: true, sequence: null });
      }

      const currentSequence = toSafeSequence(head.rows[0].sequence);
      const previousHash = typeof head.rows[0].hash === "string" ? head.rows[0].hash.trim() : "";
      if (currentSequence === null || !HASH.test(previousHash) || currentSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("POSTGRES_RUNTIME_JOURNAL_HEAD_INVALID");
      }
      const sequence = currentSequence + 1;
      const payload = { sequence, id: idempotencyKey, key, value: normalizedValue, previousHash };
      const entryHash = sha256(canonical(payload));
      await client.query(
        "INSERT INTO " + ENTRY_TABLE +
        " (sequence, entry_id, record_key, value, previous_hash, entry_hash) " +
        "VALUES ($1, $2, $3, $4::jsonb, $5, $6)",
        [sequence, idempotencyKey, key, valueJson, previousHash, entryHash]
      );
      await client.query(
        "UPDATE " + HEAD_TABLE + " SET sequence = $1, hash = $2 WHERE singleton = TRUE",
        [sequence, entryHash]
      );
      return Object.freeze({ ok: true, duplicate: false, sequence, hash: entryHash });
    });
  }

  async function readAll() {
    const snapshot = await readSnapshot(pool);
    return Object.freeze(snapshot.entries.map(entry => Object.freeze({
      sequence: entry.sequence,
      id: entry.id,
      key: entry.key,
      value: structuredClone(entry.value),
      hash: entry.hash
    })));
  }

  async function verify() {
    const snapshot = await readSnapshot(pool);
    return Object.freeze({ ok: true, count: snapshot.sequence, headHash: snapshot.headHash });
  }

  async function status() {
    const verification = await verify();
    return Object.freeze({
      loaded: true,
      entries: verification.count,
      headHash: verification.headHash,
      encrypted: null,
      remoteSync: null,
      scope: "POSTGRES_SHARED_DATABASE"
    });
  }

  const store = Object.freeze({ open, put, readAll, verify, status });
  return store;
}
