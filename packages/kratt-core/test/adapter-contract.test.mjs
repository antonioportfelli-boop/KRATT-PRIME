import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeAdapterContract,
  validateAdapterContract,
  negotiateAdapterContract,
} from "../src/adapter-contract.mjs";

const makeContract = (overrides = {}) => ({
  schema: "3XT-ADAPTER",
  contractVersion: "1.0.0",
  adapterId: "github.readonly",
  provider: "github",
  implementation: {
    version: "1.2.0",
    executionMode: "WORKER_ISOLATED",
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
      maxAttempts: 2,
    },
  ],
  ...overrides,
});

const hostCompatibility = (overrides = {}) => ({
  contractVersions: ["1.0.0"],
  eventSchemas: [{ id: "3XT-FABRIC", version: "1" }],
  protocols: [{ id: "3XT-FABRIC", version: "1" }],
  providerApis: [{ id: "github-rest", version: "2022-11-28" }],
  configurationSchemas: [{ id: "github.adapter.config", version: "1.0.0" }],
  capabilities: [
    { id: "repository.read", version: "1.0.0" },
    { id: "repository.write", version: "1.0.0" },
  ],
  ...overrides,
});

test("normalizes a valid declarative contract and deeply freezes nested values", () => {
  const normalized = normalizeAdapterContract(makeContract());
  assert.equal(normalized.schema, "3XT-ADAPTER");
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.implementation.source), true);
  assert.equal(Object.isFrozen(normalized.operations[0].requiredCapabilities), true);
  assert.equal(normalized.operations.length, 2);
});

test("normalization produces deterministic operation and capability ordering", () => {
  const normalized = normalizeAdapterContract(makeContract());
  assert.deepEqual(normalized.capabilities.map((item) => item.id), ["repository.read", "repository.write"]);
  assert.deepEqual(normalized.operations.map((item) => item.operationId), [
    "repo.contents.read", "repo.contents.write",
  ]);
});

test("rejects unknown root fields rather than accepting self-declared trust", () => {
  const input = makeContract({ trusted: true });
  assert.deepEqual(validateAdapterContract(input), {
    ok: false, code: "ADAPTER_CONTRACT_SHAPE_INVALID",
  });
});

test("rejects accessors and proxies at the trust boundary", () => {
  const accessor = makeContract();
  Object.defineProperty(accessor, "provider", { enumerable: true, get() { throw new Error("getter invoked"); } });
  assert.equal(validateAdapterContract(accessor).code, "ADAPTER_CONTRACT_SHAPE_INVALID");
  const proxied = new Proxy(makeContract(), {});
  assert.equal(validateAdapterContract(proxied).code, "ADAPTER_CONTRACT_SHAPE_INVALID");
});

test("rejects path traversal, non-pinned source revisions and malformed artifact digests", () => {
  const pathTraversal = makeContract();
  pathTraversal.implementation.source.path = "../outside/adapter.mjs";
  assert.equal(validateAdapterContract(pathTraversal).code, "IMPLEMENTATION_SOURCE_INVALID");

  const movingRef = makeContract();
  movingRef.implementation.source.revision = "main";
  assert.equal(validateAdapterContract(movingRef).code, "IMPLEMENTATION_SOURCE_INVALID");

  const invalidDigest = makeContract();
  invalidDigest.implementation.artifactDigest = "not-a-sha256";
  assert.equal(validateAdapterContract(invalidDigest).code, "IMPLEMENTATION_ARTIFACT_DIGEST_INVALID");
});

test("rejects duplicated capabilities and operation identifiers", () => {
  const duplicateCapability = makeContract();
  duplicateCapability.capabilities.push({ id: "repository.read", version: "1.0.0" });
  assert.equal(validateAdapterContract(duplicateCapability).code, "CAPABILITY_ID_DUPLICATED");

  const duplicateOperation = makeContract();
  duplicateOperation.operations.push({ ...duplicateOperation.operations[0] });
  assert.equal(validateAdapterContract(duplicateOperation).code, "OPERATION_ID_DUPLICATED");
});

test("every operation must reference a declared capability", () => {
  const input = makeContract();
  input.operations[0].requiredCapabilities = ["admin.root"];
  assert.equal(validateAdapterContract(input).code, "OPERATION_CAPABILITY_UNDECLARED");
});

test("READ operations must declare idempotent semantics", () => {
  const input = makeContract();
  input.operations[0].idempotency = "UNKNOWN_EXTERNAL_SEMANTICS";
  input.operations[0].maxAttempts = 1;
  assert.equal(validateAdapterContract(input).code, "READ_OPERATION_MUST_BE_IDEMPOTENT");
});

test("unknown external semantics and at-most-once operations cannot advertise retries", () => {
  const input = makeContract();
  input.operations[1].idempotency = "UNKNOWN_EXTERNAL_SEMANTICS";
  input.operations[1].maxAttempts = 2;
  assert.equal(validateAdapterContract(input).code, "NON_REPLAYABLE_OPERATION_MAX_ATTEMPTS_MUST_BE_ONE");
});

test("contract versions and the four interoperability version dimensions are mandatory", () => {
  const input = makeContract();
  delete input.versions.providerApi;
  assert.equal(validateAdapterContract(input).code, "VERSION_SET_SHAPE_INVALID");
  const invalidVersion = makeContract({ contractVersion: "latest" });
  assert.equal(validateAdapterContract(invalidVersion).code, "ADAPTER_CONTRACT_VERSION_INVALID");
});

test("exactly matching host versions negotiate as compatible without granting authority", () => {
  const result = negotiateAdapterContract(makeContract(), hostCompatibility());
  assert.equal(result.supported, true);
  assert.equal(result.code, "EXACT_VERSION_MATCH");
  assert.equal("allowed" in result, false);
  assert.equal("authorized" in result, false);
});

test("an unknown event schema version fails closed without downgrade", () => {
  const result = negotiateAdapterContract(makeContract(), hostCompatibility({
    eventSchemas: [{ id: "3XT-FABRIC", version: "2" }],
  }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.unsupportedDimensions, ["eventSchema"]);
});

test("a provider API version mismatch is not silently mapped", () => {
  const result = negotiateAdapterContract(makeContract(), hostCompatibility({
    providerApis: [{ id: "github-rest", version: "2026-11-01" }],
  }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.unsupportedDimensions, ["providerApi"]);
});

test("capability identifier and version must both match", () => {
  const result = negotiateAdapterContract(makeContract(), hostCompatibility({
    capabilities: [{ id: "repository.read", version: "1.0.0" }],
  }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.unsupportedDimensions, ["capability:repository.write"]);
});

test("unsupported contract versions are rejected", () => {
  const result = negotiateAdapterContract(makeContract(), hostCompatibility({
    contractVersions: ["0.9.0"],
  }));
  assert.equal(result.supported, false);
  assert.deepEqual(result.unsupportedDimensions, ["contractVersion"]);
});

test("malformed host compatibility does not produce a positive negotiation", () => {
  const result = negotiateAdapterContract(makeContract(), { contractVersions: ["1.0.0"] });
  assert.equal(result.supported, false);
  assert.equal(result.code, "HOST_COMPATIBILITY_INVALID");
});

test("validation failures expose stable codes, not the rejected payload", () => {
  const result = validateAdapterContract({ secret: "do-not-reflect" });
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("do-not-reflect"), false);
});
