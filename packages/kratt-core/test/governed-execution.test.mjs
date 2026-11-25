import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { PrimeStore } from "../src/prime-store.mjs";
import { createConstructionTask, transitionConstructionTask } from "../src/construction-protocol.mjs";
import { canonicalApprovalPayload, canonicalTaskDigest } from "../src/policy.mjs";
import { createTrustedAuthorizationRuntime } from "../src/trusted-runtime.mjs";
import { DurableEvidenceRepository } from "../../kratt-runtime/src/durable-evidence.mjs";
import { createGovernedExecutionRuntime } from "../../kratt-runtime/src/governed-execution.mjs";

const at = "2026-11-26T12:00:00.000Z";
const revision = "a".repeat(40);
const artifactDigest = `sha256:${"b".repeat(64)}`;
const taskId = "governed-task-01";
const principal = Object.freeze({ credential: "test-credential" });

function makeTask() {
  return {
    schema_version: "kratt-prime/v0.1",
    task_id: taskId,
    actor: "builder-1",
    action: "publish",
    target: { resource_type: "repository", resource_id: "repo-main" },
    constraints: {
      provider: "github",
      branch: "feature/governed",
      path: "packages/kratt-core/src"
    },
    required_evidence: [{
      claim_type: "TESTS_PASSED",
      subject: "repo-main",
      required: true,
      revision
    }],
    created_at: at,
    requested_authority: ["repository-write"],
    status: "PENDING"
  };
}

function makeConstructionTask() {
  const created = createConstructionTask({
    goal: "Perform the approved repository construction operation",
    base_commit: revision,
    target_scope: ["packages/kratt-core/src"],
    required_evidence: ["unit-tests"],
    builder_id: "builder-1"
  }, { now: () => at, id: () => taskId });
  assert.equal(created.ok, true);
  const review = transitionConstructionTask(created.task, {
    to: "IN_REVIEW", actor_id: "reviewer-1", at
  });
  assert.equal(review.ok, true);
  const approved = transitionConstructionTask(review.task, {
    to: "APPROVED", actor_id: "reviewer-1", evidence_refs: ["approval-reference-1"], at
  });
  assert.equal(approved.ok, true);
  return approved.task;
}

const evidenceCardInput = () => ({
  rootId: "repo-main",
  branchId: "feature/governed",
  eventId: "evidence-tests-01",
  eventType: "ci.tests.passed",
  actorId: "ci-verifier",
  occurredAt: at,
  subject: "repo-main",
  decision: "VERIFIED",
  sourceRef: { provider: "ci", resource: "run-2026-11-26", revision },
  artifactDigest,
  metadata: {
    policy_evidence: {
      schema_version: "kratt-policy-evidence/v1",
      claim_type: "TESTS_PASSED",
      verification_method: "ci-signature"
    }
  }
});

function trustedContext({ killSwitch = false } = {}) {
  return {
    schema_version: "kratt-prime/v0.1",
    authorities: ["repository-write"],
    allowed_targets: [{
      resource_type: "repository",
      resource_id: "repo-main",
      branch: "feature/governed",
      path: "packages/kratt-core/src"
    }],
    policies: [{
      action: "publish",
      required_authority: "repository-write",
      target_types: ["repository"],
      side_effect_class: "EXTERNAL_WRITE",
      approval_required: true,
      approval_authority: "repository-write",
      required_claims: ["TESTS_PASSED"]
    }],
    evaluated_at: at,
    expires_at: "2026-11-26T12:15:00.000Z",
    kill_switch: killSwitch
  };
}

