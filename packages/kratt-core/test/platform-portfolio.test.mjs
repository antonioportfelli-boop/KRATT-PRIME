import test from "node:test";
import assert from "node:assert/strict";
import { PLATFORM_PORTFOLIO, MATURITY, READINESS, OPERATION, validatePlatformPortfolio, evaluatePlatformIntegration } from "../src/platform-portfolio.mjs";

test("portfolio validates and is immutable", () => {
  assert.deepEqual(validatePlatformPortfolio(), { ok: true, errors: [] });
  assert.equal(Object.isFrozen(PLATFORM_PORTFOLIO), true);
  assert.equal(Object.isFrozen(PLATFORM_PORTFOLIO.systems[0]), true);
});
test("canonical repository ownership is explicit and unique", () => {
  const repos = PLATFORM_PORTFOLIO.systems.map(x => x.repository);
  assert.equal(new Set(repos).size, repos.length);
  assert.equal(PLATFORM_PORTFOLIO.systems.find(x => x.id === "kratt-prime").repository, "antonioportfelli-boop/KRATT-PRIME");
  assert.equal(PLATFORM_PORTFOLIO.systems.find(x => x.id === "steel").repository, "3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP-");
});
test("GOLIATH is an experimental component inside KRATT, not a separate repository", () => {
  const x = PLATFORM_PORTFOLIO.components[0];
  assert.equal(x.ownerSystem, "kratt-prime");
  assert.equal(x.repository, "antonioportfelli-boop/KRATT-PRIME");
  assert.equal(x.maturity, MATURITY.EXPERIMENTAL);
});
test("rejects duplicate system repository ownership", () => {
  const input = structuredClone(PLATFORM_PORTFOLIO);
  input.systems.push({ ...input.systems[0], id: "kratt-copy" });
  assert.ok(validatePlatformPortfolio(input).errors.includes("SYSTEM_REPOSITORY_DUPLICATE:antonioportfelli-boop/KRATT-PRIME"));
});
test("rejects unknown component owner and unsafe component path", () => {
  const input = structuredClone(PLATFORM_PORTFOLIO);
  input.components[0].ownerSystem = "missing-system";
  input.components[0].path = "../outside";
  const errors = validatePlatformPortfolio(input).errors;
  assert.ok(errors.includes("COMPONENT_OWNER_UNKNOWN:goliath-kernel"));
  assert.ok(errors.includes("COMPONENT_PATH_INVALID:goliath-kernel"));
});
test("rejects unknown integration endpoints and unapproved write policy", () => {
  const input = structuredClone(PLATFORM_PORTFOLIO);
  input.integrations[0].target = "unknown-system";
  input.integrations[0].externalWrites = "APPROVAL_GATED";
  input.integrations[0].approvalRequired = false;
  const errors = validatePlatformPortfolio(input).errors;
  assert.ok(errors.includes("INTEGRATION_ENDPOINT_UNKNOWN:kratt-steel-fabric"));
  assert.ok(errors.includes("INTEGRATION_APPROVAL_REQUIRED:kratt-steel-fabric"));
});
test("rejects secret-like fields in the portfolio", () => {
  const input = structuredClone(PLATFORM_PORTFOLIO);
  input.credentials = { apiKey: "never-store-here" };
  assert.ok(validatePlatformPortfolio(input).errors.includes("PORTFOLIO_SECRET_FIELD_FORBIDDEN"));
});
test("unverified cross-system reads fail closed", () => {
  for (const edge of PLATFORM_PORTFOLIO.integrations) {
    assert.ok([READINESS.DOCUMENTED, READINESS.CONTRACT, READINESS.DEMO].includes(edge.readiness));
    assert.deepEqual(evaluatePlatformIntegration({ integrationId: edge.id, operationClass: OPERATION.READ }), { allowed: false, code: "INTEGRATION_NOT_VERIFIED" });
  }
});
test("unverified cross-system writes fail closed even with a claimed approval", () => {
  for (const edge of PLATFORM_PORTFOLIO.integrations) {
    assert.deepEqual(evaluatePlatformIntegration({ integrationId: edge.id, operationClass: OPERATION.WRITE, approvalVerified: true }), { allowed: false, code: "EXTERNAL_WRITE_NOT_ENABLED" });
  }
});
test("unknown integrations and invalid operation classes fail closed", () => {
  assert.deepEqual(evaluatePlatformIntegration({ integrationId: "unknown-edge", operationClass: OPERATION.READ }), { allowed: false, code: "INTEGRATION_NOT_FOUND" });
  assert.deepEqual(evaluatePlatformIntegration({ integrationId: "kratt-steel-fabric", operationClass: "DEPLOY_TO_PRODUCTION" }), { allowed: false, code: "INVALID_INTEGRATION_REQUEST" });
});