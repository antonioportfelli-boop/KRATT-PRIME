import { createHash } from "node:crypto";

const ZERO = "0".repeat(64);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) {
    if (value.some((item, index) => !(index in value) || item === undefined)) {
      throw new TypeError("SEMANTIC_MEMORY_ARRAY_VALUE_INVALID");
    }
    return "[" + value.map(stable).join(",") + "]";
  }
  if (!plain(value)) throw new TypeError("SEMANTIC_MEMORY_RECORD_NOT_JSON");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) throw new TypeError("SEMANTIC_MEMORY_SYMBOL_KEY");
  return "{" + keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("SEMANTIC_MEMORY_ACCESSOR_REJECTED");
    return JSON.stringify(key) + ":" + stable(descriptor.value);
  }).join(",") + "}";
}
const sha256 = value => createHash("sha256").update(value, "utf8").digest("hex");
const recordHash = (sequence, previousHash, recordJson) => sha256(String(sequence) + "\n" + previousHash + "\n" + recordJson);
function parseJson(value) {
  if (typeof value === "string") { try { return JSON.parse(value); } catch { return null; } }
  return plain(value) || Array.isArray(value) ? value : null;
}
function entryFromRow(row) {
  const record = parseJson(row.record_json);
  if (!record) throw new Error("SEMANTIC_MEMORY_RECORD_JSON_INVALID");
  return { sequence: Number(row.sequence), record, hash: String(row.hash).trim() };
}
async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    if (result === false || (result && result.ok === false)) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally { client.release(); }
}

/**
 * Durable append-only PostgreSQL adapter for the semantic evidence bridge.
 * Apply migration 0005_semantic_memory.sql first. Use a dedicated runtime role
 * with SELECT/INSERT on events and SELECT/UPDATE on the singleton head only.
 */
export function createPostgresSemanticMemoryStore(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("SEMANTIC_POSTGRES_POOL_REQUIRED");
  }

  async function append(record) {
    if (!plain(record) || !ID.test(record.id ?? "") || !ID.test(record.kind ?? "")
        || typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt))
        || !Object.hasOwn(record, "payload")) return { ok: false, reason: "INVALID_MEMORY_RECORD" };
    let recordJson;
    try { recordJson = stable(record); }
    catch { return { ok: false, reason: "SEMANTIC_MEMORY_RECORD_NOT_CANONICAL_JSON" }; }
    if (Buffer.byteLength(recordJson, "utf8") > 2_000_000) return { ok: false, reason: "SEMANTIC_MEMORY_RECORD_TOO_LARGE" };

    return transaction(pool, async client => {
      // Serialize all appends before checking the ID. A unique-ID race cannot
      // turn a replay into a database exception or admit a changed payload.
      const headResult = await client.query(
        "SELECT sequence,hash FROM kratt_semantic_memory_head WHERE singleton=TRUE FOR UPDATE");
      const head = headResult.rows?.[0];
      if (!head) return { ok: false, reason: "SEMANTIC_MEMORY_HEAD_NOT_INITIALIZED" };

      const existing = await client.query(
        "SELECT sequence,record_json,previous_hash,hash FROM kratt_semantic_memory_events WHERE memory_id=$1",
        [record.id]);
      if (existing.rowCount === 1) {
        const prior = entryFromRow(existing.rows[0]);
        if (stable(prior.record) !== recordJson) return { ok: false, reason: "SEMANTIC_MEMORY_ID_COLLISION" };
        return { ok: true, duplicate: true, entry: prior };
      }
      if (!head) return { ok: false, reason: "SEMANTIC_MEMORY_HEAD_NOT_INITIALIZED" };
      const sequence = Number(head.sequence) + 1;
      const previousHash = String(head.hash).trim();
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !/^[a-f0-9]{64}$/.test(previousHash)) {
        return { ok: false, reason: "SEMANTIC_MEMORY_HEAD_INVALID" };
      }
      const hash = recordHash(sequence, previousHash, recordJson);
      await client.query(
        "INSERT INTO kratt_semantic_memory_events(sequence,memory_id,record_json,previous_hash,hash) VALUES($1,$2,$3::jsonb,$4,$5)",
        [sequence, record.id, recordJson, previousHash, hash]);
      await client.query(
        "UPDATE kratt_semantic_memory_head SET sequence=$1,hash=$2 WHERE singleton=TRUE",
        [sequence, hash]);
      return { ok: true, duplicate: false, entry: { sequence, record: structuredClone(record), hash } };
    });
  }

  async function getById(id) {
    if (!ID.test(id ?? "")) throw new TypeError("SEMANTIC_MEMORY_ID_INVALID");
    const result = await pool.query(
      "SELECT sequence,memory_id,record_json,previous_hash,hash FROM kratt_semantic_memory_events WHERE memory_id=$1",
      [id]);
    return result.rows?.[0] ? entryFromRow(result.rows[0]) : null;
  }

  async function list({ kind, afterSequence = 0 } = {}) {
    if (kind !== undefined && !ID.test(kind ?? "")) throw new TypeError("SEMANTIC_MEMORY_KIND_INVALID");
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new TypeError("SEMANTIC_MEMORY_SEQUENCE_INVALID");
    const values = [afterSequence];
    let where = "sequence>$1";
    if (kind !== undefined) { values.push(kind); where += " AND record_json->>'kind'=$2"; }
    const result = await pool.query(
      "SELECT sequence,memory_id,record_json,previous_hash,hash FROM kratt_semantic_memory_events WHERE " + where + " ORDER BY sequence",
      values);
    return (result.rows ?? []).map(entryFromRow);
  }

  async function verify() {
    const client = await pool.connect();
    let inTransaction = false;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      inTransaction = true;
      const events = await client.query(
        "SELECT sequence,memory_id,record_json,previous_hash,hash FROM kratt_semantic_memory_events ORDER BY sequence");
      const headResult = await client.query(
        "SELECT sequence,hash FROM kratt_semantic_memory_head WHERE singleton=TRUE");
      await client.query("COMMIT");
      inTransaction = false;
      let previous = ZERO;
      let expected = 1;
      for (const row of events.rows ?? []) {
        const sequence = Number(row.sequence);
        const record = parseJson(row.record_json);
        if (!record || sequence !== expected || row.previous_hash !== previous
            || record.id !== row.memory_id || recordHash(sequence, previous, stable(record)) !== String(row.hash).trim()) {
          return { ok: false, count: events.rows.length, broken_sequence: sequence };
        }
        previous = String(row.hash).trim();
        expected += 1;
      }
      const head = headResult.rows?.[0];
      if (!head || Number(head.sequence) !== (events.rows ?? []).length || String(head.hash).trim() !== previous) {
        return { ok: false, count: (events.rows ?? []).length, broken_sequence: expected };
      }
      return { ok: true, count: expected - 1, head_hash: previous };
    } catch {
      if (inTransaction) { try { await client.query("ROLLBACK"); } catch {} }
      return { ok: false, reason: "SEMANTIC_MEMORY_CHAIN_READ_FAILED" };
    } finally { client.release(); }
  }

  return Object.freeze({ durable: true, append, getById, list, verify });
}
