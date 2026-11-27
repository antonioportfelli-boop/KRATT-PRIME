import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus, totalmem } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { createAuthorizedDispatchRuntime } from "../src/authorized-dispatch.mjs";
import { canonicalTaskDigest, canonicalApprovalPayload } from "../src/policy.mjs";
import { canonicalizeEvidencePayload } from "../src/evidence-integrity.mjs";
import { validateTaskEnvelope, KRATT_SCHEMA_VERSION } from "../src/contracts.mjs";
import { createTrustedAuthorizationRuntime } from "../src/trusted-runtime.mjs";
import { createSqliteCommandStore } from "../src/sqlite-command-store.mjs";
import { createSqliteNonceStore } from "../src/sqlite-nonce-store.mjs";
import { createSecurityTelemetry } from "../src/security-telemetry.mjs";
import { canonicalizeRequest } from "../src/canonical-request.mjs";

const ALLOWED_EVIDENCE = [1, 8, 32, 128];
const ALLOWED_CONCURRENCY = [1, 4, 16, 64];
const iterations = Number(process.env.KRATT_BENCH_ITERATIONS ?? 100);
const warmup = Number(process.env.KRATT_BENCH_WARMUP ?? 10);

function parseProfile(value, allowed, fallback) {
  if (!value) return fallback;
  const values = value.split(",").map(item => Number(item.trim()));
  if (!values.length || values.some(item => !allowed.includes(item)) || new Set(values).size !== values.length) {
    throw new Error("Invalid benchmark profile: " + value);
  }
  return values;
}

if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 10_000) {
  throw new Error("KRATT_BENCH_ITERATIONS must be an integer from 1 to 10000");
}
if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > 2_000) {
  throw new Error("KRATT_BENCH_WARMUP must be an integer from 0 to 2000");
}

const evidenceCounts = parseProfile(process.env.KRATT_BENCH_EVIDENCE_COUNTS, ALLOWED_EVIDENCE, ALLOWED_EVIDENCE);
const concurrencyLevels = parseProfile(process.env.KRATT_BENCH_CONCURRENCY, ALLOWED_CONCURRENCY, ALLOWED_CONCURRENCY);
const outputDirectory = process.env.KRATT_BENCH_OUTPUT_DIR ?? join(process.cwd(), "benchmarks", "results");
mkdirSync(outputDirectory, { recursive: true });

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  if (!values.length) return { count: 0, p50: null, p95: null, p99: null, mean: null };
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    mean: total / values.length,
  };
}

function isoNow() {
  return new Date().toISOString();
}

function createEvidenceSet(count, keyPair) {
  const records = [];
  for (let index = 0; index < count; index += 1) {
    const unsigned = {
      schema_version: KRATT_SCHEMA_VERSION,
      evidence_id: "bench-evidence-" + index,
      subject: "KRATT-PRIME",
      claim_type: "TESTS_PASSED",
      source: {
        source_type: "github",
        source_id: "bench-run-" + index,
        revision: "a".repeat(40),
      },
      observed_at: isoNow(),
      verification_method: "ed25519-bench-attestation",
      result: "VERIFIED",
      artifact_digest: null,
      metadata: { attestation_key_id: "bench-evidence-key-v1" },
    };
    const payload = canonicalizeEvidencePayload(unsigned);
    const signature = sign(null, Buffer.from(payload, "utf8"), keyPair.privateKey).toString("base64url");
    records.push(Object.freeze({
      ...unsigned,
      metadata: Object.freeze({ ...unsigned.metadata, attestation_signature: signature }),
    }));
  }
  return Object.freeze(records);
}

function makeTask(taskId, createdAt) {
  return {
    schema_version: KRATT_SCHEMA_VERSION,
    task_id: taskId,
    actor: "bench-operator",
    action: "repo.write",
    target: { resource_type: "repository", resource_id: "KRATT-PRIME" },
    constraints: { provider: "bench-provider" },
    required_evidence: [{
      claim_type: "TESTS_PASSED",
      subject: "KRATT-PRIME",
      required: true,
      revision: null,
    }],
    created_at: createdAt,
    requested_authority: ["repository.write"],
    status: "PENDING",
  };
}

