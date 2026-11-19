import { createHash } from "node:crypto";

export const SCALE_OBSERVATION_SCHEMA = "kratt-agent-run-observation/v1";
export const SCALE_REPORT_SCHEMA = "kratt-agent-performance/v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STATUSES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);
const OBSERVATION_FIELDS = [
  "schemaVersion", "observationId", "agentId", "taskId", "environment", "status",
  "startedAt", "finishedAt", "costMicroUsd", "attemptCount", "recoveryCount",
  "queueWaitMs", "queueDepthAtAdmission", "concurrencyAtStart", "sourceDigest"
];
const LIMIT_FIELDS = [
  "minSampleCount", "minSuccessRate", "minSuccessLower95", "maxErrorRate",
  "maxP95LatencyMs", "maxCostPerSuccessMicroUsd", "maxRecoveryAttemptRate",
  "minQueueWaitP95Ms", "minQueueDepthP95", "minConcurrency", "maxConcurrency"
];
const trustedReports = new WeakSet();
const isPlain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, fields) => isPlain(value) && Reflect.ownKeys(value).length === fields.length && fields.every(field => {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return Boolean(descriptor && "value" in descriptor && descriptor.get === undefined && descriptor.set === undefined);
});
const isId = value => typeof value === "string" && ID.test(value);
const isUtc = value => typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
const isDigest = value => typeof value === "string" && DIGEST.test(value);
const hash = value => "sha256:" + createHash("sha256").update(value, "utf8").digest("hex");

function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (!isPlain(value)) throw new TypeError("SCALE_VALUE_NOT_CANONICAL_JSON");
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) throw new TypeError("SCALE_SYMBOL_KEY_REJECTED");
  return "{" + keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("SCALE_ACCESSOR_REJECTED");
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

function normalizeObservation(input) {
  if (!exact(input, OBSERVATION_FIELDS) || input.schemaVersion !== SCALE_OBSERVATION_SCHEMA ||
      !isId(input.observationId) || !isId(input.agentId) || !isId(input.taskId) || !isId(input.environment) ||
      !STATUSES.has(input.status) || !isUtc(input.startedAt) || !isUtc(input.finishedAt) ||
      !Number.isSafeInteger(input.costMicroUsd) || input.costMicroUsd < 0 || input.costMicroUsd > 1_000_000_000_000 ||
      !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 1 || input.attemptCount > 100 ||
      !Number.isSafeInteger(input.recoveryCount) || input.recoveryCount < 0 || input.recoveryCount > input.attemptCount - 1 ||
      !Number.isSafeInteger(input.queueWaitMs) || input.queueWaitMs < 0 || input.queueWaitMs > 86_400_000 ||
      !Number.isSafeInteger(input.queueDepthAtAdmission) || input.queueDepthAtAdmission < 0 || input.queueDepthAtAdmission > 1_000_000 ||
      !Number.isSafeInteger(input.concurrencyAtStart) || input.concurrencyAtStart < 1 || input.concurrencyAtStart > 100_000 ||
      !isDigest(input.sourceDigest)) return null;
  const started = Date.parse(input.startedAt);
  const finished = Date.parse(input.finishedAt);
  if (finished <= started || finished - started > 7 * 24 * 60 * 60 * 1_000) return null;
  return Object.freeze({
    schemaVersion: SCALE_OBSERVATION_SCHEMA,
    observationId: input.observationId,
    agentId: input.agentId,
    taskId: input.taskId,
    environment: input.environment,
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: finished - started,
    costMicroUsd: input.costMicroUsd,
    attemptCount: input.attemptCount,
    recoveryCount: input.recoveryCount,
    queueWaitMs: input.queueWaitMs,
    queueDepthAtAdmission: input.queueDepthAtAdmission,
    concurrencyAtStart: input.concurrencyAtStart,
    sourceDigest: input.sourceDigest
  });
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

function wilsonLowerBound(successes, total, z = 1.959963984540054) {
  if (!total) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - spread) / denominator);
}

