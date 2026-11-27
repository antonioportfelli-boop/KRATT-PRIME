import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InMemoryApprovalLedger } from "../src/approval-evidence.mjs";
import {
  createAdapterAuthorizationRuntime,
  isAuthorizedAdapterInvocation,
} from "../src/adapter-authorization.mjs";

const now = Date.parse("2026-11-27T02:00:00.000Z");
const digest = createHash("sha256").update("immutable payload", "utf8").digest("hex");
const actor = "principal.antonio";
const agent = "agent.kratt";

const contract = () => ({
  schema: "3XT-ADAPTER",
  contractVersion: "1.0.0",
  adapterId: "github.adapter",
  provider: "github",
  implementation: {
    version: "1.0.0",
    executionMode: "PROCESS_ISOLATED",
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
  capabilities: [
    { id: "repository.read", version: "1.0.0" },
    { id: "repository.write", version: "1.0.0" },
  ],
  operations: [
    {
      operationId: "repo.contents.read",
      class: "READ",
      requiredCapabilities: ["repository.read"],
      idempotency: "IDEMPOTENT",
      timeoutMs: 5000,
      maxAttempts: 3,
    },
    {
      operationId: "repo.contents.write",
      class: "EXTERNAL_WRITE",
      requiredCapabilities: ["repository.write"],
      idempotency: "DEDUPLICATED",
      timeoutMs: 10000,
      maxAttempts: 1,
    },
  ],
});

const request = (overrides = {}) => ({
  adapterId: "github.adapter",
  requestId: "req.wp04.3.01",
  principalRef: actor,
  agentRef: agent,
  target: "antonioportfelli-boop/KRATT-PRIME",
  operationId: "repo.contents.read",
  requestDigest: digest,
  destructive: false,
  ...overrides,
});

const record = (state = "VERIFIED_READ_ONLY") => ({
  adapterId: "github.adapter",
  provider: "github",
  contract: contract(),
  contractDigest: "c".repeat(64),
  contractSource: undefined,
  sourceProvenance: {
    repository: "antonioportfelli-boop/KRATT-PRIME",
    revision: "a".repeat(40),
    path: "packages/adapters/github/index.mjs",
    artifactDigest: "b".repeat(64),
    evidenceRef: "evidence.source",
    verifierRef: "verifier.git",
    verifiedAt: "2026-11-27T01:00:00.000Z",
  },
  integration: {
    integration_id: "github.adapter",
    name: "github.adapter",
    state,
    read_operations: ["repo.contents.read"],
    write_operations: ["repo.contents.write"],
  },
  revision: 2,
  readOnlyAttestation: state === "VERIFIED_READ_ONLY" ? {
    contractDigest: "c".repeat(64),
    artifactDigest: "b".repeat(64),
    evidenceRef: "evidence.conformance",
    verifierRef: "verifier.ci",
    verifiedAt: "2026-11-27T01:30:00.000Z",
  } : null,
});

const trustedContext = {
  principal: { ref: actor, scopes: { read: ["repository.read@1.0.0"], write: ["repository.write@1.0.0"] } },
  agent: { ref: agent, scopes: { read: ["repository.read@1.0.0"], write: ["repository.write@1.0.0"] } },
  integration: {
    accountRef: "account.github.primary",
    scopes: { read: ["repository.read@1.0.0"], write: ["repository.write@1.0.0"] },
    resourceScopes: { allow: ["antonioportfelli-boop/KRATT-PRIME"], deny: [] },
  },
};

function setup({
  adapterRecord = record(),
  context = trustedContext,
  verifier = { verify: async () => true },
  ledger = new InMemoryApprovalLedger(),
  auditResult = "APPENDED",
  clock = () => now,
} = {}) {
  const audits = [];
  const runtime = createAdapterAuthorizationRuntime({
    registrationRuntime: { get: async () => ({ ok: true, record: adapterRecord }) },
    trustedContextLoader: { load: async () => context },
    approvalVerifier: verifier,
    approvalLedger: ledger,
    auditStore: { appendDecision: async (event) => { audits.push(event); return auditResult; } },
    now: clock,
  });
  return { runtime, audits, ledger };
}

test("authorizes a scoped READ only after independently verified registration", async () => {
  const { runtime, audits } = setup();
  const result = await runtime.authorize({ request: request(), approvalEnvelope: null });
  assert.equal(result.allowed, true);
  assert.equal(result.code, "ADAPTER_OPERATION_AUTHORIZED");
  assert.equal(isAuthorizedAdapterInvocation(result), true);
  assert.equal(result.requiredScopes[0], "repository.read@1.0.0");
  assert.equal(result.artifactDigest, "b".repeat(64));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, "adapter.operation.allowed");
});

