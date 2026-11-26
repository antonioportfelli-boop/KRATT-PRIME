import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  authorizeIntegrationOperation,
} from "../src/integration-registry.mjs";
import {
  createAdapterRegistrationRuntime,
} from "../src/adapter-registration.mjs";

const SOURCE = Buffer.from("export const adapter = true;\n", "utf8");
const REVISION = "a".repeat(40);
const ARTIFACT_DIGEST = createHash("sha256").update(SOURCE).digest("hex");
const ACTOR = "principal:antonio";
const NOW = Date.parse("2026-11-27T01:00:00.000Z");

const contract = (overrides = {}) => ({
  schema: "3XT-ADAPTER",
  contractVersion: "1.0.0",
  adapterId: "github.readonly",
  provider: "github",
  implementation: {
    version: "1.2.0",
    executionMode: "WORKER_ISOLATED",
    source: {
      repository: "antonioportfelli-boop/KRATT-PRIME",
      revision: REVISION,
      path: "packages/adapters/github/index.mjs",
    },
    artifactDigest: ARTIFACT_DIGEST,
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

function createStore({ createOutcome = "CREATED", updateOutcome = "UPDATED" } = {}) {
  const records = new Map();
  const audits = [];
  return {
    records,
    audits,
    async get(adapterId) {
      return records.get(adapterId) ?? null;
    },
    async createWithAudit({ record, auditEvent }) {
      if (createOutcome !== "CREATED") return createOutcome;
      if (records.has(record.adapterId)) return "ALREADY_EXISTS";
      records.set(record.adapterId, record);
      audits.push(auditEvent);
      return "CREATED";
    },
    async compareAndSwapWithAudit({ adapterId, expectedRevision, record, auditEvent }) {
      if (updateOutcome !== "UPDATED") return updateOutcome;
      const current = records.get(adapterId);
      if (!current) return "NOT_FOUND";
      if (current.revision !== expectedRevision) return "REVISION_MISMATCH";
      records.set(adapterId, record);
      audits.push(auditEvent);
      return "UPDATED";
    },
  };
}

function createRuntime({
  store = createStore(),
  sourceBytes = SOURCE,
  sourceOverride = {},
  provenanceReceipt = {
    verified: true,
    evidenceRef: "evidence:source:01",
    verifierRef: "verifier:git:01",
  },
  conformanceReceipt = {
    verified: true,
    evidenceRef: "evidence:conformance:01",
    verifierRef: "verifier:ci:01",
  },
  host = hostCompatibility(),
  clock = () => NOW,
  conformanceVerifier = true,
} = {}) {
  const seen = { source: [], provenance: [], conformance: [] };
  const runtime = createAdapterRegistrationRuntime({
    registrationStore: store,
    sourceReader: {
      async readPinnedSource(input) {
        seen.source.push(input);
        return {
          repository: input.repository,
          revision: input.revision,
          path: input.path,
          bytes: sourceBytes,
          ...sourceOverride,
        };
      },
    },
    provenanceVerifier: {
      async verify(input) {
        seen.provenance.push(input);
        return provenanceReceipt;
      },
    },
    conformanceVerifier: conformanceVerifier
      ? {
          async verify(input) {
            seen.conformance.push(input);
            return conformanceReceipt;
          },
        }
      : null,
    hostCompatibility: host,
    now: clock,
  });
  return { runtime, store, seen };
}

function request(mode, operation) {
  return {
    request_id: "req:adapter-registration:01",
    principal: ACTOR,
    operation,
    mode,
    scope: "repo:KRATT-PRIME:feature/*",
    args_digest: "c".repeat(64),
  };
}

test("constructor requires host-owned store, source reader and verifiers", () => {
  assert.throws(() => createAdapterRegistrationRuntime({}), /ADAPTER_REGISTRATION_STORE_REQUIRED/);
});

test("register pins exact source, verifies bytes and stores CONNECTED_UNVERIFIED with an audit event", async () => {
  const { runtime, store, seen } = createRuntime();
  const result = await runtime.register({ contract: contract(), actorRef: ACTOR });
  assert.equal(result.ok, true);
  assert.equal(result.record.integration.state, "CONNECTED_UNVERIFIED");
  assert.equal(result.record.sourceProvenance.artifactDigest, ARTIFACT_DIGEST);
  assert.equal(result.record.revision, 1);
  assert.equal(store.audits.length, 1);
  assert.equal(store.audits[0].eventType, "adapter.registration.created");
  assert.deepEqual(seen.source[0], {
    repository: "antonioportfelli-boop/KRATT-PRIME",
    revision: REVISION,
    path: "packages/adapters/github/index.mjs",
  });
  assert.equal(seen.provenance[0].artifactDigest, ARTIFACT_DIGEST);
  assert.equal(typeof runtime.enableWrite, "undefined");
  assert.equal(typeof runtime.execute, "undefined");
  assert.equal(typeof runtime.load, "undefined");
});

test("unverified registration blocks both read and write operations", async () => {
  const { runtime } = createRuntime();
  const registered = await runtime.register({ contract: contract(), actorRef: ACTOR });
  const integration = registered.record.integration;
  assert.equal(authorizeIntegrationOperation({
    integration,
    request: request("read", "repo.contents.read"),
    now: NOW,
  }).reason, "INTEGRATION_NOT_VERIFIED");
  assert.equal(authorizeIntegrationOperation({
    integration,
    request: request("write", "repo.contents.write"),
    now: NOW,
  }).reason, "INTEGRATION_NOT_VERIFIED");
});

test("rejects artifact bytes whose digest differs from the pinned manifest", async () => {
  const { runtime, store } = createRuntime({ sourceBytes: Buffer.from("tampered", "utf8") });
  const result = await runtime.register({ contract: contract(), actorRef: ACTOR });
  assert.deepEqual(result, { ok: false, code: "ARTIFACT_DIGEST_MISMATCH" });
  assert.equal(store.records.size, 0);
  assert.equal(store.audits.length, 0);
});

test("rejects a source reader that returns a different pinned repository, revision or path", async () => {
  for (const sourceOverride of [
    { repository: "attacker/repo" },
    { revision: "b".repeat(40) },
    { path: "packages/evil.mjs" },
  ]) {
    const { runtime, store } = createRuntime({ sourceOverride });
    const result = await runtime.register({ contract: contract(), actorRef: ACTOR });
    assert.deepEqual(result, { ok: false, code: "PINNED_SOURCE_BINDING_INVALID" });
    assert.equal(store.records.size, 0);
  }
});

test("rejects malformed or self-asserted provenance receipts", async () => {
  for (const provenanceReceipt of [
    { verified: false, evidenceRef: "evidence:source:01", verifierRef: "verifier:git:01" },
    { verified: true, evidenceRef: "evidence:source:01" },
    { verified: true, evidenceRef: " ", verifierRef: "verifier:git:01" },
  ]) {
    const { runtime, store } = createRuntime({ provenanceReceipt });
    const result = await runtime.register({ contract: contract(), actorRef: ACTOR });
    assert.deepEqual(result, { ok: false, code: "SOURCE_PROVENANCE_UNVERIFIED" });
    assert.equal(store.records.size, 0);
  }
});

test("rejects unsupported host compatibility without downgrade", async () => {
  const { runtime, store } = createRuntime({
    host: hostCompatibility({ providerApis: [{ id: "github-rest", version: "2027-01-01" }] }),
  });
  const result = await runtime.register({ contract: contract(), actorRef: ACTOR });
  assert.deepEqual(result, { ok: false, code: "ADAPTER_CONTRACT_UNSUPPORTED" });
  assert.equal(store.records.size, 0);
});

test("rejects duplicate registration", async () => {
  const { runtime } = createRuntime();
  assert.equal((await runtime.register({ contract: contract(), actorRef: ACTOR })).ok, true);
  assert.deepEqual(await runtime.register({ contract: contract(), actorRef: ACTOR }), {
    ok: false, code: "ADAPTER_ALREADY_REGISTERED",
  });
});

test("does not enter VERIFIED_READ_ONLY without an injected conformance verifier", async () => {
  const { runtime } = createRuntime({ conformanceVerifier: false });
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  assert.deepEqual(await runtime.verifyReadOnly({ adapterId: "github.readonly", actorRef: ACTOR }), {
    ok: false, code: "READ_ONLY_VERIFIER_UNAVAILABLE",
  });
});

test("independently verified conformance advances only to VERIFIED_READ_ONLY", async () => {
  const { runtime, store, seen } = createRuntime();
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  const verified = await runtime.verifyReadOnly({ adapterId: "github.readonly", actorRef: ACTOR });
  assert.equal(verified.ok, true);
  assert.equal(verified.record.integration.state, "VERIFIED_READ_ONLY");
  assert.equal(verified.record.revision, 2);
  assert.equal(store.audits.length, 2);
  assert.equal(store.audits[1].previousState, "CONNECTED_UNVERIFIED");
  assert.equal(store.audits[1].nextState, "VERIFIED_READ_ONLY");
  assert.equal(seen.conformance[0].contractDigest, verified.record.contractDigest);

  const read = authorizeIntegrationOperation({
    integration: verified.record.integration,
    request: request("read", "repo.contents.read"),
    now: NOW,
  });
  assert.equal(read.allowed, true);
  assert.equal(read.decision, "ALLOW_READ_ONLY");

  const write = authorizeIntegrationOperation({
    integration: verified.record.integration,
    request: request("write", "repo.contents.write"),
    approval: {
      request_id: "req:adapter-registration:01",
      integration_id: "github.readonly",
      principal: ACTOR,
      operation: "repo.contents.write",
      scope: "repo:KRATT-PRIME:feature/*",
      args_digest: "c".repeat(64),
      status: "approved",
      expires_at: "2026-11-27T02:00:00.000Z",
    },
    now: NOW,
  });
  assert.equal(write.allowed, false);
  assert.equal(write.reason, "WRITE_NOT_ENABLED");
  assert.equal(typeof runtime.enableWrite, "undefined");
});

test("a failed conformance attestation cannot change lifecycle state", async () => {
  const { runtime } = createRuntime({
    conformanceReceipt: {
      verified: false,
      evidenceRef: "evidence:conformance:01",
      verifierRef: "verifier:ci:01",
    },
  });
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  const result = await runtime.verifyReadOnly({ adapterId: "github.readonly", actorRef: ACTOR });
  assert.deepEqual(result, { ok: false, code: "READ_ONLY_CONFORMANCE_UNVERIFIED" });
  const current = await runtime.get("github.readonly");
  assert.equal(current.record.integration.state, "CONNECTED_UNVERIFIED");
  assert.equal(current.record.revision, 1);
});

test("revision compare-and-swap failure does not report successful verification", async () => {
  const store = createStore({ updateOutcome: "REVISION_MISMATCH" });
  const { runtime } = createRuntime({ store });
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  const result = await runtime.verifyReadOnly({ adapterId: "github.readonly", actorRef: ACTOR });
  assert.deepEqual(result, { ok: false, code: "REGISTRATION_REVISION_CHANGED" });
  assert.equal(store.audits.length, 1);
});

test("read-back integrity failure does not return a successful registration", async () => {
  const store = createStore();
  const originalGet = store.get.bind(store);
  let reads = 0;
  store.get = async (adapterId) => {
    reads += 1;
    if (reads > 1) return { invalid: true };
    return originalGet(adapterId);
  };
  const { runtime } = createRuntime({ store });
  const result = await runtime.register({ contract: contract(), actorRef: ACTOR });
  assert.deepEqual(result, { ok: false, code: "REGISTRATION_READBACK_FAILED" });
});

test("disable is a host-controlled terminal transition with a minimal audit event", async () => {
  const { runtime, store } = createRuntime();
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  const disabled = await runtime.disable({
    adapterId: "github.readonly",
    actorRef: ACTOR,
    reasonCode: "OPERATOR_REQUEST",
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.record.integration.state, "DISABLED");
  assert.equal(store.audits.at(-1).eventType, "adapter.lifecycle.disabled");
  assert.equal(store.audits.at(-1).reasonCode, "OPERATOR_REQUEST");
});

test("markError uses the existing lifecycle transition graph", async () => {
  const { runtime } = createRuntime();
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  const failed = await runtime.markError({
    adapterId: "github.readonly",
    actorRef: ACTOR,
    reasonCode: "PROVENANCE_REVOKED",
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.record.integration.state, "ERROR");
});

test("arbitrary reason text and malformed actor references are rejected", async () => {
  const { runtime } = createRuntime();
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  assert.deepEqual(await runtime.disable({
    adapterId: "github.readonly", actorRef: ACTOR, reasonCode: "token=secret",
  }), { ok: false, code: "REASON_CODE_INVALID" });
  assert.deepEqual(await runtime.disable({
    adapterId: "github.readonly", actorRef: "   ", reasonCode: "OPERATOR_REQUEST",
  }), { ok: false, code: "ACTOR_REFERENCE_INVALID" });
});

test("an invalid operation-to-lifecycle mapping is rejected", async () => {
  const invalid = contract();
  invalid.operations[0].operationId = "READ";
  const { runtime, store } = createRuntime();
  const result = await runtime.register({ contract: invalid, actorRef: ACTOR });
  assert.deepEqual(result, { ok: false, code: "INTEGRATION_OPERATION_MAPPING_INVALID" });
  assert.equal(store.records.size, 0);
});

test("registration storage commit failure is not reported as success", async () => {
  const store = createStore({ createOutcome: "COMMIT_FAILED" });
  const { runtime } = createRuntime({ store });
  assert.deepEqual(await runtime.register({ contract: contract(), actorRef: ACTOR }), {
    ok: false, code: "REGISTRATION_COMMIT_FAILED",
  });
});

test("tampered persisted contract digest or source binding fails closed on read", async () => {
  const { runtime, store } = createRuntime();
  const registered = await runtime.register({ contract: contract(), actorRef: ACTOR });
  store.records.set("github.readonly", {
    ...registered.record,
    contractDigest: "d".repeat(64),
  });
  assert.deepEqual(await runtime.get("github.readonly"), {
    ok: false, code: "REGISTRATION_RECORD_INVALID",
  });
});

test("read-only verification is idempotent and does not create a second audit event", async () => {
  const { runtime, store } = createRuntime();
  await runtime.register({ contract: contract(), actorRef: ACTOR });
  await runtime.verifyReadOnly({ adapterId: "github.readonly", actorRef: ACTOR });
  const again = await runtime.verifyReadOnly({ adapterId: "github.readonly", actorRef: ACTOR });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(store.audits.length, 2);
});


test("rejects accessor-bearing public requests without evaluating caller getters", async () => {
  const { runtime, store } = createRuntime();
  let getterCalled = false;
  const input = {};
  Object.defineProperty(input, "contract", {
    enumerable: true,
    get() {
      getterCalled = true;
      throw new Error("must not run");
    },
  });
  Object.defineProperty(input, "actorRef", { enumerable: true, value: ACTOR });
  assert.deepEqual(await runtime.register(input), {
    ok: false, code: "REGISTRATION_REQUEST_INVALID",
  });
  assert.equal(getterCalled, false);
  assert.equal(store.records.size, 0);
});