/**
 * Build a performance report from source-verified run observations.
 * The verifier must bind each observation to a trusted runtime/ECK record. This module
 * computes descriptive metrics only; it never starts, stops, or reconfigures workers.
 */
export async function summarizeAgentRuns({ observations, verifyObservation, maxObservations = 50_000 } = {}) {
  if (!Array.isArray(observations) || observations.length < 1 || observations.length > maxObservations ||
      !Number.isInteger(maxObservations) || maxObservations < 1 || maxObservations > 100_000 ||
      typeof verifyObservation !== "function") {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_OBSERVATION_INPUT_INVALID" });
  }

  const normalized = [];
  const ids = new Set();
  for (const input of observations) {
    const item = normalizeObservation(input);
    if (!item) return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_OBSERVATION_INVALID" });
    if (ids.has(item.observationId)) return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_OBSERVATION_DUPLICATE" });
    ids.add(item.observationId);
    let verified = false;
    try {
      const digest = hash(stableJson(item));
      verified = await verifyObservation(deepFreeze(structuredClone(item)), digest) === true;
    } catch { verified = false; }
    if (!verified) return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_OBSERVATION_PROVENANCE_REJECTED" });
    normalized.push(item);
  }

  const first = normalized[0];
  if (normalized.some(item => item.agentId !== first.agentId || item.environment !== first.environment ||
      item.concurrencyAtStart !== first.concurrencyAtStart)) {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_SAMPLE_COHORT_MISMATCH" });
  }

  const ordered = [...normalized].sort((a, b) => a.observationId.localeCompare(b.observationId));
  const sampleSetDigest = hash(stableJson(ordered));
  const durations = normalized.map(item => item.durationMs);
  const costs = normalized.map(item => item.costMicroUsd);
  const queueWaits = normalized.map(item => item.queueWaitMs);
  const queueDepths = normalized.map(item => item.queueDepthAtAdmission);
  const attempts = normalized.reduce((sum, item) => sum + item.attemptCount, 0);
  const recoveries = normalized.reduce((sum, item) => sum + item.recoveryCount, 0);
  const successes = normalized.filter(item => item.status === "SUCCEEDED").length;
  const failures = normalized.filter(item => item.status === "FAILED").length;
  const timeouts = normalized.filter(item => item.status === "TIMED_OUT").length;
  const cancelled = normalized.filter(item => item.status === "CANCELLED").length;
  const earliestStart = Math.min(...normalized.map(item => Date.parse(item.startedAt)));
  const latestFinish = Math.max(...normalized.map(item => Date.parse(item.finishedAt)));
  const measurementSpanMs = latestFinish - earliestStart;
  if (!Number.isFinite(measurementSpanMs) || measurementSpanMs <= 0) {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_MEASUREMENT_WINDOW_INVALID" });
  }
  const totalCostMicroUsd = costs.reduce((sum, value) => sum + value, 0);
  const metrics = {
    sampleCount: normalized.length,
    successCount: successes,
    failureCount: failures,
    timeoutCount: timeouts,
    cancelledCount: cancelled,
    successRate: successes / normalized.length,
    errorRate: (failures + timeouts) / normalized.length,
    successRateLower95: wilsonLowerBound(successes, normalized.length),
    p50LatencyMs: percentile(durations, 0.50),
    p95LatencyMs: percentile(durations, 0.95),
    meanLatencyMs: durations.reduce((sum, value) => sum + value, 0) / durations.length,
    p95CostMicroUsd: percentile(costs, 0.95),
    meanCostMicroUsd: totalCostMicroUsd / normalized.length,
    costPerSuccessMicroUsd: successes ? totalCostMicroUsd / successes : null,
    retryRunRate: normalized.filter(item => item.attemptCount > 1).length / normalized.length,
    recoveryAttemptRate: attempts ? recoveries / attempts : 0,
    p95QueueWaitMs: percentile(queueWaits, 0.95),
    p95QueueDepth: percentile(queueDepths, 0.95),
    meanQueueDepth: queueDepths.reduce((sum, value) => sum + value, 0) / queueDepths.length,
    throughputPerMinute: normalized.length / (measurementSpanMs / 60_000),
    measurementSpanMs,
    concurrencyAtStart: first.concurrencyAtStart
  };
  const report = deepFreeze({
    ok: true,
    state: "MEASURED",
    schemaVersion: SCALE_REPORT_SCHEMA,
    agentId: first.agentId,
    environment: first.environment,
    metrics,
    provenance: {
      verifiedObservationCount: normalized.length,
      sourceDigestCount: new Set(normalized.map(item => item.sourceDigest)).size,
      sampleSetDigest
    },
    interpretation: "DESCRIPTIVE_ONLY",
    scalingApplied: false
  });
  trustedReports.add(report);
  return report;
}

