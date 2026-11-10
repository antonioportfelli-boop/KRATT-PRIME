import { createHash } from "node:crypto";
import { createSqliteReflectionRootStore } from "./reflection-root-store.mjs";
import { createTelegramReflectionCasAdapter } from "./telegram-reflection-proposal-verifier.mjs";

export const KRATT_ONTOLOGY_VERSION = "kratt-ontology/v1";

const NODE_TYPES = new Set(["SOURCE", "SEGMENT", "CLAIM", "EVIDENCE", "CONTRADICTION", "DECISION", "BRANCH_RUN", "AGENT"]);
const NODE_FIELDS = {
  SOURCE: ["sourceDigest", "observedAt", "rightsStatus"],
  SEGMENT: ["sourceId", "startOffset", "endOffset", "excerptDigest"],
  CLAIM: ["normalizedText", "extractionMethod", "claimStatus", "sourceRefs"],
  EVIDENCE: ["sourceId", "sourceDigest", "stance", "integrityStatus", "sourceLineageId", "independenceGroupId"],
  CONTRADICTION: ["claimIds", "timeScope", "detectionMethod", "status"],
  DECISION: ["targetId", "decision", "reviewerId", "reason", "policyVersion", "evidenceSnapshotDigest", "decidedAt"],
  BRANCH_RUN: ["rootVersion", "rootDigest", "status"],
  AGENT: ["role", "scope", "status"],
};
const RELATIONS = {
  SOURCE_HAS_SEGMENT: ["SOURCE", "SEGMENT"],
  SEGMENT_SUPPORTS_CLAIM: ["SEGMENT", "CLAIM"],
  EVIDENCE_SUPPORTS_CLAIM: ["EVIDENCE", "CLAIM"],
  EVIDENCE_CONTRADICTS_CLAIM: ["EVIDENCE", "CLAIM"],
  CLAIM_CONTRADICTS_CLAIM: ["CLAIM", "CLAIM"],
  DECISION_REVIEWS_CLAIM: ["DECISION", "CLAIM"],
  BRANCH_RUN_PROPOSES_CLAIM: ["BRANCH_RUN", "CLAIM"],
  AGENT_PRODUCED: ["AGENT", "*"],
  DERIVED_FROM: ["*", "*"],
  PARENT_OF: ["*", "*"],
};
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validTime = value => typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));

function canonical(value, active = new WeakSet()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("ONTOLOGY_NON_FINITE_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object" || active.has(value)) throw new TypeError("ONTOLOGY_VALUE_INVALID");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError("ONTOLOGY_ARRAY_INVALID");
      return `[${value.map(item => canonical(item, active)).join(",")}]`;
    }
    if (!plain(value)) throw new TypeError("ONTOLOGY_OBJECT_INVALID");
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key))) throw new TypeError("ONTOLOGY_KEY_INVALID");
    return `{${keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("ONTOLOGY_ACCESSOR_INVALID");
      return `${JSON.stringify(key)}:${canonical(descriptor.value, active)}`;
    }).join(",")}}`;
  } finally { active.delete(value); }
}

function nodeDigest(node) {
  const payload = { ...node };
  delete payload.recordDigest;
  return `sha256:${createHash("sha256").update(canonical(payload), "utf8").digest("hex")}`;
}

function add(errors, condition, code) { if (!condition) errors.push(code); }

function hasFields(object, fields) {
  return plain(object) && fields.every(field => Object.hasOwn(object, field));
}

