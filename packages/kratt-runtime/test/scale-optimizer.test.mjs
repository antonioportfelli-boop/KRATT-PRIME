import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  SCALE_OBSERVATION_SCHEMA,
  compareScaleAssessments,
  proposeAgentScale,
  summarizeAgentRuns
} from "../src/scale-optimizer.mjs";

const at = (offsetMs = 0) => new Date(Date.parse("2026-11-19T10:00:00.000Z") + offsetMs).toISOString();
const digest = value => "sha256:" + createHash("sha256").update(value).digest("hex");
function observation(index, overrides = {}) {
  const started = 1_000 + index * 2_000;
  const { durationMs = 10_000, ...recordOverrides } = overrides;
  const duration = durationMs;
  return {
    schemaVersion: SCALE_OBSERVATION_SCHEMA,
    observationId: "obs-" + index,
    agentId: "agent-research-1",
    taskId: "task-" + index,
    environment: "staging-canary",
    status: "SUCCEEDED",
    startedAt: at(started),
    finishedAt: at(started + duration),
    costMicroUsd: 1_000,
    attemptCount: 1,
    recoveryCount: 0,
    queueWaitMs: 1_000,
    queueDepthAtAdmission: 8,
    concurrencyAtStart: 2,
    sourceDigest: digest("source-" + index),
    ...recordOverrides
  };
}
const verify = async (record, recordDigest) => recordDigest === digest(JSON.stringify(record));
const limits = overrides => ({
  minSampleCount: 10,
  minSuccessRate: 0.9,
  minSuccessLower95: 0.65,
  maxErrorRate: 0.1,
  maxP95LatencyMs: 30_000,
  maxCostPerSuccessMicroUsd: 5_000,
  maxRecoveryAttemptRate: 0.2,
  minQueueWaitP95Ms: 500,
  minQueueDepthP95: 5,
  minConcurrency: 1,
  maxConcurrency: 8,
  ...overrides
});

async function measured(overrides = [], count = 20) {
  const items = Array.from({ length: count }, (_, index) => observation(index, overrides[index] ?? {}));
  return summarizeAgentRuns({ observations: items, verifyObservation: async (_record, recordDigest) => typeof recordDigest === "string" });
}

test("creates deterministic, source-verified performance metrics", async () => {
  const runs = Array.from({ length: 20 }, (_, index) => observation(index));
  const report = await summarizeAgentRuns({ observations: runs, verifyObservation: async (_record, recordDigest) => recordDigest.startsWith("sha256:") });
  assert.equal(report.ok, true);
  assert.equal(report.state, "MEASURED");
  assert.equal(report.schemaVersion, "kratt-agent-performance/v1");
  assert.equal(report.metrics.sampleCount, 20);
  assert.equal(report.metrics.successRate, 1);
  assert.equal(report.metrics.p95LatencyMs, 10_000);
  assert.equal(report.metrics.costPerSuccessMicroUsd, 1_000);
  assert.equal(report.provenance.verifiedObservationCount, 20);
  assert.equal(report.scalingApplied, false);
  assert.equal(Object.isFrozen(report.metrics), true);
});

test("blocks unverified, duplicate, malformed and mixed-cohort observations", async () => {
  const runs = [observation(1), observation(2)];
  assert.equal((await summarizeAgentRuns({ observations: runs, verifyObservation: async () => false })).reason,
    "SCALE_OBSERVATION_PROVENANCE_REJECTED");
  assert.equal((await summarizeAgentRuns({ observations: [runs[0], runs[0]], verifyObservation: async () => true })).reason,
    "SCALE_OBSERVATION_DUPLICATE");
  assert.equal((await summarizeAgentRuns({ observations: [{ ...runs[0], shell: "yes" }], verifyObservation: async () => true })).reason,
    "SCALE_OBSERVATION_INVALID");
  assert.equal((await summarizeAgentRuns({ observations: [runs[0], observation(3, { concurrencyAtStart: 3 })], verifyObservation: async () => true })).reason,
    "SCALE_SAMPLE_COHORT_MISMATCH");
});

