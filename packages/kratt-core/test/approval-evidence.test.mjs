import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryApprovalLedger, normalizeApprovalEnvelope, verifyApprovalForRequest } from "../src/approval-evidence.mjs";
const now = Date.parse("2026-11-25T12:00:00Z");
const envelope = (overrides = {}) => ({
  approvalId: "approval.01", requestId: "request.01", principalRef: "principal.01",
  agentRef: "agent.01", provider: "github", operationId: "repo.write", target: "org/repo:feature/x",
  scopes: ["repo.write"], issuedAt: "2026-11-25T11:59:00Z", expiresAt: "2026-11-25T12:05:00Z",
  nonce: "nonce-value-0123456789", evidenceRef: "evidence.01", destructive: false, ...overrides,
});
const request = { requestId: "request.01", provider: "github", operationId: "repo.write", target: "org/repo:feature/x", destructive: false };
const verify = (overrides = {}) => verifyApprovalForRequest({
  envelope: envelope(), verifier: { verify: async () => true }, request, principalRef: "principal.01",
  agentRef: "agent.01", requiredScopes: ["repo.write"], now, ...overrides,
});
test("normalizes immutable envelope", () => { const a = normalizeApprovalEnvelope(envelope()); assert.equal(a.schemaVersion, 1); assert.ok(Object.isFrozen(a)); });
test("rejects duplicate scopes", () => assert.throws(() => normalizeApprovalEnvelope(envelope({ scopes: ["repo.write", "repo.write"] }))));
test("fails closed without verifier", async () => assert.equal((await verify({ verifier: null })).code, "VERIFIER_UNAVAILABLE"));
test("does not trust caller verified flag", async () => assert.equal((await verify({ verifier: { verify: async () => false } })).code, "APPROVAL_UNTRUSTED"));
test("binds approval to exact target and actor", async () => assert.equal((await verify({ request: { ...request, target: "other/repo" } })).code, "APPROVAL_BINDING_MISMATCH"));
test("rejects expired and future-issued approvals", async () => {
  assert.equal((await verify({ now: Date.parse("2026-11-25T12:06:00Z") })).code, "APPROVAL_EXPIRED");
  assert.equal((await verify({ now: Date.parse("2026-11-25T11:58:00Z") })).code, "APPROVAL_NOT_YET_VALID");
});
test("enforces scopes and destructive approval", async () => {
  assert.equal((await verify({ requiredScopes: ["repo.write", "repo.admin"] })).code, "APPROVAL_SCOPE_MISSING");
  assert.equal((await verify({ request: { ...request, destructive: true } })).code, "DESTRUCTIVE_APPROVAL_REQUIRED");
});
test("verifier errors fail closed", async () => assert.equal((await verify({ verifier: { verify: async () => { throw Error("no"); } } })).code, "VERIFIER_ERROR"));
test("ledger consumes once and blocks replay", async () => {
  const a = await verify(), ledger = new InMemoryApprovalLedger();
  assert.equal(ledger.consume(a, { now }).code, "APPROVAL_CONSUMED");
  assert.equal(ledger.consume(a, { now }).code, "APPROVAL_REPLAYED");
});
test("ledger rejects unverified and revoked approvals", async () => {
  const ledger = new InMemoryApprovalLedger(), a = await verify();
  assert.equal(ledger.consume({ ...a, code: "APPROVAL_VERIFIED" }, { now }).code, "APPROVAL_NOT_VERIFIED");
  ledger.revoke(a.approvalId);
  assert.equal(ledger.consume(a, { now }).code, "APPROVAL_REVOKED");
});
