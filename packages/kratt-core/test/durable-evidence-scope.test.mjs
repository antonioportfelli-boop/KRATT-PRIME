import test from "node:test";
import assert from "node:assert/strict";
import { DurableEvidenceRepository } from "../../kratt-runtime/src/durable-evidence.mjs";

function memoryJournal(scope) {
  const entries = [];
  let sequence = 0;
  let headHash = "0".repeat(64);
  return {
    async open() { return this; },
    async put({ idempotencyKey, key, value }) {
      if (entries.some(entry => entry.id === idempotencyKey)) {
        return { ok: true, duplicate: true, sequence: null };
      }
      sequence += 1;
      headHash = sequence.toString(16).padStart(64, "0");
      entries.push({ sequence, id: idempotencyKey, key, value, hash: headHash });
      return { ok: true, duplicate: false, sequence, hash: headHash };
    },
    async readAll() { return entries.slice(); },
    async verify() { return { ok: true, count: entries.length, headHash }; },
    async status() {
      return {
        loaded: true, entries: entries.length, headHash,
        encrypted: null, remoteSync: null, ...(scope ? { scope } : {})
      };
    }
  };
}

test("durable evidence reports a shared injected journal scope without claiming encryption", async () => {
  const store = memoryJournal("POSTGRES_SHARED_DATABASE");
  const repository = new DurableEvidenceRepository({ store });
  const status = await repository.verify();
  assert.equal(status.ok, true);
  assert.equal(status.scope, "POSTGRES_SHARED_DATABASE");
  assert.equal(status.encrypted, false);
  assert.equal(status.remoteSync, false);
});

test("durable evidence retains the local-journal default when no scope is advertised", async () => {
  const store = memoryJournal(null);
  const repository = new DurableEvidenceRepository({ store });
  const status = await repository.verify();
  assert.equal(status.ok, true);
  assert.equal(status.scope, "SINGLE_PROCESS_LOCAL_JOURNAL");
});