async function withRuntime(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "kratt-governed-execution-"));
  try {
    let currentMs = Date.parse(at);
    const nowEpochMs = () => currentMs;
    const nowIso = () => new Date(currentMs).toISOString();
    const store = new PrimeStore({ path: join(directory, "prime.ndjson") });
    const evidenceRepository = new DurableEvidenceRepository({ store });
    const appended = await evidenceRepository.append(evidenceCardInput());
    assert.equal(appended.ok, true);

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const consumedNonces = new Set();
    const authorizationRuntime = createTrustedAuthorizationRuntime({
      trustedApprovalKeys: [{
        key_id: "key-1",
        approver_id: "approver-1",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
        authorities: ["repository-write"]
      }],
      nonceStore: {
        consume(keyId, nonce, approvalId) {
          const key = `${keyId}:${nonce}:${approvalId}`;
          if (consumedNonces.has(key)) return false;
          consumedNonces.add(key);
          return true;
        }
      },
      verifyEvidence: evidence => evidence.result === "VERIFIED" &&
        evidence.subject === "repo-main" && /^sha256:[a-f0-9]{64}$/.test(evidence.metadata.eck_content_digest),
      now: nowEpochMs
    });

    const task = makeTask();
    const constructionTask = makeConstructionTask();
    let context = trustedContext({ killSwitch: options.killSwitch === true });
    const runtime = createGovernedExecutionRuntime({
      store,
      evidenceRepository,
      authorizationRuntime,
      authenticatePrincipal: async () => ({ id: "builder-1", active: true }),
      loadTrustedContext: async () => context,
      verifyEvidenceProvenance: async (record, { card }) =>
        record.evidence_id === card.cardId &&
        record.metadata.eck_content_digest === card.contentDigest &&
        card.evidence.decision === "VERIFIED" &&
        card.rootId === "repo-main",
      nowEpochMs,
      nowIso,
      leaseTtlMs: 60_000,
      cancelWorker: async () => options.cancelAcknowledged === true
    });

    function makeApproval(nonce = "nonce-unique-1234567890") {
      const approval = {
        schema_version: "kratt-prime/v0.1",
        approval_id: `approval-${nonce.slice(-4)}`,
        task_id: task.task_id,
        actor: task.actor,
        provider: task.constraints.provider,
        operation: task.action,
        target: task.target,
        request_digest: canonicalTaskDigest(task),
        key_id: "key-1",
        nonce,
        issued_at: at,
        expires_at: "2026-11-26T12:04:00.000Z",
        decision: "APPROVE",
        approved_by: "approver-1",
        authority: "repository-write",
        signature: "pending"
      };
      const payload = canonicalApprovalPayload(approval);
      assert.equal(typeof payload, "string");
      return {
        ...approval,
        signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url")
      };
    }

    await run({
      runtime, store, evidenceRepository, authorizationRuntime, task, constructionTask,
      makeApproval, nowEpochMs, nowIso,
      setCurrentMs(value) { currentMs = value; },
      setContext(value) { context = value; }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("WP-01 approval + verified ECK provenance + fenced lease govern execution lifecycle", async () => withRuntime(async fixture => {
  const { runtime, task, constructionTask, makeApproval } = fixture;
  const authorized = await runtime.authorizeAndClaim({
    principal, task, constructionTask, approval: makeApproval()
  });
  assert.equal(authorized.ok, true);
  assert.equal(authorized.state, "CLAIMED");
  assert.equal(authorized.dispatch, false);
  assert.equal(authorized.executionStarted, false);
  assert.equal(authorized.authorization.decision, "ALLOW");
  assert.equal(authorized.evidence_ids.length, 1);
  assert.equal(authorized.lease.fencing_token, 1);

  const started = await runtime.start({
    principal, task, constructionTask, record: authorized.record
  });
  assert.equal(started.ok, true);
  assert.equal(started.state, "RUNNING");
  assert.equal(started.dispatch, false);
  assert.equal(started.externalEffects, false);

  const completed = await runtime.complete({
    principal, task, constructionTask, record: started.record,
    resultDigest: `sha256:${"c".repeat(64)}`
  });
  assert.equal(completed.ok, true);
  assert.equal(completed.state, "SUCCEEDED");
  assert.equal(completed.lease_released, true);

  const recovered = await runtime.recover();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.count, 1);
  assert.equal(recovered.records[0].state, "SUCCEEDED");
  assert.equal(recovered.records[0].revision, 3);
  assert.equal((await runtime.status()).activeLeaseCount, 0);
}));

test("missing request-bound approval is denied before a lease is acquired", async () => withRuntime(async fixture => {
  const result = await fixture.runtime.authorizeAndClaim({
    principal, task: fixture.task, constructionTask: fixture.constructionTask
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "AUTHORIZATION_NOT_ALLOWED");
  assert.equal((await fixture.runtime.status()).reservationCount, 0);
}));

test("unverified evidence provenance blocks authorization and lease acquisition", async () => withRuntime(async fixture => {
  // Replace the adapter with a runtime whose evidence provenance callback fails closed.
  const directoryStore = fixture.store;
  const alternate = createGovernedExecutionRuntime({
    store: directoryStore,
    evidenceRepository: fixture.evidenceRepository,
    authorizationRuntime: {
      evaluate: (...args) => fixture.runtime.authorizationRuntime?.evaluate?.(...args) ??
        { decision: "BLOCKED", reasons: ["not wired"], evidence_ids: [] }
    },
    authenticatePrincipal: async () => ({ id: "builder-1", active: true }),
    loadTrustedContext: async () => trustedContext(),
    verifyEvidenceProvenance: async () => false,
    nowEpochMs: fixture.nowEpochMs,
    nowIso: fixture.nowIso
  });
  const result = await alternate.authorizeAndClaim({
    principal, task: fixture.task, constructionTask: fixture.constructionTask,
    approval: fixture.makeApproval("nonce-provenance-123456")
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "POLICY_EVIDENCE_PROVENANCE_REJECTED");
  assert.equal((await alternate.status()).reservationCount, 0);
}));

test("retry appends a new execution revision and advances the fencing token", async () => withRuntime(async fixture => {
  const first = await fixture.runtime.authorizeAndClaim({
    principal, task: fixture.task, constructionTask: fixture.constructionTask,
    approval: fixture.makeApproval("nonce-first-1234567890")
  });
  assert.equal(first.ok, true);
  const running = await fixture.runtime.start({
    principal, task: fixture.task, constructionTask: fixture.constructionTask, record: first.record
  });
  assert.equal(running.ok, true);
  const failed = await fixture.runtime.fail({
    principal, task: fixture.task, constructionTask: fixture.constructionTask,
    record: running.record, reason: "transient provider interruption", retryable: true
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.state, "RETRY_WAIT");

  const second = await fixture.runtime.authorizeAndClaim({
    principal, task: fixture.task, constructionTask: fixture.constructionTask,
    executionRecord: failed.record,
    approval: fixture.makeApproval("nonce-second-1234567890")
  });
  assert.equal(second.ok, true);
  assert.equal(second.state, "CLAIMED");
  assert.equal(second.record.attempts, 2);
  assert.equal(second.lease.fencing_token, 2);
  const recovered = await fixture.runtime.recover();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.records[0].revision, second.record.revision);
}));

test("kill switch blocks execution before consuming a lease", async () => withRuntime(async fixture => {
  const result = await fixture.runtime.authorizeAndClaim({
    principal, task: fixture.task, constructionTask: fixture.constructionTask,
    approval: fixture.makeApproval()
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "TRUSTED_CONTEXT_STALE_OR_KILL_SWITCHED");
  assert.equal((await fixture.runtime.status()).reservationCount, 0);
}, { killSwitch: true }));

test("expired worker lease prevents the workflow from entering RUNNING", async () => withRuntime(async fixture => {
  const authorized = await fixture.runtime.authorizeAndClaim({
    principal, task: fixture.task, constructionTask: fixture.constructionTask,
    approval: fixture.makeApproval()
  });
  assert.equal(authorized.ok, true);
  fixture.setCurrentMs(Date.parse(at) + 61_000);
  const result = await fixture.runtime.start({
    principal, task: fixture.task, constructionTask: fixture.constructionTask, record: authorized.record
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "WORKER_LEASE_NOT_CURRENT");
}));
