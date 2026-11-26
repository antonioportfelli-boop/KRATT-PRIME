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
  assert.equal(status.encrypted, null);
  assert.equal(status.remoteSync, null);
});

test("durable evidence retains the local-journal default when no scope is advertised", async () => {
  const store = memoryJournal(null);
  const repository = new DurableEvidenceRepository({ store });
  const status = await repository.verify();
  assert.equal(status.ok, true);
  assert.equal(status.scope, "SINGLE_PROCESS_LOCAL_JOURNAL");
});


function evidenceInput(eventId, resource) {
  return {
    rootId: "repo-shared",
    branchId: "feature-wave2",
    eventId,
    eventType: "ci.tests.passed",
    actorId: "ci-verifier",
    occurredAt: "2026-11-26T12:00:00.000Z",
    subject: "repo-shared",
    decision: "VERIFIED",
    sourceRef: { provider: "ci", resource, revision: "a".repeat(40) },
    artifactDigest: "sha256:" + "b".repeat(64),
    metadata: {
      policy_evidence: {
        schema_version: "kratt-policy-evidence/v1",
        claim_type: "TESTS_PASSED",
        verification_method: "ci-signature"
      }
    }
  };
}

test("independent evidence repositories refresh cards written by other runtime instances", async () => {
  const store = memoryJournal("POSTGRES_SHARED_DATABASE");
  const first = new DurableEvidenceRepository({ store });
  const second = new DurableEvidenceRepository({ store });

  const firstAppend = await first.append(evidenceInput("evidence-shared-1", "run-1"));
  assert.equal(firstAppend.ok, true);

  // The second repository was never restarted after the first append.
  const seenBySecond = await second.list();
  assert.equal(seenBySecond.ok, true);
  assert.equal(seenBySecond.count, 1);
  assert.equal(seenBySecond.cards[0].cardId, "evidence-shared-1");

  const secondAppend = await second.append(evidenceInput("evidence-shared-2", "run-2"));
  assert.equal(secondAppend.ok, true);

  // The first repository must refresh its in-memory ECK projection too.
  const seenByFirst = await first.list();
  assert.equal(seenByFirst.ok, true);
  assert.equal(seenByFirst.count, 2);
  assert.deepEqual(seenByFirst.cards.map(card => card.cardId), [
    "evidence-shared-1", "evidence-shared-2"
  ]);

  const status = await first.verify();
  assert.equal(status.ok, true);
  assert.equal(status.eventCount, 2);
  assert.equal(status.scope, "POSTGRES_SHARED_DATABASE");
});
