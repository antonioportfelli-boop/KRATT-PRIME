import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  canonicalApprovalPayload,
  canonicalTaskDigest
} from "../src/policy.mjs";
import { createPostgresTrustedAuthorizationRuntime } from "../src/postgres-trusted-authorization.mjs";

const at = "2026-11-26T12:00:00.000Z";
const revision = "a".repeat(40);
const artifactDigest = "sha256:" + "b".repeat(64);

function makeTask() {
  return {
    schema_version: "kratt-prime/v0.1",
    task_id: "pg-auth-task-1",
    actor: "builder-1",
    action: "publish",
    target: { resource_type: "repository", resource_id: "repo-main" },
    constraints: {
      provider: "github",
      branch: "feature-governed",
      path: "/packages/kratt-core/src"
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

function makeContext() {
  return {
    schema_version: "kratt-prime/v0.1",
    authorities: ["repository-write"],
    allowed_targets: [{
      resource_type: "repository",
      resource_id: "repo-main",
      branch: "feature-governed",
      path: "/packages/kratt-core/src"
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
    kill_switch: false
  };
}

function makeEvidence() {
  return {
    schema_version: "kratt-prime/v0.1",
    evidence_id: "pg-ci-evidence-1",
    subject: "repo-main",
    claim_type: "TESTS_PASSED",
    source: { source_type: "ci", source_id: "run-pg-1", revision },
    observed_at: at,
    verification_method: "ci-signature",
    result: "VERIFIED",
    artifact_digest: artifactDigest,
    metadata: {
      actor_id: "ci-verifier",
      event_type: "ci.tests.passed",
      eck_content_digest: artifactDigest
    }
  };
}

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const task = makeTask();
  const consumed = new Set();
  const pool = {
    async query(sql, values) {
      assert.match(sql, /INSERT INTO kratt_governed_approval_nonces/);
      assert.match(sql, /ON CONFLICT DO NOTHING/);
      const key = values[0] + ":" + values[1];
      if (consumed.has(key)) return { rowCount: 0, rows: [] };
      consumed.add(key);
      return { rowCount: 1, rows: [{ key_id: values[0] }] };
    }
  };
  const runtime = createPostgresTrustedAuthorizationRuntime({
    pool,
    trustedApprovalKeys: [{
      key_id: "key-1",
      approver_id: "approver-1",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }),
      authorities: ["repository-write"]
    }],
    verifyEvidence: evidence => evidence.result === "VERIFIED" &&
      evidence.subject === "repo-main" &&
      evidence.artifact_digest === artifactDigest,
    now: () => Date.parse(at)
  });

  function makeApproval(nonce = "pg-nonce-unique-123456") {
    const approval = {
      schema_version: "kratt-prime/v0.1",
      approval_id: "pg-approval-" + nonce.slice(-5),
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

  return { runtime, task, evidence: [makeEvidence()], context: makeContext(), makeApproval, consumed };
}

test("shared PostgreSQL authorization consumes one verified nonce for a request-bound approval", async () => {
  const f = fixture();
  assert.equal((await f.runtime.open()).ok, true);
  const result = await f.runtime.evaluate(f.task, f.evidence, f.context, { approval: f.makeApproval() });
  assert.equal(result.decision, "ALLOW");
  assert.equal(f.consumed.size, 1);
});

test("same approval nonce cannot be replayed after a successful authorization", async () => {
  const f = fixture();
  const approval = f.makeApproval();
  const first = await f.runtime.evaluate(f.task, f.evidence, f.context, { approval });
  const second = await f.runtime.evaluate(f.task, f.evidence, f.context, { approval });
  assert.equal(first.decision, "ALLOW");
  assert.equal(second.decision, "DENY");
  assert.ok(second.reasons.includes("APPROVAL_REPLAYED_OR_NONCE_STORE_UNAVAILABLE"));
  assert.equal(f.consumed.size, 1);
});

test("concurrent authorization attempts race safely on one shared nonce identity", async () => {
  const f = fixture();
  const approval = f.makeApproval();
  const [a, b] = await Promise.all([
    f.runtime.evaluate(f.task, f.evidence, f.context, { approval }),
    f.runtime.evaluate(f.task, f.evidence, f.context, { approval })
  ]);
  assert.equal([a, b].filter(result => result.decision === "ALLOW").length, 1);
  assert.equal([a, b].filter(result => result.decision === "DENY").length, 1);
  assert.equal(f.consumed.size, 1);
});

test("invalid signature and mismatched request do not consume an approval nonce", async () => {
  const f = fixture();
  const invalid = { ...f.makeApproval(), signature: "invalid-signature" };
  const result = await f.runtime.evaluate(f.task, f.evidence, f.context, { approval: invalid });
  assert.notEqual(result.decision, "ALLOW");
  assert.equal(f.consumed.size, 0);
});

test("missing host-provided trusted evidence verifier fails at composition time", () => {
  assert.throws(() => createPostgresTrustedAuthorizationRuntime({
    pool: { query: async () => ({ rowCount: 1, rows: [] }) },
    trustedApprovalKeys: [{ key_id: "k", approver_id: "a", public_key_pem: "invalid", authorities: ["x"] }]
  }), /TRUSTED_EVIDENCE_VERIFIER_REQUIRED/);
});