function validateNode(node, errors) {
  if (!plain(node)) { errors.push("ONTOLOGY_NODE_SHAPE_INVALID"); return; }
  add(errors, typeof node.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(node.id), "ONTOLOGY_NODE_ID_INVALID");
  add(errors, NODE_TYPES.has(node.type), "ONTOLOGY_NODE_TYPE_INVALID");
  add(errors, validTime(node.createdAt), "ONTOLOGY_NODE_TIMESTAMP_INVALID");
  add(errors, plain(node.attributes), "ONTOLOGY_NODE_ATTRIBUTES_INVALID");
  add(errors, Object.keys(node).sort().join("|") === ["attributes", "createdAt", "id", "recordDigest", "type"].join("|"), "ONTOLOGY_NODE_FIELDS_INVALID");
  if (!NODE_TYPES.has(node.type) || !plain(node.attributes)) return;
  const required = NODE_FIELDS[node.type];
  add(errors, hasFields(node.attributes, required), `ONTOLOGY_${node.type}_ATTRIBUTES_INCOMPLETE`);
  add(errors, Object.keys(node.attributes).sort().join("|") === [...required].sort().join("|"), `ONTOLOGY_${node.type}_ATTRIBUTES_UNKNOWN_OR_MISSING`);
  if (Object.hasOwn(node, "recordDigest")) {
    add(errors, DIGEST.test(node.recordDigest) && node.recordDigest === nodeDigest(node), "ONTOLOGY_NODE_DIGEST_INVALID");
  } else errors.push("ONTOLOGY_NODE_DIGEST_REQUIRED");
  const a = node.attributes;
  if (node.type === "SOURCE") {
    add(errors, DIGEST.test(a.sourceDigest), "ONTOLOGY_SOURCE_DIGEST_INVALID");
    add(errors, validTime(a.observedAt), "ONTOLOGY_SOURCE_OBSERVED_AT_INVALID");
    add(errors, ["unknown", "permitted", "restricted", "user_supplied"].includes(a.rightsStatus), "ONTOLOGY_SOURCE_RIGHTS_INVALID");
  }
  if (node.type === "SEGMENT") {
    add(errors, typeof a.sourceId === "string" && Number.isSafeInteger(a.startOffset) && a.startOffset >= 0 &&
      Number.isSafeInteger(a.endOffset) && a.endOffset > a.startOffset && DIGEST.test(a.excerptDigest), "ONTOLOGY_SEGMENT_PROVENANCE_INVALID");
  }
  if (node.type === "CLAIM") {
    add(errors, typeof a.normalizedText === "string" && a.normalizedText.trim().length > 0, "ONTOLOGY_CLAIM_TEXT_INVALID");
    add(errors, ["human", "rules", "model", "parser"].includes(a.extractionMethod), "ONTOLOGY_CLAIM_EXTRACTION_INVALID");
    add(errors, ["UNREVIEWED", "UNDER_REVIEW", "SUPPORTED", "CONTESTED", "REJECTED", "APPROVED", "UNKNOWN"].includes(a.claimStatus), "ONTOLOGY_CLAIM_STATUS_INVALID");
    add(errors, Array.isArray(a.sourceRefs) && a.sourceRefs.length > 0, "ONTOLOGY_CLAIM_SOURCE_REQUIRED");
    add(errors, Array.isArray(a.sourceRefs) && a.sourceRefs.every(ref => plain(ref) &&
      Object.keys(ref).sort().join("|") === ["endOffset", "excerptDigest", "segmentId", "sourceDigest", "startOffset"].join("|") &&
      typeof ref.segmentId === "string" && DIGEST.test(ref.sourceDigest) && DIGEST.test(ref.excerptDigest) &&
      Number.isSafeInteger(ref.startOffset) && ref.startOffset >= 0 &&
      Number.isSafeInteger(ref.endOffset) && ref.endOffset > ref.startOffset), "ONTOLOGY_CLAIM_SOURCE_REFERENCE_INVALID");
    if (a.extractionMethod === "model") add(errors, a.claimStatus === "UNREVIEWED", "ONTOLOGY_MODEL_CLAIM_PROMOTION_FORBIDDEN");
  }
  if (node.type === "EVIDENCE") {
    add(errors, DIGEST.test(a.sourceDigest), "ONTOLOGY_EVIDENCE_SOURCE_DIGEST_INVALID");
    add(errors, ["supports", "contradicts", "contextualizes", "mentions"].includes(a.stance), "ONTOLOGY_EVIDENCE_STANCE_INVALID");
    add(errors, ["UNVERIFIED", "VERIFIED", "INVALID"].includes(a.integrityStatus), "ONTOLOGY_EVIDENCE_INTEGRITY_INVALID");
    add(errors, typeof a.sourceLineageId === "string" && a.sourceLineageId.length > 0 &&
      typeof a.independenceGroupId === "string" && a.independenceGroupId.length > 0, "ONTOLOGY_EVIDENCE_LINEAGE_INVALID");
  }
  if (node.type === "CONTRADICTION") {
    add(errors, Array.isArray(a.claimIds) && a.claimIds.length === 2 && a.claimIds[0] !== a.claimIds[1], "ONTOLOGY_CONTRADICTION_PAIR_INVALID");
    add(errors, typeof a.timeScope === "string" && a.timeScope.length > 0, "ONTOLOGY_CONTRADICTION_TIME_SCOPE_REQUIRED");
    add(errors, ["UNREVIEWED", "CONFIRMED", "DISMISSED"].includes(a.status), "ONTOLOGY_CONTRADICTION_STATUS_INVALID");
  }
  if (node.type === "DECISION") {
    add(errors, ["APPROVE", "REJECT", "CONTEST", "ABSTAIN"].includes(a.decision), "ONTOLOGY_DECISION_INVALID");
    add(errors, typeof a.reason === "string" && a.reason.trim().length > 0, "ONTOLOGY_DECISION_REASON_REQUIRED");
    add(errors, DIGEST.test(a.evidenceSnapshotDigest) && validTime(a.decidedAt), "ONTOLOGY_DECISION_BINDING_INVALID");
  }
  if (node.type === "BRANCH_RUN") add(errors, Number.isSafeInteger(a.rootVersion) && a.rootVersion >= 0 && DIGEST.test(a.rootDigest), "ONTOLOGY_BRANCH_RUN_ROOT_BINDING_INVALID");
  if (node.type === "AGENT") add(errors, typeof a.role === "string" && a.role.length > 0 && plain(a.scope), "ONTOLOGY_AGENT_SCOPE_INVALID");
}

