import { performance } from "node:perf_hooks";
import { digestCanonicalRequest } from "../src/canonical-request.mjs";

const iterations = Number(process.env.KRATT_BENCH_ITERATIONS ?? 20_000);
if (!Number.isSafeInteger(iterations) || iterations < 100 || iterations > 1_000_000) {
  throw new Error("KRATT_BENCH_ITERATIONS must be an integer between 100 and 1000000");
}

const sample = Object.freeze({
  actor: "agent-benchmark",
  action: "repository.read",
  target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
  provider: "github",
  policy_version: "policy-2026-11",
  constraints: { branch: "feature/benchmark", path: "packages/kratt-core/src/policy.mjs" },
  evidence: Array.from({ length: 8 }, (_, index) => ({
    evidence_id: `evidence-${index}`,
    result: "VERIFIED",
    digest: `sha256:${String(index).padStart(64, "0")}`,
  })),
});

const durations = [];
let digestSink = "";
const warmup = Math.min(2_000, Math.floor(iterations / 5));
for (let index = 0; index < warmup; index += 1) {
  digestSink = digestCanonicalRequest(sample).digest;
}
for (let index = 0; index < iterations; index += 1) {
  const started = performance.now();
  digestSink = digestCanonicalRequest(sample).digest;
  durations.push(performance.now() - started);
}
durations.sort((a, b) => a - b);
const percentile = p => durations[Math.min(durations.length - 1, Math.floor((durations.length - 1) * p))];
const totalMs = durations.reduce((sum, value) => sum + value, 0);
const result = {
  benchmark: "kratt.canonical_request.sha256",
  iterations,
  workload: {
    evidenceRecords: sample.evidence.length,
    payloadBytesApprox: Buffer.byteLength(JSON.stringify(sample)),
  },
  durationMs: {
    p50: percentile(0.50),
    p95: percentile(0.95),
    p99: percentile(0.99),
    mean: totalMs / durations.length,
  },
  usefulOperationsPerSecond: totalMs > 0 ? iterations / (totalMs / 1000) : null,
  digest: digestSink,
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  note: "Microbenchmark only; run on controlled hardware and compare against a baseline commit.",
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
