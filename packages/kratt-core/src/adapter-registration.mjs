import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  normalizeAdapterContract,
  negotiateAdapterContract,
  validateAdapterContract,
} from "./adapter-contract.mjs";
import {
  transitionIntegrationState,
  validateIntegrationRecord,
} from "./integration-registry.mjs";

const REGISTRATION_SCHEMA = "3XT-ADAPTER-REGISTRATION";
const AUDIT_SCHEMA = "3XT-ADAPTER-REGISTRATION-AUDIT";
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_REASON = /^[A-Z][A-Z0-9_]{1,63}$/;
const ALLOWED_STATES = new Set([
  "CONNECTED_UNVERIFIED",
  "VERIFIED_READ_ONLY",
  "DISABLED",
  "ERROR",
]);
const RECORD_KEYS = [
  "schema", "schemaVersion", "adapterId", "provider", "contract",
  "contractDigest", "sourceProvenance", "integration", "revision",
  "readOnlyAttestation",
];

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      utilTypes.isProxy(value)) return false;
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

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function validRef(value) {
  return typeof value === "string" && SAFE_ID.test(value);
}

function trustedTimestamp(clock) {
  let value;
  try {
    value = clock();
  } catch {
    return null;
  }
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
  return new Date(milliseconds).toISOString();
}

function verifierReceipt(value) {
  if (!hasExactDataKeys(value, ["verified", "evidenceRef", "verifierRef"]) ||
      value.verified !== true || !validRef(value.evidenceRef) ||
      !validRef(value.verifierRef)) return null;
  return Object.freeze({
    evidenceRef: value.evidenceRef,
    verifierRef: value.verifierRef,
  });
}

function integrationFor(adapterId, contract) {
  const readOperations = contract.operations
    .filter((operation) => operation.class === "READ")
    .map((operation) => operation.operationId);
  const writeOperations = contract.operations
    .filter((operation) => operation.class !== "READ")
    .map((operation) => operation.operationId);
  const initial = {
    integration_id: adapterId,
    name: adapterId,
    state: "DISCOVERED",
    read_operations: readOperations,
    write_operations: writeOperations,
  };
  const transitioned = transitionIntegrationState(initial, "CONNECTED_UNVERIFIED");
  if (!transitioned.ok || !validateIntegrationRecord(transitioned.value).ok) return null;
  return transitioned.value;
}