function makeApproval(task, index, privateKey) {
  const issuedAt = isoNow();
  const unsigned = {
    schema_version: KRATT_SCHEMA_VERSION,
    approval_id: "bench-approval-" + index,
    task_id: task.task_id,
    actor: task.actor,
    provider: "bench-provider",
    operation: task.action,
    target: task.target,
    request_digest: canonicalTaskDigest(task),
    key_id: "bench-approval-key-v1",
    nonce: "bench-nonce-" + index,
    issued_at: issuedAt,
    expires_at: new Date(Date.now() + 240_000).toISOString(),
    decision: "APPROVE",
    approved_by: "bench-security-owner",
    authority: "repository.approve",
    signature: "pending",
  };
  const payload = canonicalApprovalPayload(unsigned);
  if (typeof payload !== "string") throw new Error("BENCH_APPROVAL_CANONICALIZATION_FAILED");
  return Object.freeze({
    ...unsigned,
    signature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64url"),
  });
}

async function runBatch(runtime, inputs, concurrency, captureLatencies) {
  let next = 0;
  let successes = 0;
  let errors = 0;
  const errorKinds = {};
  const latencies = [];

  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= inputs.length) return;
      const input = inputs[index];
      const startedAt = performance.now();
      try {
        const result = await runtime.execute(input);
        const duration = performance.now() - startedAt;
        if (captureLatencies) latencies.push(duration);
        if (result?.status === "COMPLETED") {
          successes += 1;
        } else {
          errors += 1;
          const reason = typeof result?.reason === "string" ? result.reason : "UNKNOWN_RESULT";
          errorKinds[reason] = (errorKinds[reason] ?? 0) + 1;
        }
      } catch (error) {
        if (captureLatencies) latencies.push(performance.now() - startedAt);
        errors += 1;
        const reason = typeof error?.code === "string" ? error.code : "UNEXPECTED_EXCEPTION";
        errorKinds[reason] = (errorKinds[reason] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker()));
  return { successes, errors, errorKinds, latencies };
}

