import { createHash } from "node:crypto";

const MODALITY = Object.freeze({ MUST: [3, 1], SHOULD: [2, 1], MAY: [1, 1], MUST_NOT: [3, -1], SHOULD_NOT: [2, -1], MAY_NOT: [1, -1], INFORMATIONAL: [0, 0] });
const own = (value, key) => Object.hasOwn(value ?? {}, key);
const isRecord = value => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};
const SEMANTIC_DIMENSIONS = Object.freeze(["subject", "scope", "effect", "authority", "power", "freshness", "provenance", "negation", "temporal", "principle", "content", "meaning", "influence", "wordContent", "wordMeaning", "wordPrinciple", "wordInfluence", "wordPower", "languageContext", "jurisdiction", "purpose", "schemaVersion"]);
const SEMANTIC_ALLOWED = new Set(["modality", ...SEMANTIC_DIMENSIONS, "conditions", "prohibitedEquivalences", "losses"]);

function canonical(value, active = new WeakSet(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (typeof value !== "object" || active.has(value)) throw new TypeError("SEMANTIC_VALUE_UNSUPPORTED");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || keys.some(key => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)))) throw new TypeError("SEMANTIC_ARRAY_INVALID");
      const items = [];
      for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new TypeError("SEMANTIC_ARRAY_INVALID");
        items.push(canonical(descriptor.value, active, `${path}[${i}]`));
      }
      return `[${items.join(",")}]`;
    }
    if (!isRecord(value)) throw new TypeError("SEMANTIC_OBJECT_INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw new TypeError("SEMANTIC_SYMBOL_KEY");
    return `{${keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) throw new TypeError("SEMANTIC_ACCESSOR_INVALID");
      return `${JSON.stringify(key)}:${canonical(descriptor.value, active, `${path}.${key}`)}`;
    }).join(",")}}`;
  } finally { active.delete(value); }
}


function digest(value) { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }
function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && Object.hasOwn(descriptor, "value")) deepFreeze(descriptor.value, seen);
    }
    Object.freeze(value);
  }
  return value;
}

/** Compare semantic dimensions conservatively; this is not an NLP truth oracle. */
export function evaluateSemanticPreservation(source, candidate) {
  try { canonical(source); canonical(candidate); } catch { return { ok: false, findings: ["SEMANTIC_OBJECT_INVALID"] }; }
  if (!isRecord(source) || !isRecord(candidate)) return { ok: false, findings: ["SEMANTIC_OBJECT_INVALID"] };
  if ([...Reflect.ownKeys(source), ...Reflect.ownKeys(candidate)].some(key => typeof key !== "string" || !SEMANTIC_ALLOWED.has(key))) {
    return { ok: false, findings: ["SEMANTIC_UNKNOWN_FIELD"] };
  }
  const findings = [], left = MODALITY[source.modality], right = MODALITY[candidate.modality];
  if (!left || !right) findings.push("MODALITY_MISSING_OR_UNKNOWN");
  else {
    if (left[1] !== right[1]) findings.push("MODALITY_POLARITY_CHANGED");
    if (right[0] < left[0]) findings.push("MODALITY_WEAKENED");
  }
  for (const field of SEMANTIC_DIMENSIONS) {
    const hasLeft = own(source, field), hasRight = own(candidate, field);
    if (hasLeft !== hasRight) findings.push(`${field.toUpperCase()}_${hasLeft ? "DROPPED" : "INTRODUCED"}`);
    else if (hasLeft && canonical(source[field]) !== canonical(candidate[field])) findings.push(`${field.toUpperCase()}_CHANGED`);
  }
  if (own(source, "conditions")) {
    if (!Array.isArray(source.conditions) || !Array.isArray(candidate.conditions)) findings.push("CONDITIONS_INVALID_OR_MISSING");
    else if (source.conditions.some(condition => !candidate.conditions.some(item => canonical(item) === canonical(condition)))) findings.push("CONDITION_DROPPED");
  }
  if (own(source, "prohibitedEquivalences")) {
    if (!Array.isArray(source.prohibitedEquivalences) || !Array.isArray(candidate.prohibitedEquivalences)) findings.push("PROHIBITED_EQUIVALENCES_INVALID_OR_MISSING");
    else if (source.prohibitedEquivalences.some(item => !candidate.prohibitedEquivalences.some(value => canonical(value) === canonical(item)))) findings.push("PROHIBITED_EQUIVALENCE_DROPPED");
  }
  if (own(candidate, "losses") && (!Array.isArray(candidate.losses) || candidate.losses.length)) findings.push("DECLARED_SEMANTIC_LOSS");
  return { ok: findings.length === 0, findings: [...new Set(findings)] };
}

