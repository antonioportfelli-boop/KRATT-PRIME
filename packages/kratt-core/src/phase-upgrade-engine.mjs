import { createHash, randomUUID } from "node:crypto";
import { validateHardwareSnapshot, proposeComputeRoute } from "./hardware-capabilities.mjs";

export const PHASE_UPGRADE_ENGINE_VERSION = "1.0.0";
export const PHASE_UPGRADE_AGENTS = Object.freeze([
  "ARCHITECT", "PLANNER", "CODER", "TESTER", "CRITIC", "DOCUMENTARIAN"
]);

const SHA = /^[a-f0-9]{40}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PHASE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;
const BACKENDS = new Set(["CPU", "GPU", "NPU", "HTP", "ANE", "REMOTE"]);
const PATCH_ROOTS = [
  "packages/kratt-core/src/",
  "packages/kratt-core/test/",
  "packages/kratt-orchestrator/src/",
  "packages/kratt-orchestrator/test/",
  "docs/"
];
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /(?:password|client_secret|api_key|access_token)\s*[:=]\s*["'][^"']{8,}["']/i
];

const plain = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

const bad = reason => Object.freeze({ ok: false, reason });
const iso = clock => {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("CLOCK_INVALID");
  return date.toISOString();
};
const sha256 = value => createHash("sha256").update(value).digest("hex");
const bounded = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const safeBranch = value => typeof value === "string" &&
  value.startsWith("feature/") && value.length <= 100 &&
  !value.includes("..") && !value.includes("//") &&
  !value.endsWith("/") && /^[A-Za-z0-9._/-]+$/.test(value);

function validatePatchList(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 32) return bad("PATCH_LIST_INVALID");
  const seen = new Set();
  let totalBytes = 0;
  const patches = [];
  for (const patch of input) {
    if (!plain(patch) || !bounded(patch.path, 240) ||
        typeof patch.content !== "string" || patch.content.length < 1 ||
        patch.content.length > 262144) return bad("PATCH_SHAPE_INVALID");
    const path = patch.path;
    if (path.startsWith("/") || path.includes("\\") ||
        path.split("/").some(part => part === "." || part === "..") ||
        !PATCH_ROOTS.some(root => path.startsWith(root)) ||
        /(^|\/)(?:\.env(?:\..*)?|secrets?|credentials?)(?:\/|$)/i.test(path) ||
        /(^|\/)(?:id_rsa|id_ed25519|.*\.pem)$/i.test(path)) return bad("PATCH_PATH_BLOCKED");
    if (seen.has(path)) return bad("PATCH_PATH_DUPLICATE");
    seen.add(path);
    if (SECRET_PATTERNS.some(pattern => pattern.test(patch.content))) return bad("PATCH_SECRET_PATTERN");
    if (patch.expectedBlobSha !== undefined && patch.expectedBlobSha !== null &&
        !SHA.test(patch.expectedBlobSha)) return bad("PATCH_BASE_SHA_INVALID");
    totalBytes += Buffer.byteLength(patch.content, "utf8");
    if (totalBytes > 2 * 1024 * 1024) return bad("PATCH_TOTAL_SIZE_EXCEEDED");
    patches.push(Object.freeze({
      path,
      content: patch.content,
      expectedBlobSha: patch.expectedBlobSha ?? null
    }));
  }
  return Object.freeze({ ok: true, patches: Object.freeze(patches) });
}

function patchDigest(patches) {
  const canonical = [...patches]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(p => ({ path: p.path, contentSha256: sha256(p.content), expectedBlobSha: p.expectedBlobSha }));
  return sha256(JSON.stringify(canonical));
}

function assertStore(store) {
  const required = ["findByIdempotencyKey", "createRun", "getRun", "updateRun",
    "appendEvent", "claimLease", "releaseLease"];
  for (const method of required) {
    if (typeof store?.[method] !== "function") throw new TypeError("PHASE_STORE_METHOD_REQUIRED:" + method);
  }
}

