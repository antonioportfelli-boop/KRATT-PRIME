import { canonicalTaskDigest, validateTaskEnvelope } from "./policy.mjs";
import {
  claimExecution, completeExecution, createExecutionRecord, failExecution, startExecution
} from "./construction-execution-ledger.mjs";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const validId = value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const fail = reason => ({ ok: false, reason });

function validateDependencies({ authorizationRuntime, leaseCoordinator, ledgerStore, execute }) {
  if (!authorizationRuntime || typeof authorizationRuntime.evaluate !== "function") return "AUTHORIZATION_RUNTIME_REQUIRED";
  if (!leaseCoordinator || typeof leaseCoordinator.acquire !== "function" ||
      typeof leaseCoordinator.release !== "function") return "LEASE_COORDINATOR_REQUIRED";
  if (!ledgerStore || typeof ledgerStore.append !== "function") return "REVISIONED_LEDGER_STORE_REQUIRED";
  if (typeof execute !== "function") return "EXECUTOR_REQUIRED";
  return null;
}

async function persist(store, record, expectedRevision) {
  try {
    const result = await store.append({
      execution_key: record.execution_key,
      expected_revision: expectedRevision,
      record
    });
    if (result?.ok !== true) return fail(result?.reason || "LEDGER_COMPARE_AND_APPEND_FAILED");
    return { ok: true, sequence: result.sequence, journal_hash: result.journal_hash };
  } catch {
    return fail("LEDGER_STORE_UNAVAILABLE");
  }
}

async function releaseLease(coordinator, claim) {
  try {
    const result = await coordinator.release(claim);
    return result?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Execute one already-defined KRATT task through trusted authorization,
 * authoritative lease acquisition, revisioned durable ledger writes, and a
 * caller-supplied executor. This function is an orchestration boundary, not
 * a source of authority or evidence.
 *
 * ledgerStore.append must atomically compare expected_revision and append the
 * next record revision. leaseCoordinator must be durable and enforce fencing.
 * The executor must independently honor cancellation and its scoped capability.
 */
export async function executeAuthorizedConstructionTask({
  task,
  evidence,
  trustedContext,
  approval,
  authorizationRuntime,
  leaseCoordinator,
  ledgerStore,
  execute,
  worker_id,
  task_revision = 0,
  max_attempts = 1,
  lease_ttl_ms = 30_000,
  now = () => new Date().toISOString()
} = {}) {
  const dependencyError = validateDependencies({ authorizationRuntime, leaseCoordinator, ledgerStore, execute });
  if (dependencyError) return fail(dependencyError);
  if (!validId(worker_id)) return fail("WORKER_ID_INVALID");
  if (!Number.isSafeInteger(task_revision) || task_revision < 0) return fail("TASK_REVISION_INVALID");
  if (!Number.isInteger(lease_ttl_ms) || lease_ttl_ms < 1_000 || lease_ttl_ms > 300_000)
    return fail("LEASE_TTL_INVALID");

  const validated = validateTaskEnvelope(task);
  if (!validated.ok) return fail("TASK_ENVELOPE_INVALID");
  const digest = canonicalTaskDigest(validated.value);
  if (!SHA256.test(digest || "")) return fail("TASK_DIGEST_UNAVAILABLE");

  let createdAt;
  try { createdAt = now(); } catch { return fail("CLOCK_UNAVAILABLE"); }
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))
    return fail("CLOCK_INVALID");

  const created = createExecutionRecord({
    task_id: validated.value.task_id,
    task_revision,
    task_digest: digest,
    operation: validated.value.action,
    max_attempts,
    now: () => createdAt
  });
  if (!created.ok) return created;
  let record = created.record;

  // Persist the intent before acquiring a lease or performing any side effect.
  const initialWrite = await persist(ledgerStore, record, -1);
  if (!initialWrite.ok) return initialWrite;

  let claim;
  try {
    const acquired = await leaseCoordinator.acquire({
      execution_key: record.execution_key,
      task_id: record.task_id,
      worker_id,
      ttl_ms: lease_ttl_ms
    });
    if (acquired?.ok !== true || !acquired.claim) return fail(acquired?.reason || "LEASE_ACQUISITION_FAILED");
    claim = acquired.claim;
  } catch {
    return fail("LEASE_COORDINATOR_UNAVAILABLE");
  }

  const decision = authorizationRuntime.evaluate(validated.value, evidence, trustedContext, { approval });
  if (decision?.decision !== "ALLOW") {
    const released = await releaseLease(leaseCoordinator, claim);
    return { ok: false, reason: "AUTHORIZATION_DENIED", decision, lease_released: released };
  }

  const claimed = claimExecution(record, claim, { now });
  if (!claimed.ok) {
    const released = await releaseLease(leaseCoordinator, claim);
    return { ...claimed, lease_released: released };
  }
  let write = await persist(ledgerStore, claimed.record, record.revision);
  if (!write.ok) {
    const released = await releaseLease(leaseCoordinator, claim);
    return { ...write, lease_released: released };
  }
  record = claimed.record;

  const running = startExecution(record, claim, { now });
  if (!running.ok) {
    const released = await releaseLease(leaseCoordinator, claim);
    return { ...running, lease_released: released };
  }
  write = await persist(ledgerStore, running.record, record.revision);
  if (!write.ok) {
    const released = await releaseLease(leaseCoordinator, claim);
    return { ...write, lease_released: released };
  }
  record = running.record;

  let result;
  try {
    result = await execute({
      task: validated.value,
      execution_key: record.execution_key,
      claim,
      decision
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : "EXECUTOR_FAILED";
    const failed = failExecution(record, claim, reason || "EXECUTOR_FAILED", { retryable: false, now });
    if (failed.ok) await persist(ledgerStore, failed.record, record.revision);
    const released = await releaseLease(leaseCoordinator, claim);
    return { ok: false, reason: "EXECUTOR_FAILED", failure: failed.ok ? failed.record.failure : failed.reason, lease_released: released };
  }

  if (!result || typeof result !== "object" || !SHA256.test(result.result_digest || "")) {
    const failed = failExecution(record, claim, "EXECUTOR_RESULT_INVALID", { retryable: false, now });
    if (failed.ok) await persist(ledgerStore, failed.record, record.revision);
    const released = await releaseLease(leaseCoordinator, claim);
    return { ok: false, reason: "EXECUTOR_RESULT_INVALID", lease_released: released };
  }

  const completed = completeExecution(record, claim, result.result_digest, { now });
  if (!completed.ok) {
    const released = await releaseLease(leaseCoordinator, claim);
    return { ...completed, lease_released: released };
  }
  write = await persist(ledgerStore, completed.record, record.revision);
  const released = await releaseLease(leaseCoordinator, claim);
  if (!write.ok) return { ...write, side_effect_may_have_completed: true, lease_released: released };
  return {
    ok: true,
    execution_key: completed.record.execution_key,
    state: completed.record.state,
    result_digest: completed.record.result_digest,
    revision: completed.record.revision,
    journal_sequence: write.sequence,
    journal_hash: write.journal_hash,
    lease_released: released
  };
}
