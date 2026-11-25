import { createHash } from "node:crypto";
import { EVIDENCE_LEDGER_SCHEMA, validateEvidenceEvent } from "../../kratt-core/src/evidence-ledger.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[0-9a-f]{40}$/;
const hash = text => `sha256:${createHash("sha256").update(text).digest("hex")}`;

export function createRootClaim({ rootId, statement, revision }) {
  if (typeof rootId !== "string" || !ID.test(rootId) || typeof statement !== "string" || !statement.trim() || statement.length > 4000 || typeof revision !== "string" || !SHA.test(revision)) {
    return { ok: false, reason: "ROOT_CLAIM_INVALID" };
  }
  return Object.freeze({ ok: true, claim: Object.freeze({ schemaVersion: "kratt-root-claim/v1", rootId,
    statement: statement.trim(), revision, createdAt: new Date().toISOString() }) });
}

export function createEvidenceCard(input) {
  const { rootId, branchId, ...eventInput } = input ?? {};
  if (typeof rootId !== "string" || !ID.test(rootId) || typeof branchId !== "string" || !ID.test(branchId)) return { ok: false, reason: "EVIDENCE_PROVENANCE_INVALID" };
  const event = validateEvidenceEvent({ schemaVersion: EVIDENCE_LEDGER_SCHEMA, ...eventInput });
  if (!event.ok) return event;
  const body = { schemaVersion: "kratt-eck-card/v1", cardId: event.value.eventId, rootId, branchId, evidence: event.value };
  return Object.freeze({ ok: true, card: Object.freeze({ ...body, contentDigest: hash(JSON.stringify(body)) }) });
}

/** Convert local Git index metadata into provenance-bearing ECK observations. */
export function createRepositoryEvidenceCards({ index, rootId, branchId, actorId, occurredAt }) {
  const sha = /^[0-9a-f]{40}$/;
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!index?.ok || !sha.test(index.revision ?? "") || !Array.isArray(index.files) || index.files.length > 500 ||
      !identifier.test(rootId ?? "") || !identifier.test(branchId ?? "") || !identifier.test(actorId ?? "") ||
      typeof occurredAt !== "string" || !Number.isFinite(Date.parse(occurredAt))) {
    return { ok: false, reason: "REPOSITORY_INDEX_EVIDENCE_INPUT_INVALID" };
  }
  const cards = [];
  for (const file of index.files) {
    if (!file || !sha.test(file.blobSha ?? "") || !/^sha256:[0-9a-f]{64}$/.test(file.contentDigest ?? "") ||
        !Number.isSafeInteger(file.byteLength) || file.byteLength < 0 || typeof file.path !== "string" || file.path.length > 512) {
      return { ok: false, reason: "REPOSITORY_INDEX_METADATA_INVALID" };
    }
    const pathDigest = createHash("sha256").update(file.path).digest("hex");
    const scopeDigest = createHash("sha256").update(`${rootId}\0${branchId}`).digest("hex");
    const card = createEvidenceCard({ rootId, branchId, eventId: `repo-${scopeDigest.slice(0, 12)}-${index.revision.slice(0, 12)}-${pathDigest.slice(0, 32)}`,
      eventType: "repository.file.indexed", actorId, occurredAt, subject: `repo-file:${pathDigest.slice(0, 48)}`,
      decision: "OBSERVED", sourceRef: { provider: "local-git", resource: file.blobSha, revision: index.revision },
      artifactDigest: file.contentDigest, metadata: { path: file.path, blobSha: file.blobSha, byteLength: file.byteLength,
        indexing: "metadata-only" } });
    if (!card.ok) return card;
    cards.push(card.card);
  }
  return Object.freeze({ ok: true, cards: Object.freeze(cards) });
}

export function createBranchManager(rootClaim) {
  if (!rootClaim || rootClaim.schemaVersion !== "kratt-root-claim/v1") throw new TypeError("ROOT_CLAIM_REQUIRED");
  const branches = new Map();
  return Object.freeze({
    create({ branchId, parentBranchId = null, question }) {
      if (typeof branchId !== "string" || !ID.test(branchId) || branches.has(branchId) || typeof question !== "string" || !question.trim() || question.length > 1000 ||
          (parentBranchId !== null && !branches.has(parentBranchId))) return { ok: false, reason: "BRANCH_INPUT_INVALID" };
      const branch = Object.freeze({ schemaVersion: "kratt-evidence-branch/v1", branchId,
        rootId: rootClaim.rootId, rootRevision: rootClaim.revision, parentBranchId,
        question: question.trim(), state: "OPEN", findings: Object.freeze([]) });
      branches.set(branchId, branch);
      return { ok: true, branch };
    },
    addFinding(branchId, card) {
      const current = branches.get(branchId);
      if (!current || current.state !== "OPEN") return { ok: false, reason: "BRANCH_NOT_OPEN" };
      if (card?.schemaVersion !== "kratt-eck-card/v1" || card.rootId !== rootClaim.rootId || card.branchId !== branchId) return { ok: false, reason: "FINDING_PROVENANCE_MISMATCH" };
      const next = Object.freeze({ ...current, findings: Object.freeze([...current.findings, card]) });
      branches.set(branchId, next);
      return { ok: true, branch: next };
    },
    close(branchId) {
      const current = branches.get(branchId);
      if (!current || current.state !== "OPEN") return { ok: false, reason: "BRANCH_NOT_OPEN" };
      const next = Object.freeze({ ...current, state: "CLOSED" });
      branches.set(branchId, next);
      return { ok: true, branch: next };
    },
    list() { return [...branches.values()]; }
  });
}

