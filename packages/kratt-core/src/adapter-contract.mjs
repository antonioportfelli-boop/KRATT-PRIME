import { types as utilTypes } from "node:util";

export const ADAPTER_CONTRACT_SCHEMA = "3XT-ADAPTER";
export const ADAPTER_EXECUTION_MODES = Object.freeze([
  "IN_PROCESS_TRUSTED",
  "WORKER_ISOLATED",
  "PROCESS_ISOLATED",
]);
export const ADAPTER_OPERATION_CLASSES = Object.freeze([
  "READ",
  "EXTERNAL_WRITE",
  "DESTRUCTIVE_WRITE",
]);
export const ADAPTER_IDEMPOTENCY_CLASSES = Object.freeze([
  "IDEMPOTENT",
  "DEDUPLICATED",
  "AT_MOST_ONCE_ATTEMPT",
  "UNKNOWN_EXTERNAL_SEMANTICS",
]);

const ROOT_KEYS = [
  "schema", "contractVersion", "adapterId", "provider", "implementation",
  "versions", "capabilities", "operations",
];
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const PROVIDER = /^[a-z][a-z0-9.-]{0,63}$/;
const VERSION_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,63}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function fail(code) {
  throw new TypeError(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasExactDataKeys(value, keys) {
  try {
    if (!isPlainRecord(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length ||
        ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return Boolean(descriptor && "value" in descriptor && descriptor.enumerable);
    });
  } catch {
    return false;
  }
}

function readDenseArray(value, { min, max, label }) {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || value.length < min || value.length > max) {
    fail(label + "_ARRAY_INVALID");
  }
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(label + "_ARRAY_UNREADABLE");
  }
  if (keys.length !== value.length + 1 ||
      keys.some((key) => key !== "length" &&
        (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) {
    fail(label + "_ARRAY_NOT_DENSE");
  }
  const output = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(label + "_ARRAY_ACCESSOR_OR_HOLE");
    }
    output.push(descriptor.value);
  }
  return output;
}

function readStringArray(value, { min, max, label, pattern = IDENTIFIER }) {
  const values = readDenseArray(value, { min, max, label });
  if (values.some((item) => typeof item !== "string" || !pattern.test(item)) ||
      new Set(values).size !== values.length) {
    fail(label + "_VALUES_INVALID_OR_DUPLICATED");
  }
  return [...values].sort();
}

function readPair(value, label) {
  if (!hasExactDataKeys(value, ["id", "version"])) fail(label + "_SHAPE_INVALID");
  if (typeof value.id !== "string" || !IDENTIFIER.test(value.id) ||
      typeof value.version !== "string" || !VERSION_TOKEN.test(value.version)) {
    fail(label + "_VALUE_INVALID");
  }
  return Object.freeze({ id: value.id, version: value.version });
}

function pairKey(pair) {
  return pair.id + "\u0000" + pair.version;
}

function readPairArray(value, { min = 0, max = 32, label }) {
  const entries = readDenseArray(value, { min, max, label });
  const pairs = entries.map((item) => readPair(item, label + "_ENTRY"));
  if (new Set(pairs.map(pairKey)).size !== pairs.length) fail(label + "_DUPLICATED");
  return pairs.sort((a, b) => compareText(pairKey(a), pairKey(b)));
}

function readCapabilityArray(value) {
  const entries = readDenseArray(value, { min: 1, max: 128, label: "CAPABILITIES" });
  const capabilities = entries.map((item) => readPair(item, "CAPABILITY"));
  if (new Set(capabilities.map((item) => item.id)).size !== capabilities.length) {
    fail("CAPABILITY_ID_DUPLICATED");
  }
  return capabilities.sort((a, b) => compareText(a.id, b.id));
}