async function executeScenario(evidenceCount, concurrency) {
  const tempDirectory = mkdtempSync(join(tmpdir(), "kratt-wave4-1-bench-"));
  const dbPath = join(tempDirectory, "runtime.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");

  let collectStages = false;
  const stageSamples = new Map();
  function recordStage(name, durationMs) {
    if (!collectStages || !Number.isFinite(durationMs) || durationMs < 0) return;
    const samples = stageSamples.get(name) ?? [];
    samples.push(durationMs);
    stageSamples.set(name, samples);
  }
  function measuredSync(name, operation) {
    return (...args) => {
      const startedAt = performance.now();
      try { return operation(...args); }
      finally { recordStage(name, performance.now() - startedAt); }
    };
  }

  try {
    const commandStoreBase = createSqliteCommandStore(db);
    const commandStore = Object.freeze({
      appendDecision: measuredSync("decision_persistence", commandStoreBase.appendDecision.bind(commandStoreBase)),
      commitAuthorizedIntent: measuredSync("intent_persistence", commandStoreBase.commitAuthorizedIntent.bind(commandStoreBase)),
      appendOutcome: measuredSync("outcome_persistence", commandStoreBase.appendOutcome.bind(commandStoreBase)),
    });
    const nonceStore = createSqliteNonceStore(db);

    const approvalKeys = generateKeyPairSync("ed25519");
    const evidenceKeys = generateKeyPairSync("ed25519");
    const evidence = createEvidenceSet(evidenceCount, evidenceKeys);
    const evidencePublicKey = evidenceKeys.publicKey;

    const verifyEvidence = record => {
      const startedAt = performance.now();
      try {
        const signatureText = record?.metadata?.attestation_signature;
        if (record?.metadata?.attestation_key_id !== "bench-evidence-key-v1" ||
            typeof signatureText !== "string") return false;
        const unsignedMetadata = { ...record.metadata };
        delete unsignedMetadata.attestation_signature;
        const unsigned = { ...record, metadata: unsignedMetadata };
        const payload = canonicalizeEvidencePayload(unsigned);
        const signature = Buffer.from(signatureText, "base64url");
        return signature.length === 64 &&
          verify(null, Buffer.from(payload, "utf8"), evidencePublicKey, signature) === true;
      } catch {
        return false;
      } finally {
        recordStage("evidence_signature_verification", performance.now() - startedAt);
      }
    };

    const trustedRuntimeBase = createTrustedAuthorizationRuntime({
      trustedApprovalKeys: [{
        key_id: "bench-approval-key-v1",
        approver_id: "bench-security-owner",
        public_key_pem: approvalKeys.publicKey.export({ type: "spki", format: "pem" }),
        authorities: ["repository.approve"],
      }],
      nonceStore,
      verifyEvidence,
      now: () => Date.now(),
    });

    const authorizationRuntime = Object.freeze({
      evaluate(...args) {
        const startedAt = performance.now();
        try { return trustedRuntimeBase.evaluate(...args); }
        finally { recordStage("authorization_policy_evaluation", performance.now() - startedAt); }
      },
    });

    const providerAdapters = {
      "bench-provider": {
        async dispatch({ task }) {
          const startedAt = performance.now();
          try {
            return {
              status: "completed",
              provider_reference: "mock-" + task.task_id,
            };
          } finally {
            recordStage("mock_provider_execution", performance.now() - startedAt);
          }
        },
      },
    };

    const telemetry = createSecurityTelemetry();
    const runtime = createAuthorizedDispatchRuntime({
      authorizationRuntime,
      authenticatePrincipal: async () => ({ id: "bench-operator", active: true }),
      loadTrustedContext: async () => {
        const evaluatedAt = Date.now();
        return {
          schema_version: KRATT_SCHEMA_VERSION,
          authorities: ["repository.write"],
          allowed_targets: [{
            resource_type: "repository",
            resource_id: "KRATT-PRIME",
          }],
          policies: [{
            action: "repo.write",
            required_authority: "repository.write",
            target_types: ["repository"],
            side_effect_class: "EXTERNAL_WRITE",
            approval_required: true,
            approval_authority: "repository.approve",
            required_claims: ["TESTS_PASSED"],
          }],
          evaluated_at: new Date(evaluatedAt).toISOString(),
          expires_at: new Date(evaluatedAt + 240_000).toISOString(),
          kill_switch: false,
        };
      },
      loadEvidence: async () => evidence,
      commandStore,
      providerAdapters,
      telemetry,
      now: () => Date.now(),
    });

    let inputIndex = 0;
    function createInputs(count, collect) {
      const inputs = [];
      for (let localIndex = 0; localIndex < count; localIndex += 1) {
        const index = inputIndex;
        inputIndex += 1;
        const taskId = "bench-e" + evidenceCount + "-c" + concurrency + "-" + index;
        const createdAt = isoNow();
        const task = makeTask(taskId, createdAt);

        if (collect) {
          let startedAt = performance.now();
          const validation = validateTaskEnvelope(task);
          recordStage("task_envelope_validation", performance.now() - startedAt);
          if (!validation.ok) throw new Error("BENCH_TASK_FIXTURE_INVALID");

          startedAt = performance.now();
          canonicalizeRequest(task);
          recordStage("canonical_request_serialization", performance.now() - startedAt);

          startedAt = performance.now();
          const fingerprint = canonicalTaskDigest(task);
          recordStage("canonical_task_fingerprint", performance.now() - startedAt);
          if (typeof fingerprint !== "string") throw new Error("BENCH_TASK_FINGERPRINT_INVALID");
        }

        const approval = makeApproval(task, index, approvalKeys.privateKey);
        inputs.push({
          principal: "bench-session",
          task,
          approval,
          correlationId: "corr-" + taskId,
        });
      }
      return inputs;
    }

    const warmInputs = createInputs(warmup, false);
    const warmResult = await runBatch(runtime, warmInputs, concurrency, false);
    if (warmResult.errors !== 0) throw new Error("BENCH_WARMUP_FAILED");

    collectStages = true;
    const measurementInputs = createInputs(iterations, true);
    const memoryBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
    eventLoopDelay.enable();
    const measuredAt = performance.now();
    const measured = await runBatch(runtime, measurementInputs, concurrency, true);
    const elapsedMs = performance.now() - measuredAt;
    eventLoopDelay.disable();
    collectStages = false;
    const cpu = process.cpuUsage(cpuBefore);
    const memoryAfter = process.memoryUsage();

    const audit = commandStoreBase.verifyAuditChain();
    const telemetrySnapshot = telemetry.snapshot();
    const stages = {};
    for (const [name, samples] of stageSamples.entries()) stages[name] = summarize(samples);

    const timestamp = isoNow();
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const auditOk = audit?.ok === true && audit.count === measured.successes * 2 + warmResult.successes * 2;
    const result = {
      benchmark: "kratt.end_to_end.authorized_dispatch",
      profile: "local_sqlite_wal_full__ed25519_policy_and_evidence__mock_provider",
      commit_sha: process.env.GITHUB_SHA ?? process.env.KRATT_COMMIT_SHA ?? null,
      node_version: process.version,
      platform: process.platform,
      architecture: process.arch,
      timestamp,
      workload: {
        evidence_records: evidenceCount,
        measurement_operations: iterations,
        provider: "bench-provider",
        provider_mode: "mock; no network or external side effect",
        storage: "temporary local SQLite file; WAL; synchronous=FULL",
        approval_verification: "real Ed25519 signature verification with ephemeral benchmark key",
        evidence_verification: "real Ed25519 signature verification with ephemeral benchmark key per record",
        audit_chain_verified: auditOk,
      },
      concurrency,
      warmup_iterations: warmup,
      measurement_iterations: iterations,
      duration_ms: {
        p50: percentile(measured.latencies, 0.50),
        p95: percentile(measured.latencies, 0.95),
        p99: percentile(measured.latencies, 0.99),
        mean: measured.latencies.length
          ? measured.latencies.reduce((sum, value) => sum + value, 0) / measured.latencies.length
          : null,
        wall_clock_total: elapsedMs,
      },
      throughput: {
        successful_validated_operations_per_second: elapsedMs > 0
          ? measured.successes / (elapsedMs / 1000) : null,
        successful_operations: measured.successes,
        submitted_operations: iterations,
        success_ratio: iterations > 0 ? measured.successes / iterations : null,
      },
      errors: {
        count: measured.errors,
        rate: iterations > 0 ? measured.errors / iterations : null,
        timeouts: 0,
        kinds: measured.errorKinds,
        audit_chain_ok: auditOk,
        audit_entries: audit.count,
      },
      resources: {
        heap_used_bytes_before: memoryBefore.heapUsed,
        heap_used_bytes_after: memoryAfter.heapUsed,
        heap_used_bytes_delta: memoryAfter.heapUsed - memoryBefore.heapUsed,
        rss_bytes_before: memoryBefore.rss,
        rss_bytes_after: memoryAfter.rss,
        rss_bytes_delta: memoryAfter.rss - memoryBefore.rss,
        cpu_user_microseconds: cpu.user,
        cpu_system_microseconds: cpu.system,
        cpu_milliseconds_per_successful_operation: measured.successes > 0
          ? (cpu.user + cpu.system) / 1000 / measured.successes : null,
        event_loop_delay_ms: {
          p50: Number.isFinite(eventLoopDelay.percentile(50)) ? eventLoopDelay.percentile(50) / 1e6 : null,
          p95: Number.isFinite(eventLoopDelay.percentile(95)) ? eventLoopDelay.percentile(95) / 1e6 : null,
          p99: Number.isFinite(eventLoopDelay.percentile(99)) ? eventLoopDelay.percentile(99) / 1e6 : null,
          max: Number.isFinite(eventLoopDelay.max) ? eventLoopDelay.max / 1e6 : null,
          mean: Number.isFinite(eventLoopDelay.mean) ? eventLoopDelay.mean / 1e6 : null,
        },
      },
      retries: { count: 0, note: "This authorized-dispatch profile does not exercise the PostgreSQL outbox retry worker." },
      stages,
      not_measured: [
        "PostgreSQL outbox processing",
        "queue wait and queue admission",
        "governed-execution worker lease",
        "cross-process or multi-host coordination",
        "cancellation and crash recovery",
        "real external provider latency",
      ],
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        cpu_count: cpus().length,
        total_memory_bytes: totalmem(),
        process_id: process.pid,
        temporary_storage_path: "system temporary directory (path intentionally omitted)",
        telemetry_events_recorded: telemetrySnapshot?.diagnostics?.eventsRecorded ?? null,
      },
    };

    const fileName = "kratt-e2e-e" + evidenceCount + "-c" + concurrency + "-" + safeTimestamp + ".json";
    writeFileSync(join(outputDirectory, fileName), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({
      file: fileName,
      evidence_records: evidenceCount,
      concurrency,
      successful_operations: measured.successes,
      errors: measured.errors,
      throughput_ops_per_second: result.throughput.successful_validated_operations_per_second,
      p50_ms: result.duration_ms.p50,
      p95_ms: result.duration_ms.p95,
      p99_ms: result.duration_ms.p99,
      audit_chain_ok: auditOk,
    }) + "\n");

    if (!auditOk || measured.errors > 0 || measured.successes !== iterations) process.exitCode = 1;
  } finally {
    db.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

for (const evidenceCount of evidenceCounts) {
  for (const concurrency of concurrencyLevels) {
    await executeScenario(evidenceCount, concurrency);
  }
}