/** Fail-closed preflight. PASS is not an authorization grant. */
export function evaluateTalmudPreflight(input) {
  if (!isRecord(input)) return { decision: "BLOCKED", reasons: ["PREFLIGHT_INPUT_INVALID"] };
  const reasons = [...evaluateSemanticPreservation(input.source, input.proposed).findings];
  for (const [key, reason] of [
    ["provenanceVerified", "PROVENANCE_NOT_VERIFIED"], ["evidenceVerified", "EVIDENCE_NOT_VERIFIED"],
    ["authorityScoped", "AUTHORITY_NOT_REQUEST_SCOPED"], ["conflictFree", "CONFLICT_UNRESOLVED"],
    ["sourceVersionKnown", "SOURCE_VERSION_UNKNOWN"], ["freshnessVerified", "SOURCE_FRESHNESS_UNVERIFIED"],
  ]) if (input[key] !== true) reasons.push(reason);
  return { decision: reasons.length ? "BLOCKED" : "PASS", reasons: [...new Set(reasons)] };
}

/** Postflight compares declared and observed behavior using independently verified evidence. */
export function evaluateAntiTalmudPostflight(input) {
  if (!isRecord(input) || input.independentEvidenceVerified !== true) {
    return { decision: "QUARANTINE", findings: ["INDEPENDENT_POSTFLIGHT_EVIDENCE_MISSING"] };
  }
  const result = evaluateSemanticPreservation(input.expected, input.observed);
  return { decision: result.ok ? "PASS" : "FINDING", findings: result.findings };
}

/** Create a reviewable proposal only; never applies or self-approves a correction. */
export function createCorrectionProposal(input) {
  if (!isRecord(input) || typeof input.proposalId !== "string" || !input.proposalId.trim() ||
      typeof input.findingId !== "string" || !input.findingId.trim() ||
      !Array.isArray(input.affectedObjectIds) || !input.affectedObjectIds.length ||
      input.affectedObjectIds.some(value => typeof value !== "string" || !value.trim()) ||
      !Array.isArray(input.restoredInvariants) || !input.restoredInvariants.length ||
      input.restoredInvariants.some(value => typeof value !== "string" || !value.trim()) || input.sourceVerified !== true) {
    return { ok: false, reason: "CORRECTION_PROPOSAL_INVALID" };
  }
  const uniqueStrings = value => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !item.trim())) throw new TypeError("CORRECTION_LIST_INVALID");
    return [...new Set(value)];
  };
  try {
    const proposal = {
      proposalId: input.proposalId, findingId: input.findingId, affectedObjectIds: uniqueStrings(input.affectedObjectIds),
      sourceReferences: uniqueStrings(input.sourceReferences), restoredInvariants: uniqueStrings(input.restoredInvariants),
      dependencyObjectIds: uniqueStrings(input.dependencyObjectIds), requiredApprovalScope: input.requiredApprovalScope ?? "semantic.correction.review",
      testReferences: uniqueStrings(input.testReferences), status: "PROPOSED", applicationAllowed: false,
    };
    return { ok: true, proposal: deepFreeze(proposal) };
  } catch { return { ok: false, reason: "CORRECTION_PROPOSAL_FIELDS_INVALID" }; }
}