function validateLimits(limits) {
  if (!exact(limits, LIMIT_FIELDS) || !Number.isInteger(limits.minSampleCount) || limits.minSampleCount < 1 || limits.minSampleCount > 100_000 ||
      !["minSuccessRate", "minSuccessLower95", "maxErrorRate", "maxRecoveryAttemptRate"].every(key =>
        typeof limits[key] === "number" && Number.isFinite(limits[key]) && limits[key] >= 0 && limits[key] <= 1) ||
      !Number.isSafeInteger(limits.maxP95LatencyMs) || limits.maxP95LatencyMs < 1 ||
      !Number.isSafeInteger(limits.maxCostPerSuccessMicroUsd) || limits.maxCostPerSuccessMicroUsd < 0 ||
      !Number.isSafeInteger(limits.minQueueWaitP95Ms) || limits.minQueueWaitP95Ms < 1 ||
      !Number.isSafeInteger(limits.minQueueDepthP95) || limits.minQueueDepthP95 < 1 ||
      !Number.isSafeInteger(limits.minConcurrency) || limits.minConcurrency < 1 ||
      !Number.isSafeInteger(limits.maxConcurrency) || limits.maxConcurrency < limits.minConcurrency || limits.maxConcurrency > 100_000) return false;
  return true;
}

/**
 * Produce one bounded scale proposal. Scaling up additionally requires measured queue
 * pressure; good latency/success alone is not evidence of unmet demand. The proposal
 * is advisory and cannot modify the worker pool.
 */
