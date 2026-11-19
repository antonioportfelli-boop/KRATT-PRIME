import { createHash } from "node:crypto";

export const SEMANTIC_RETRIEVAL_EVAL_SCHEMA = "kratt-semantic-retrieval-eval/v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const QUERY_FIELDS = ["queryId", "queryDigest", "scopeId", "relevantEvidence"];
const REF_FIELDS = ["evidenceId", "sourceId", "artifactDigest", "observedAt", "scopeId"];
const RESULT_FIELDS = ["queryId", "items"];
const THRESHOLD_FIELDS = ["minQueryCount", "minPrecisionAtK", "minRecallAtK", "minMrr", "minVerifiedCoverage",
  "maxUnverifiedRate", "maxScopeViolationRate"];
const verifiedReports = new WeakSet();
const isPlain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, fields) => isPlain(value) && Reflect.ownKeys(value).length === fields.length && fields.every(field => {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return Boolean(descriptor && "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined);
});
const isId = value => typeof value === "string" && ID.test(value);
const isDigest = value => typeof value === "string" && DIGEST.test(value);
const isUtc = value => typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
const hash = value => "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");

function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (!isPlain(value)) throw new TypeError("RETRIEVAL_VALUE_NOT_CANONICAL_JSON");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) throw new TypeError("RETRIEVAL_SYMBOL_KEY_REJECTED");
  return "{" + keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("RETRIEVAL_ACCESSOR_REJECTED");
    return JSON.stringify(key) + ":" + stableJson(descriptor.value);
  }).join(",") + "}";
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validateReference(reference) {
  return exact(reference, REF_FIELDS) && isId(reference.evidenceId) && isId(reference.sourceId) &&
    isDigest(reference.artifactDigest) && isUtc(reference.observedAt) && isId(reference.scopeId);
}

async function verifyReference(verifier, reference, context) {
  try { return await verifier(deepFreeze(structuredClone(reference)), Object.freeze(context)) === true; }
  catch { return false; }
}

function ndcgAtK(relevantRanks, relevantCount, k) {
  let dcg = 0;
  for (const rank of relevantRanks) if (rank <= k) dcg += 1 / Math.log2(rank + 1);
  let ideal = 0;
  for (let rank = 1; rank <= Math.min(relevantCount, k); rank++) ideal += 1 / Math.log2(rank + 1);
  return ideal === 0 ? 0 : dcg / ideal;
}

/**
 * Evaluate a retriever against a labelled, source-backed dataset. Ground-truth and
 * retrieved references must pass the caller's evidence-ledger verifier. Query text is
 * not accepted or stored; callers provide a digest so reports remain metadata-only.
 */
