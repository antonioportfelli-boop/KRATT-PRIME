import test from "node:test";
import assert from "node:assert/strict";
import { routePolicyOperation } from "../src/policy-router.mjs";

test("fails closed on missing trusted context", () => {
  const result = routePolicyOperation({}, undefined);
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.executionStarted, false);
});
test("rejects caller-supplied authorization fields", () => {
  const result = routePolicyOperation({ approval: { verificationState: "VERIFIED" } }, {});
  assert.equal(result.reason, "POLICY_REQUEST_FIELDS_UNTRUSTED");
});
test("rejects incomplete server-owned scope context", () => {
  const result = routePolicyOperation({}, { principalScopes: [] });
  assert.equal(result.reason, "POLICY_TRUSTED_CONTEXT_INCOMPLETE");
});
test("blocks malformed manifests without execution", () => {
  const result = routePolicyOperation(
    { manifest: {}, operationId: "read", target: { resourceType: "repo", resourceId: "x" } },
    { principalScopes: [], agentScopes: [], taskScopes: [], now: "2026-11-07T00:00:00Z" }
  );
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.executionStarted, false);
});
test("fails closed on malicious getters", () => {
  const request = { get manifest() { throw new Error("unexpected getter"); } };
  const result = routePolicyOperation(request, {
    principalScopes: [], agentScopes: [], taskScopes: [], now: "2026-11-07T00:00:00Z"
  });
  assert.equal(result.decision, "BLOCKED");
  assert.equal(result.executionStarted, false);
});