export function proposeAgentScale({ report, currentConcurrency, limits } = {}) {
  if (!trustedReports.has(report) || !Number.isSafeInteger(currentConcurrency) || currentConcurrency < 1 ||
      !validateLimits(limits) || currentConcurrency < limits.minConcurrency || currentConcurrency > limits.maxConcurrency ||
      report.metrics.concurrencyAtStart !== currentConcurrency) {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_PROPOSAL_INPUT_INVALID", dispatch: false, applied: false });
  }
  const metrics = report.metrics;
  const reasonCodes = [];
  if (metrics.sampleCount < limits.minSampleCount) reasonCodes.push("MINIMUM_SAMPLE_COUNT_NOT_MET");
  if (metrics.successRate < limits.minSuccessRate) reasonCodes.push("SUCCESS_RATE_BELOW_FLOOR");
  if (metrics.successRateLower95 < limits.minSuccessLower95) reasonCodes.push("SUCCESS_CONFIDENCE_BOUND_BELOW_FLOOR");
  if (metrics.errorRate > limits.maxErrorRate) reasonCodes.push("ERROR_RATE_ABOVE_CEILING");
  if (metrics.p95LatencyMs > limits.maxP95LatencyMs) reasonCodes.push("P95_LATENCY_ABOVE_CEILING");
  if (metrics.costPerSuccessMicroUsd === null || metrics.costPerSuccessMicroUsd > limits.maxCostPerSuccessMicroUsd) {
    reasonCodes.push("COST_PER_SUCCESS_ABOVE_CEILING");
  }
  if (metrics.recoveryAttemptRate > limits.maxRecoveryAttemptRate) reasonCodes.push("RECOVERY_RATE_ABOVE_CEILING");

  let recommendation = "HOLD";
  let targetConcurrency = currentConcurrency;
  let state = "PROPOSAL_ONLY";
  if (metrics.sampleCount < limits.minSampleCount) {
    state = "INSUFFICIENT_EVIDENCE";
  } else if (reasonCodes.length > 0) {
    if (currentConcurrency > limits.minConcurrency) {
      recommendation = "DECREASE";
      targetConcurrency = Math.max(limits.minConcurrency, currentConcurrency - 1);
      reasonCodes.push("BOUNDED_CAPACITY_REDUCTION_PROPOSED");
    } else {
      state = "GUARDRAIL_BREACH_AT_MINIMUM";
      reasonCodes.push("CAPACITY_ALREADY_AT_MINIMUM");
    }
  } else if (metrics.p95QueueWaitMs >= limits.minQueueWaitP95Ms &&
      metrics.p95QueueDepth >= limits.minQueueDepthP95 && currentConcurrency < limits.maxConcurrency) {
    recommendation = "INCREASE";
    targetConcurrency = currentConcurrency + 1;
    reasonCodes.push("MEASURED_QUEUE_PRESSURE_SUPPORTS_ONE_STEP_INCREASE");
  } else {
    reasonCodes.push("NO_VERIFIED_CAPACITY_PRESSURE_FOR_SCALE_UP");
  }

  const proposalBasis = {
    sampleSetDigest: report.provenance.sampleSetDigest,
    currentConcurrency,
    targetConcurrency,
    recommendation,
    reasonCodes
  };
  return deepFreeze({
    ok: true,
    state,
    schemaVersion: "kratt-agent-scale-proposal/v1",
    proposalId: "scale-" + hash(stableJson(proposalBasis)).slice(7, 39),
    agentId: report.agentId,
    environment: report.environment,
    recommendation,
    currentConcurrency,
    proposedConcurrency: targetConcurrency,
    reasonCodes,
    sampleCount: metrics.sampleCount,
    sampleSetDigest: report.provenance.sampleSetDigest,
    metrics: structuredClone(metrics),
    policyApprovalRequired: true,
    dispatch: false,
    applied: false,
    executionStarted: false
  });
}

/** Compare two verified cohorts without converting the delta into a quality claim. */
export function compareScaleAssessments({ baseline, candidate } = {}) {
  if (!trustedReports.has(baseline) || !trustedReports.has(candidate) || baseline.agentId !== candidate.agentId ||
      baseline.environment !== candidate.environment) {
    return Object.freeze({ ok: false, state: "BLOCKED", reason: "SCALE_COMPARISON_INPUT_INVALID" });
  }
  const delta = {
    successRate: candidate.metrics.successRate - baseline.metrics.successRate,
    p95LatencyMs: candidate.metrics.p95LatencyMs - baseline.metrics.p95LatencyMs,
    costPerSuccessMicroUsd: baseline.metrics.costPerSuccessMicroUsd === null || candidate.metrics.costPerSuccessMicroUsd === null
      ? null : candidate.metrics.costPerSuccessMicroUsd - baseline.metrics.costPerSuccessMicroUsd,
    recoveryAttemptRate: candidate.metrics.recoveryAttemptRate - baseline.metrics.recoveryAttemptRate,
    throughputPerMinute: candidate.metrics.throughputPerMinute - baseline.metrics.throughputPerMinute
  };
  return deepFreeze({
    ok: true,
    state: "COMPARED",
    schemaVersion: "kratt-agent-scale-comparison/v1",
    agentId: baseline.agentId,
    environment: baseline.environment,
    baselineDigest: baseline.provenance.sampleSetDigest,
    candidateDigest: candidate.provenance.sampleSetDigest,
    baselineSampleCount: baseline.metrics.sampleCount,
    candidateSampleCount: candidate.metrics.sampleCount,
    delta,
    interpretation: "DESCRIPTIVE_ONLY",
    releaseDecision: "NOT_MADE",
    scalingApplied: false
  });
}