function normalizeStoredRecord(input) {
  if (!hasExactDataKeys(input, RECORD_KEYS) ||
      input.schema !== REGISTRATION_SCHEMA || input.schemaVersion !== 1 ||
      !validRef(input.adapterId) || typeof input.provider !== "string" ||
      !Number.isSafeInteger(input.revision) || input.revision < 1) return null;

  const contractValidation = validateAdapterContract(input.contract);
  if (!contractValidation.ok) return null;
  const contract = normalizeAdapterContract(input.contract);
  if (contract.adapterId !== input.adapterId || contract.provider !== input.provider ||
      typeof input.contractDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.contractDigest) ||
      jsonDigest(contract) !== input.contractDigest) return null;

  const sourceKeys = [
    "repository", "revision", "path", "artifactDigest",
    "evidenceRef", "verifierRef", "verifiedAt",
  ];
  if (!hasExactDataKeys(input.sourceProvenance, sourceKeys)) return null;
  const pinned = contract.implementation.source;
  if (input.sourceProvenance.repository !== pinned.repository ||
      input.sourceProvenance.revision !== pinned.revision ||
      input.sourceProvenance.path !== pinned.path ||
      input.sourceProvenance.artifactDigest !== contract.implementation.artifactDigest ||
      !validRef(input.sourceProvenance.evidenceRef) ||
      !validRef(input.sourceProvenance.verifierRef) ||
      typeof input.sourceProvenance.verifiedAt !== "string" ||
      !Number.isFinite(Date.parse(input.sourceProvenance.verifiedAt))) return null;

  if (!validateIntegrationRecord(input.integration).ok) return null;
  const expected = integrationFor(input.adapterId, contract);
  if (!expected || input.integration.integration_id !== expected.integration_id ||
      input.integration.name !== expected.name ||
      JSON.stringify(input.integration.read_operations) !== JSON.stringify(expected.read_operations) ||
      JSON.stringify(input.integration.write_operations) !== JSON.stringify(expected.write_operations) ||
      !ALLOWED_STATES.has(input.integration.state)) return null;

  let readOnlyAttestation = null;
  if (input.readOnlyAttestation !== null) {
    const attestationKeys = [
      "contractDigest", "artifactDigest", "evidenceRef", "verifierRef", "verifiedAt",
    ];
    if (!hasExactDataKeys(input.readOnlyAttestation, attestationKeys) ||
        input.readOnlyAttestation.contractDigest !== input.contractDigest ||
        input.readOnlyAttestation.artifactDigest !== contract.implementation.artifactDigest ||
        !validRef(input.readOnlyAttestation.evidenceRef) ||
        !validRef(input.readOnlyAttestation.verifierRef) ||
        typeof input.readOnlyAttestation.verifiedAt !== "string" ||
        !Number.isFinite(Date.parse(input.readOnlyAttestation.verifiedAt))) return null;
    readOnlyAttestation = Object.freeze({ ...input.readOnlyAttestation });
  }
  if (input.integration.state === "CONNECTED_UNVERIFIED" && readOnlyAttestation !== null) return null;
  if (input.integration.state === "VERIFIED_READ_ONLY" && readOnlyAttestation === null) return null;

  return deepFreeze({
    schema: REGISTRATION_SCHEMA,
    schemaVersion: 1,
    adapterId: input.adapterId,
    provider: input.provider,
    contract,
    contractDigest: input.contractDigest,
    sourceProvenance: { ...input.sourceProvenance },
    integration: {
      integration_id: input.integration.integration_id,
      name: input.integration.name,
      state: input.integration.state,
      read_operations: [...input.integration.read_operations],
      write_operations: [...input.integration.write_operations],
    },
    revision: input.revision,
    readOnlyAttestation,
  });
}

function makeAudit({
  eventType, record, actorRef, occurredAt, previousState = null,
  nextState, evidenceRef = null, reasonCode = null,
}) {
  const body = {
    schema: AUDIT_SCHEMA,
    schemaVersion: 1,
    eventType,
    adapterId: record.adapterId,
    provider: record.provider,
    revision: record.revision,
    previousState,
    nextState,
    contractDigest: record.contractDigest,
    artifactDigest: record.contract.implementation.artifactDigest,
    evidenceRef,
    actorRef,
    occurredAt,
    reasonCode,
  };
  return deepFreeze({
    eventId: "adapter-registration:" + jsonDigest(body),
    ...body,
  });
}

function resultError(code) {
  return Object.freeze({ ok: false, code });
}

function normalizeActor(actorRef) {
  return validRef(actorRef) ? actorRef : null;
}

/**
 * Host-owned adapter registration service.
 *
 * The injected store must atomically persist each registration/state update
 * together with its append-only audit event. The source reader must return
 * bytes from the exact repository, immutable commit and relative path supplied.
 * The verifiers are trusted host dependencies; their receipts are not accepted
 * from adapter manifests, callers, or provider responses.
 *
 * This service never loads or executes adapter code, resolves credentials,
 * invokes providers, grants capabilities, or enables WRITE.
 */
