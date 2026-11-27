import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAdapterAuthorizationRuntime } from "../src/adapter-authorization.mjs";
import {
  createAdapterExecutionRuntime,
} from "../src/adapter-execution-context.mjs";
import { InMemoryApprovalLedger } from "../src/approval-evidence.mjs";

const NOW = Date.parse("2026-11-27T03:00:00.000Z");
const payloadDigest = createHash("sha256").update("read-only repository query", "utf8").digest("hex");

const makeContract = (mode = "PROCESS_ISOLATED") => ({
  schema: "3XT-ADAPTER",
  contractVersion: "1.0.0",
  adapterId: "github.reader",
  provider: "github",
  implementation: {
    version: "1.0.0",
    executionMode: mode,
    source: {
      repository: "antonioportfelli-boop/KRATT-PRIME",
      revision: "a".repeat(40),
      path: "packages/adapters/github/index.mjs",
    },
    artifactDigest: "b".repeat(64),
  },
  versions: {
    eventSchema: { id: "3XT-FABRIC", version: "1" },
    protocol: { id: "3XT-FABRIC", version: "1" },
    providerApi: { id: "github-rest", version: "2022-11-28" },
    configuration: { id: "github.adapter.config", version: "1.0.0" },
  },
  capabilities: [{ id: "repository.read", version: "1.0.0" }],
  operations: [{
    operationId: "repo.contents.read",
    class: "READ",
    requiredCapabilities: ["repository.read"],
    idempotency: "IDEMPOTENT",
    timeoutMs: 20_000,
    maxAttempts: 3,
  }],
});

const request = () => ({
  adapterId: "github.reader",
  requestId: "req.wp04.4.01",
  principalRef: "principal.antonio",
  agentRef: "agent.kratt",
  target: "antonioportfelli-boop/KRATT-PRIME",
  operationId: "repo.contents.read",
  requestDigest: payloadDigest,
  destructive: false,
});

const registration = (mode = "PROCESS_ISOLATED", revision = 2) => ({
  adapterId: "github.reader",
  provider: "github",
  contract: makeContract(mode),
  contractDigest: "c".repeat(64),
  sourceProvenance: {
    repository: "antonioportfelli-boop/KRATT-PRIME",
    revision: "a".repeat(40),
    path: "packages/adapters/github/index.mjs",
    artifactDigest: "b".repeat(64),
    evidenceRef: "evidence.source",
    verifierRef: "verifier.git",
    verifiedAt: "2026-11-27T02:00:00.000Z",
  },
  integration: {
    integration_id: "github.reader",
    name: "github.reader",
    state: "VERIFIED_READ_ONLY",
    read_operations: ["repo.contents.read"],
    write_operations: [],
  },
  revision,
  readOnlyAttestation: {
    contractDigest: "c".repeat(64),
    artifactDigest: "b".repeat(64),
    evidenceRef: "evidence.conformance",
    verifierRef: "verifier.ci",
    verifiedAt: "2026-11-27T02:30:00.000Z",
  },
});

const trustedContext = {
  principal: { ref: "principal.antonio", scopes: { read: ["repository.read@1.0.0"], write: [] } },
  agent: { ref: "agent.kratt", scopes: { read: ["repository.read@1.0.0"], write: [] } },
  integration: {
    accountRef: "account.github.primary",
    scopes: { read: ["repository.read@1.0.0"], write: [] },
    resourceScopes: { allow: ["antonioportfelli-boop/KRATT-PRIME"], deny: [] },
  },
};

const supervisor = {
  supervisorRef: "supervisor.process.v1",
  isolationClass: "OS_PROCESS_CONTAINER",
  policyDigest: "d".repeat(64),
  networkPolicy: "PROVIDER_ALLOWLIST_ONLY",
  filesystemPolicy: "READ_ONLY_ARTIFACT_AND_EPHEMERAL_TMP",
  credentialPolicy: "NO_RAW_SECRETS",
};

