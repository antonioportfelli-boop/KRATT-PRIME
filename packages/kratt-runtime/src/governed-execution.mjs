import { createHash } from "node:crypto";
import { validateEvidenceRecord, validateTaskEnvelope, validateTrustedContext } from "../../kratt-core/src/contracts.mjs";
import { canonicalTaskDigest, isPolicyDecision } from "../../kratt-core/src/policy.mjs";
import { verifyConstructionTask } from "../../kratt-core/src/construction-protocol.mjs";
import {
  appendExecutionRecord, cancelExecution, claimExecution, completeExecution,
  createExecutionRecord, failExecution, recoverExecutionRecords, startExecution,
  validateExecutionRecord
} from "../../kratt-core/src/construction-execution-ledger.mjs";
import { DurableEvidenceRepository } from "./durable-evidence.mjs";
import { createWorkerLeaseCoordinator } from "./worker-lease-coordinator.mjs";

export const GOVERNANCE_RECEIPT_KEY = "construction.governance.receipt.v1";
const POLICY_EVIDENCE_SCHEMA = "kratt-policy-evidence/v1";
const RECEIPT_SCHEMA = "kratt-governance-receipt/v1";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const validId = value => typeof value === "string" && ID.test(value);
const validUtc = value => typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
const canonical = value => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  throw new TypeError("GOVERNANCE_VALUE_NOT_CANONICAL");
};
const digest = value => `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
const failure = (reason, extra = {}) => Object.freeze({ ok: false, state: "BLOCKED", reason, dispatch: false, executionStarted: false, ...extra });

function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !value.startsWith("/") && !value.includes("\\") &&
    value.split("/").every(part => part && part !== "." && part !== "..");
}
function pathInScope(path, scopes) {
  return scopes.some(scope => path === scope || path.startsWith(`${scope}/`));
}

function bindTasks(taskInput, constructionTask, identity) {
  const checked = validateTaskEnvelope(taskInput);
  if (!checked.ok) return failure("POLICY_TASK_INVALID", { details: checked.errors });
  const task = checked.value;
  const integrity = verifyConstructionTask(constructionTask);
  if (!integrity.ok) return failure("CONSTRUCTION_TASK_INTEGRITY_INVALID", { detail: integrity.reason });
  if (constructionTask.status !== "APPROVED") return failure("CONSTRUCTION_TASK_NOT_APPROVED");
  if (task.task_id !== constructionTask.task_id || task.actor !== identity.id ||
      constructionTask.builder_id !== identity.id)
    return failure("CONSTRUCTION_POLICY_BINDING_MISMATCH");
  const requestedPath = task.constraints.path;
  if (requestedPath !== undefined) {
    if (!safeRelativePath(requestedPath) || !pathInScope(requestedPath, constructionTask.target_scope))
      return failure("CONSTRUCTION_PATH_OUT_OF_SCOPE");
  } else if (!constructionTask.target_scope.includes(task.target.resource_id)) {
    return failure("CONSTRUCTION_TARGET_OUT_OF_SCOPE");
  }
  const policyDigest = canonicalTaskDigest(task);
  if (!policyDigest) return failure("POLICY_TASK_DIGEST_UNAVAILABLE");
  const bindingDigest = digest({
    construction_task_digest: integrity.task_digest,
    policy_task_digest: policyDigest
  });
  return {
    ok: true, task, constructionTask, constructionDigest: integrity.task_digest,
    policyDigest, bindingDigest
  };
}

function cardToPolicyEvidence(card, task) {
  if (!plain(card) || card.schemaVersion !== "kratt-eck-card/v1" ||
      typeof card.cardId !== "string" || !validId(card.cardId) ||
      typeof card.contentDigest !== "string" || !DIGEST.test(card.contentDigest) ||
      card.rootId !== task.target.resource_id ||
      (task.constraints.branch !== undefined && card.branchId !== task.constraints.branch) ||
      !plain(card.evidence)) return null;
  const event = card.evidence;
  const policy = event.metadata?.policy_evidence;
  if (event.decision !== "VERIFIED" || event.subject !== task.target.resource_id ||
      !plain(event.sourceRef) || !plain(policy) ||
      policy.schema_version !== POLICY_EVIDENCE_SCHEMA ||
      Object.keys(policy).sort().join(",") !== "claim_type,schema_version,verification_method" ||
      !validId(policy.claim_type) || !validId(policy.verification_method) ||
      !validUtc(event.occurredAt) || !validId(event.actorId) ||
      !validId(event.sourceRef.provider) || !validId(event.sourceRef.resource) ||
      (event.sourceRef.revision !== null && !/^[a-f0-9]{40}$/.test(event.sourceRef.revision)) ||
      typeof event.artifactDigest !== "string" || !DIGEST.test(event.artifactDigest)) return null;
  const record = {
    schema_version: "kratt-prime/v0.1",
    evidence_id: card.cardId,
    subject: event.subject,
    claim_type: policy.claim_type,
    source: {
      source_type: event.sourceRef.provider,
      source_id: event.sourceRef.resource,
      revision: event.sourceRef.revision
    },
    observed_at: event.occurredAt,
    verification_method: policy.verification_method,
    result: "VERIFIED",
    artifact_digest: event.artifactDigest,
    metadata: {
      actor_id: event.actorId,
      event_type: event.eventType,
      eck_content_digest: card.contentDigest
    }
  };
  return validateEvidenceRecord(record).ok ? record : null;
}

async function readEvidenceSnapshot(repository, { maxCards }) {
  const before = await repository.verify();
  if (before?.ok !== true || !Number.isSafeInteger(before.eventCount) ||
      before.eventCount < 0 || before.eventCount > maxCards ||
      typeof before.evidenceHeadHash !== "string" || typeof before.journalHeadHash !== "string")
    return { ok: false, reason: "EVIDENCE_JOURNAL_UNVERIFIED" };
  const cards = [];
  for (let offset = 0; offset < before.eventCount; offset += 1000) {
    const page = await repository.list({ afterSequence: offset, limit: Math.min(1000, before.eventCount - offset) });
    if (page?.ok !== true || !Array.isArray(page.cards) ||
        page.count !== before.eventCount || page.cards.length === 0)
      return { ok: false, reason: "EVIDENCE_JOURNAL_PAGE_INVALID" };
    cards.push(...page.cards);
  }
  const after = await repository.verify();
  if (after?.ok !== true || after.eventCount !== before.eventCount ||
      after.evidenceHeadHash !== before.evidenceHeadHash ||
      after.journalHeadHash !== before.journalHeadHash || cards.length !== before.eventCount)
    return { ok: false, reason: "EVIDENCE_JOURNAL_CHANGED_DURING_READ" };
  return {
    ok: true, cards,
    evidenceHeadHash: after.evidenceHeadHash,
    journalHeadHash: after.journalHeadHash,
    eventCount: after.eventCount
  };
}

function leaseReservationKey(record) {
  return `reserve-${record.execution_key}`;
}
function leaseId(reservationKey, ownerId, fence) {
  return `lease-${createHash("sha256").update(`${reservationKey}:${ownerId}:${fence}`).digest("hex").slice(0, 40)}`;
}
function operationId(prefix, record, fence = 0) {
  return `${prefix}-${createHash("sha256").update(`${record.execution_key}:${record.revision}:${fence}`).digest("hex").slice(0, 40)}`;
}

async function appendReceipt(store, receipt) {
  const unsigned = { ...receipt };
  const record = Object.freeze({ ...unsigned, receipt_digest: digest(unsigned) });
  try {
    const saved = await store.put({
      idempotencyKey: record.receipt_id,
      key: GOVERNANCE_RECEIPT_KEY,
      value: record
    });
    if (saved?.ok !== true) return { ok: false, reason: "GOVERNANCE_RECEIPT_APPEND_FAILED" };
    if (saved.duplicate === true) {
      const entries = await store.readAll();
      const existing = entries.find(entry => entry?.id === record.receipt_id && entry?.key === GOVERNANCE_RECEIPT_KEY);
      if (!existing || existing.value?.receipt_digest !== record.receipt_digest)
        return { ok: false, reason: "GOVERNANCE_RECEIPT_IDEMPOTENCY_CONFLICT" };
      return { ok: true, duplicate: true, record: existing.value };
    }
    return { ok: true, duplicate: false, record };
  } catch {
    return { ok: false, reason: "GOVERNANCE_RECEIPT_APPEND_FAILED" };
  }
}

export function createGovernedExecutionRuntime({
  store,
  authorizationRuntime,
  authenticatePrincipal,
  loadTrustedContext,
  verifyEvidenceProvenance,
  evidenceRepository,
  leaseCoordinator,
  nowEpochMs = () => Date.now(),
  nowIso = () => new Date().toISOString(),
  leaseTtlMs = 60_000,
  maxContextAgeMs = 300_000,
  maxEvidenceCards = 10_000,
  cancelWorker
} = {}) {
  if (!store || typeof store.open !== "function" || typeof store.put !== "function" ||
      typeof store.readAll !== "function" || typeof store.verify !== "function")
    throw new TypeError("GOVERNED_EXECUTION_PRIMESTORE_REQUIRED");
  if (!authorizationRuntime || typeof authorizationRuntime.evaluate !== "function")
    throw new TypeError("TRUSTED_AUTHORIZATION_RUNTIME_REQUIRED");
  if (typeof authenticatePrincipal !== "function" || typeof loadTrustedContext !== "function" ||
      typeof verifyEvidenceProvenance !== "function")
    throw new TypeError("TRUSTED_EXECUTION_DEPENDENCIES_REQUIRED");
  if (typeof nowEpochMs !== "function" || typeof nowIso !== "function")
    throw new TypeError("TRUSTED_EXECUTION_CLOCK_REQUIRED");
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 900_000)
    throw new TypeError("GOVERNED_EXECUTION_LEASE_TTL_INVALID");
  if (!Number.isSafeInteger(maxContextAgeMs) || maxContextAgeMs < 0 ||
      !Number.isInteger(maxEvidenceCards) || maxEvidenceCards < 1 || maxEvidenceCards > 100_000)
    throw new TypeError("GOVERNED_EXECUTION_LIMIT_INVALID");
  if (cancelWorker !== undefined && typeof cancelWorker !== "function")
    throw new TypeError("WORKER_CANCELLATION_ACK_REQUIRED");

  const evidence = evidenceRepository ?? new DurableEvidenceRepository({ store });
  const leases = leaseCoordinator ?? createWorkerLeaseCoordinator({ store, now: nowIso });

  async function identityFor(principal) {
    let identity;
    try { identity = await authenticatePrincipal(principal); }
    catch { return failure("PRINCIPAL_AUTHENTICATION_FAILED"); }
    if (!plain(identity) || identity.active !== true || !validId(identity.id))
      return failure("PRINCIPAL_AUTHENTICATION_FAILED");
    return { ok: true, identity };
  }

  async function trustedContextFor(task, identity) {
    let context, now;
    try {
      [context, now] = await Promise.all([
        loadTrustedContext({ task, principal: identity }),
        Promise.resolve(nowEpochMs())
      ]);
    } catch { return failure("TRUSTED_CONTEXT_UNAVAILABLE"); }
    const checked = validateTrustedContext(context);
    if (!checked.ok || !Number.isFinite(now) || now < 0)
      return failure("TRUSTED_CONTEXT_INVALID");
    const age = now - Date.parse(context.evaluated_at);
    if (context.kill_switch === true || Date.parse(context.expires_at) <= now ||
        Date.parse(context.evaluated_at) > now + 30_000 || age > maxContextAgeMs)
      return failure("TRUSTED_CONTEXT_STALE_OR_KILL_SWITCHED");
    return { ok: true, context: checked.value, now, contextDigest: digest(checked.value) };
  }

  async function verifiedPolicyEvidence(task, identity) {
    let snapshot;
    try { snapshot = await readEvidenceSnapshot(evidence, { maxCards: maxEvidenceCards }); }
    catch { return failure("EVIDENCE_JOURNAL_UNAVAILABLE"); }
    if (!snapshot.ok) return failure(snapshot.reason);
    const records = [];
    const cardsById = new Map();
    for (const card of snapshot.cards) {
      if (!plain(card?.evidence?.metadata) || !Object.hasOwn(card.evidence.metadata, "policy_evidence")) continue;
      const record = cardToPolicyEvidence(card, task);
      if (!record) return failure("POLICY_EVIDENCE_CARD_INVALID", { evidence_id: card?.cardId ?? null });
      let provenance = false;
      try {
        provenance = await verifyEvidenceProvenance(record, {
          task, principal: identity, card,
          evidence_head_hash: snapshot.evidenceHeadHash,
          journal_head_hash: snapshot.journalHeadHash
        });
      } catch { provenance = false; }
      if (provenance !== true) return failure("POLICY_EVIDENCE_PROVENANCE_REJECTED", { evidence_id: record.evidence_id });
      if (cardsById.has(record.evidence_id)) return failure("DUPLICATE_POLICY_EVIDENCE_ID");
      records.push(record);
      cardsById.set(record.evidence_id, {
        card_id: card.cardId, content_digest: card.contentDigest
      });
    }
    return { ok: true, records, cardsById, snapshot };
  }

  async function validateBinding({ principal, task: taskInput, constructionTask }) {
    const identityResult = await identityFor(principal);
    if (!identityResult.ok) return identityResult;
    const identity = identityResult.identity;
    const bound = bindTasks(taskInput, constructionTask, identity);
    if (!bound.ok) return bound;
    const trusted = await trustedContextFor(bound.task, identity);
    if (!trusted.ok) return trusted;
    return { ok: true, identity, ...bound, ...trusted };
  }

  function verifyRecordBinding(record, bound) {
    const valid = validateExecutionRecord(record);
    if (!valid.ok) return failure(valid.reason);
    if (record.task_id !== bound.task.task_id ||
        record.task_revision !== bound.constructionTask.revision ||
        record.task_digest !== bound.bindingDigest ||
        record.operation !== bound.task.action)
      return failure("EXECUTION_RECORD_TASK_BINDING_MISMATCH");
    return { ok: true };
  }

  async function releaseLease(record, claim, identityId) {
    if (!claim) return { ok: true, released: false };
    try {
      const result = await leases.release({
        operationId: operationId("release", record, claim.fence),
        reservationKey: leaseReservationKey(record),
        taskDigest: record.task_digest,
        ownerId: identityId,
        fencingToken: claim.fence
      });
      return result?.ok === true ? { ok: true, released: true } : { ok: false, reason: result?.reason ?? "LEASE_RELEASE_FAILED" };
    } catch { return { ok: false, reason: "LEASE_RELEASE_FAILED" }; }
  }

  async function persistFailedAfterCompensation(record, claim, identityId, reason) {
    const failed = failExecution(record, claim, reason, { retryable: false, now: nowIso });
    if (failed.ok) await appendExecutionRecord(failed.record, store);
    await releaseLease(record, claim, identityId);
  }

  async function authorizeAndClaim({ principal, task: taskInput, constructionTask, approval, executionRecord } = {}) {
    const bound = await validateBinding({ principal, task: taskInput, constructionTask });
    if (!bound.ok) return bound;
    const recordResult = executionRecord
      ? { ok: true, record: executionRecord }
      : createExecutionRecord({
          task_id: bound.task.task_id,
          task_revision: bound.constructionTask.revision,
          task_digest: bound.bindingDigest,
          operation: bound.task.action,
          now: nowIso
        });
    if (!recordResult.ok) return failure(recordResult.reason);
    const record = recordResult.record;
    const recordBinding = verifyRecordBinding(record, bound);
    if (!recordBinding.ok) return recordBinding;
    if (!["QUEUED", "RETRY_WAIT"].includes(record.state))
      return failure("EXECUTION_NOT_READY_FOR_CLAIM", { execution_state: record.state });

    const policyEvidence = await verifiedPolicyEvidence(bound.task, bound.identity);
    if (!policyEvidence.ok) return policyEvidence;

    let decision;
    try {
      decision = authorizationRuntime.evaluate(bound.task, policyEvidence.records, bound.context, { approval });
    } catch { return failure("AUTHORIZATION_EVALUATION_FAILED"); }
    if (!isPolicyDecision(decision) || decision.decision !== "ALLOW")
      return failure("AUTHORIZATION_NOT_ALLOWED", {
        decision: isPolicyDecision(decision) ? decision.decision : "BLOCKED",
        reasons: isPolicyDecision(decision) ? decision.reasons : ["INVALID_POLICY_DECISION"]
      });

    const usedIds = [...decision.evidence_ids];
    if (usedIds.some(id => !policyEvidence.cardsById.has(id)))
      return failure("AUTHORIZED_EVIDENCE_NOT_IN_DURABLE_PROJECTION");
    const evidenceCards = usedIds.map(id => policyEvidence.cardsById.get(id));
    const created = await appendExecutionRecord(record, store);
    if (!created.ok) return failure(created.reason);

    let at;
    try { at = nowIso(); } catch { return failure("TRUSTED_EXECUTION_CLOCK_UNAVAILABLE"); }
    if (!validUtc(at)) return failure("TRUSTED_EXECUTION_CLOCK_INVALID");
    const reservationKey = leaseReservationKey(record);
    let acquired;
    try {
      acquired = await leases.acquire({
        operationId: operationId("acquire", record, record.last_fencing_token),
        reservationKey,
        taskDigest: record.task_digest,
        ownerId: bound.identity.id,
        ttlMs: leaseTtlMs
      });
    } catch { acquired = null; }
    if (acquired?.ok !== true || acquired.dispatch !== false)
      return failure(acquired?.reason ?? "WORKER_LEASE_ACQUISITION_FAILED", {
        authorization: "ALLOW", evidence_ids: usedIds, lease_state: acquired?.state ?? "UNAVAILABLE"
      });

    const claim = {
      worker_id: bound.identity.id,
      lease_id: leaseId(reservationKey, bound.identity.id, acquired.fencingToken),
      fence: acquired.fencingToken,
      expires_at: acquired.expiresAt
    };
    const claimed = claimExecution(record, claim, { now: nowIso });
    if (!claimed.ok) {
      const compensation = await releaseLease(record, claim, bound.identity.id);
      return failure(claimed.reason, { lease_compensated: compensation.ok });
    }
    const persistedClaim = await appendExecutionRecord(claimed.record, store);
    if (!persistedClaim.ok) {
      const compensation = await releaseLease(record, claim, bound.identity.id);
      return failure("EXECUTION_CLAIM_PERSIST_FAILED", { lease_compensated: compensation.ok });
    }

    const receiptContext = {
      schema_version: RECEIPT_SCHEMA,
      execution_key: claimed.record.execution_key,
      record_revision: claimed.record.revision,
      principal_id: bound.identity.id,
      decision_id: decision.decision_id,
      decision: decision.decision,
      evidence_ids: usedIds,
      evidence_cards: evidenceCards,
      evidence_head_hash: policyEvidence.snapshot.evidenceHeadHash,
      evidence_journal_head_hash: policyEvidence.snapshot.journalHeadHash,
      construction_task_digest: bound.constructionDigest,
      policy_task_digest: bound.policyDigest,
      trusted_context_digest: bound.contextDigest,
      trusted_context_expires_at: bound.context.expires_at,
      authorized_at: at,
      approval_id: typeof approval?.approval_id === "string" ? approval.approval_id : null,
      reservation_key: reservationKey,
      lease_fence: claim.fence,
      lease_expires_at: claim.expires_at
    };
    const receiptId = `gov-${digest(receiptContext).slice(7, 55)}`;
    const receipt = await appendReceipt(store, { ...receiptContext, receipt_id: receiptId });
    if (!receipt.ok) {
      await persistFailedAfterCompensation(claimed.record, claim, bound.identity.id, "GOVERNANCE_RECEIPT_APPEND_FAILED");
      return failure(receipt.reason, { lease_compensation_attempted: true });
    }

    return Object.freeze({
      ok: true, state: claimed.record.state,
      record: claimed.record, claim: Object.freeze(claim),
      authorization: decision, authorization_receipt_id: receiptId,
      evidence_ids: Object.freeze(usedIds),
      lease: Object.freeze({ reservation_key: reservationKey, fencing_token: claim.fence, expires_at: claim.expires_at }),
      dispatch: false, executionStarted: false
    });
  }

  async function receiptFor(record) {
    const entries = await store.readAll();
    const matches = entries.filter(entry => entry?.key === GOVERNANCE_RECEIPT_KEY &&
      entry.value?.schema_version === RECEIPT_SCHEMA &&
      entry.value.execution_key === record.execution_key &&
      entry.value.lease_fence === record.claim?.fence &&
      entry.value.record_revision === record.revision);
    if (matches.length !== 1) return null;
    const value = matches[0].value;
    const { receipt_digest, ...unsigned } = value;
    if (matches[0].id !== value.receipt_id || receipt_digest !== digest(unsigned)) return null;
    return value;
  }

  async function leaseIsCurrent(record) {
    if (!record.claim) return { ok: false, reason: "EXECUTION_CLAIM_MISSING" };
    const inspected = await leases.inspect(leaseReservationKey(record));
    const reservation = inspected?.reservation;
    if (inspected?.ok !== true || !reservation || reservation.status !== "LEASED" ||
        reservation.taskDigest !== record.task_digest ||
        reservation.fence !== record.claim.fence ||
        reservation.lease?.ownerId !== record.claim.worker_id ||
        reservation.lease?.expiresAt !== record.claim.expires_at ||
        Date.parse(reservation.lease.expiresAt) <= nowEpochMs())
      return { ok: false, reason: "WORKER_LEASE_NOT_CURRENT" };
    return { ok: true, reservation };
  }

  async function start({ principal, task: taskInput, constructionTask, record } = {}) {
    const bound = await validateBinding({ principal, task: taskInput, constructionTask });
    if (!bound.ok) return bound;
    const recordBinding = verifyRecordBinding(record, bound);
    if (!recordBinding.ok) return recordBinding;
    if (record.state !== "CLAIMED") return failure("EXECUTION_NOT_CLAIMED");
    const lease = await leaseIsCurrent(record);
    if (!lease.ok) return failure(lease.reason);

    let receipt;
    try { receipt = await receiptFor(record); } catch { receipt = null; }
    if (!receipt || receipt.decision !== "ALLOW" || receipt.principal_id !== bound.identity.id)
      return failure("GOVERNANCE_RECEIPT_MISSING_OR_INVALID");
    const now = bound.now;
    if (Date.parse(receipt.trusted_context_expires_at) <= now ||
        receipt.trusted_context_digest !== bound.contextDigest)
      return failure("TRUSTED_CONTEXT_CHANGED_OR_EXPIRED");

    const policyEvidence = await verifiedPolicyEvidence(bound.task, bound.identity);
    if (!policyEvidence.ok) return policyEvidence;
    for (const used of receipt.evidence_cards) {
      const current = policyEvidence.cardsById.get(used.card_id);
      if (!current || current.content_digest !== used.content_digest)
        return failure("AUTHORIZED_EVIDENCE_CARD_CHANGED_OR_MISSING", { evidence_id: used.card_id });
    }
    const started = startExecution(record, record.claim, { now: nowIso });
    if (!started.ok) return failure(started.reason);
    const persisted = await appendExecutionRecord(started.record, store);
    if (!persisted.ok) return failure("EXECUTION_START_PERSIST_FAILED");
    return Object.freeze({
      ok: true, state: started.record.state, record: started.record,
      dispatch: false, workflowStarted: true, externalEffects: false
    });
  }

  async function complete({ principal, task: taskInput, constructionTask, record, resultDigest } = {}) {
    const bound = await validateBinding({ principal, task: taskInput, constructionTask });
    if (!bound.ok) return bound;
    const recordBinding = verifyRecordBinding(record, bound);
    if (!recordBinding.ok) return recordBinding;
    if (record.state !== "RUNNING") return failure("EXECUTION_NOT_RUNNING");
    const lease = await leaseIsCurrent(record);
    if (!lease.ok) return failure(lease.reason);
    const completed = completeExecution(record, record.claim, resultDigest, { now: nowIso });
    if (!completed.ok) return failure(completed.reason);
    const persisted = await appendExecutionRecord(completed.record, store);
    if (!persisted.ok) return failure("EXECUTION_COMPLETION_PERSIST_FAILED");
    const released = await releaseLease(record, record.claim, bound.identity.id);
    return Object.freeze({
      ok: released.ok, state: completed.record.state, record: completed.record,
      lease_released: released.ok, ...(released.ok ? {} : { lease_release_reason: released.reason }),
      dispatch: false, externalEffects: false
    });
  }

  async function fail({ principal, task: taskInput, constructionTask, record, reason, retryable = false } = {}) {
    const bound = await validateBinding({ principal, task: taskInput, constructionTask });
    if (!bound.ok) return bound;
    const recordBinding = verifyRecordBinding(record, bound);
    if (!recordBinding.ok) return recordBinding;
    if (!["CLAIMED", "RUNNING"].includes(record.state)) return failure("EXECUTION_NOT_ACTIVE");
    const lease = await leaseIsCurrent(record);
    if (!lease.ok) return failure(lease.reason);
    const failed = failExecution(record, record.claim, reason, { retryable, now: nowIso });
    if (!failed.ok) return failure(failed.reason);
    const persisted = await appendExecutionRecord(failed.record, store);
    if (!persisted.ok) return failure("EXECUTION_FAILURE_PERSIST_FAILED");
    const released = await releaseLease(record, record.claim, bound.identity.id);
    return Object.freeze({
      ok: released.ok, state: failed.record.state, record: failed.record,
      lease_released: released.ok, ...(released.ok ? {} : { lease_release_reason: released.reason }),
      dispatch: false, externalEffects: false
    });
  }

  async function cancel({ principal, task: taskInput, constructionTask, record, reason } = {}) {
    const bound = await validateBinding({ principal, task: taskInput, constructionTask });
    if (!bound.ok) return bound;
    const recordBinding = verifyRecordBinding(record, bound);
    if (!recordBinding.ok) return recordBinding;
    if (record.state === "RUNNING") {
      if (typeof cancelWorker !== "function") return failure("RUNNING_CANCELLATION_REQUIRES_WORKER_ACK");
      let acknowledged = false;
      try { acknowledged = await cancelWorker({
        execution_key: record.execution_key, worker_id: record.claim?.worker_id,
        fencing_token: record.claim?.fence
      }); } catch { acknowledged = false; }
      if (acknowledged !== true) return failure("WORKER_CANCELLATION_NOT_ACKNOWLEDGED");
    }
    if (record.claim) {
      const lease = await leaseIsCurrent(record);
      if (!lease.ok) return failure(lease.reason);
    }
    const cancelled = cancelExecution(record, bound.identity.id, reason, {
      workerAcknowledged: record.state === "RUNNING", now: nowIso
    });
    if (!cancelled.ok) return failure(cancelled.reason);
    const persisted = await appendExecutionRecord(cancelled.record, store);
    if (!persisted.ok) return failure("EXECUTION_CANCELLATION_PERSIST_FAILED");
    const released = await releaseLease(record, record.claim, bound.identity.id);
    return Object.freeze({
      ok: released.ok, state: cancelled.record.state, record: cancelled.record,
      lease_released: released.ok, ...(released.ok ? {} : { lease_release_reason: released.reason }),
      dispatch: false, externalEffects: false
    });
  }

  return Object.freeze({
    authorizeAndClaim,
    start,
    complete,
    fail,
    cancel,
    recover: () => recoverExecutionRecords(store),
    status: () => leases.status(),
    evidenceStatus: () => evidence.verify()
  });
}