test("refuses to scale up without adequate sample size", async () => {
  const report = await measured([], 5);
  const proposal = proposeAgentScale({ report, currentConcurrency: 2, limits: limits() });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.state, "INSUFFICIENT_EVIDENCE");
  assert.equal(proposal.recommendation, "HOLD");
  assert.equal(proposal.proposedConcurrency, 2);
  assert.equal(proposal.applied, false);
  assert.equal(proposal.dispatch, false);
});

test("proposes one bounded increase only with measured queue pressure and healthy guardrails", async () => {
  const report = await measured([], 20);
  const proposal = proposeAgentScale({ report, currentConcurrency: 2, limits: limits() });
  assert.equal(proposal.state, "PROPOSAL_ONLY");
  assert.equal(proposal.recommendation, "INCREASE");
  assert.equal(proposal.proposedConcurrency, 3);
  assert.ok(proposal.reasonCodes.includes("MEASURED_QUEUE_PRESSURE_SUPPORTS_ONE_STEP_INCREASE"));
  assert.equal(proposal.policyApprovalRequired, true);
  assert.equal(proposal.dispatch, false);
  assert.equal(proposal.applied, false);
  assert.equal(proposal.executionStarted, false);
});

test("holds capacity when good performance has no measured queue pressure", async () => {
  const overrides = Array.from({ length: 20 }, () => ({ queueWaitMs: 0, queueDepthAtAdmission: 0 }));
  const report = await measured(overrides, 20);
  const proposal = proposeAgentScale({ report, currentConcurrency: 2, limits: limits() });
  assert.equal(proposal.recommendation, "HOLD");
  assert.equal(proposal.proposedConcurrency, 2);
  assert.ok(proposal.reasonCodes.includes("NO_VERIFIED_CAPACITY_PRESSURE_FOR_SCALE_UP"));
});

test("proposes a one-step reduction when measured reliability breaches an operator limit", async () => {
  const overrides = Array.from({ length: 20 }, (_, index) => index < 6 ? { status: "FAILED" } : {});
  const report = await measured(overrides, 20);
  const proposal = proposeAgentScale({ report, currentConcurrency: 2, limits: limits() });
  assert.equal(proposal.recommendation, "DECREASE");
  assert.equal(proposal.proposedConcurrency, 1);
  assert.ok(proposal.reasonCodes.includes("SUCCESS_RATE_BELOW_FLOOR"));
  assert.equal(proposal.applied, false);
});

test("requires exact limits and an assessment produced by the trusted summarizer", async () => {
  const forged = { ok: true, metrics: { concurrencyAtStart: 2 } };
  assert.equal(proposeAgentScale({ report: forged, currentConcurrency: 2, limits: limits() }).reason,
    "SCALE_PROPOSAL_INPUT_INVALID");
  const report = await measured([], 20);
  assert.equal(proposeAgentScale({ report, currentConcurrency: 2, limits: { ...limits(), surprise: true } }).reason,
    "SCALE_PROPOSAL_INPUT_INVALID");
});

test("compares verified cohorts descriptively without issuing a release decision", async () => {
  const baseline = await measured(Array.from({ length: 20 }, () => ({ durationMs: 12_000, costMicroUsd: 1_200 })), 20);
  const candidate = await measured([], 20);
  const result = compareScaleAssessments({ baseline, candidate });
  assert.equal(result.ok, true);
  assert.equal(result.state, "COMPARED");
  assert.equal(result.delta.p95LatencyMs, -2_000);
  assert.equal(result.delta.costPerSuccessMicroUsd, -200);
  assert.equal(result.interpretation, "DESCRIPTIVE_ONLY");
  assert.equal(result.releaseDecision, "NOT_MADE");
  assert.equal(result.scalingApplied, false);
});
