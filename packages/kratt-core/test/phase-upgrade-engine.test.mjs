import test from "node:test";
import assert from "node:assert/strict";
import { createPhaseUpgradeEngine } from "../src/phase-upgrade-engine.mjs";

const NOW = "2026-11-21T12:00:00.000Z";
const future = "2026-11-21T13:00:00.000Z";
const sourceRevision = "d".repeat(40);

function hardware(devices = [{
  id: "npu0",
  kind: "NPU",
  state: "AVAILABLE",
  backends: [{ id: "openvino", kind: "OpenVINO", state: "AVAILABLE", stages: ["PREFILL"] }]
}]) {
  return {
    schemaVersion: "0.2.0",
    platform: "linux",
    architecture: "x86_64",
    observedAt: 1794000000000,
    devices
  };
}

function createHarness(options = {}) {
  const runs = new Map();
  const events = [];
  const leases = new Set();
  const commits = [];
  const store = {
    async findByIdempotencyKey(key) {
      return [...runs.values()].find(run => run.idempotencyKey === key) ?? null;
    },
    async createRun(run) { runs.set(run.runId, structuredClone(run)); return run; },
    async getRun(id) { return runs.has(id) ? structuredClone(runs.get(id)) : null; },
    async updateRun(id, patch) {
      const current = runs.get(id);
      const next = { ...current, ...structuredClone(patch) };
      runs.set(id, next);
      return structuredClone(next);
    },
    async appendEvent(event) { events.push(structuredClone(event)); return event; },
    async claimLease(id) {
      if (leases.has(id)) return false;
      leases.add(id);
      return "lease:" + id;
    },
    async releaseLease(id) { leases.delete(id); },
    async watchEvents(id) { return events.filter(event => event.runId === id); }
  };

  const makeAgent = async ({ agent }) => {
    if (agent === "CODER") {
      return {
        summary: "Generated a bounded code proposal.",
        patches: [{
          path: "packages/kratt-core/src/phase-example.mjs",
          content: "export const phaseExample = true;\n",
          expectedBlobSha: null
        }]
      };
    }
    if (agent === "TESTER") {
      return { summary: "Focused regression tests passed.", tests: [{ name: "phase-example-contract", passed: true, evidenceRef: "local:test-run" }] };
    }
    if (agent === "CRITIC") return { summary: "No blocking findings.", blockers: [] };
    return { summary: agent + " stage completed." };
  };

  const engine = createPhaseUpgradeEngine({
    store,
    clock: () => NOW,
    policyEvaluator: options.policyEvaluator ?? (async request => ({
      decision: "ALLOW",
      requestId: request.requestId,
      decisionId: "policy:" + request.action,
      evaluatedAt: NOW
    })),
    approvalVerifier: options.approvalVerifier ?? (async approval => approval.verified === true),
    resourceAdapters: {
      local: { runAgent: options.localAgent ?? makeAgent },
      cloud: { runAgent: options.cloudAgent ?? makeAgent }
    },
    gitWriter: {
      async commitFiles(input) {
        commits.push(structuredClone(input));
        return { commitSha: "a".repeat(40) };
      }
    }
  });

  return { engine, runs, events, commits };
}

function request(overrides = {}) {
  return {
    requestId: "request-phase11",
    phaseId: "phase-11",
    objective: "Create a governed autonomous phase upgrade engine.",
    repository: "antonioportfelli-boop/KRATT-PRIME",
    baseRef: "feature/wave10-observatory-hardening-remediation-v1",
    targetBranch: "feature/phase11-phase-upgrade-engine-v1",
    sourceRevision,
    hardwareSnapshot: hardware(),
    resourcePolicy: { stage: "PREFILL", allowedBackends: ["CPU", "NPU"], requireLocal: true },
    ...overrides
  };
}

test("rejects main and master as write targets", async () => {
  const { engine } = createHarness();
  assert.equal((await engine.propose(request({ targetBranch: "main" }))).reason, "PHASE_REQUEST_INVALID");
  assert.equal((await engine.propose(request({ targetBranch: "master" }))).reason, "PHASE_REQUEST_INVALID");
});

test("proposes the detected accelerator without starting execution", async () => {
  const { engine } = createHarness();
  const result = await engine.propose(request());
  assert.equal(result.ok, true);
  assert.equal(result.run.compute.route.target, "NPU");
  assert.equal(result.run.status, "PLANNED");
  assert.equal(result.run.executionStarted, false);
  assert.equal(result.run.externalWritesStarted, false);
});

test("idempotency returns the existing run instead of duplicating it", async () => {
  const { engine, runs } = createHarness();
  const first = await engine.propose(request());
  const second = await engine.propose(request());
  assert.equal(first.run.runId, second.run.runId);
  assert.equal(second.duplicate, true);
  assert.equal(runs.size, 1);
});

test("local agent wave creates a proposal and never writes GitHub automatically", async () => {
  const { engine, commits } = createHarness();
  const planned = await engine.propose(request());
  const result = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  assert.equal(result.ok, true);
  assert.equal(result.run.status, "READY_FOR_APPROVAL");
  assert.equal(result.run.tests.length, 1);
  assert.equal(result.run.patches.length, 1);
  assert.equal(result.externalWritesStarted, false);
  assert.equal(commits.length, 0);
});

