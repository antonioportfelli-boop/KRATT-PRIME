import { getWaveById } from "./wave-progression.mjs";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const validReference = (value) =>
  typeof value === "string" && SAFE_REF.test(value) && !value.includes("..");

/**
 * Release gate backed by a trusted server-side evidence verifier.
 * Never trusts caller-supplied verified flags or completed-wave arrays.
 * The injected verifier must validate signature, issuer, scope, expiry,
 * revocation, immutable digest, nonce/replay state and provenance.
 */
export async function evaluateTrustedWaveGate(
  waveId,
  { evidence = [], completionEvidence = [], verifyEvidence } = {},
) {
  const wave = getWaveById(waveId);
  if (!wave) return Object.freeze({ ok: false, eligible: false, reason: "WAVE_NOT_FOUND" });
  if (!Array.isArray(evidence) || !Array.isArray(completionEvidence)) {
    return Object.freeze({ ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" });
  }
  if (typeof verifyEvidence !== "function") {
    return Object.freeze({ ok: false, eligible: false, reason: "TRUSTED_VERIFIER_REQUIRED" });
  }

  const verifiedKinds = new Set();
  for (const kind of wave.requiredEvidence) {
    const candidates = evidence.filter((item) =>
      item && typeof item === "object" && item.kind === kind && validReference(item.ref),
    );
    for (const candidate of candidates) {
      try {
        if (await verifyEvidence(candidate, Object.freeze({
          purpose: "wave-evidence", waveId, kind,
        })) === true) {
          verifiedKinds.add(kind);
          break;
        }
      } catch {
        // Fail closed. A verifier outage cannot promote a wave.
      }
    }
  }

  const missingEvidence = wave.requiredEvidence.filter((kind) => !verifiedKinds.has(kind));
  const missingDependencies = [];
  for (const dependencyId of wave.dependsOn) {
    const candidates = completionEvidence.filter((item) =>
      item && typeof item === "object" &&
      item.kind === "wave-completion" &&
      item.waveId === dependencyId &&
      validReference(item.ref),
    );
    let verified = false;
    for (const candidate of candidates) {
      try {
        if (await verifyEvidence(candidate, Object.freeze({
          purpose: "wave-completion", waveId: dependencyId, requiredBy: waveId,
        })) === true) {
          verified = true;
          break;
        }
      } catch {
        // Fail closed.
      }
    }
    if (!verified) missingDependencies.push(dependencyId);
  }

  return Object.freeze({
    ok: true,
    waveId,
    eligible: missingDependencies.length === 0 && missingEvidence.length === 0,
    missingDependencies: Object.freeze(missingDependencies),
    missingEvidence: Object.freeze(missingEvidence),
  });
}