function setup({
  record = registration(),
  registrationSequence = null,
  supervisorDescriptor = supervisor,
  isolationReceipt = {
    verified: true, evidenceRef: "evidence.isolation", verifierRef: "verifier.platform",
  },
  fenceResult = true,
  fenceResults = null,
  startResult = "STARTED",
  finishResult = "FINISHED",
  workerResult = {
    status: "COMPLETED", workerRef: "worker.github.01",
    resultRef: "result.github.01", resultDigest: "e".repeat(64),
    finishedAt: "2026-11-27T03:00:01.000Z", reasonCode: null,
  },
} = {}) {
  const calls = { authorize: 0, worker: [], starts: [], finishes: [], fences: [], registrationReads: 0 };
  const registrations = Array.isArray(registrationSequence) && registrationSequence.length > 0
    ? registrationSequence
    : [record];
  const registrationReader = {
    async get() {
      const index = Math.min(calls.registrationReads, registrations.length - 1);
      calls.registrationReads += 1;
      return { ok: true, record: registrations[index] };
    },
  };
  const authorizationRuntime = createAdapterAuthorizationRuntime({
    registrationRuntime: registrationReader,
    trustedContextLoader: { load: async () => trustedContext },
    approvalVerifier: { verify: async () => true },
    approvalLedger: new InMemoryApprovalLedger(),
    auditStore: { appendDecision: async () => "APPENDED" },
    now: () => NOW,
  });
  const runtime = createAdapterExecutionRuntime({
    authorizationRuntime: {
      async authorize(input) {
        calls.authorize += 1;
        return authorizationRuntime.authorize(input);
      },
    },
    registrationRuntime: registrationReader,
    workerSupervisor: {
      describeIsolation: async () => supervisorDescriptor,
      runInRestrictedProcess: async (input) => {
        calls.worker.push(input);
        return workerResult;
      },
    },
    isolationVerifier: {
      verify: async () => isolationReceipt,
    },
    executionFence: {
      check: async (input) => {
        calls.fences.push(input);
        if (Array.isArray(fenceResults)) return fenceResults[calls.fences.length - 1] ?? false;
        return fenceResult;
      },
    },
    executionStore: {
      startWithAudit: async (input) => {
        calls.starts.push(input);
        return startResult;
      },
      finishWithAudit: async (input) => {
        calls.finishes.push(input);
        return finishResult;
      },
    },
    now: () => NOW,
    maxExecutionMs: 10_000,
    maxOutputBytes: 16_384,
    memoryLimitMb: 128,
  });
  return { runtime, calls };
}

test("authorizes and dispatches a read through the restricted process boundary", async () => {
  const { runtime, calls } = setup();
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.ok, true);
  assert.equal(result.code, "READ_EXECUTION_COMPLETED");
  assert.equal(calls.authorize, 1);
  assert.equal(calls.worker.length, 1);
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.finishes.length, 1);
  const invocation = calls.worker[0].invocation;
  assert.equal(invocation.schema, "3XT-ADAPTER-INVOCATION");
  assert.equal(invocation.operation.class, "READ");
  assert.equal(invocation.limits.timeoutMs, 10_000);
  assert.equal(invocation.adapter.source.artifactDigest, "b".repeat(64));
  assert.equal("accessToken" in invocation, false);
  assert.equal("credential" in invocation, false);
  assert.equal(calls.fences.map(x => x.phase).join(","), "BEFORE_START,AFTER_EXECUTION");
});

test("does not start a worker when authorization grant is unbranded or mismatched", async () => {
  const record = registration();
  const runtime = createAdapterExecutionRuntime({
    authorizationRuntime: { authorize: async () => ({
      ok: true, allowed: true, code: "ADAPTER_OPERATION_AUTHORIZED",
      adapterId: record.adapterId, requestId: request().requestId,
      requestDigest: payloadDigest, principalRef: request().principalRef,
      agentRef: request().agentRef, operationId: request().operationId,
      target: request().target,
    }) },
    registrationRuntime: { get: async () => ({ ok: true, record }) },
    workerSupervisor: {
      describeIsolation: async () => supervisor,
      runInRestrictedProcess: async () => { throw new Error("must not run"); },
    },
    isolationVerifier: { verify: async () => ({ verified: true, evidenceRef: "evidence.isolation", verifierRef: "verifier.platform" }) },
    executionFence: { check: async () => true },
    executionStore: { startWithAudit: async () => "STARTED", finishWithAudit: async () => "FINISHED" },
    now: () => NOW,
  });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "AUTHORIZATION_GRANT_UNTRUSTED_OR_MISMATCHED");
});

test("blocks a registration revision or artifact digest changed after authorization", async () => {
  const { runtime } = setup({
    registrationSequence: [
      registration("PROCESS_ISOLATED", 2),
      registration("PROCESS_ISOLATED", 3),
    ],
  });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "REGISTRATION_CHANGED_AFTER_AUTHORIZATION");
});

test("requires OS process/container isolation rather than in-process or worker-thread mode", async () => {
  for (const mode of ["IN_PROCESS_TRUSTED", "WORKER_ISOLATED"]) {
    const { runtime, calls } = setup({ record: registration(mode) });
    const result = await runtime.execute({ request: request(), approvalEnvelope: null });
    assert.equal(result.code, "PROCESS_ISOLATION_REQUIRED");
    assert.equal(calls.worker.length, 0);
  }
});

test("rejects a supervisor without the exact network, filesystem and credential restrictions", async () => {
  const { runtime, calls } = setup({
    supervisorDescriptor: { ...supervisor, networkPolicy: "UNRESTRICTED" },
  });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "SUPERVISOR_ISOLATION_PROFILE_INVALID");
  assert.equal(calls.worker.length, 0);
});

