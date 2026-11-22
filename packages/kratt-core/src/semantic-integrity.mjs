import { createHash } from "node:crypto";

const MODALITY = Object.freeze({ MUST: 3, SHOULD: 2, MAY: 1 });
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);

function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isRecord(value)) throw new TypeError("SEMANTIC_VALUE_UNSUPPORTED");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }

/** Compare semantic-strength-bearing fields. This is a conservative structural check, not an NLP truth oracle. */
export function evaluateSemanticPreservation(source, candidate) {
  if (!isRecord(source) || !isRecord(candidate)) return { ok: false, findings: ["SEMANTIC_OBJECT_INVALID"] };
  const findings = [];
  if (!own(source, "modality") || !own(candidate, "modality") || !(source.modality in MODALITY) || !(candidate.modality in MODALITY)) {
    findings.push("MODALITY_MISSING_OR_UNKNOWN");
  } else if (MODALITY[candidate.modality] < MODALITY[source.modality]) findings.push("MODALITY_WEAKENED");
  for (const field of ["subject", "scope", "effect", "authority", "freshness", "provenance"]) {
    if (own(source, field) && (!own(candidate, field) || canonical(source[field]) !== canonical(candidate[field]))) {
      findings.push(`${field.toUpperCase()}_CHANGED_OR_MISSING`);
    }
  }
  if (own(source, "conditions")) {
    if (!Array.isArray(source.conditions) || !Array.isArray(candidate.conditions)) findings.push("CONDITIONS_INVALID_OR_MISSING");
    else if (source.conditions.some(condition => !candidate.conditions.some(item => canonical(item) === canonical(condition)))) findings.push("CONDITION_DROPPED");
  }
  if (own(source, "prohibitedEquivalences") && (!Array.isArray(candidate.prohibitedEquivalences) ||
      source.prohibitedEquivalences.some(item => !candidate.prohibitedEquivalences.includes(item)))) findings.push("PROHIBITED_EQUIVALENCE_DROPPED");
  return { ok: findings.length === 0, findings };
}

/** Fail-closed preflight. A pass is not an authorization grant; caller must still invoke policy/dispatch. */
export function evaluateTalmudPreflight(input) {
  if (!isRecord(input)) return { decision: "BLOCKED", reasons: ["PREFLIGHT_INPUT_INVALID"] };
  const reasons = [];
  const preservation = evaluateSemanticPreservation(input.source, input.proposed);
  reasons.push(...preservation.findings);
  if (input.provenanceVerified !== true) reasons.push("PROVENANCE_NOT_VERIFIED");
  if (input.evidenceVerified !== true) reasons.push("EVIDENCE_NOT_VERIFIED");
  if (input.authorityScoped !== true) reasons.push("AUTHORITY_NOT_REQUEST_SCOPED");
  if (input.conflictFree !== true) reasons.push("CONFLICT_UNRESOLVED");
  return { decision: reasons.length ? "BLOCKED" : "PASS", reasons };
}

/** Postflight compares declared and observed behavior using independently verified evidence. */
export function evaluateAntiTalmudPostflight(input) {
  if (!isRecord(input) || input.independentEvidenceVerified !== true) {
    return { decision: "QUARANTINE", findings: ["INDEPENDENT_POSTFLIGHT_EVIDENCE_MISSING"] };
  }
  const result = evaluateSemanticPreservation(input.expected, input.observed);
  return { decision: result.ok ? "PASS" : "FINDING", findings: result.findings };
}

/** Create a reviewable correction proposal; never mutates canonical source or applies a write. */
export function createCorrectionProposal(input) {
  if (!isRecord(input) || typeof input.findingId !== "string" || !input.findingId ||
      !Array.isArray(input.affectedObjectIds) || !input.affectedObjectIds.length ||
      !Array.isArray(input.restoredInvariants) || input.restoredInvariants.length === 0 ||
      input.sourceVerified !== true) return { ok: false, reason: "CORRECTION_PROPOSAL_INVALID" };
  const proposal = {
    proposalId: input.proposalId, findingId: input.findingId, affectedObjectIds: [...new Set(input.affectedObjectIds)],
    sourceReferences: Array.isArray(input.sourceReferences) ? [...input.sourceReferences] : [],
    restoredInvariants: [...new Set(input.restoredInvariants)],
    requiredApprovalScope: input.requiredApprovalScope ?? null,
    status: "PROPOSED",
  };
  if (typeof proposal.proposalId !== "string" || !proposal.proposalId) return { ok: false, reason: "CORRECTION_PROPOSAL_ID_INVALID" };
  return { ok: true, proposal: Object.freeze(proposal) };
}

/** Echo release is gated on restored Meridian, explicit approval, and independent invariant checks. */
export function evaluateEchoRestoration(input) {
  if (!isRecord(input) || input.meridianRestored !== true) return { decision: "QUARANTINE", reason: "MERIDIAN_NOT_RESTORED" };
  if (input.approvalVerified !== true) return { decision: "BLOCKED", reason: "RESTORATION_APPROVAL_MISSING" };
  if (input.invariantsVerified !== true) return { decision: "BLOCKED", reason: "ECHO_INVARIANT_CHECK_FAILED" };
  return { decision: "RELEASE_ELIGIBLE", reason: null };
}

/** Append a provenance-linked node to a local hash chain. Hashes detect mutation; they do not prove truth. */
export function appendMeridianNode(chain, node) {
  if (!Array.isArray(chain) || !isRecord(node) || typeof node.id !== "string" || !node.id ||
      typeof node.kind !== "string" || !node.kind || typeof node.sourceRef !== "string" || !node.sourceRef ||
      typeof node.version !== "string" || !node.version || typeof node.createdAt !== "string" || !Number.isFinite(Date.parse(node.createdAt))) {
    return { ok: false, reason: "MERIDIAN_NODE_INVALID" };
  }
  if (chain.some(entry => entry.node.id === node.id)) return { ok: false, reason: "MERIDIAN_DUPLICATE_NODE" };
  const previousDigest = chain.length ? chain[chain.length - 1].digest : null;
  const payload = { sequence: chain.length + 1, previousDigest, node: structuredClone(node) };
  const entry = Object.freeze({ ...payload, digest: digest(payload) });
  return { ok: true, entry };
}

export function verifyMeridianChain(chain) {
  if (!Array.isArray(chain)) return { ok: false, reason: "MERIDIAN_CHAIN_INVALID" };
  let previousDigest = null;
  const ids = new Set();
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    if (!isRecord(entry) || !isRecord(entry.node) || entry.sequence !== index + 1 || entry.previousDigest !== previousDigest ||
        typeof entry.digest !== "string" || ids.has(entry.node.id)) return { ok: false, sequence: index + 1 };
    const payload = { sequence: entry.sequence, previousDigest: entry.previousDigest, node: entry.node };
    if (digest(payload) !== entry.digest) return { ok: false, sequence: index + 1 };
    ids.add(entry.node.id);
    previousDigest = entry.digest;
  }
  return { ok: true, count: chain.length, head: previousDigest };
}