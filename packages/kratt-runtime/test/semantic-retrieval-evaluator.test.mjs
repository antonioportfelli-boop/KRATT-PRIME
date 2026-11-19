import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  assessSemanticShadowEligibility,
  evaluateSemanticRetrieval
} from "../src/semantic-retrieval-evaluator.mjs";

const at = "2026-11-19T10:00:00.000Z";
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const ref = (evidenceId, overrides = {}) => ({
  evidenceId,
  sourceId: "source-" + evidenceId,
  artifactDigest: digest("artifact-" + evidenceId),
  observedAt: at,
  scopeId: "root-alpha",
  ...overrides
});
const dataset = [{
  queryId: "query-1",
  queryDigest: digest("query text is intentionally not stored"),
  scopeId: "root-alpha",
  relevantEvidence: [ref("evidence-a"), ref("evidence-b")]
}];
const thresholds = overrides => ({
  minQueryCount: 1,
  minPrecisionAtK: 0.8,
  minRecallAtK: 0.8,
  minMrr: 0.8,
  minVerifiedCoverage: 1,
  maxUnverifiedRate: 0.05,
  maxScopeViolationRate: 0,
  ...overrides
});
const verifyAll = async () => true;

test("evaluates source-verified retrieval using precision, recall, MRR and nDCG", async () => {
  const report = await evaluateSemanticRetrieval({
    dataset,
    results: [{ queryId: "query-1", items: [ref("evidence-b"), ref("evidence-a"), ref("irrelevant")] }],
    verifyEvidenceRef: verifyAll,
    k: 2,
    now: () => at
  });
  assert.equal(report.ok, true);
  assert.equal(report.state, "EVALUATED");
  assert.equal(report.precisionAtK, 1);
  assert.equal(report.recallAtK, 1);
  assert.equal(report.mrr, 1);
  assert.equal(report.ndcgAtK, 1);
  assert.equal(report.verifiedResultCoverage, 1);
  assert.equal(report.semanticMemoryActivation, false);
  assert.equal(report.truthPromotion, false);
  assert.equal(Object.isFrozen(report), true);
});

test("unverified retrieved evidence is counted as contamination and not scored relevant", async () => {
  const report = await evaluateSemanticRetrieval({
    dataset,
    results: [{ queryId: "query-1", items: [ref("evidence-a"), ref("evidence-b"), ref("bad-source")] }],
    verifyEvidenceRef: async (reference, context) => context.purpose === "GROUND_TRUTH" || reference.evidenceId !== "evidence-a",
    k: 2,
    now: () => at
  });
  assert.equal(report.verifiedCount, 2);
  assert.equal(report.unverifiedCount, 1);
  assert.equal(report.unverifiedRate, 1 / 3);
  assert.equal(report.recallAtK, 0.5);
});

test("scope mismatch, duplicate hits and malformed result references are not promoted", async () => {
  const report = await evaluateSemanticRetrieval({
    dataset,
    results: [{ queryId: "query-1", items: [
      ref("evidence-a", { scopeId: "other-root" }),
      ref("evidence-b"),
      ref("evidence-b"),
      { evidenceId: "broken" }
    ] }],
    verifyEvidenceRef: verifyAll,
    k: 2,
    now: () => at
  });
  assert.equal(report.scopeViolationCount, 1);
  assert.equal(report.duplicateCount, 1);
  assert.equal(report.unverifiedCount, 1);
  assert.equal(report.recallAtK, 0.5);
});

test("requires provenance verification for every ground-truth label", async () => {
  const result = await evaluateSemanticRetrieval({
    dataset,
    results: [{ queryId: "query-1", items: [] }],
    verifyEvidenceRef: async (_reference, context) => context.purpose !== "GROUND_TRUTH",
    now: () => at
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "RETRIEVAL_LABEL_PROVENANCE_REJECTED");
});

test("rejects incomplete, duplicate and out-of-scope evaluation inputs", async () => {
  const incomplete = await evaluateSemanticRetrieval({ dataset, results: [], verifyEvidenceRef: verifyAll, now: () => at });
  assert.equal(incomplete.reason, "RETRIEVAL_EVALUATION_INPUT_INVALID");
  const duplicate = await evaluateSemanticRetrieval({
    dataset: [dataset[0], dataset[0]],
    results: [{ queryId: "query-1", items: [] }, { queryId: "query-1", items: [] }],
    verifyEvidenceRef: verifyAll, now: () => at
  });
  assert.equal(duplicate.reason, "RETRIEVAL_DATASET_INVALID");
  const futureLabel = [{ ...dataset[0], relevantEvidence: [ref("evidence-a", { observedAt: "2026-11-19T10:01:00.000Z" })] }];
  const future = await evaluateSemanticRetrieval({ dataset: futureLabel, results: [{ queryId: "query-1", items: [] }], verifyEvidenceRef: verifyAll, now: () => at });
  assert.equal(future.reason, "RETRIEVAL_LABEL_TIME_IN_FUTURE");
});

test("shadow gate is proposal-only and never enables semantic memory writes", async () => {
  const report = await evaluateSemanticRetrieval({
    dataset,
    results: [{ queryId: "query-1", items: [ref("evidence-a"), ref("evidence-b")] }],
    verifyEvidenceRef: verifyAll,
    k: 2,
    now: () => at
  });
  const gate = assessSemanticShadowEligibility({ report, thresholds: thresholds() });
  assert.equal(gate.ok, true);
  assert.equal(gate.state, "SHADOW_ELIGIBLE");
  assert.equal(gate.shadowOnly, true);
  assert.equal(gate.memoryWriteEnabled, false);
  assert.equal(gate.productionActivationAllowed, false);
  assert.equal(gate.truthPromotionAllowed, false);
  assert.equal(gate.dispatch, false);
});

test("shadow gate blocks quality regressions and forged reports", async () => {
  const report = await evaluateSemanticRetrieval({
    dataset,
    results: [{ queryId: "query-1", items: [ref("evidence-a")] }],
    verifyEvidenceRef: verifyAll,
    k: 5,
    now: () => at
  });
  const gate = assessSemanticShadowEligibility({ report, thresholds: thresholds({ minRecallAtK: 1 }) });
  assert.equal(gate.state, "BLOCKED");
  assert.equal(gate.memoryWriteEnabled, false);
  const forged = assessSemanticShadowEligibility({ report: { ...report }, thresholds: thresholds() });
  assert.equal(forged.ok, false);
  assert.equal(forged.memoryWriteEnabled, false);
});
