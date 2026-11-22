import test from "node:test";
import assert from "node:assert/strict";
import { createPostgresSemanticMemoryStore } from "../src/postgres-semantic-memory-store.mjs";

const ZERO = "0".repeat(64);
function mockPool({ initialized = true } = {}) {
  const state = { sequence: 0, hash: ZERO, events: [], calls: [] };
  const pool = {
    state,
    async connect() {
      return {
        async query(sql, values = []) {
          const normalized = sql.replace(/\s+/g, " ").trim();
          state.calls.push({ sql: normalized, values });
          if (["BEGIN", "COMMIT", "ROLLBACK", "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"].includes(normalized)) return { rowCount: 0, rows: [] };
          if (normalized.includes("SELECT sequence,record_json,previous_hash,hash FROM kratt_semantic_memory_events WHERE memory_id=$1")) {
            const row = state.events.find(item => item.memory_id === values[0]);
            return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
          }
          if (normalized.includes("SELECT sequence,hash FROM kratt_semantic_memory_head")) {
            return { rowCount: initialized ? 1 : 0, rows: initialized ? [{ sequence: state.sequence, hash: state.hash }] : [] };
          }
          if (normalized.startsWith("INSERT INTO kratt_semantic_memory_events")) {
            const [sequence, memory_id, recordJson, previous_hash, hash] = values;
            const record = JSON.parse(recordJson);
            const row = { sequence, memory_id, record_json: record, previous_hash, hash };
            state.events.push(row);
            return { rowCount: 1, rows: [] };
          }
          if (normalized.startsWith("UPDATE kratt_semantic_memory_head")) {
            state.sequence = values[0]; state.hash = values[1];
            return { rowCount: 1, rows: [] };
          }
          if (normalized.includes("SELECT sequence,memory_id,record_json,previous_hash,hash FROM kratt_semantic_memory_events WHERE")) {
            const [after, kind] = values;
            const rows = state.events.filter(item => item.sequence > after && (!kind || item.record_json.kind === kind));
            return { rowCount: rows.length, rows };
          }
          if (normalized.includes("SELECT sequence,memory_id,record_json,previous_hash,hash FROM kratt_semantic_memory_events ORDER BY sequence")) {
            return { rowCount: state.events.length, rows: [...state.events] };
          }
          if (normalized.includes("SELECT sequence,hash FROM kratt_semantic_memory_head WHERE singleton=TRUE")) {
            return { rowCount: initialized ? 1 : 0, rows: initialized ? [{ sequence: state.sequence, hash: state.hash }] : [] };
          }
          throw new Error("Unexpected SQL: " + normalized);
        },
        release() {}
      };
    },
    async query(sql, values) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      if (normalized.includes("WHERE memory_id=$1")) {
        const row = state.events.find(item => item.memory_id === values[0]);
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (normalized.includes("WHERE sequence>$1")) {
        const [after, kind] = values;
        const rows = state.events.filter(item => item.sequence > after && (!kind || item.record_json.kind === kind));
        return { rowCount: rows.length, rows };
      }
      throw new Error("Unexpected pool SQL: " + normalized);
    }
  };
  return pool;
}
const record = (payload = "semantic") => ({
  id: "word-semantic:record-01", kind: "WORD_SEMANTIC_RECORD",
  createdAt: "2026-11-22T10:00:00.000Z", payload: { value: payload }
});

test("appends a durable semantic record and verifies the hash chain", async () => {
  const pool = mockPool();
  const store = createPostgresSemanticMemoryStore(pool);
  const result = await store.append(record());
  assert.equal(result.ok, true);
  assert.equal(result.duplicate, false);
  assert.equal(store.durable, true);
  assert.equal((await store.verify()).ok, true);
  assert.equal((await store.list({ kind: "WORD_SEMANTIC_RECORD" })).length, 1);
  assert.ok(pool.state.calls.some(call => call.sql === "COMMIT"));
});

test("same id and same canonical payload is idempotent", async () => {
  const store = createPostgresSemanticMemoryStore(mockPool());
  const first = await store.append(record());
  const replay = await store.append(record());
  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.entry.hash, first.entry.hash);
});

test("same id with changed payload is rejected", async () => {
  const store = createPostgresSemanticMemoryStore(mockPool());
  await store.append(record());
  const collision = await store.append(record("changed"));
  assert.equal(collision.ok, false);
  assert.equal(collision.reason, "SEMANTIC_MEMORY_ID_COLLISION");
});

test("missing initialized head fails closed and rolls back", async () => {
  const pool = mockPool({ initialized: false });
  const result = await createPostgresSemanticMemoryStore(pool).append(record());
  assert.equal(result.reason, "SEMANTIC_MEMORY_HEAD_NOT_INITIALIZED");
  assert.ok(pool.state.calls.some(call => call.sql === "ROLLBACK"));
});

test("record validation rejects non-JSON payloads", async () => {
  const store = createPostgresSemanticMemoryStore(mockPool());
  const invalid = record();
  invalid.payload = { secret: undefined };
  assert.equal((await store.append(invalid)).ok, false);
});

test("verify detects a modified event hash", async () => {
  const pool = mockPool();
  const store = createPostgresSemanticMemoryStore(pool);
  await store.append(record());
  pool.state.events[0].hash = "f".repeat(64);
  const result = await store.verify();
  assert.equal(result.ok, false);
  assert.equal(result.broken_sequence, 1);
});
