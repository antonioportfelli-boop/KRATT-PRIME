import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createSqliteTypedMemoryStore } from "../src/typed-memory-store.mjs";

const rootDigest = `sha256:${createHash("sha256").update("root", "utf8").digest("hex")}`;
const scope = { rootDigest, rootVersion: 4 };
const now = "2026-11-10T15:00:00.000Z";
function record(id, kind, parentId, payload, recordScope = scope) {
  return {
    schemaVersion: "kratt-memory-record/v1",
    id, kind, parentId, createdAt: now,
    scope: recordScope,
    provenance: { sourceIds: [], evidenceIds: [] },
    payload,
  };
}

test("typed memory persists hierarchical parent scope and idempotent appends", () => {
  const directory = mkdtempSync(join(tmpdir(), "kratt-memory-"));
  const path = join(directory, "memory.sqlite");
  const firstDb = new DatabaseSync(path);
  const secondDb = new DatabaseSync(path);
  try {
    const first = createSqliteTypedMemoryStore(firstDb);
    const root = record("run-1", "BRANCH_RUN", null, { status: "PROPOSAL_ONLY" });
    const child = record("claim-memory-1", "CLAIM", "run-1", { claimId: "claim-1", state: "UNREVIEWED" });
    assert.equal(first.append(root).status, "APPENDED");
    assert.equal(first.append(child).status, "APPENDED");
    assert.equal(first.append(child).status, "ALREADY_EXISTS");

    const second = createSqliteTypedMemoryStore(secondDb);
    assert.equal(second.get("claim-memory-1").record.parentId, "run-1");
    assert.equal(second.list({ kind: "CLAIM", parentId: "run-1" }).length, 1);
    assert.equal(second.verify().ok, true);
    assert.equal(second.verify().count, 2);
  } finally {
    firstDb.close();
    secondDb.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("typed memory rejects missing parents, scope changes and identifier reuse", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSqliteTypedMemoryStore(db);
    assert.equal(store.append(record("orphan", "CLAIM", "missing", {})).reason, "TYPED_MEMORY_PARENT_NOT_FOUND");
    assert.equal(store.append(record("root", "BRANCH_RUN", null, {})).status, "APPENDED");
    assert.equal(store.append(record("child", "CLAIM", "root", {}, { rootDigest, rootVersion: 5 })).reason, "TYPED_MEMORY_PARENT_SCOPE_MISMATCH");
    assert.equal(store.append(record("root", "BRANCH_RUN", null, { changed: true })).reason, "TYPED_MEMORY_ID_CONFLICT");
    assert.equal(store.verify().ok, true);
    assert.equal(store.verify().count, 1);
  } finally { db.close(); }
});

test("typed memory verifier detects record and journal tampering", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = createSqliteTypedMemoryStore(db);
    assert.equal(store.append(record("root", "BRANCH_RUN", null, { status: "PROPOSAL_ONLY" })).status, "APPENDED");
    db.prepare("UPDATE kratt_typed_memory SET record_json=? WHERE record_id=?")
      .run(JSON.stringify(record("root", "BRANCH_RUN", null, { status: "APPROVED" })), "root");
    assert.equal(store.verify().ok, false);
  } finally { db.close(); }
});