export function createAdapterRegistrationRuntime({
  registrationStore,
  sourceReader,
  provenanceVerifier,
  conformanceVerifier = null,
  hostCompatibility,
  now,
} = {}) {
  if (!registrationStore ||
      typeof registrationStore.get !== "function" ||
      typeof registrationStore.createWithAudit !== "function" ||
      typeof registrationStore.compareAndSwapWithAudit !== "function") {
    throw new TypeError("ADAPTER_REGISTRATION_STORE_REQUIRED");
  }
  if (!sourceReader || typeof sourceReader.readPinnedSource !== "function") {
    throw new TypeError("PINNED_SOURCE_READER_REQUIRED");
  }
  if (!provenanceVerifier || typeof provenanceVerifier.verify !== "function") {
    throw new TypeError("TRUSTED_PROVENANCE_VERIFIER_REQUIRED");
  }
  if (conformanceVerifier !== null &&
      typeof conformanceVerifier.verify !== "function") {
    throw new TypeError("READ_ONLY_CONFORMANCE_VERIFIER_INVALID");
  }
  if (!isPlainRecord(hostCompatibility)) {
    throw new TypeError("HOST_COMPATIBILITY_REQUIRED");
  }
  if (typeof now !== "function" || trustedTimestamp(now) === null) {
    throw new TypeError("TRUSTED_REGISTRATION_CLOCK_REQUIRED");
  }
  let hostCompatibilitySnapshot;
  try {
    hostCompatibilitySnapshot = deepFreeze(structuredClone(hostCompatibility));
  } catch {
    throw new TypeError("HOST_COMPATIBILITY_INVALID");
  }

  async function readRecord(adapterId) {
    if (!validRef(adapterId)) return resultError("ADAPTER_ID_INVALID");
    let stored;
    try {
      stored = await registrationStore.get(adapterId);
    } catch {
      return resultError("REGISTRATION_STORE_UNAVAILABLE");
    }
    if (stored === null || stored === undefined) return resultError("ADAPTER_NOT_FOUND");
    const record = normalizeStoredRecord(stored);
    if (!record) return resultError("REGISTRATION_RECORD_INVALID");
    return Object.freeze({ ok: true, record });
  }

  async function readBack(adapterId, expectedRevision, expectedDigest) {
    const fetched = await readRecord(adapterId);
    if (!fetched.ok) return resultError("REGISTRATION_READBACK_FAILED");
    if (fetched.record.revision !== expectedRevision ||
        fetched.record.contractDigest !== expectedDigest) {
      return resultError("REGISTRATION_READBACK_MISMATCH");
    }
    return fetched;
  }

  async function register(input = {}) {
    if (!hasExactDataKeys(input, ["contract", "actorRef"])) {
      return resultError("REGISTRATION_REQUEST_INVALID");
    }
    const contractInput = input.contract;
    const actorRef = input.actorRef;
    const actor = normalizeActor(actorRef);
    if (!actor) return resultError("ACTOR_REFERENCE_INVALID");

    const validation = validateAdapterContract(contractInput);
    if (!validation.ok) return resultError("ADAPTER_CONTRACT_INVALID");

    let contract;
    try {
      contract = normalizeAdapterContract(contractInput);
    } catch {
      return resultError("ADAPTER_CONTRACT_INVALID");
    }

    const compatibility = negotiateAdapterContract(contract, hostCompatibilitySnapshot);
    if (compatibility.supported !== true) {
      return resultError("ADAPTER_CONTRACT_UNSUPPORTED");
    }
    const integration = integrationFor(contract.adapterId, contract);
    if (!integration) return resultError("INTEGRATION_OPERATION_MAPPING_INVALID");

    let existing;
    try {
      existing = await registrationStore.get(contract.adapterId);
    } catch {
      return resultError("REGISTRATION_STORE_UNAVAILABLE");
    }
    if (existing !== null && existing !== undefined) return resultError("ADAPTER_ALREADY_REGISTERED");

    const pinned = contract.implementation.source;
    let source;
    try {
      source = await sourceReader.readPinnedSource(Object.freeze({
        repository: pinned.repository,
        revision: pinned.revision,
        path: pinned.path,
      }));
    } catch {
      return resultError("PINNED_SOURCE_READ_FAILED");
    }

    if (!hasExactDataKeys(source, ["repository", "revision", "path", "bytes"]) ||
        source.repository !== pinned.repository ||
        source.revision !== pinned.revision ||
        source.path !== pinned.path ||
        !(source.bytes instanceof Uint8Array) ||
        utilTypes.isProxy(source.bytes) ||
        source.bytes.byteLength < 1 ||
        source.bytes.byteLength > MAX_SOURCE_BYTES) {
      return resultError("PINNED_SOURCE_BINDING_INVALID");
    }

    let sourceBytes;
    try {
      sourceBytes = Uint8Array.from(source.bytes);
    } catch {
      return resultError("PINNED_SOURCE_BYTES_INVALID");
    }
    const actualArtifactDigest = sha256(sourceBytes);
    if (actualArtifactDigest !== contract.implementation.artifactDigest) {
      return resultError("ARTIFACT_DIGEST_MISMATCH");
    }

    const contractDigest = jsonDigest(contract);
    let provenance;
    try {
      provenance = await provenanceVerifier.verify(Object.freeze({
        repository: pinned.repository,
        revision: pinned.revision,
        path: pinned.path,
        artifactDigest: actualArtifactDigest,
        contractDigest,
      }));
    } catch {
      return resultError("PROVENANCE_VERIFIER_FAILED");
    }
    const provenanceReceipt = verifierReceipt(provenance);
    if (!provenanceReceipt) return resultError("SOURCE_PROVENANCE_UNVERIFIED");

    const verifiedAt = trustedTimestamp(now);
    if (!verifiedAt) return resultError("TRUSTED_CLOCK_UNAVAILABLE");

    const record = normalizeStoredRecord({
      schema: REGISTRATION_SCHEMA,
      schemaVersion: 1,
      adapterId: contract.adapterId,
      provider: contract.provider,
      contract,
      contractDigest,
      sourceProvenance: {
        repository: pinned.repository,
        revision: pinned.revision,
        path: pinned.path,
        artifactDigest: actualArtifactDigest,
        evidenceRef: provenanceReceipt.evidenceRef,
        verifierRef: provenanceReceipt.verifierRef,
        verifiedAt,
      },
      integration,
      revision: 1,
      readOnlyAttestation: null,
    });
    if (!record) return resultError("REGISTRATION_RECORD_INVALID");

    const auditEvent = makeAudit({
      eventType: "adapter.registration.created",
      record,
      actorRef: actor,
      occurredAt: verifiedAt,
      nextState: "CONNECTED_UNVERIFIED",
      evidenceRef: provenanceReceipt.evidenceRef,
    });

    let outcome;
    try {
      outcome = await registrationStore.createWithAudit({ record, auditEvent });
    } catch {
      return resultError("REGISTRATION_COMMIT_FAILED");
    }
    if (outcome !== "CREATED") {
      return resultError(outcome === "ALREADY_EXISTS"
        ? "ADAPTER_ALREADY_REGISTERED"
        : "REGISTRATION_COMMIT_FAILED");
    }

    return readBack(contract.adapterId, 1, contractDigest);
  }

  async function verifyReadOnly(input = {}) {
    if (!hasExactDataKeys(input, ["adapterId", "actorRef"])) {
      return resultError("LIFECYCLE_REQUEST_INVALID");
    }
    const adapterId = input.adapterId;
    const actorRef = input.actorRef;
    const actor = normalizeActor(actorRef);
    if (!actor) return resultError("ACTOR_REFERENCE_INVALID");
    const fetched = await readRecord(adapterId);
    if (!fetched.ok) return fetched;
    const current = fetched.record;
    if (current.integration.state === "VERIFIED_READ_ONLY") {
      return Object.freeze({ ok: true, record: current, idempotent: true });
    }
    if (current.integration.state !== "CONNECTED_UNVERIFIED") {
      return resultError("ADAPTER_NOT_AWAITING_READ_ONLY_VERIFICATION");
    }
    if (conformanceVerifier === null) return resultError("READ_ONLY_VERIFIER_UNAVAILABLE");

    let verification;
    try {
      verification = await conformanceVerifier.verify(Object.freeze({
        adapterId: current.adapterId,
        provider: current.provider,
        contractDigest: current.contractDigest,
        artifactDigest: current.contract.implementation.artifactDigest,
        sourceProvenance: current.sourceProvenance,
      }));
    } catch {
      return resultError("READ_ONLY_VERIFIER_FAILED");
    }
    const receipt = verifierReceipt(verification);
    if (!receipt) return resultError("READ_ONLY_CONFORMANCE_UNVERIFIED");

    const latest = await readRecord(adapterId);
    if (!latest.ok || latest.record.revision !== current.revision ||
        latest.record.integration.state !== "CONNECTED_UNVERIFIED") {
      return resultError("REGISTRATION_REVISION_CHANGED");
    }

    const changed = transitionIntegrationState(current.integration, "VERIFIED_READ_ONLY");
    if (!changed.ok) return resultError("INTEGRATION_TRANSITION_DENIED");
    const verifiedAt = trustedTimestamp(now);
    if (!verifiedAt) return resultError("TRUSTED_CLOCK_UNAVAILABLE");

    const nextRecord = normalizeStoredRecord({
      ...current,
      integration: changed.value,
      revision: current.revision + 1,
      readOnlyAttestation: {
        contractDigest: current.contractDigest,
        artifactDigest: current.contract.implementation.artifactDigest,
        evidenceRef: receipt.evidenceRef,
        verifierRef: receipt.verifierRef,
        verifiedAt,
      },
    });
    if (!nextRecord) return resultError("REGISTRATION_RECORD_INVALID");

    const auditEvent = makeAudit({
      eventType: "adapter.lifecycle.verified_read_only",
      record: nextRecord,
      actorRef: actor,
      occurredAt: verifiedAt,
      previousState: "CONNECTED_UNVERIFIED",
      nextState: "VERIFIED_READ_ONLY",
      evidenceRef: receipt.evidenceRef,
    });

    let outcome;
    try {
      outcome = await registrationStore.compareAndSwapWithAudit({
        adapterId,
        expectedRevision: current.revision,
        record: nextRecord,
        auditEvent,
      });
    } catch {
      return resultError("REGISTRATION_UPDATE_FAILED");
    }
    if (outcome !== "UPDATED") {
      return resultError(outcome === "REVISION_MISMATCH"
        ? "REGISTRATION_REVISION_CHANGED"
        : "REGISTRATION_UPDATE_FAILED");
    }
    return readBack(adapterId, nextRecord.revision, current.contractDigest);
  }

  async function changeTerminalState(input = {}, nextState) {
    if (!hasExactDataKeys(input, ["adapterId", "actorRef", "reasonCode"])) {
      return resultError("LIFECYCLE_REQUEST_INVALID");
    }
    const adapterId = input.adapterId;
    const actorRef = input.actorRef;
    const reasonCode = input.reasonCode;
    const actor = normalizeActor(actorRef);
    if (!actor) return resultError("ACTOR_REFERENCE_INVALID");
    if (!SAFE_REASON.test(reasonCode)) return resultError("REASON_CODE_INVALID");
    const fetched = await readRecord(adapterId);
    if (!fetched.ok) return fetched;
    const current = fetched.record;
    if (current.integration.state === nextState) {
      return Object.freeze({ ok: true, record: current, idempotent: true });
    }
    const changed = transitionIntegrationState(current.integration, nextState);
    if (!changed.ok) return resultError("INTEGRATION_TRANSITION_DENIED");
    const occurredAt = trustedTimestamp(now);
    if (!occurredAt) return resultError("TRUSTED_CLOCK_UNAVAILABLE");

    const nextRecord = normalizeStoredRecord({
      ...current,
      integration: changed.value,
      revision: current.revision + 1,
    });
    if (!nextRecord) return resultError("REGISTRATION_RECORD_INVALID");

    const auditEvent = makeAudit({
      eventType: nextState === "DISABLED"
        ? "adapter.lifecycle.disabled"
        : "adapter.lifecycle.error",
      record: nextRecord,
      actorRef: actor,
      occurredAt,
      previousState: current.integration.state,
      nextState,
      evidenceRef: current.sourceProvenance.evidenceRef,
      reasonCode,
    });

    let outcome;
    try {
      outcome = await registrationStore.compareAndSwapWithAudit({
        adapterId,
        expectedRevision: current.revision,
        record: nextRecord,
        auditEvent,
      });
    } catch {
      return resultError("REGISTRATION_UPDATE_FAILED");
    }
    if (outcome !== "UPDATED") {
      return resultError(outcome === "REVISION_MISMATCH"
        ? "REGISTRATION_REVISION_CHANGED"
        : "REGISTRATION_UPDATE_FAILED");
    }
    return readBack(adapterId, nextRecord.revision, current.contractDigest);
  }

  return Object.freeze({
    register,
    get: readRecord,
    verifyReadOnly,
    disable: (input = {}) => changeTerminalState(input, "DISABLED"),
    markError: (input = {}) => changeTerminalState(input, "ERROR"),
  });
}