function readOperationArray(value, capabilities) {
  const entries = readDenseArray(value, { min: 1, max: 128, label: "OPERATIONS" });
  const operations = entries.map((item) => {
    const keys = [
      "operationId", "class", "requiredCapabilities", "idempotency",
      "timeoutMs", "maxAttempts",
    ];
    if (!hasExactDataKeys(item, keys)) fail("OPERATION_SHAPE_INVALID");
    if (typeof item.operationId !== "string" || !IDENTIFIER.test(item.operationId)) {
      fail("OPERATION_ID_INVALID");
    }
    if (!ADAPTER_OPERATION_CLASSES.includes(item.class)) fail("OPERATION_CLASS_INVALID");
    if (!ADAPTER_IDEMPOTENCY_CLASSES.includes(item.idempotency)) fail("OPERATION_IDEMPOTENCY_INVALID");
    if (!Number.isSafeInteger(item.timeoutMs) ||
        item.timeoutMs < MIN_TIMEOUT_MS || item.timeoutMs > MAX_TIMEOUT_MS) {
      fail("OPERATION_TIMEOUT_INVALID");
    }
    if (!Number.isSafeInteger(item.maxAttempts) || item.maxAttempts < 1 || item.maxAttempts > 10) {
      fail("OPERATION_MAX_ATTEMPTS_INVALID");
    }
    const requiredCapabilities = readStringArray(item.requiredCapabilities, {
      min: 1, max: 32, label: "OPERATION_REQUIRED_CAPABILITIES",
    });
    if (requiredCapabilities.some((id) => !capabilities.has(id))) {
      fail("OPERATION_CAPABILITY_UNDECLARED");
    }
    if (item.class === "READ" && item.idempotency !== "IDEMPOTENT") {
      fail("READ_OPERATION_MUST_BE_IDEMPOTENT");
    }
    if (["AT_MOST_ONCE_ATTEMPT", "UNKNOWN_EXTERNAL_SEMANTICS"].includes(item.idempotency) &&
        item.maxAttempts !== 1) {
      fail("NON_REPLAYABLE_OPERATION_MAX_ATTEMPTS_MUST_BE_ONE");
    }
    return Object.freeze({
      operationId: item.operationId,
      class: item.class,
      requiredCapabilities: Object.freeze(requiredCapabilities),
      idempotency: item.idempotency,
      timeoutMs: item.timeoutMs,
      maxAttempts: item.maxAttempts,
    });
  });
  if (new Set(operations.map((item) => item.operationId)).size !== operations.length) {
    fail("OPERATION_ID_DUPLICATED");
  }
  return operations.sort((a, b) => compareText(a.operationId, b.operationId));
}

function normalizeImplementation(value) {
  if (!hasExactDataKeys(value, ["version", "executionMode", "source", "artifactDigest"])) {
    fail("IMPLEMENTATION_SHAPE_INVALID");
  }
  if (typeof value.version !== "string" || !SEMVER.test(value.version)) fail("IMPLEMENTATION_VERSION_INVALID");
  if (!ADAPTER_EXECUTION_MODES.includes(value.executionMode)) fail("EXECUTION_MODE_INVALID");
  if (!hasExactDataKeys(value.source, ["repository", "revision", "path"])) fail("IMPLEMENTATION_SOURCE_INVALID");
  if (typeof value.source.repository !== "string" || !REPOSITORY.test(value.source.repository) ||
      typeof value.source.revision !== "string" || !COMMIT.test(value.source.revision) ||
      typeof value.source.path !== "string" || value.source.path.length < 1 || value.source.path.length > 240 ||
      value.source.path.startsWith("/") || value.source.path.includes("\\") ||
      value.source.path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("IMPLEMENTATION_SOURCE_INVALID");
  }
  if (typeof value.artifactDigest !== "string" || !SHA256.test(value.artifactDigest)) {
    fail("IMPLEMENTATION_ARTIFACT_DIGEST_INVALID");
  }
  return Object.freeze({
    version: value.version,
    executionMode: value.executionMode,
    source: Object.freeze({
      repository: value.source.repository,
      revision: value.source.revision,
      path: value.source.path,
    }),
    artifactDigest: value.artifactDigest,
  });
}

/**
 * Validate and normalize a declarative adapter contract.
 *
 * A valid contract is still only a declaration. This function does not trust,
 * register, authorize, load, or execute an adapter.
 */
export function normalizeAdapterContract(input) {
  if (!hasExactDataKeys(input, ROOT_KEYS)) fail("ADAPTER_CONTRACT_SHAPE_INVALID");
  if (input.schema !== ADAPTER_CONTRACT_SCHEMA) fail("ADAPTER_CONTRACT_SCHEMA_UNSUPPORTED");
  if (typeof input.contractVersion !== "string" || !SEMVER.test(input.contractVersion)) {
    fail("ADAPTER_CONTRACT_VERSION_INVALID");
  }
  if (typeof input.adapterId !== "string" || !IDENTIFIER.test(input.adapterId)) fail("ADAPTER_ID_INVALID");
  if (typeof input.provider !== "string" || !PROVIDER.test(input.provider)) fail("PROVIDER_ID_INVALID");
  const implementation = normalizeImplementation(input.implementation);
  if (!hasExactDataKeys(input.versions, ["eventSchema", "protocol", "providerApi", "configuration"])) {
    fail("VERSION_SET_SHAPE_INVALID");
  }
  const versions = Object.freeze({
    eventSchema: readPair(input.versions.eventSchema, "EVENT_SCHEMA_VERSION"),
    protocol: readPair(input.versions.protocol, "PROTOCOL_VERSION"),
    providerApi: readPair(input.versions.providerApi, "PROVIDER_API_VERSION"),
    configuration: readPair(input.versions.configuration, "CONFIGURATION_VERSION"),
  });
  const capabilityList = readCapabilityArray(input.capabilities);
  const capabilityIds = new Set(capabilityList.map((item) => item.id));
  const operations = readOperationArray(input.operations, capabilityIds);
  return Object.freeze({
    schema: ADAPTER_CONTRACT_SCHEMA,
    contractVersion: input.contractVersion,
    adapterId: input.adapterId,
    provider: input.provider,
    implementation,
    versions,
    capabilities: Object.freeze(capabilityList),
    operations: Object.freeze(operations),
  });
}

