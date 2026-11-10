import { createHash } from "node:crypto";
import { createRootSnapshot, validateRootDelta } from "./reflection-root-store.mjs";
import { validateReflectionOntology } from "./reflection-ontology.mjs";

const sha256 = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function makeNode(id, type, attributes, createdAt) {
  const payload = { id, type, createdAt, attributes };
  return { ...payload, recordDigest: sha256(canonical(payload)) };
}
function makeEdge(from, to, relation, runId, createdAt) {
  const payload = { id: `edge:${sha256(canonical({ from, to, relation, runId })).slice(7)}`, from, to, relation, createdAt };
  return { ...payload, recordDigest: sha256(canonical(payload)) };
}
function sameObjectValue(left, right) {
  try { return canonical(left) === canonical(right); } catch { return false; }
}
function uniquePush(target, existing, item) {
  const key = `${item.relation}:${item.from}:${item.to}`;
  if (existing.has(key)) return;
  existing.add(key);
  target.push(item);
}

/**
 * Deterministic, non-mutating reflection reducer.
 * It appends validated claim/evidence candidates, derives typed provenance edges,
 * detects structured contradiction candidates, and emits RootDelta only.
 * It never promotes a claim or applies a root write.
 */
export function buildReflectionRootDelta({ snapshot, nodes = [], now = () => new Date().toISOString() } = {}) {
  try {
    if (!snapshot || snapshot.schemaVersion !== "kratt-root-snapshot/v1" ||
        !Number.isSafeInteger(snapshot.version) || snapshot.version < 0 ||
        typeof snapshot.digest !== "string" || typeof snapshot.createdAt !== "string" ||
        !Array.isArray(nodes) || nodes.length < 1 || nodes.length > 256 || typeof now !== "function") {
      return Object.freeze({ status: "DENY", reason: "REFLECTION_ENGINE_INPUT_INVALID" });
    }
    const verifiedSnapshot = createRootSnapshot(snapshot.document, { version: snapshot.version, createdAt: snapshot.createdAt });
    if (verifiedSnapshot.digest !== snapshot.digest) return Object.freeze({ status: "BLOCKED", reason: "REFLECTION_ENGINE_ROOT_DIGEST_MISMATCH" });
    const baseValidation = validateReflectionOntology(snapshot.document);
    if (!baseValidation.ok) return Object.freeze({ status: "BLOCKED", reason: "REFLECTION_ENGINE_BASE_ONTOLOGY_INVALID", errors: baseValidation.errors });

    const createdAt = now();
    if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))) {
      return Object.freeze({ status: "BLOCKED", reason: "REFLECTION_ENGINE_TRUSTED_CLOCK_INVALID" });
    }
    const existingIds = new Set(snapshot.document.nodes.map(node => node.id));
    const incomingIds = new Set();
    for (const node of nodes) {
      if (!node || typeof node.id !== "string" || existingIds.has(node.id) || incomingIds.has(node.id)) {
        return Object.freeze({ status: "DENY", reason: "REFLECTION_ENGINE_NODE_ID_CONFLICT" });
      }
      incomingIds.add(node.id);
    }

    const nextNodes = [...snapshot.document.nodes, ...nodes.map(node => JSON.parse(canonical(node)))];
    const nextEdges = [...snapshot.document.edges];
    const generatedEdges = [];
    const edgeKeys = new Set(nextEdges.map(edge => `${edge.relation}:${edge.from}:${edge.to}`));
    const allNodes = new Map(nextNodes.map(node => [node.id, node]));
    const incomingClaims = nodes.filter(node => node.type === "CLAIM");
    const incomingEvidence = nodes.filter(node => node.type === "EVIDENCE");

    for (const node of nodes) {
      const a = node.attributes;
      if (node.type === "SEGMENT") uniquePush(generatedEdges, edgeKeys,
        makeEdge(a.sourceId, node.id, "SOURCE_HAS_SEGMENT", snapshot.digest, createdAt));
      if (node.type === "CLAIM") {
        for (const ref of a.sourceRefs) uniquePush(generatedEdges, edgeKeys,
          makeEdge(ref.segmentId, node.id, "SEGMENT_SUPPORTS_CLAIM", snapshot.digest, createdAt));
      }
      if (node.type === "EVIDENCE" && a.integrityStatus === "VERIFIED") {
        if (a.stance === "supports") uniquePush(generatedEdges, edgeKeys,
          makeEdge(node.id, a.claimId, "EVIDENCE_SUPPORTS_CLAIM", snapshot.digest, createdAt));
        if (a.stance === "contradicts") uniquePush(generatedEdges, edgeKeys,
          makeEdge(node.id, a.claimId, "EVIDENCE_CONTRADICTS_CLAIM", snapshot.digest, createdAt));
      }
    }

    const claims = [...allNodes.values()].filter(node => node.type === "CLAIM" && node.attributes.claimStatus !== "REJECTED");
    const existingContradictions = new Set(nextNodes.filter(node => node.type === "CONTRADICTION")
      .map(node => `${[...node.attributes.claimIds].sort().join("|")}:${node.attributes.timeScope}`));
    const contradictions = [];
    for (let i = 0; i < claims.length; i += 1) {
      for (let j = i + 1; j < claims.length; j += 1) {
        const left = claims[i], right = claims[j], a = left.attributes, b = right.attributes;
        if (a.subjectId !== b.subjectId || a.predicate !== b.predicate || a.timeScope !== b.timeScope ||
            sameObjectValue(a.objectValue, b.objectValue)) continue;
        const claimIds = [left.id, right.id].sort();
        const key = `${claimIds.join("|")}:${a.timeScope}`;
        if (existingContradictions.has(key)) continue;
        existingContradictions.add(key);
        const detectionMethod = "structured-subject-predicate-time/v1";
        const contradiction = makeNode(
          `contradiction:${sha256(canonical({ claimIds, timeScope: a.timeScope, detectionMethod })).slice(7)}`,
          "CONTRADICTION",
          { claimIds, timeScope: a.timeScope, detectionMethod, status: "UNREVIEWED" },
          createdAt,
        );
        contradictions.push(contradiction);
        uniquePush(generatedEdges, edgeKeys,
          makeEdge(claimIds[0], claimIds[1], "CLAIM_CONTRADICTS_CLAIM", snapshot.digest, createdAt));
      }
    }

    const runSeed = {
      rootDigest: snapshot.digest,
      rootVersion: snapshot.version,
      nodeIds: nodes.map(node => node.id).sort(),
      contradictionIds: contradictions.map(node => node.id).sort(),
    };
    const branchRunId = `branch-run:${sha256(canonical(runSeed)).slice(7)}`;
    if (existingIds.has(branchRunId) || incomingIds.has(branchRunId)) {
      return Object.freeze({ status: "DENY", reason: "REFLECTION_ENGINE_BRANCH_RUN_ID_CONFLICT" });
    }
    const branchRun = makeNode(branchRunId, "BRANCH_RUN", {
      rootVersion: snapshot.version,
      rootDigest: snapshot.digest,
      status: "PROPOSAL_ONLY",
    }, createdAt);
    const branchEdges = incomingClaims.map(claim => makeEdge(branchRunId, claim.id, "BRANCH_RUN_PROPOSES_CLAIM", snapshot.digest, createdAt));

    const addedNodes = [...contradictions, branchRun];
    const addedEdges = [...generatedEdges, ...branchEdges];
    const proposedDocument = {
      nodes: [...nextNodes, ...addedNodes],
      edges: [...nextEdges, ...addedEdges],
      metadata: JSON.parse(canonical(snapshot.document.metadata)),
    };
    const semanticValidation = validateReflectionOntology(proposedDocument);
    if (!semanticValidation.ok) {
      return Object.freeze({ status: "DENY", reason: "REFLECTION_ENGINE_PROPOSED_ONTOLOGY_INVALID", errors: semanticValidation.errors });
    }

    const operations = [
      ...addedNodes.map(value => ({ op: "add", path: "/nodes/-", value })),
      ...addedEdges.map(value => ({ op: "add", path: "/edges/-", value })),
    ];
    const rootDelta = { schemaVersion: "kratt-root-delta/v1", operations };
    const deltaValidation = validateRootDelta(rootDelta);
    if (!deltaValidation.ok) return Object.freeze({ status: "DENY", reason: "REFLECTION_ENGINE_DELTA_INVALID", detail: deltaValidation.reason });

    const verifiedEvidence = [...allNodes.values()].filter(node => node.type === "EVIDENCE" && node.attributes.integrityStatus === "VERIFIED");
    const independenceGroups = new Set(verifiedEvidence.map(node => node.attributes.independenceGroupId));
    const payload = {
      schemaVersion: "kratt-reflection-engine-proposal/v1",
      status: "PROPOSAL_ONLY",
      applyStatus: "NOT_APPLIED",
      expectedRootVersion: snapshot.version,
      expectedRootDigest: snapshot.digest,
      rootDeltaDigest: deltaValidation.digest,
      rootDelta,
      branchRunId,
      createdAt,
      requiresArchitectApproval: true,
      claimPromotion: "FORBIDDEN",
      statistics: {
        incomingClaimCount: incomingClaims.length,
        incomingEvidenceCount: incomingEvidence.length,
        verifiedEvidenceCount: verifiedEvidence.length,
        independentEvidenceGroups: independenceGroups.size,
        dependentEvidenceCopies: Math.max(0, verifiedEvidence.length - independenceGroups.size),
        contradictionCandidatesAdded: contradictions.length,
      },
    };
    const proposalDigest = sha256(canonical(payload));
    return Object.freeze({
      status: "PROPOSED",
      proposal: Object.freeze({
        ...payload,
        proposalId: `reflection-engine-proposal:${proposalDigest.slice(7)}`,
        proposalDigest,
      }),
    });
  } catch {
    return Object.freeze({ status: "ERROR", reason: "REFLECTION_ENGINE_FAILED_CLOSED" });
  }
}