test("requires an independent supervisor isolation attestation", async () => {
  const { runtime, calls } = setup({
    isolationReceipt: { verified: false, evidenceRef: "evidence.isolation", verifierRef: "verifier.platform" },
  });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "PROCESS_ISOLATION_UNVERIFIED");
  assert.equal(calls.worker.length, 0);
});

test("requires cancellation and current-policy fence immediately before launch", async () => {
  const { runtime, calls } = setup({ fenceResult: false });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "EXECUTION_FENCE_REJECTED");
  assert.equal(calls.starts.length, 0);
  assert.equal(calls.worker.length, 0);
});

test("does not run a worker when durable intent/audit start commit fails", async () => {
  const { runtime, calls } = setup({ startResult: "COMMIT_FAILED" });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "EXECUTION_START_NOT_COMMITTED");
  assert.equal(calls.worker.length, 0);
});

test("records unknown worker outcomes and never reports them as success", async () => {
  const { runtime, calls } = setup({
    workerResult: null,
  });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(calls.finishes.length, 1);
  assert.equal(calls.finishes[0].result.status, "UNKNOWN");
});

test("quarantines results when the post-execution fence rejects", async () => {
  const { runtime, calls } = setup({ fenceResults: [true, false] });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "EXECUTION_RESULT_QUARANTINED");
  assert.equal(calls.worker.length, 1);
  assert.equal(calls.finishes[0].event.eventType, "adapter.execution.quarantined");
});

test("unknown and oversized worker results cannot be exposed as completed", async () => {
  const { runtime } = setup({
    workerResult: {
      status: "COMPLETED", workerRef: "worker.github.01",
      resultRef: "result.github.01", resultDigest: "not-a-digest",
      finishedAt: "2026-11-27T03:00:01.000Z", reasonCode: null,
    },
  });
  const result = await runtime.execute({ request: request(), approvalEnvelope: null });
  assert.equal(result.code, "EXECUTION_OUTCOME_UNKNOWN");
});

test("denies non-READ operations even if an external grant is presented", async () => {
  const { runtime, calls } = setup();
  const result = await runtime.execute({
    request: { ...request(), operationId: "repo.contents.write" },
    approvalEnvelope: null,
  });
  assert.equal(result.code, "ADAPTER_OPERATION_NOT_DECLARED");
  assert.equal(calls.worker.length, 0);
});

test("rejects audit failures and malformed invocation inputs", async () => {
  const { runtime:failedAudit } = setup({ finishResult: "COMMIT_FAILED" });
  const failed = await failedAudit.execute({ request: request(), approvalEnvelope: null });
  assert.equal(failed.code, "EXECUTION_OUTCOME_UNRECORDED");
  const { runtime } = setup();
  assert.equal((await runtime.execute({
    request: request(), approvalEnvelope: null, injected: true,
  })).code, "EXECUTION_INPUT_INVALID");
});

test("constructor rejects missing trusted isolation and execution dependencies", () => {
  assert.throws(() => createAdapterExecutionRuntime({}), /ADAPTER_AUTHORIZATION_RUNTIME_REQUIRED/);
});

test("rejects Proxy-backed invocation requests and isolation receipts", async () => {
  const requestProxy = new Proxy(request(), {
    get(target, key, receiver) {
      if (key === "requestDigest") return "f".repeat(64);
      return Reflect.get(target, key, receiver);
    },
  });
  const { runtime, calls } = setup();
  const requestResult = await runtime.execute({
    request: requestProxy,
    approvalEnvelope: null,
  });
  assert.equal(requestResult.code, "EXECUTION_REQUEST_INVALID");
  assert.equal(calls.authorize, 0);
  assert.equal(calls.worker.length, 0);

  const isolationReceipt = new Proxy({
    verified: true,
    evidenceRef: "evidence.isolation",
    verifierRef: "verifier.platform",
  }, {});
  const { runtime: receiptRuntime, calls: receiptCalls } = setup({ isolationReceipt });
  const receiptResult = await receiptRuntime.execute({
    request: request(),
    approvalEnvelope: null,
  });
  assert.equal(receiptResult.code, "PROCESS_ISOLATION_UNVERIFIED");
  assert.equal(receiptCalls.worker.length, 0);
});

test("treats Proxy-backed worker outcomes as UNKNOWN, never as completed", async () => {
  const workerResult = new Proxy({
    status: "COMPLETED",
    workerRef: "worker.github.01",
    resultRef: "result.github.01",
    resultDigest: "e".repeat(64),
    finishedAt: "2026-11-27T03:00:01.000Z",
    reasonCode: null,
  }, {});
  const { runtime, calls } = setup({ workerResult });
  const result = await runtime.execute({
    request: request(),
    approvalEnvelope: null,
  });
  assert.equal(result.code, "EXECUTION_OUTCOME_UNKNOWN");
  assert.equal(calls.finishes[0].result.status, "UNKNOWN");
});