export async function evaluateSemanticRetrieval({ dataset, results, verifyEvidenceRef, k = 5, now = () => new Date().toISOString() } = {}) {
  if (!Array.isArray(dataset) || dataset.length < 1 || dataset.length > 5_000 ||
      !Array.isArray(results) || results.length !== dataset.length || results.length > 5_000 ||
      typeof verifyEvidenceRef !== "function" || !Number.isSafeInteger(k) || k < 1 || k > 100) {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_EVALUATION_INPUT_INVALID" });
  }
  let current;
  try { current = now(); } catch { current = null; }
  if (!isUtc(current)) return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_EVALUATION_CLOCK_INVALID" });
  const nowMs = Date.parse(current);
  const queries = new Map();
  const resultMap = new Map();

  for (const query of dataset) {
    if (!exact(query, QUERY_FIELDS) || !isId(query.queryId) || !isDigest(query.queryDigest) || !isId(query.scopeId) ||
        !Array.isArray(query.relevantEvidence) || query.relevantEvidence.length < 1 || query.relevantEvidence.length > 256 ||
        queries.has(query.queryId)) {
      return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_DATASET_INVALID" });
    }
    const relevantIds = new Set();
    for (const reference of query.relevantEvidence) {
      if (!validateReference(reference) || reference.scopeId !== query.scopeId || relevantIds.has(reference.evidenceId)) {
        return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_LABEL_REFERENCE_INVALID" });
      }
      if (Date.parse(reference.observedAt) > nowMs + 30_000) {
        return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_LABEL_TIME_IN_FUTURE" });
      }
      const valid = await verifyReference(verifyEvidenceRef, reference, { purpose: "GROUND_TRUTH", queryId: query.queryId });
      if (!valid) return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_LABEL_PROVENANCE_REJECTED" });
      relevantIds.add(reference.evidenceId);
    }
    queries.set(query.queryId, { query, relevantIds });
  }

  for (const result of results) {
    if (!exact(result, RESULT_FIELDS) || !isId(result.queryId) || !Array.isArray(result.items) || result.items.length > 256 ||
        !queries.has(result.queryId) || resultMap.has(result.queryId)) {
      return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_RESULT_INVALID" });
    }
    resultMap.set(result.queryId, result);
  }
  if (resultMap.size !== queries.size) return Object.freeze({ ok: false, state: "BLOCKED", reason: "RETRIEVAL_RESULTS_INCOMPLETE" });

  const perQuery = [];
  let retrievedCount = 0;
  let verifiedCount = 0;
  let unverifiedCount = 0;
  let scopeViolationCount = 0;
  let duplicateCount = 0;
  for (const [queryId, entry] of queries) {
    const seen = new Set();
    const rankedSlots = [];
    const result = resultMap.get(queryId);
    retrievedCount += result.items.length;
    for (const reference of result.items) {
      if (!validateReference(reference)) {
        unverifiedCount++;
        rankedSlots.push(null);
        continue;
      }
      if (seen.has(reference.evidenceId)) {
        duplicateCount++;
        rankedSlots.push(null);
        continue;
      }
      seen.add(reference.evidenceId);
      if (reference.scopeId !== entry.query.scopeId) {
        scopeViolationCount++;
        rankedSlots.push(null);
        continue;
      }
      if (Date.parse(reference.observedAt) > nowMs + 30_000) {
        unverifiedCount++;
        rankedSlots.push(null);
        continue;
      }
      const valid = await verifyReference(verifyEvidenceRef, reference, { purpose: "RETRIEVED_RESULT", queryId });
      if (!valid) {
        unverifiedCount++;
        rankedSlots.push(null);
        continue;
      }
      verifiedCount++;
      rankedSlots.push(reference.evidenceId);
    }
    const relevant = entry.relevantIds;
    const relevantRanks = [];
    rankedSlots.forEach((id, index) => { if (id !== null && relevant.has(id)) relevantRanks.push(index + 1); });
    const topKRelevant = relevantRanks.filter(rank => rank <= k).length;
    const firstRelevantRank = relevantRanks.length ? Math.min(...relevantRanks) : null;
    perQuery.push({
      queryId,
      labelledRelevantCount: relevant.size,
      verifiedRetrievedCount: rankedSlots.filter(id => id !== null).length,
      precisionAtK: topKRelevant / k,
      recallAtK: topKRelevant / relevant.size,
      reciprocalRank: firstRelevantRank === null ? 0 : 1 / firstRelevantRank,
      ndcgAtK: ndcgAtK(relevantRanks, relevant.size, k),
      hasVerifiedResult: rankedSlots.some(id => id !== null)
    });
  }
  const mean = field => perQuery.reduce((sum, item) => sum + item[field], 0) / perQuery.length;
  const rejectedCount = unverifiedCount + scopeViolationCount + duplicateCount;
  const datasetDigest = hash(stableJson(dataset));
  const retrievalDigest = hash(stableJson(results));
  const summary = {
    schemaVersion: SEMANTIC_RETRIEVAL_EVAL_SCHEMA,
    queryCount: perQuery.length,
    k,
    precisionAtK: mean("precisionAtK"),
    recallAtK: mean("recallAtK"),
    mrr: mean("reciprocalRank"),
    ndcgAtK: mean("ndcgAtK"),
    verifiedResultCoverage: perQuery.filter(item => item.hasVerifiedResult).length / perQuery.length,
    retrievedCount,
    verifiedCount,
    unverifiedCount,
    scopeViolationCount,
    duplicateCount,
    unverifiedRate: retrievedCount ? rejectedCount / retrievedCount : 0,
    scopeViolationRate: retrievedCount ? scopeViolationCount / retrievedCount : 0,
    datasetDigest,
    retrievalDigest
  };
  const evaluationDigest = hash(stableJson(summary));
  const report = deepFreeze({
    ok: true,
    state: "EVALUATED",
    ...summary,
    evaluationDigest,
    perQuery,
    sourceAuthority: "CALLER_VERIFIED_EVIDENCE_REFERENCES",
    semanticMemoryActivation: false,
    truthPromotion: false
  });
  verifiedReports.add(report);
  return report;
}

/** A quality gate for shadow evaluation only; it never enables writes or truth promotion. */
export function assessSemanticShadowEligibility({ report, thresholds } = {}) {
  const rates = ["minPrecisionAtK", "minRecallAtK", "minMrr", "minVerifiedCoverage", "maxUnverifiedRate", "maxScopeViolationRate"];
  if (!verifiedReports.has(report) || !exact(thresholds, THRESHOLD_FIELDS) ||
      !Number.isSafeInteger(thresholds.minQueryCount) || thresholds.minQueryCount < 1 || thresholds.minQueryCount > 5_000 ||
      !rates.every(key => typeof thresholds[key] === "number" && Number.isFinite(thresholds[key]) && thresholds[key] >= 0 && thresholds[key] <= 1)) {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "SEMANTIC_SHADOW_GATE_INPUT_INVALID", memoryWriteEnabled: false });
  }
  const checks = {
    enoughQueries: report.queryCount >= thresholds.minQueryCount,
    precision: report.precisionAtK >= thresholds.minPrecisionAtK,
    recall: report.recallAtK >= thresholds.minRecallAtK,
    mrr: report.mrr >= thresholds.minMrr,
    coverage: report.verifiedResultCoverage >= thresholds.minVerifiedCoverage,
    unverifiedRate: report.unverifiedRate <= thresholds.maxUnverifiedRate,
    scopeViolationRate: report.scopeViolationRate <= thresholds.maxScopeViolationRate
  };
  const eligible = Object.values(checks).every(Boolean);
  return deepFreeze({
    ok: true,
    state: eligible ? "SHADOW_ELIGIBLE" : "BLOCKED",
    reason: eligible ? "EVALUATION_THRESHOLDS_MET" : "EVALUATION_THRESHOLDS_NOT_MET",
    checks,
    evaluationDigest: report.evaluationDigest,
    shadowOnly: eligible,
    memoryWriteEnabled: false,
    productionActivationAllowed: false,
    truthPromotionAllowed: false,
    dispatch: false
  });
}