function validateApprovalShape(approval, expected, now) {
  if (!plain(approval) || approval.status !== "approved" ||
      approval.runId !== expected.runId ||
      approval.requestId !== expected.requestId ||
      approval.scope !== expected.scope ||
      approval.expiresAt === undefined ||
      !Number.isFinite(Date.parse(approval.expiresAt)) ||
      Date.parse(approval.expiresAt) <= Date.parse(now) ||
      !bounded(approval.approvedBy, 256)) return false;
  for (const key of Object.keys(expected)) {
    if (key === "runId" || key === "requestId" || key === "scope") continue;
    if (approval[key] !== expected[key]) return false;
  }
  return true;
}

export function createPhaseUpgradeEngine({
  store,
  resourceAdapters = {},
  policyEvaluator,
  approvalVerifier,
  testEvidenceVerifier,
  gitWriter,
  clock = () => new Date()
} = {}) {
  assertStore(store);

  const append = async (runId, eventType, payload = {}) => store.appendEvent({
    eventId: randomUUID(),
    runId,
    eventType,
    occurredAt: iso(clock),
    payload
  });

  const policy = async request => {
    if (typeof policyEvaluator !== "function") return bad("POLICY_EVALUATOR_NOT_CONFIGURED");
    let result;
    try { result = await policyEvaluator(request); }
    catch { return bad("POLICY_EVALUATION_FAILED"); }
    if (!plain(result) || result.decision !== "ALLOW" ||
        result.requestId !== request.requestId ||
        !bounded(result.decisionId, 128) ||
        !Number.isFinite(Date.parse(result.evaluatedAt))) return bad("POLICY_NOT_ALLOW");
    return Object.freeze({ ok: true, decision: result });
  };

  async function propose(input = {}) {
    if (!plain(input) || !bounded(input.requestId, 128) ||
        !PHASE.test(input.phaseId ?? "") ||
        !bounded(input.objective, 4000) ||
        !REPO.test(input.repository ?? "") ||
        !bounded(input.baseRef, 120) ||
        !SHA.test(input.sourceRevision ?? "") ||
        !safeBranch(input.targetBranch)) return bad("PHASE_REQUEST_INVALID");

    const idempotencyKey = bounded(input.idempotencyKey, 160)
      ? input.idempotencyKey
      : "phase:" + input.phaseId + ":" + input.sourceRevision + ":" + input.targetBranch;
    const existing = await store.findByIdempotencyKey(idempotencyKey);
    if (existing) return Object.freeze({ ok: true, duplicate: true, run: existing });

    const resourcePolicy = plain(input.resourcePolicy) ? input.resourcePolicy : {};
    const allowedBackends = Array.isArray(resourcePolicy.allowedBackends)
      ? resourcePolicy.allowedBackends : ["CPU"];
    if (allowedBackends.length < 1 || allowedBackends.some(x => !BACKENDS.has(x))) {
      return bad("RESOURCE_ALLOWLIST_INVALID");
    }
    const checked = validateHardwareSnapshot(input.hardwareSnapshot);
    if (!checked.ok) return bad("HARDWARE_SNAPSHOT_INVALID:" + checked.reason);

    const stage = resourcePolicy.stage ?? "PREFILL";
    const route = proposeComputeRoute({
      snapshot: checked.snapshot,
      stage,
      allowedBackends,
      requireLocal: resourcePolicy.requireLocal === true
    });
    if (!route.ok) return bad("COMPUTE_ROUTE_INVALID:" + route.reason);

    const runId = "phase_" + randomUUID().replace(/-/g, "");
    const createdAt = iso(clock);
    const run = {
      schemaVersion: "kratt-phase-upgrade/v1",
      engineVersion: PHASE_UPGRADE_ENGINE_VERSION,
      runId,
      requestId: input.requestId,
      idempotencyKey,
      phaseId: input.phaseId,
      objective: input.objective.trim(),
      repository: input.repository,
      baseRef: input.baseRef,
      targetBranch: input.targetBranch,
      sourceRevision: input.sourceRevision.toLowerCase(),
      compute: {
        stage,
        allowedBackends: [...allowedBackends],
        route: route.proposal,
        hardwareObservedAt: checked.snapshot.observedAt
      },
      status: route.proposal.state === "BLOCKED" ? "BLOCKED_RESOURCE" : "PLANNED",
      createdAt,
      updatedAt: createdAt,
      executionStarted: false,
      externalWritesStarted: false,
      agentResults: [],
      patches: [],
      tests: [],
      blockers: route.proposal.state === "BLOCKED" ? [route.proposal.reason] : [],
      patchDigest: null,
      commitSha: null
    };
    await store.createRun(run);
    await append(runId, "PHASE_PLANNED", {
      phaseId: run.phaseId,
      repository: run.repository,
      targetBranch: run.targetBranch,
      computeTarget: route.proposal.target ?? null,
      executionStarted: false
    });
    return Object.freeze({ ok: true, duplicate: false, run });
  }

  async function execute({ runId, requestId, remoteApproval } = {}) {
    if (!bounded(runId, 128) || !bounded(requestId, 128)) return bad("EXECUTION_REQUEST_INVALID");
    const run = await store.getRun(runId);
    if (!run) return bad("RUN_NOT_FOUND");
    if (run.requestId !== requestId) return bad("REQUEST_ID_MISMATCH");
    if (run.status === "READY_FOR_APPROVAL" || run.status === "COMMITTED") {
      return Object.freeze({ ok: true, duplicate: true, run });
    }
    if (run.status !== "PLANNED" && run.status !== "WAITING_REMOTE_APPROVAL") {
      return bad("RUN_NOT_EXECUTABLE:" + run.status);
    }
    const lease = await store.claimLease(runId, "phase-execute:" + requestId);
    if (!lease) return bad("RUN_ALREADY_CLAIMED");

    try {
      const now = iso(clock);
      const policyResult = await policy({
        action: "phase.agent.execute",
        requestId,
        runId,
        repository: run.repository,
        branch: run.targetBranch,
        sourceRevision: run.sourceRevision,
        computeTarget: run.compute.route.target
      });
      if (!policyResult.ok) {
        await store.updateRun(runId, { status: "BLOCKED_POLICY", blockers: [policyResult.reason], updatedAt: now });
        await append(runId, "PHASE_BLOCKED_POLICY", { reason: policyResult.reason });
        return policyResult;
      }

      const remote = run.compute.route.target === "REMOTE";
      if (remote) {
        const expected = {
          runId,
          requestId,
          scope: "remote_compute",
          provider: typeof remoteApproval?.provider === "string" ? remoteApproval.provider : null,
          dataClasses: "source_code_and_task_context"
        };
        const shapeOk = validateApprovalShape(remoteApproval, expected, now);
        let verified = false;
        if (shapeOk && typeof approvalVerifier === "function") {
          try {
            verified = await approvalVerifier(remoteApproval, {
              kind: "remote_compute", runId, requestId, branch: run.targetBranch
            });
          } catch { verified = false; }
        }
        if (!shapeOk || verified !== true) {
          await store.updateRun(runId, {
            status: "WAITING_REMOTE_APPROVAL",
            blockers: ["REMOTE_COMPUTE_APPROVAL_REQUIRED"],
            updatedAt: now
          });
          await append(runId, "REMOTE_COMPUTE_BLOCKED", { approvalRequired: true });
          return bad("REMOTE_COMPUTE_APPROVAL_REQUIRED");
        }
      }

      const adapter = remote ? resourceAdapters.cloud : resourceAdapters.local;
      if (!adapter || typeof adapter.runAgent !== "function") {
        await store.updateRun(runId, { status: "BLOCKED_RESOURCE", blockers: ["RESOURCE_ADAPTER_NOT_CONFIGURED"], updatedAt: now });
        await append(runId, "RESOURCE_ADAPTER_MISSING", { target: remote ? "cloud" : "local" });
        return bad("RESOURCE_ADAPTER_NOT_CONFIGURED");
      }

      await store.updateRun(runId, {
        status: "EXECUTING",
        executionStarted: true,
        blockers: [],
        updatedAt: now
      });
      await append(runId, "PHASE_EXECUTION_STARTED", {
        computeTarget: run.compute.route.target,
        locality: run.compute.route.locality,
        externalWritesStarted: false
      });

      const results = [];
      let patches = [];
      let tests = [];
      for (const agent of PHASE_UPGRADE_AGENTS) {
        await append(runId, "AGENT_STARTED", { agent });
        const result = await adapter.runAgent({
          agent,
          run: {
            runId: run.runId,
            phaseId: run.phaseId,
            objective: run.objective,
            repository: run.repository,
            sourceRevision: run.sourceRevision,
            targetBranch: run.targetBranch
          },
          computeRoute: run.compute.route,
          priorResults: results.map(item => ({ agent: item.agent, summary: item.summary })),
          signal: undefined
        });
        if (!plain(result) || !bounded(result.summary, 12000)) {
          throw new Error("AGENT_RESULT_INVALID:" + agent);
        }
        if (agent === "CODER") {
          const validated = validatePatchList(result.patches);
          if (!validated.ok) throw new Error(validated.reason);
          patches = validated.patches;
        }
        if (agent === "TESTER") {
          if (!Array.isArray(result.tests) || result.tests.length < 1 || result.tests.length > 100 ||
              result.tests.some(test => !plain(test) || !bounded(test.name, 200) ||
                test.passed !== true || !bounded(test.evidenceRef, 240))) {
            throw new Error("TEST_EVIDENCE_FAILED_OR_MISSING");
          }
          if (typeof testEvidenceVerifier !== "function") {
            throw new Error("TEST_EVIDENCE_VERIFIER_NOT_CONFIGURED");
          }
          const boundPatchDigest = patchDigest(patches);
          tests = [];
          for (const test of result.tests) {
            let accepted = false;
            try {
              accepted = await testEvidenceVerifier(
                Object.freeze({
                  name: test.name,
                  passed: true,
                  evidenceRef: test.evidenceRef
                }),
                Object.freeze({
                  runId,
                  requestId,
                  sourceRevision: run.sourceRevision,
                  targetBranch: run.targetBranch,
                  patchDigest: boundPatchDigest
                })
              ) === true;
            } catch {
              accepted = false;
            }
            if (!accepted) throw new Error("TEST_EVIDENCE_UNVERIFIED");
            tests.push(Object.freeze({
              name: test.name,
              passed: true,
              evidenceRef: test.evidenceRef
            }));
          }
        }
        if (agent === "CRITIC" && Array.isArray(result.blockers) && result.blockers.length > 0) {
          throw new Error("CRITIC_BLOCKERS_PRESENT");
        }
        results.push({ agent, summary: result.summary });
        await append(runId, "AGENT_COMPLETED", {
          agent,
          summarySha256: sha256(result.summary),
          patchCount: agent === "CODER" ? patches.length : undefined,
          testCount: agent === "TESTER" ? tests.length : undefined
        });
      }

      const digest = patchDigest(patches);
      const completedAt = iso(clock);
      const updated = await store.updateRun(runId, {
        status: "READY_FOR_APPROVAL",
        agentResults: results,
        patches,
        tests,
        patchDigest: digest,
        blockers: [],
        updatedAt: completedAt
      });
      await append(runId, "CODE_PROPOSAL_READY", {
        patchCount: patches.length,
        testCount: tests.length,
        patchDigest: digest,
        targetBranch: run.targetBranch,
        automaticCommit: false
      });
      return Object.freeze({
        ok: true,
        run: updated ?? { ...run, status: "READY_FOR_APPROVAL", patches, tests, patchDigest: digest },
        commitRequired: true,
        executionStarted: true,
        externalWritesStarted: false
      });
    } catch (error) {
      const reason = String(error?.message ?? "PHASE_EXECUTION_FAILED").slice(0, 300);
      const failedAt = iso(clock);
      await store.updateRun(runId, { status: "QUALITY_BLOCKED", blockers: [reason], updatedAt: failedAt });
      await append(runId, "PHASE_QUALITY_BLOCKED", { reason });
      return bad(reason);
    } finally {
      await store.releaseLease(runId, "phase-execute:" + requestId);
    }
  }

  async function commitApproved({ runId, requestId, approval } = {}) {
    if (!bounded(runId, 128) || !bounded(requestId, 128)) return bad("COMMIT_REQUEST_INVALID");
    const run = await store.getRun(runId);
    if (!run) return bad("RUN_NOT_FOUND");
    if (run.requestId !== requestId) return bad("REQUEST_ID_MISMATCH");
    if (run.status !== "READY_FOR_APPROVAL") return bad("RUN_NOT_READY_FOR_COMMIT");
    if (!safeBranch(run.targetBranch)) return bad("PROTECTED_BRANCH_WRITE_BLOCKED");
    if (!run.patchDigest || !Array.isArray(run.patches) || run.patches.length < 1) return bad("PATCH_PROPOSAL_MISSING");

    const now = iso(clock);
    const expected = {
      runId,
      requestId,
      scope: "github_commit",
      branch: run.targetBranch,
      patchDigest: run.patchDigest,
      repository: run.repository,
      sourceRevision: run.sourceRevision
    };
    const shapeOk = validateApprovalShape(approval, expected, now);
    let verified = false;
    if (shapeOk && typeof approvalVerifier === "function") {
      try {
        verified = await approvalVerifier(approval, {
          kind: "github_commit", runId, requestId, repository: run.repository,
          branch: run.targetBranch, patchDigest: run.patchDigest, sourceRevision: run.sourceRevision
        });
      } catch { verified = false; }
    }
    if (!shapeOk || verified !== true) return bad("EXACT_REQUEST_BOUND_COMMIT_APPROVAL_REQUIRED");

    const policyResult = await policy({
      action: "github.contents.write",
      requestId,
      runId,
      repository: run.repository,
      branch: run.targetBranch,
      sourceRevision: run.sourceRevision,
      patchDigest: run.patchDigest
    });
    if (!policyResult.ok) return policyResult;
    if (!gitWriter || typeof gitWriter.commitFiles !== "function") return bad("GITHUB_WRITER_NOT_CONFIGURED");

    const lease = await store.claimLease(runId, "phase-commit:" + requestId);
    if (!lease) return bad("RUN_ALREADY_CLAIMED");
    try {
      const fresh = await store.getRun(runId);
      if (!fresh || fresh.status !== "READY_FOR_APPROVAL" || fresh.patchDigest !== run.patchDigest) {
        return bad("RUN_CHANGED_DURING_APPROVAL");
      }
      const commit = await gitWriter.commitFiles({
        repository: run.repository,
        branch: run.targetBranch,
        expectedHead: run.sourceRevision,
        requestId,
        message: "feat(phase11): " + run.phaseId + " governed phase update",
        files: run.patches
      });
      if (!plain(commit) || !SHA.test(commit.commitSha ?? "")) return bad("GITHUB_COMMIT_RECEIPT_INVALID");
      const committedAt = iso(clock);
      const updated = await store.updateRun(runId, {
        status: "COMMITTED",
        commitSha: commit.commitSha,
        committedAt,
        externalWritesStarted: true,
        updatedAt: committedAt
      });
      await append(runId, "GITHUB_COMMIT_CREATED", {
        repository: run.repository,
        branch: run.targetBranch,
        commitSha: commit.commitSha,
        patchDigest: run.patchDigest,
        approvalId: bounded(approval.approvalId, 128) ? approval.approvalId : null
      });
      return Object.freeze({ ok: true, run: updated, commitSha: commit.commitSha });
    } catch (error) {
      const reason = String(error?.message ?? "GITHUB_COMMIT_FAILED").slice(0, 300);
      await append(runId, "GITHUB_COMMIT_FAILED", { reason });
      return bad(reason);
    } finally {
      await store.releaseLease(runId, "phase-commit:" + requestId);
    }
  }

  async function getRun(runId) {
    if (!bounded(runId, 128)) return bad("RUN_ID_INVALID");
    const run = await store.getRun(runId);
    return run ? Object.freeze({ ok: true, run }) : bad("RUN_NOT_FOUND");
  }

  async function watchEvents(runId) {
    if (typeof store.watchEvents !== "function") throw new Error("REALTIME_EVENT_SUBSCRIPTION_NOT_CONFIGURED");
    return store.watchEvents(runId);
  }

  return Object.freeze({ propose, execute, commitApproved, getRun, watchEvents });
}

export function computePhasePatchDigest(patches) {
  const checked = validatePatchList(patches);
  return checked.ok ? Object.freeze({ ok: true, digest: patchDigest(checked.patches) }) : checked;
}