export function aggregateCalibratedEvidence({ priorProbability, observations }) {
  if (!Number.isFinite(priorProbability) || priorProbability <= 0 || priorProbability >= 1 || !Array.isArray(observations) || observations.length === 0 || observations.length > 256) {
    return { ok: false, status: "ABSTAIN", reason: "CALIBRATED_PRIOR_REQUIRED" };
  }
  const groups = new Map();
  for (const item of observations) {
    if (!item || item.state !== "CALIBRATED" || !ID.test(item.calibrationId ?? "") ||
        typeof item.dependencyGroup !== "string" || !ID.test(item.dependencyGroup) || !Number.isFinite(item.likelihoodRatio) || item.likelihoodRatio < 1e-6 || item.likelihoodRatio > 1e6) {
      return { ok: true, status: "ABSTAIN", posterior: null, reason: "UNCALIBRATED_OR_INVALID_EVIDENCE" };
    }
    const list = groups.get(item.dependencyGroup) ?? [];
    list.push(item);
    groups.set(item.dependencyGroup, list);
  }
  let logOdds = Math.log(priorProbability / (1 - priorProbability));
  const usedGroups = [];
  for (const [dependencyGroup, items] of groups) {
    const signs = new Set(items.map(item => Math.sign(Math.log(item.likelihoodRatio))));
    if (signs.has(-1) && signs.has(1)) return { ok: true, status: "CONFLICTED", posterior: null, reason: "DEPENDENT_EVIDENCE_CONFLICT", dependencyGroup };
    // Correlated records in a group are never multiplied; one conservative contribution is used.
    const contribution = items.map(item => Math.log(item.likelihoodRatio)).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
    logOdds += contribution;
    usedGroups.push(dependencyGroup);
  }
  const posterior = 1 / (1 + Math.exp(-logOdds));
  return { ok: true, status: "AGGREGATED", posterior, method: "DEPENDENCY_GROUPED_LOG_ODDS_V1", usedGroups };
}

export function reflectEvidence({ rootClaim, branches, requiredInvariants = [] }) {
  const failures = [];
  if (!rootClaim || rootClaim.schemaVersion !== "kratt-root-claim/v1") failures.push("ROOT_CLAIM_INVALID");
  if (!Array.isArray(branches)) failures.push("BRANCHES_INVALID");
  const branchList = Array.isArray(branches) ? branches : [];
  for (const branch of branchList) {
    if (branch.rootId !== rootClaim?.rootId || branch.rootRevision !== rootClaim?.revision) failures.push(`ROOT_MAPPING_INVALID:${branch.branchId}`);
    for (const card of branch.findings ?? []) if (card.rootId !== rootClaim?.rootId || card.branchId !== branch.branchId) failures.push(`PROVENANCE_INVALID:${card.cardId}`);
  }
  if (!Array.isArray(requiredInvariants)) failures.push("INVARIANTS_INVALID");
  else for (const invariant of requiredInvariants) if (invariant?.passed !== true) failures.push(`INVARIANT_FAILED:${invariant?.id ?? "unknown"}`);
  const decisionsBySubject = new Map();
  for (const branch of branchList) for (const card of branch.findings ?? []) {
    const decisions = decisionsBySubject.get(card.evidence.subject) ?? new Set();
    decisions.add(card.evidence.decision);
    decisionsBySubject.set(card.evidence.subject, decisions);
  }
  const conflict = [...decisionsBySubject.values()].some(decisions => decisions.has("VERIFIED") && decisions.has("BLOCKED"));
  const state = failures.length ? "REJECTED" : conflict ? "CONFLICTED" : "VALIDATED";
  return Object.freeze({ ok: failures.length === 0 && !conflict, state, rootId: rootClaim?.rootId ?? null,
    rootRevision: rootClaim?.revision ?? null, branchCount: branchList.length,
    validatedDelta: state === "VALIDATED" ? Object.freeze({ fromRevision: rootClaim.revision,
      status: "PROPOSED_ONLY", autoApply: false }) : null, failures: Object.freeze(failures) });
}