function hasCycle(adjacency) {
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (visit(next)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  for (const id of adjacency.keys()) if (visit(id)) return true;
  return false;
}

/** Validate the versioned KRATT ontology graph; candidates remain distinct from approved knowledge. */
export function validateReflectionOntology(document) {
  const errors = [];
  try {
    add(errors, plain(document) && Array.isArray(document.nodes) && Array.isArray(document.edges) && plain(document.metadata), "ONTOLOGY_ROOT_SHAPE_INVALID");
    if (errors.length) return Object.freeze({ ok: false, errors });
    add(errors, document.metadata.ontologyVersion === KRATT_ONTOLOGY_VERSION, "ONTOLOGY_VERSION_UNSUPPORTED");
    const nodes = new Map();
    for (const node of document.nodes) {
      validateNode(node, errors);
      if (typeof node?.id === "string") {
        if (nodes.has(node.id)) errors.push("ONTOLOGY_NODE_ID_DUPLICATE");
        else nodes.set(node.id, node);
      }
    }
    for (const node of nodes.values()) {
      const a = node.attributes ?? {};
      if (node.type === "SEGMENT" && nodes.get(a.sourceId)?.type !== "SOURCE") errors.push("ONTOLOGY_SEGMENT_SOURCE_NOT_FOUND");
      if (node.type === "EVIDENCE" && nodes.get(a.sourceId)?.type !== "SOURCE") errors.push("ONTOLOGY_EVIDENCE_SOURCE_NOT_FOUND");
      if (node.type === "CLAIM" && Array.isArray(a.sourceRefs) &&
          a.sourceRefs.some(ref => nodes.get(ref.segmentId)?.type !== "SEGMENT")) errors.push("ONTOLOGY_CLAIM_SEGMENT_NOT_FOUND");
      if (node.type === "CONTRADICTION" && Array.isArray(a.claimIds) &&
          a.claimIds.some(id => nodes.get(id)?.type !== "CLAIM")) errors.push("ONTOLOGY_CONTRADICTION_CLAIM_NOT_FOUND");
      if (node.type === "DECISION" && !nodes.has(a.targetId)) errors.push("ONTOLOGY_DECISION_TARGET_NOT_FOUND");
    }
    const edgeIds = new Set(), derived = new Map(), parent = new Map();
    for (const edge of document.edges) {
      if (!plain(edge) || typeof edge.id !== "string" || typeof edge.from !== "string" ||
          typeof edge.to !== "string" || typeof edge.relation !== "string" || !validTime(edge.createdAt) ||
          Object.keys(edge).sort().join("|") !== ["createdAt", "from", "id", "recordDigest", "relation", "to"].join("|")) {
        errors.push("ONTOLOGY_EDGE_SHAPE_INVALID"); continue;
      }
      const edgePayload = { ...edge };
      delete edgePayload.recordDigest;
      if (typeof edge.recordDigest !== "string" || edge.recordDigest !== `sha256:${createHash("sha256").update(canonical(edgePayload), "utf8").digest("hex")}`) {
        errors.push("ONTOLOGY_EDGE_DIGEST_INVALID");
      }
      if (edgeIds.has(edge.id)) errors.push("ONTOLOGY_EDGE_ID_DUPLICATE");
      edgeIds.add(edge.id);
      const from = nodes.get(edge.from), to = nodes.get(edge.to), rule = RELATIONS[edge.relation];
      if (!from || !to || !rule || (rule[0] !== "*" && from.type !== rule[0]) || (rule[1] !== "*" && to.type !== rule[1])) {
        errors.push("ONTOLOGY_EDGE_ENDPOINT_OR_RELATION_INVALID"); continue;
      }
      if (edge.relation === "DERIVED_FROM") {
        if (!derived.has(edge.from)) derived.set(edge.from, []);
        derived.get(edge.from).push(edge.to);
      }
      if (edge.relation === "PARENT_OF") {
        if (!parent.has(edge.from)) parent.set(edge.from, []);
        parent.get(edge.from).push(edge.to);
      }
    }
    if (hasCycle(derived)) errors.push("ONTOLOGY_DERIVATION_CYCLE");
    if (hasCycle(parent)) errors.push("ONTOLOGY_PARENT_CYCLE");
    return Object.freeze({ ok: errors.length === 0, errors: Object.freeze([...new Set(errors)]) });
  } catch {
    return Object.freeze({ ok: false, errors: Object.freeze(["ONTOLOGY_VALIDATION_FAILED"]) });
  }
}

/** Production composition helper: every persisted root version must satisfy the ontology contract. */
export function createOntologyValidatedReflectionRootStore(database, options = {}) {
  const result = validateReflectionOntology(options.initialSnapshot?.document);
  if (!result.ok) throw new TypeError(`KRATT_ONTOLOGY_INITIAL_ROOT_INVALID:${result.errors.join(",")}`);
  return createSqliteReflectionRootStore(database, {
    ...options,
    validateDocument: document => validateReflectionOntology(document).ok,
  });
}


/** Production Telegram composition with ontology validation at every root trust boundary. */
export function createOntologyValidatedTelegramReflectionCasAdapter(options = {}) {
  const result = validateReflectionOntology(options.initialSnapshot?.document);
  if (!result.ok) throw new TypeError(`KRATT_ONTOLOGY_INITIAL_ROOT_INVALID:${result.errors.join(",")}`);
  return createTelegramReflectionCasAdapter({
    ...options,
    validateDocument: document => validateReflectionOntology(document).ok,
  });
}