test("remote route is blocked until exact request-bound data-transfer approval", async () => {
  let agentCalls = 0;
  const cloudAgent = async ({ agent }) => {
    agentCalls++;
    if (agent === "CODER") return { summary: "cloud coder", patches: [{ path: "docs/cloud.md", content: "# cloud\n" }] };
    if (agent === "TESTER") return { summary: "cloud tests", tests: [{ name: "cloud-test", passed: true }] };
    if (agent === "CRITIC") return { summary: "clear", blockers: [] };
    return { summary: "cloud stage " + agent };
  };
  const { engine } = createHarness({ cloudAgent });
  const planned = await engine.propose(request({
    hardwareSnapshot: hardware([]),
    resourcePolicy: { stage: "PREFILL", allowedBackends: ["CPU", "REMOTE"], requireLocal: false }
  }));
  assert.equal(planned.run.compute.route.target, "REMOTE");
  const blocked = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  assert.equal(blocked.reason, "REMOTE_COMPUTE_APPROVAL_REQUIRED");
  assert.equal(agentCalls, 0);
});

test("approved remote route runs agents only after approval verification", async () => {
  const { engine } = createHarness();
  const planned = await engine.propose(request({
    hardwareSnapshot: hardware([]),
    resourcePolicy: { stage: "PREFILL", allowedBackends: ["CPU", "REMOTE"], requireLocal: false }
  }));
  const approval = {
    status: "approved", runId: planned.run.runId, requestId: "request-phase11",
    scope: "remote_compute", provider: "approved-cloud", dataClasses: "source_code_and_task_context",
    expiresAt: future, approvedBy: "human-reviewer", verified: true
  };
  const result = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11", remoteApproval: approval });
  assert.equal(result.ok, true);
  assert.equal(result.run.status, "READY_FOR_APPROVAL");
});

test("test evidence failure blocks the phase before approval", async () => {
  const { engine } = createHarness({
    localAgent: async ({ agent }) => {
      if (agent === "CODER") return { summary: "code", patches: [{ path: "docs/test.md", content: "safe\n" }] };
      if (agent === "TESTER") return { summary: "tests failed", tests: [{ name: "negative", passed: false }] };
      return { summary: "stage completed", blockers: [] };
    }
  });
  const planned = await engine.propose(request());
  const result = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "TEST_EVIDENCE_FAILED_OR_MISSING");
  assert.equal((await engine.getRun(planned.run.runId)).run.status, "QUALITY_BLOCKED");
});

test("rejects dangerous code paths and embedded credentials", async () => {
  const { engine } = createHarness({
    localAgent: async ({ agent }) => {
      if (agent === "CODER") return { summary: "unsafe", patches: [{ path: ".env", content: "TOKEN=bad" }] };
      if (agent === "TESTER") return { summary: "ok", tests: [{ name: "x", passed: true }] };
      return { summary: "ok", blockers: [] };
    }
  });
  const planned = await engine.propose(request());
  const result = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  assert.equal(result.reason, "PATCH_PATH_BLOCKED");
});

test("GitHub commit requires exact unexpired approval, policy allow, and feature branch", async () => {
  const { engine, commits } = createHarness();
  const planned = await engine.propose(request());
  const ready = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  const run = ready.run;
  const wrong = await engine.commitApproved({
    runId: run.runId,
    requestId: "request-phase11",
    approval: {
      status: "approved", runId: run.runId, requestId: "request-phase11",
      scope: "github_commit", branch: "main", patchDigest: run.patchDigest,
      repository: run.repository, sourceRevision, expiresAt: future,
      approvedBy: "human-reviewer", verified: true
    }
  });
  assert.equal(wrong.reason, "EXACT_REQUEST_BOUND_COMMIT_APPROVAL_REQUIRED");
  assert.equal(commits.length, 0);

  const approval = {
    status: "approved", runId: run.runId, requestId: "request-phase11",
    scope: "github_commit", branch: run.targetBranch, patchDigest: run.patchDigest,
    repository: run.repository, sourceRevision, expiresAt: future,
    approvedBy: "human-reviewer", approvalId: "approval-11", verified: true
  };
  const committed = await engine.commitApproved({ runId: run.runId, requestId: "request-phase11", approval });
  assert.equal(committed.ok, true);
  assert.equal(committed.commitSha, "a".repeat(40));
  assert.equal(commits[0].branch, "feature/phase11-phase-upgrade-engine-v1");
  assert.equal(commits[0].expectedHead, sourceRevision);
});

test("expired commit approval is denied", async () => {
  const { engine, commits } = createHarness();
  const planned = await engine.propose(request());
  const ready = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  const run = ready.run;
  const result = await engine.commitApproved({
    runId: run.runId, requestId: "request-phase11",
    approval: {
      status: "approved", runId: run.runId, requestId: "request-phase11",
      scope: "github_commit", branch: run.targetBranch, patchDigest: run.patchDigest,
      repository: run.repository, sourceRevision, expiresAt: "2026-11-21T11:59:59.000Z",
      approvedBy: "human-reviewer", verified: true
    }
  });
  assert.equal(result.reason, "EXACT_REQUEST_BOUND_COMMIT_APPROVAL_REQUIRED");
  assert.equal(commits.length, 0);
});

test("policy denial prevents agent execution and code generation", async () => {
  let calls = 0;
  const { engine } = createHarness({
    policyEvaluator: async request => ({ decision: "DENY", requestId: request.requestId, decisionId: "deny", evaluatedAt: NOW }),
    localAgent: async () => { calls++; return { summary: "not run" }; }
  });
  const planned = await engine.propose(request());
  const result = await engine.execute({ runId: planned.run.runId, requestId: "request-phase11" });
  assert.equal(result.reason, "POLICY_NOT_ALLOW");
  assert.equal(calls, 0);
});
