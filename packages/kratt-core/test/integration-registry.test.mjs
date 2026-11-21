import test from "node:test";
import assert from "node:assert/strict";
import {
  authorizeIntegrationOperation,
  listAllowedTransitions,
  transitionIntegrationState,
  validateIntegrationRecord,
} from "../src/integration-registry.mjs";

const INTEGRATION = {
  integration_id: "github-main",
  name: "GitHub API",
  state: "VERIFIED_READ_ONLY",
  read_operations: ["repository.read", "pull-request.read"],
  write_operations: ["branch.create", "file.write"],
};
const REQUEST = {
  request_id: "req-2026-11-18-0001",
  principal: "owner-01",
  operation: "file.write",
  mode: "write",
  scope: "repo:KRATT-PRIME:feature/*",
  args_digest: "a".repeat(64),
};
const APPROVAL = {
  request_id: REQUEST.request_id,
  integration_id: INTEGRATION.integration_id,
  principal: REQUEST.principal,
  operation: REQUEST.operation,
  scope: REQUEST.scope,
  args_digest: REQUEST.args_digest,
  status: "approved",
  expires_at: "2026-11-18T18:00:00.000Z",
};
const NOW = Date.parse("2026-11-18T15:00:00.000Z");

test("validates a minimal integration contract without credentials", () => {
  assert.deepEqual(validateIntegrationRecord(INTEGRATION), { ok: true });
  assert.deepEqual(validateIntegrationRecord({ ...INTEGRATION, api_key: "secret" }), {
    ok: false,
    errors: ["INTEGRATION_SHAPE_INVALID"],
  });
});

test("rejects invalid and overlapping operation scopes", () => {
  assert.equal(validateIntegrationRecord({ ...INTEGRATION, read_operations: ["branch.create"] }).errors[0],
    "INTEGRATION_OPERATION_MODE_OVERLAP");
  assert.equal(validateIntegrationRecord({ ...INTEGRATION, write_operations: ["not an action"] }).ok, false);
});

test("enforces the explicit lifecycle transition graph", () => {
  const changed = transitionIntegrationState(INTEGRATION, "WRITE_PENDING_APPROVAL");
  assert.equal(changed.ok, true);
  assert.equal(changed.value.state, "WRITE_PENDING_APPROVAL");
  assert.deepEqual(listAllowedTransitions("DISABLED"), []);
  assert.deepEqual(transitionIntegrationState(INTEGRATION, "DISCOVERED"), {
    ok: false,
    errors: ["INTEGRATION_TRANSITION_DENIED"],
  });
});

test("allows a scoped read only after verification", () => {
  const result = authorizeIntegrationOperation({
    integration: INTEGRATION,
    request: { ...REQUEST, mode: "read", operation: "repository.read" },
    now: NOW,
  });
  assert.deepEqual(result, { allowed: true, decision: "ALLOW_READ_ONLY", approval_required: false });
});

test("denies reads from unverified integrations and out-of-scope read operations", () => {
  assert.equal(authorizeIntegrationOperation({
    integration: { ...INTEGRATION, state: "CONNECTED_UNVERIFIED" },
    request: { ...REQUEST, mode: "read", operation: "repository.read" },
    now: NOW,
  }).reason, "INTEGRATION_NOT_VERIFIED");
  assert.equal(authorizeIntegrationOperation({
    integration: INTEGRATION,
    request: { ...REQUEST, mode: "read", operation: "admin.delete" },
    now: NOW,
  }).reason, "READ_OPERATION_OUT_OF_SCOPE");
});

test("denies writes unless state is WRITE_ENABLED", () => {
  assert.equal(authorizeIntegrationOperation({
    integration: INTEGRATION,
    request: REQUEST,
    approval: APPROVAL,
    now: NOW,
  }).reason, "WRITE_NOT_ENABLED");
});

test("denies a write when approval is absent or malformed", () => {
  const enabled = { ...INTEGRATION, state: "WRITE_ENABLED" };
  assert.equal(authorizeIntegrationOperation({ integration: enabled, request: REQUEST, now: NOW }).reason,
    "REQUEST_BOUND_APPROVAL_REQUIRED");
  assert.equal(authorizeIntegrationOperation({
    integration: enabled, request: REQUEST, approval: { ...APPROVAL, scope: "repo:KRATT-PRIME:main" }, now: NOW,
  }).reason, "APPROVAL_BINDING_MISMATCH");
});

test("denies approval replay across request, principal, operation, scope or args digest", () => {
  const enabled = { ...INTEGRATION, state: "WRITE_ENABLED" };
  for (const altered of [
    { request_id: "other-request" },
    { principal: "other-principal" },
    { operation: "branch.create" },
    { scope: "repo:other/*" },
    { args_digest: "b".repeat(64) },
  ]) {
    assert.equal(authorizeIntegrationOperation({
      integration: enabled,
      request: REQUEST,
      approval: { ...APPROVAL, ...altered },
      now: NOW,
    }).reason, "APPROVAL_BINDING_MISMATCH");
  }
});

test("denies expired approvals and requires caller-supplied trusted time", () => {
  const enabled = { ...INTEGRATION, state: "WRITE_ENABLED" };
  assert.equal(authorizeIntegrationOperation({
    integration: enabled,
    request: REQUEST,
    approval: { ...APPROVAL, expires_at: "2026-11-18T14:59:59.000Z" },
    now: NOW,
  }).reason, "APPROVAL_EXPIRED");
  assert.equal(authorizeIntegrationOperation({
    integration: enabled, request: REQUEST, approval: APPROVAL,
  }).reason, "TRUSTED_TIME_REQUIRED");
});

test("denies disabled, error and structurally unsafe records", () => {
  for (const state of ["DISABLED", "ERROR"]) {
    assert.notEqual(authorizeIntegrationOperation({
      integration: { ...INTEGRATION, state },
      request: { ...REQUEST, mode: "read", operation: "repository.read" },
      now: NOW,
    }).allowed, true);
  }
  const getter = { ...INTEGRATION };
  Object.defineProperty(getter, "name", { get() { throw new Error("must not run"); } });
  assert.equal(validateIntegrationRecord(getter).errors[0], "INTEGRATION_SHAPE_INVALID");
});