/** Return a compact validation result without exposing untrusted input values. */
export function validateAdapterContract(input) {
  try {
    return Object.freeze({ ok: true, value: normalizeAdapterContract(input) });
  } catch (error) {
    return Object.freeze({
      ok: false,
      code: error instanceof TypeError && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "ADAPTER_CONTRACT_UNREADABLE",
    });
  }
}

function normalizeHostCompatibility(input) {
  const keys = [
    "contractVersions", "eventSchemas", "protocols", "providerApis",
    "configurationSchemas", "capabilities",
  ];
  if (!hasExactDataKeys(input, keys)) fail("HOST_COMPATIBILITY_SHAPE_INVALID");
  const contractVersions = readStringArray(input.contractVersions, {
    min: 1, max: 16, label: "HOST_CONTRACT_VERSIONS", pattern: SEMVER,
  });
  return Object.freeze({
    contractVersions: Object.freeze(contractVersions),
    eventSchemas: Object.freeze(readPairArray(input.eventSchemas, { label: "HOST_EVENT_SCHEMAS" })),
    protocols: Object.freeze(readPairArray(input.protocols, { label: "HOST_PROTOCOLS" })),
    providerApis: Object.freeze(readPairArray(input.providerApis, { label: "HOST_PROVIDER_APIS" })),
    configurationSchemas: Object.freeze(readPairArray(input.configurationSchemas, { label: "HOST_CONFIGURATION_SCHEMAS" })),
    capabilities: Object.freeze(readPairArray(input.capabilities, { max: 128, label: "HOST_CAPABILITIES" })),
  });
}

function hasPair(values, wanted) {
  const key = pairKey(wanted);
  return values.some((item) => pairKey(item) === key);
}

/**
 * Exact-match compatibility negotiation. No coercion, implicit mapping,
 * downgrade, or semantic authorization is performed.
 */
export function negotiateAdapterContract(contractInput, hostInput) {
  let contract;
  let host;
  try {
    contract = normalizeAdapterContract(contractInput);
  } catch (error) {
    return Object.freeze({
      supported: false,
      code: "ADAPTER_CONTRACT_INVALID",
      reason: error instanceof TypeError && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "ADAPTER_CONTRACT_UNREADABLE",
      unsupportedDimensions: Object.freeze([]),
    });
  }
  try {
    host = normalizeHostCompatibility(hostInput);
  } catch (error) {
    return Object.freeze({
      supported: false,
      code: "HOST_COMPATIBILITY_INVALID",
      reason: error instanceof TypeError && /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : "HOST_COMPATIBILITY_UNREADABLE",
      unsupportedDimensions: Object.freeze([]),
    });
  }

  const unsupported = [];
  if (!host.contractVersions.includes(contract.contractVersion)) unsupported.push("contractVersion");
  if (!hasPair(host.eventSchemas, contract.versions.eventSchema)) unsupported.push("eventSchema");
  if (!hasPair(host.protocols, contract.versions.protocol)) unsupported.push("protocol");
  if (!hasPair(host.providerApis, contract.versions.providerApi)) unsupported.push("providerApi");
  if (!hasPair(host.configurationSchemas, contract.versions.configuration)) unsupported.push("configuration");
  for (const capability of contract.capabilities) {
    if (!hasPair(host.capabilities, capability)) unsupported.push("capability:" + capability.id);
  }
  return Object.freeze({
    supported: unsupported.length === 0,
    code: unsupported.length === 0 ? "EXACT_VERSION_MATCH" : "UNSUPPORTED_VERSION",
    adapterId: contract.adapterId,
    contractVersion: contract.contractVersion,
    unsupportedDimensions: Object.freeze(unsupported),
  });
}
