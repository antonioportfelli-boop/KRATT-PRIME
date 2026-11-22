import { createHash } from "node:crypto";
import {
  appendMeridianNode,
  createCorrectionProposal,
  evaluateAntiTalmudPostflight,
  evaluateEchoRestoration,
  evaluateTalmudPreflight,
} from "./semantic-integrity.mjs";

export const SMF01 = Object.freeze({
  id: "SMF-01",
  version: "1.0.0",
  dimensions: Object.freeze(["wordContent", "meaning", "principle", "effect", "authority"]),
  protectedPaths: Object.freeze(["id", "version", "context", "wordContent", "meaning", "principle", "effect", "authority", "modality", "subject", "scope", "conditions", "freshness", "provenance", "prohibitedEquivalences"]),
});
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const forbidden = new Set(["__proto__", "prototype", "constructor"]);

export function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("SMF_NON_FINITE_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("SMF_CYCLIC_VALUE");
    seen.add(value);
    const items = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !own(descriptor, "value")) throw new TypeError("SMF_ARRAY_HOLE_OR_ACCESSOR");
      items.push(canonicalize(descriptor.value, seen));
    }
    const allowedKeys = new Set(["length", ...items.map((_, index) => String(index))]);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !allowedKeys.has(key))) throw new TypeError("SMF_ARRAY_EXTRA_PROPERTY");
    const result = "[" + items.join(",") + "]";
    seen.delete(value);
    return result;
  }
  if (!isRecord(value)) throw new TypeError("SMF_UNSUPPORTED_VALUE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("SMF_NON_PLAIN_OBJECT");
  if (seen.has(value)) throw new TypeError("SMF_CYCLIC_VALUE");
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || forbidden.has(key))) throw new TypeError("SMF_OBJECT_KEY_UNSAFE");
  const entries = keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, "value") || !descriptor.enumerable) throw new TypeError("SMF_ACCESSOR_OR_HIDDEN_PROPERTY");
    return JSON.stringify(key) + ":" + canonicalize(descriptor.value, seen);
  });
  seen.delete(value);
  return "{" + entries.join(",") + "}";
}
export function digest(value) {
  return "sha256:" + createHash("sha256").update(canonicalize(value)).digest("hex");
}
function normalize(value) { return JSON.parse(canonicalize(value)); }
function freezeDeep(value) {
  if (!isRecord(value) && !Array.isArray(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(freezeDeep);
  return value;
}
function nonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }
function pathParts(path) {
  if (!nonEmpty(path)) throw new TypeError("SMF_PATH_INVALID");
  const parts = path.split(".");
  if (parts.some(part => !part || forbidden.has(part))) throw new TypeError("SMF_PATH_UNSAFE");
  return parts;
}
function getPath(root, path) {
  let value = root;
  for (const part of pathParts(path)) {
    if ((!isRecord(value) && !Array.isArray(value)) || !own(value, part)) return { exists: false };
    value = value[part];
  }
  return { exists: true, value };
}
function equal(a, b) { return canonicalize(a) === canonicalize(b); }

/** Keep lexical content, meaning, principle, effect and authority independent. */
export function createSemanticIdentity(input) {
  const value = normalize(input);
  if (!isRecord(value) || !nonEmpty(value.id) || !nonEmpty(value.version) || !isRecord(value.context)) throw new TypeError("SMF_IDENTITY_INVALID");
  for (const key of SMF01.dimensions) {
    if (!own(value, key) || value[key] === null || value[key] === undefined) throw new TypeError("SMF_DIMENSION_REQUIRED:" + key);
  }
  return freezeDeep(value);
}

/** Structured counterexample search; not an NLP truth oracle or proof of truth. */
export function evaluateAntiSemanticChallenge(input) {
  let source;
  try { source = normalize(input && input.source); } catch { return { decision: "INCONCLUSIVE", reason: "SOURCE_INVALID", candidates: [] }; }
  if (!isRecord(source) || !Array.isArray(input.candidates) || input.candidates.length === 0) return { decision: "INCONCLUSIVE", reason: "COUNTERINTERPRETATIONS_MISSING", candidates: [] };
  const results = input.candidates.map((raw, index) => {
    let candidate;
    try { candidate = normalize(raw); } catch { return { index, decision: "INCONCLUSIVE", findings: ["CANDIDATE_INVALID"] }; }
    if (!isRecord(candidate) || !nonEmpty(candidate.id)) return { index, decision: "INCONCLUSIVE", findings: ["CANDIDATE_INVALID"] };
    const findings = [];
    for (const key of SMF01.dimensions) if (!own(candidate, key) || !equal(source[key], candidate[key])) findings.push("DIMENSION_CHANGED:" + key);
    for (const key of ["modality", "subject", "scope", "freshness", "provenance", "prohibitedEquivalences"]) {
      if (own(source, key) && (!own(candidate, key) || !equal(source[key], candidate[key]))) findings.push("CONSTRAINT_CHANGED:" + key);
    }
    if (Array.isArray(source.conditions) && (!Array.isArray(candidate.conditions) || source.conditions.some(item => !candidate.conditions.some(other => equal(item, other))))) findings.push("CONDITION_DROPPED");
    return { candidateId: candidate.id, index, decision: findings.length ? "COUNTEREXAMPLE_CANDIDATE" : "NO_STRUCTURAL_COUNTEREXAMPLE", findings };
  });
  if (results.some(item => item.decision === "COUNTEREXAMPLE_CANDIDATE")) return { decision: "COUNTEREXAMPLE_FOUND", candidates: results };
  if (results.some(item => item.decision === "INCONCLUSIVE")) return { decision: "INCONCLUSIVE", candidates: results };
  return { decision: "NO_COUNTEREXAMPLE_FOUND", note: "Absence of a structural counterexample is not proof of truth.", candidates: results };
}

function validateProfile(profile, source) {
  const p = normalize(profile);
  if (!isRecord(p) || !nonEmpty(p.id) || !nonEmpty(p.version) || !nonEmpty(p.targetForm)) throw new TypeError("SMF_PROFILE_INVALID");
  if (!["REQUIRED", "OPTIONAL", "LOSSY"].includes(p.roundTrip) || !Array.isArray(p.invariants) || !p.invariants.length || !Array.isArray(p.losses)) throw new TypeError("SMF_PROFILE_POLICY_INVALID");
  const sourcePaths = new Set();
  const targetPaths = new Set();
  for (const item of p.invariants) {
    if (!isRecord(item) || !nonEmpty(item.sourcePath) || !nonEmpty(item.targetPath)) throw new TypeError("SMF_INVARIANT_INVALID");
    pathParts(item.sourcePath); pathParts(item.targetPath);
    if (sourcePaths.has(item.sourcePath) || targetPaths.has(item.targetPath)) throw new TypeError("SMF_MAPPING_DUPLICATE");
    sourcePaths.add(item.sourcePath); targetPaths.add(item.targetPath);
  }
  for (const key of ["id", ...SMF01.dimensions]) if (!sourcePaths.has(key)) throw new TypeError("SMF_CORE_MAPPING_REQUIRED:" + key);
  const lossPaths = new Set();
  for (const loss of p.losses) {
    if (!isRecord(loss) || !nonEmpty(loss.sourcePath) || !nonEmpty(loss.reason)) throw new TypeError("SMF_LOSS_INVALID");
    pathParts(loss.sourcePath);
    if (SMF01.protectedPaths.includes(loss.sourcePath)) throw new TypeError("SMF_PROTECTED_LOSS_FORBIDDEN:" + loss.sourcePath);
    if (!getPath(source, loss.sourcePath).exists) throw new TypeError("SMF_LOSS_SOURCE_PATH_MISSING:" + loss.sourcePath);
    if (lossPaths.has(loss.sourcePath)) throw new TypeError("SMF_LOSS_DUPLICATE:" + loss.sourcePath);
    lossPaths.add(loss.sourcePath);
  }
  for (const key of Object.keys(source)) if (!sourcePaths.has(key) && !lossPaths.has(key)) throw new TypeError("SMF_UNDECLARED_FIELD_LOSS:" + key);
  if (p.roundTrip === "LOSSY" && lossPaths.size === 0) throw new TypeError("SMF_LOSSY_PROFILE_WITHOUT_LOSS");
  if (p.roundTrip === "REQUIRED" && lossPaths.size) throw new TypeError("SMF_REQUIRED_ROUNDTRIP_CANNOT_DROP_FIELDS");
  return p;
}

/** Transform one identity without granting authority or executing a write. */
export function executePolymorphosis(input) {
  try {
    const source = createSemanticIdentity(input.source);
    const profile = validateProfile(input.profile, source);
    if (typeof input.toTarget !== "function") throw new TypeError("SMF_TARGET_TRANSFORM_REQUIRED");
    if (profile.roundTrip === "REQUIRED" && typeof input.toCanonical !== "function") throw new TypeError("SMF_REVERSE_TRANSFORM_REQUIRED");
    const target = normalize(input.toTarget(source, freezeDeep(profile)));
    if (!isRecord(target)) throw new TypeError("SMF_TARGET_NOT_OBJECT");
    const invariantFindings = [];
    for (const mapping of profile.invariants) {
      const left = getPath(source, mapping.sourcePath);
      const right = getPath(target, mapping.targetPath);
      if (!left.exists || !right.exists || !equal(left.value, right.value)) invariantFindings.push("INVARIANT_MISMATCH:" + mapping.sourcePath);
    }
    let canonicalRoundTrip = null;
    if (typeof input.toCanonical === "function") {
      canonicalRoundTrip = normalize(input.toCanonical(freezeDeep(target), freezeDeep(profile)));
      for (const key of Object.keys(source)) {
        if (!profile.losses.some(loss => loss.sourcePath === key) && (!own(canonicalRoundTrip, key) || !equal(source[key], canonicalRoundTrip[key]))) invariantFindings.push("ROUNDTRIP_MISMATCH:" + key);
      }
    }
    if (profile.roundTrip === "REQUIRED" && !canonicalRoundTrip) invariantFindings.push("ROUNDTRIP_REQUIRED");
    const accepted = invariantFindings.length === 0;
    return {
      ok: accepted, decision: accepted ? "TRANSFORMED" : "BLOCKED",
      profile: { id: profile.id, version: profile.version, targetForm: profile.targetForm },
      target, losses: profile.losses, invariantFindings,
      sourceDigest: digest(source), targetDigest: digest(target), authorityGranted: false,
    };
  } catch (error) {
    return { ok: false, decision: "BLOCKED", reason: error instanceof Error ? error.message : "SMF_TRANSFORM_FAILED", authorityGranted: false };
  }
}

/** Extend SIPA-11 postflight to cover all SMF-01 identity dimensions and context. */
function evaluateSMFPostflight(expectedInput, observedInput) {
  let expected;
  let observed;
  try {
    expected = createSemanticIdentity(expectedInput);
    observed = normalize(observedInput);
  } catch {
    return { decision: "FINDING", findings: ["SMF_POSTFLIGHT_IDENTITY_INVALID"] };
  }
  const integrity = evaluateAntiTalmudPostflight({
    expected,
    observed,
    independentEvidenceVerified: true,
  });
  const findings = [...integrity.findings];
  for (const key of ["context", ...SMF01.dimensions]) {
    if (!own(observed, key) || !equal(expected[key], observed[key])) {
      findings.push("SMF_POSTFLIGHT_DIMENSION_CHANGED:" + key);
    }
  }
  return findings.length
    ? { decision: "FINDING", findings: [...new Set(findings)] }
    : integrity;
}

/** Compose trusted SIPA-11 gates with challenge, transform and independent postflight. */
export function runSemanticMorphosisPipeline(input) {
  const preflight = evaluateTalmudPreflight(input.preflight);
  if (preflight.decision !== "PASS") return { decision: "BLOCKED", stage: "TALMUD_PREFLIGHT", preflight };
  const challenge = evaluateAntiSemanticChallenge({ source: input.source, candidates: input.counterInterpretations });
  if (challenge.decision !== "NO_COUNTEREXAMPLE_FOUND") return { decision: "BLOCKED", stage: "ANTI_SEMANTIC_CHALLENGE", challenge };
  const transform = executePolymorphosis({ source: input.source, profile: input.profile, toTarget: input.toTarget, toCanonical: input.toCanonical });
  if (!transform.ok) return { decision: "BLOCKED", stage: "POLYMORPHOSIS", transform, challenge };
  if (!input.observedCanonical || input.independentEvidenceVerified !== true) {
    return { decision: "QUARANTINE", stage: "ANTI_TALMUD_POSTFLIGHT", transform, challenge, reason: "INDEPENDENT_POSTFLIGHT_EVIDENCE_REQUIRED" };
  }
  const postflight = evaluateSMFPostflight(input.source, input.observedCanonical);
  if (postflight.decision !== "PASS") {
    const correction = createCorrectionProposal({
      proposalId: input.proposalId, findingId: input.findingId, affectedObjectIds: input.affectedObjectIds,
      restoredInvariants: input.restoredInvariants, sourceVerified: input.sourceVerified === true,
      sourceReferences: input.sourceReferences, requiredApprovalScope: input.requiredApprovalScope,
    });
    const echo = evaluateEchoRestoration({
      meridianRestored: input.meridianRestored === true,
      approvalVerified: input.approvalVerified === true,
      invariantsVerified: input.invariantsVerified === true,
    });
    return { decision: "FINDING", stage: "ANTI_TALMUD_POSTFLIGHT", postflight, correction, echo, transform, challenge };
  }
  return { decision: "PASS", stage: "COMPLETE", postflight, transform, challenge, authorityGranted: false };
}

/** Append a transform audit node to the SIPA-11 Meridian chain. */
export function appendMorphosisAuditEvent(chain, event) {
  try {
    const item = normalize(event);
    if (!isRecord(item) || !nonEmpty(item.id) || !nonEmpty(item.sourceRef) || !nonEmpty(item.profileId) || !nonEmpty(item.profileVersion) || !nonEmpty(item.actor) || !nonEmpty(item.createdAt)) return { ok: false, reason: "SMF_AUDIT_EVENT_INVALID" };
    return appendMeridianNode(chain, {
      id: item.id, kind: "SMF_POLYMORPHOSIS", sourceRef: item.sourceRef,
      version: item.profileId + "@" + item.profileVersion, createdAt: item.createdAt,
      actor: item.actor, decision: item.decision || "RECORDED",
      sourceDigest: item.sourceDigest || null, targetDigest: item.targetDigest || null,
    });
  } catch {
    return { ok: false, reason: "SMF_AUDIT_EVENT_INVALID" };
  }
}