/** Echo restoration waits for Meridian, approval, constitution and round-trip verification. */
export function evaluateEchoRestoration(input) {
  if (!isRecord(input) || input.meridianRestored !== true || input.meridianVerified !== true) return { decision: "QUARANTINE", reason: "MERIDIAN_NOT_RESTORED_AND_VERIFIED" };
  if (input.approvalVerified !== true) return { decision: "BLOCKED", reason: "RESTORATION_APPROVAL_MISSING" };
  if (input.invariantsVerified !== true || input.constitutionVersionMatches !== true) return { decision: "BLOCKED", reason: "ECHO_INVARIANT_OR_CONSTITUTION_CHECK_FAILED" };
  if (input.roundTripVerified !== true) return { decision: "BLOCKED", reason: "ECHO_ROUND_TRIP_NOT_VERIFIED" };
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

/** Loss-aware bidirectional transform check. Authority-bearing losses always block. */
export function evaluatePolymorphosisRoundTrip({ canonical: original, forward, restored, declaredLosses = [] } = {}) {
  if (!Array.isArray(declaredLosses) || declaredLosses.some(item => typeof item !== "string")) return { ok: false, decision: "BLOCKED", findings: ["POLYMORPHOSIS_LOSS_MANIFEST_INVALID"] };
  const findings = [
    ...evaluateSemanticPreservation(original, forward).findings.map(item => `FORWARD_${item}`),
    ...evaluateSemanticPreservation(original, restored).findings.map(item => `ROUND_TRIP_${item}`),
  ];
  if (declaredLosses.length) findings.push("POLYMORPHOSIS_LOSS_DECLARED");
  const privileged = declaredLosses.some(item => ["authority", "power", "scope", "effect"].includes(item));
  if (privileged) findings.push("POLYMORPHOSIS_PRIVILEGE_FIELD_LOSS");
  return { ok: findings.length === 0, decision: findings.length ? (privileged ? "BLOCKED" : "LOSSY_REVIEW_REQUIRED") : "ROUND_TRIP_PRESERVED", findings: [...new Set(findings)] };
}

/** Evidence invalidation propagates through semantic memory dependencies. */
export function evaluateSemanticMemoryDependencies(memory, invalidatedEvidenceIds = []) {
  if (!isRecord(memory) || typeof memory.id !== "string" || !memory.id || !Array.isArray(memory.evidenceIds) || !Array.isArray(invalidatedEvidenceIds)) return { decision: "QUARANTINE", reason: "MEMORY_PROVENANCE_INVALID" };
  if (memory.provenanceVerified !== true) return { decision: "QUARANTINE", reason: "MEMORY_PROVENANCE_UNVERIFIED" };
  const invalid = new Set(invalidatedEvidenceIds), affected = memory.evidenceIds.filter(id => invalid.has(id));
  return affected.length ? { decision: "STALE", reason: "DEPENDENCY_EVIDENCE_INVALIDATED", affectedEvidenceIds: affected } : { decision: "FRESH", reason: null, affectedEvidenceIds: [] };
}

/** Decorator around the existing authorized dispatcher; SIPA-11 never grants write authority. */
export function createSipa11GuardedDispatchRuntime({ dispatchRuntime, loadSemanticContext, loadIndependentPostflight, meridianStore, correctionStore = null, now } = {}) {
  if (!dispatchRuntime || typeof dispatchRuntime.execute !== "function" || typeof loadSemanticContext !== "function" ||
      typeof loadIndependentPostflight !== "function" || !meridianStore || typeof meridianStore.append !== "function" ||
      typeof meridianStore.verify !== "function" || typeof now !== "function" ||
      (correctionStore !== null && typeof correctionStore.propose !== "function")) throw new TypeError("SIPA11_RUNTIME_DEPENDENCIES_INVALID");
  const record = async node => {
    try {
      const result = await meridianStore.append(node);
      if (result !== true && (!isRecord(result) || result.ok !== true)) return false;
      const verification = await meridianStore.verify();
      return isRecord(verification) && verification.ok === true;
    } catch { return false; }
  };
  const execute = async request => {
    let context;
    try { context = await loadSemanticContext(request); } catch { return { status: "BLOCKED", reason: "SIPA11_SEMANTIC_CONTEXT_UNAVAILABLE", dispatched: false }; }
    const preflight = evaluateTalmudPreflight(context);
    if (preflight.decision !== "PASS") return { status: "BLOCKED", reason: "SIPA11_TALMUD_PREFLIGHT_BLOCKED", semanticPreflight: preflight, dispatched: false };
    let existing;
    try { existing = await meridianStore.verify(); } catch { existing = null; }
    if (!isRecord(existing) || existing.ok !== true) return { status: "QUARANTINED", reason: "SIPA11_MERIDIAN_CHAIN_UNVERIFIED", dispatched: false, semanticPreflight: preflight };
    const taskId = request?.task?.task_id, sourceRef = context.sourceReference ?? context.source?.provenance, version = context.sourceVersion ?? context.source?.schemaVersion;
    if (typeof taskId !== "string" || !taskId || typeof sourceRef !== "string" || !sourceRef || typeof version !== "string" || !version) return { status: "BLOCKED", reason: "SIPA11_SOURCE_BINDING_MISSING", dispatched: false, semanticPreflight: preflight };
    let time; try { time = now(); } catch { time = null; }
    if (!Number.isFinite(time) || time < 0) return { status: "BLOCKED", reason: "SIPA11_TRUSTED_CLOCK_INVALID", dispatched: false, semanticPreflight: preflight };
    const createdAt = new Date(time).toISOString();
    if (!await record({ id: `sipa11-preflight:${taskId}`, kind: "INTERPRETATION", sourceRef, version, createdAt, validationState: "VERIFIED", metadata: { engine: "TALMUD", decision: preflight.decision } })) return { status: "QUARANTINED", reason: "SIPA11_MERIDIAN_PREFLIGHT_APPEND_FAILED", dispatched: false, semanticPreflight: preflight };
    let outcome;
    try { outcome = await dispatchRuntime.execute(request); } catch { return { status: "OUTCOME_UNRECORDED", reason: "AUTHORIZED_DISPATCH_RUNTIME_FAILED", dispatched: "UNKNOWN", semanticPreflight: preflight }; }
    if (!isRecord(outcome) || !["COMPLETED", "FAILED", "OUTCOME_UNRECORDED"].includes(outcome.status)) return { ...outcome, semanticPreflight: preflight };
    let independent; try { independent = await loadIndependentPostflight({ request, dispatchResult: outcome, semanticContext: context }); } catch { independent = null; }
    const postflight = evaluateAntiTalmudPostflight({ expected: context.proposed, observed: independent?.observed, independentEvidenceVerified: independent?.independentEvidenceVerified });
    let end; try { end = now(); } catch { end = null; }
    if (!Number.isFinite(end) || end < 0) return { status: "QUARANTINED", reason: "SIPA11_POSTFLIGHT_CLOCK_INVALID", dispatched: true, dispatchStatus: outcome.status, semanticPreflight: preflight, semanticPostflight: postflight };
    const node = { id: `sipa11-postflight:${taskId}`, kind: postflight.decision === "PASS" ? "OUTCOME" : "FINDING", sourceRef: independent?.sourceRef ?? sourceRef,
      version, createdAt: new Date(end).toISOString(), validationState: postflight.decision === "PASS" ? "VERIFIED" : "QUARANTINED", metadata: { engine: "ANTI_TALMUD", decision: postflight.decision, findings: postflight.findings } };
    if (!await record(node)) return { status: "QUARANTINED", reason: "SIPA11_MERIDIAN_POSTFLIGHT_APPEND_FAILED", dispatched: true, dispatchStatus: outcome.status, semanticPreflight: preflight, semanticPostflight: postflight };
    if (postflight.decision !== "PASS") {
      const findingId = independent?.findingId ?? `finding:${taskId}`;
      const proposal = createCorrectionProposal({ proposalId: `correction:${findingId}`, findingId, affectedObjectIds: independent?.affectedObjectIds ?? [taskId],
        sourceReferences: [sourceRef, ...(independent?.sourceReferences ?? [])], restoredInvariants: postflight.findings.length ? postflight.findings : ["semantic-preservation"],
        dependencyObjectIds: independent?.dependencyObjectIds ?? [], requiredApprovalScope: independent?.requiredApprovalScope ?? "semantic.correction.review",
        testReferences: independent?.testReferences ?? [], sourceVerified: independent?.sourceVerified === true });
      let persisted = false;
      if (proposal.ok && correctionStore) try { persisted = await correctionStore.propose(proposal.proposal) === true; } catch { persisted = false; }
      return { status: "QUARANTINED", reason: postflight.decision === "FINDING" ? "SIPA11_ANTI_TALMUD_FINDING" : "SIPA11_POSTFLIGHT_EVIDENCE_UNAVAILABLE",
        dispatched: true, dispatchStatus: outcome.status, semanticPreflight: preflight, semanticPostflight: postflight, correctionProposal: proposal.ok ? proposal.proposal : null, correctionPersisted: persisted };
    }
    return { ...outcome, semanticPreflight: preflight, semanticPostflight: postflight };
  };
  return Object.freeze({ execute });
}