test("denies a read when any principal, agent or integration scope is missing", async () => {
  for (const context of [
    { ...trustedContext, principal: { ...trustedContext.principal, scopes: { read: [], write: [] } } },
    { ...trustedContext, agent: { ...trustedContext.agent, scopes: { read: [], write: [] } } },
    { ...trustedContext, integration: { ...trustedContext.integration, scopes: { read: [], write: [] } } },
  ]) {
    const { runtime } = setup({ context });
    const result = await runtime.authorize({ request: request(), approvalEnvelope: null });
    assert.equal(result.allowed, false);
    assert.equal(result.code, "READ_SCOPE_MISSING");
  }
});

test("denies target outside trusted integration allow scope", async () => {
  const { runtime } = setup();
  const result = await runtime.authorize({
    request: request({ target: "another-org/private-repo" }),
    approvalEnvelope: null,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "TARGET_OUT_OF_SCOPE");
});

test("denies unverified, disabled and error registrations", async () => {
  for (const state of ["CONNECTED_UNVERIFIED", "DISABLED", "ERROR"]) {
    const { runtime } = setup({ adapterRecord: record(state) });
    const result = await runtime.authorize({ request: request(), approvalEnvelope: null });
    assert.equal(result.allowed, false);
    assert.equal(["INTEGRATION_UNVERIFIED", "INTEGRATION_DISABLED", "INTEGRATION_ERROR"].includes(result.code), true);
  }
});

test("denies caller-supplied principal or agent identity mismatch", async () => {
  const { runtime } = setup();
  const result = await runtime.authorize({
    request: request({ principalRef: "principal.attacker" }),
    approvalEnvelope: null,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "TRUSTED_AUTHORIZATION_CONTEXT_INVALID");
});

test("denies an undeclared operation and malformed request digest", async () => {
  const { runtime } = setup();
  assert.equal((await runtime.authorize({
    request: request({ operationId: "repo.admin.delete" }), approvalEnvelope: null,
  })).code, "ADAPTER_OPERATION_NOT_DECLARED");
  assert.equal((await runtime.authorize({
    request: request({ requestDigest: "not-sha256" }), approvalEnvelope: null,
  })).code, "AUTHORIZATION_REQUEST_INVALID");
});

test("denies arbitrary or accessor-bearing authorization input", async () => {
  const { runtime } = setup();
  assert.equal((await runtime.authorize({ request: request(), approvalEnvelope: null, trusted: true })).code,
    "AUTHORIZATION_INPUT_INVALID");
  const malicious = {};
  let invoked = false;
  Object.defineProperty(malicious, "request", { enumerable: true, get() { invoked = true; return request(); } });
  Object.defineProperty(malicious, "approvalEnvelope", { enumerable: true, value: null });
  assert.equal((await runtime.authorize(malicious)).code, "AUTHORIZATION_INPUT_INVALID");
  assert.equal(invoked, false);
});

test("read-only registration cannot authorize WRITE even with a forged approval flag", async () => {
  const { runtime } = setup();
  const result = await runtime.authorize({
    request: request({ operationId: "repo.contents.write", destructive: false }),
    approvalEnvelope: {
      verified: true,
      approvalId: "fake",
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "WRITE_NOT_ENABLED");
});

test("WRITE requires a signed request digest, trusted approval and one-time ledger consumption", async () => {
  const { runtime, ledger } = setup({ adapterRecord: record("WRITE_ENABLED") });
  const envelope = {
    approvalId: "approval.wp04.3.01",
    requestId: "req.wp04.3.01",
    principalRef: actor,
    agentRef: agent,
    provider: "github",
    operationId: "repo.contents.write",
    target: "antonioportfelli-boop/KRATT-PRIME",
    scopes: ["repository.write@1.0.0"],
    issuedAt: "2026-11-27T01:59:00.000Z",
    expiresAt: "2026-11-27T02:05:00.000Z",
    nonce: "nonce-wp04.3-0123456789",
    evidenceRef: "evidence.approval",
    destructive: false,
    requestDigest: digest,
  };
  const result = await runtime.authorize({
    request: request({ operationId: "repo.contents.write" }),
    approvalEnvelope: envelope,
  });
  assert.equal(result.allowed, true);
  assert.equal(isAuthorizedAdapterInvocation(result), true);
  assert.equal(result.approvalId, envelope.approvalId);
  assert.equal(ledger.consume({ ...result, code: "APPROVAL_VERIFIED" }, { now }).code, "APPROVAL_NOT_VERIFIED");
});

test("rejects a signed approval whose request digest differs from the exact payload", async () => {
  const { runtime } = setup({ adapterRecord: record("WRITE_ENABLED") });
  const envelope = {
    approvalId: "approval.wp04.3.02", requestId: "req.wp04.3.01",
    principalRef: actor, agentRef: agent, provider: "github",
    operationId: "repo.contents.write", target: "antonioportfelli-boop/KRATT-PRIME",
    scopes: ["repository.write@1.0.0"], issuedAt: "2026-11-27T01:59:00.000Z",
    expiresAt: "2026-11-27T02:05:00.000Z", nonce: "nonce-wp04.3-0223456789",
    evidenceRef: "evidence.approval", destructive: false, requestDigest: "e".repeat(64),
  };
  const result = await runtime.authorize({
    request: request({ operationId: "repo.contents.write" }),
    approvalEnvelope: envelope,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "APPROVAL_REQUEST_DIGEST_MISMATCH");
});

test("approval replay or durable ledger failure blocks authorization", async () => {
  const { runtime } = setup({
    adapterRecord: record("WRITE_ENABLED"),
    ledger: { consume: async () => ({ allowed: false, code: "APPROVAL_REPLAYED" }) },
  });
  const envelope = {
    approvalId: "approval.wp04.3.03", requestId: "req.wp04.3.01",
    principalRef: actor, agentRef: agent, provider: "github",
    operationId: "repo.contents.write", target: "antonioportfelli-boop/KRATT-PRIME",
    scopes: ["repository.write@1.0.0"], issuedAt: "2026-11-27T01:59:00.000Z",
    expiresAt: "2026-11-27T02:05:00.000Z", nonce: "nonce-wp04.3-0323456789",
    evidenceRef: "evidence.approval", destructive: false, requestDigest: digest,
  };
  const result = await runtime.authorize({
    request: request({ operationId: "repo.contents.write" }), approvalEnvelope: envelope,
  });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "APPROVAL_REPLAYED");
});

test("failed append-only audit prevents an authorization grant", async () => {
  const { runtime } = setup({ auditResult: "FAILED" });
  const result = await runtime.authorize({ request: request(), approvalEnvelope: null });
  assert.equal(result.allowed, false);
  assert.equal(result.code, "AUTH_AUDIT_APPEND_FAILED");
});

test("missing registration and trusted context fail closed", async () => {
  const runtime = createAdapterAuthorizationRuntime({
    registrationRuntime: { get: async () => ({ ok: false, code: "ADAPTER_NOT_FOUND" }) },
    trustedContextLoader: { load: async () => trustedContext },
    approvalVerifier: { verify: async () => true },
    approvalLedger: new InMemoryApprovalLedger(),
    auditStore: { appendDecision: async () => "APPENDED" },
    now: () => now,
  });
  assert.equal((await runtime.authorize({ request: request(), approvalEnvelope: null })).code, "ADAPTER_NOT_REGISTERED");
});

test("rejects Proxy-backed authorization requests, trusted contexts and scope arrays", async () => {
  const requestProxy = new Proxy(request(), {
    get(target, key, receiver) {
      if (key === "target") return "attacker/private-repository";
      return Reflect.get(target, key, receiver);
    },
  });
  const { runtime: requestRuntime } = setup();
  const requestResult = await requestRuntime.authorize({
    request: requestProxy,
    approvalEnvelope: null,
  });
  assert.equal(requestResult.code, "AUTHORIZATION_REQUEST_INVALID");

  const { runtime: contextRuntime } = setup({
    context: new Proxy(trustedContext, {}),
  });
  const contextResult = await contextRuntime.authorize({
    request: request(),
    approvalEnvelope: null,
  });
  assert.equal(contextResult.code, "TRUSTED_AUTHORIZATION_CONTEXT_INVALID");

  const scopeArray = new Proxy(trustedContext.principal.scopes.read, {});
  const proxiedScopes = {
    ...trustedContext,
    principal: {
      ...trustedContext.principal,
      scopes: { read: scopeArray, write: [] },
    },
  };
  const { runtime: scopeRuntime } = setup({ context: proxiedScopes });
  const scopeResult = await scopeRuntime.authorize({
    request: request(),
    approvalEnvelope: null,
  });
  assert.equal(scopeResult.code, "TRUSTED_AUTHORIZATION_CONTEXT_INVALID");
});
