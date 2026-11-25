import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateIntegrationOperation, intersectEffectiveScopes,
  normalizeIntegrationDescriptor, toCapabilityAuditRecord, OPERATION_CLASSES,
} from "../src/integration-capability-registry.mjs";

const descriptor = (overrides = {}) => ({
  integrationId: "github.primary", provider: "github", accountRef: "acct:antonio",
  state: "WRITE_ENABLED",
  capabilities: { read: ["repo:read"], write: ["repo:contents:write"] },
  resourceScopes: { allow: ["antonioportfelli-boop/KRATT-PRIME"], deny: [] },
  verifiedAt: "2026-11-25T00:00:00.000Z", evidenceRef: "evidence:connector:01",
  credentialRef: "vault:github:primary", ...overrides,
});
const operation = (overrides = {}) => ({
  operationId: "repo.file.create", class: OPERATION_CLASSES.EXTERNAL_WRITE,
  requiredScopes: ["repo:contents:write"], ...overrides,
});
const request = (overrides = {}) => ({
  requestId: "req:wave11:01", provider: "github",
  target: "antonioportfelli-boop/KRATT-PRIME", ...overrides,
});
const scopes = { read: ["repo:read"], write: ["repo:contents:write"] };
const approval = (overrides = {}) => ({
  verified: true, provider: "github", operationId: "repo.file.create",
  target: "antonioportfelli-boop/KRATT-PRIME", requestId: "req:wave11:01",
  expiresAt: "2026-11-26T00:00:00.000Z", approvalRef: "approval:wave11:01", ...overrides,
});

test("normalizes and freezes descriptor", () => {
  const value = normalizeIntegrationDescriptor(descriptor());
  assert.equal(Object.isFrozen(value.capabilities.read), true);
});
test("rejects credential material in descriptor", () => {
  assert.throws(() => normalizeIntegrationDescriptor({ ...descriptor(), accessToken: "secret" }), /secret-like/);
});
test("rejects overlapping read/write scopes", () => {
  assert.throws(() => normalizeIntegrationDescriptor({
    ...descriptor(), capabilities: { read: ["x"], write: ["x"] },
  }), /overlap/);
});
test("intersects server-derived principal, agent and connector scopes", () => {
  assert.deepEqual(intersectEffectiveScopes({
    principal: { read: ["a", "b"], write: ["x", "y"] },
    agent: { read: ["b"], write: ["x"] },
    integration: { read: ["b", "c"], write: ["x", "z"] },
  }), { read: ["b"], write: ["x"] });
});
test("fails closed on absent context", () => {
  assert.equal(evaluateIntegrationOperation({}).code, "MISSING_CONTEXT");
});
test("blocks discovered and connected-unverified states", () => {
  for (const state of ["DISCOVERED", "CONNECTED_UNVERIFIED"]) {
    assert.equal(evaluateIntegrationOperation({
      integration: descriptor({ state }), operation: operation(), request: request(),
      effectiveScopes: scopes, approval: approval(),
    }).code, "INTEGRATION_UNVERIFIED");
  }
});
test("blocks disabled and error states", () => {
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor({ state: "DISABLED" }), operation: operation(),
    request: request(), effectiveScopes: scopes,
  }).code, "INTEGRATION_DISABLED");
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor({ state: "ERROR" }), operation: operation(),
    request: request(), effectiveScopes: scopes,
  }).code, "INTEGRATION_ERROR");
});
test("allows scoped read from verified-read-only integration", () => {
  const result = evaluateIntegrationOperation({
    integration: descriptor({ state: "VERIFIED_READ_ONLY", capabilities: { read: ["repo:read"], write: [] } }),
    operation: operation({ operationId: "repo.read", class: OPERATION_CLASSES.READ, requiredScopes: ["repo:read"] }),
    request: request(), effectiveScopes: scopes,
  });
  assert.equal(result.allowed, true);
  assert.equal(result.sideEffect, "NONE");
});
test("read-only integration cannot authorize writes", () => {
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor({ state: "VERIFIED_READ_ONLY", capabilities: { read: ["repo:read"], write: [] } }),
    operation: operation(), request: request(), effectiveScopes: { read: ["repo:read"], write: [] },
    approval: approval(),
  }).code, "WRITE_NOT_ENABLED");
});
test("blocks target outside allow-list", () => {
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor(), operation: operation(),
    request: request({ target: "3XTRINITY-CORPORATION-AND-SOFTWARE/KRATT-PRIME" }),
    effectiveScopes: scopes, approval: approval({ target: "3XTRINITY-CORPORATION-AND-SOFTWARE/KRATT-PRIME" }),
  }).code, "TARGET_OUT_OF_SCOPE");
});
test("blocks missing, unverified and mismatched approvals", () => {
  const base = { integration: descriptor(), operation: operation(), request: request(), effectiveScopes: scopes };
  assert.equal(evaluateIntegrationOperation(base).code, "APPROVAL_NOT_VERIFIED");
  assert.equal(evaluateIntegrationOperation({ ...base, approval: approval({ verified: false }) }).code, "APPROVAL_NOT_VERIFIED");
  assert.equal(evaluateIntegrationOperation({ ...base, approval: approval({ target: "other/repo" }) }).code, "APPROVAL_BINDING_MISMATCH");
  assert.equal(evaluateIntegrationOperation({ ...base, approval: approval({ requestId: "req:other" }) }).code, "APPROVAL_BINDING_MISMATCH");
});
test("blocks expired approval", () => {
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor(), operation: operation(), request: request(), effectiveScopes: scopes,
    approval: approval(), now: Date.parse("2026-11-27T00:00:00.000Z"),
  }).code, "APPROVAL_EXPIRED");
});
test("requires explicit destructive approval", () => {
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor(), operation: operation({ class: OPERATION_CLASSES.DESTRUCTIVE_WRITE }),
    request: request(), effectiveScopes: scopes, approval: approval({ destructive: false }),
  }).code, "DESTRUCTIVE_APPROVAL_REQUIRED");
});
test("blocks provider mismatch", () => {
  assert.equal(evaluateIntegrationOperation({
    integration: descriptor(), operation: operation(), request: request({ provider: "slack" }),
    effectiveScopes: scopes, approval: approval(),
  }).code, "PROVIDER_MISMATCH");
});
test("creates minimal redacted audit record", () => {
  const decision = evaluateIntegrationOperation({
    integration: descriptor(), operation: operation(), request: request(),
    effectiveScopes: scopes, approval: approval(),
  });
  const audit = toCapabilityAuditRecord(decision, {
    integrationId: "github.primary", actorRef: "principal:antonio",
    occurredAt: "2026-11-25T01:00:00.000Z",
  });
  assert.equal(audit.allowed, true);
  assert.equal(audit.approvalRef, "approval:wave11:01");
  assert.equal(Object.isFrozen(audit), true);
  assert.equal("accessToken" in audit, false);
});
test("rejects invalid audit input", () => {
  assert.throws(() => toCapabilityAuditRecord(null, { integrationId: "github.primary", actorRef: "principal:a" }));
  assert.throws(() => toCapabilityAuditRecord({ allowed: true }, { integrationId: "github.primary" }));
});
