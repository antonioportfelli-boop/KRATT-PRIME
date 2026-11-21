import { getWaveById } from "./wave-progression.mjs";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const MAX_EVIDENCE = 128;
const MAX_COMPLETIONS = 64;
const MAX_CANDIDATES_PER_KIND = 8;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;

function validReference(value) {
  return typeof value === "string" &&
    SAFE_REF.test(value) &&
    !value.includes("..");
}

function snapshotOptions(input) {
  if (input === undefined) input = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;

  const keys = Reflect.ownKeys(input);
  const allowed = new Set(["evidence", "completionEvidence", "verifyEvidence", "verificationTimeoutMs"]);
  if (keys.length > allowed.size || keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    return null;
  }

  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    values[key] = descriptor.value;
  }

  const evidence = values.evidence ?? [];
  const completionEvidence = values.completionEvidence ?? [];
  const verifyEvidence = values.verifyEvidence;
  const verificationTimeoutMs = values.verificationTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (typeof verifyEvidence !== "function" ||
      !Number.isSafeInteger(verificationTimeoutMs) ||
      verificationTimeoutMs < 10 ||
      verificationTimeoutMs > MAX_TIMEOUT_MS) {
    return {
      evidence,
      completionEvidence,
      verifyEvidence,
      verificationTimeoutMs,
      invalid: true,
    };
  }

  return { evidence, completionEvidence, verifyEvidence, verificationTimeoutMs, invalid: false };
}

function snapshotDenseArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return null;
  if (Object.getPrototypeOf(value) !== Array.prototype) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 ||
      !keys.includes("length") ||
      keys.some((key) =>
        typeof key !== "string" ||
        key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))) {
    return null;
  }

  const result = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    result.push(descriptor.value);
  }
  return result;
}

function snapshotEvidenceRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length < 2 || keys.length > 3 ||
      keys.some((key) => typeof key !== "string" ||
        !["kind", "ref", "verified"].includes(key))) {
    return null;
  }

  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    values[key] = descriptor.value;
  }

  if (typeof values.kind !== "string" ||
      !validReference(values.ref) ||
      values.verified !== undefined && typeof values.verified !== "boolean") {
    return null;
  }

  // Caller-supplied verified is omitted from the immutable verifier input.
  return Object.freeze(Object.assign(Object.create(null), {
    kind: values.kind,
    ref: values.ref,
  }));
}

function snapshotCompletionRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 3 ||
      keys.some((key) => typeof key !== "string" ||
        !["kind", "waveId", "ref"].includes(key))) {
    return null;
  }

  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    values[key] = descriptor.value;
  }

  if (values.kind !== "wave-completion" ||
      typeof values.waveId !== "string" ||
      !validReference(values.ref)) {
    return null;
  }

  return Object.freeze(Object.assign(Object.create(null), {
    kind: values.kind,
    waveId: values.waveId,
    ref: values.ref,
  }));
}

async function verifyWithDeadline(verifier, record, context, deadline) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) return false;

  const controller = new AbortController();
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, remainingMs);
    });
    const result = await Promise.race([
      Promise.resolve().then(() =>
        verifier(record, context, Object.freeze({ signal: controller.signal }))),
      timeout,
    ]);
    return result === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Release gate backed by a trusted server-side evidence verifier.
 * The verifier must load immutable evidence by reference and validate issuer/key,
 * signature, audience, wave/kind scope, digest, expiry, revocation, nonce/replay
 * state and provenance. Caller-supplied verified flags are ignored.
 */
export async function evaluateTrustedWaveGate(waveId, input = {}) {
  const wave = getWaveById(waveId);
  if (!wave) return Object.freeze({ ok: false, eligible: false, reason: "WAVE_NOT_FOUND" });

  let options;
  let evidence;
  let completionEvidence;
  try {
    options = snapshotOptions(input);
    if (!options) {
      return Object.freeze({ ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" });
    }
    if (options.invalid) {
      return Object.freeze({
        ok: false,
        eligible: false,
        reason: typeof options.verifyEvidence !== "function"
          ? "TRUSTED_VERIFIER_REQUIRED"
          : "WAVE_GATE_INPUT_INVALID",
      });
    }
    evidence = snapshotDenseArray(options.evidence, MAX_EVIDENCE);
    completionEvidence = snapshotDenseArray(options.completionEvidence, MAX_COMPLETIONS);
  } catch {
    return Object.freeze({ ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" });
  }

  if (!evidence || !completionEvidence) {
    return Object.freeze({ ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" });
  }

  const evidenceRecords = [];
  for (const item of evidence) {
    try {
      const record = snapshotEvidenceRecord(item);
      if (!record) {
        return Object.freeze({ ok: false, eligible: false, reason: "WAVE_EVIDENCE_RECORD_INVALID" });
      }
      evidenceRecords.push(record);
    } catch {
      return Object.freeze({ ok: false, eligible: false, reason: "WAVE_EVIDENCE_RECORD_INVALID" });
    }
  }

  const completionRecords = [];
  for (const item of completionEvidence) {
    try {
      const record = snapshotCompletionRecord(item);
      if (!record) {
        return Object.freeze({ ok: false, eligible: false, reason: "WAVE_COMPLETION_RECORD_INVALID" });
      }
      completionRecords.push(record);
    } catch {
      return Object.freeze({ ok: false, eligible: false, reason: "WAVE_COMPLETION_RECORD_INVALID" });
    }
  }

  const deadline = Date.now() + options.verificationTimeoutMs;
  const verifiedKinds = new Set();
  for (const kind of wave.requiredEvidence) {
    const candidates = evidenceRecords
      .filter((record) => record.kind === kind)
      .slice(0, MAX_CANDIDATES_PER_KIND);
    for (const record of candidates) {
      const verified = await verifyWithDeadline(
        options.verifyEvidence,
        record,
        Object.freeze({ purpose: "wave-evidence", waveId, kind }),
        deadline,
      );
      if (verified) {
        verifiedKinds.add(kind);
        break;
      }
      if (Date.now() >= deadline) break;
    }
    if (Date.now() >= deadline) break;
  }

  const missingEvidence = wave.requiredEvidence.filter((kind) => !verifiedKinds.has(kind));
  const missingDependencies = [];
  for (const dependencyId of wave.dependsOn) {
    const candidates = completionRecords
      .filter((record) => record.waveId === dependencyId)
      .slice(0, MAX_CANDIDATES_PER_KIND);
    let verified = false;
    for (const record of candidates) {
      verified = await verifyWithDeadline(
        options.verifyEvidence,
        record,
        Object.freeze({
          purpose: "wave-completion",
          waveId: dependencyId,
          requiredBy: waveId,
        }),
        deadline,
      );
      if (verified) break;
      if (Date.now() >= deadline) break;
    }
    if (!verified) missingDependencies.push(dependencyId);
  }

  return Object.freeze({
    ok: true,
    waveId,
    eligible: missingDependencies.length === 0 && missingEvidence.length === 0,
    missingDependencies: Object.freeze(missingDependencies),
    missingEvidence: Object.freeze(missingEvidence),
    verificationTimedOut: Date.now() >= deadline,
  });
}
