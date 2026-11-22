import { createHash, randomUUID } from "node:crypto";
import { createObservedOperationRunner } from "./observed-operation.mjs";

export const PHASE11_WAVE10_INTEGRATION_VERSION = "1.0.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const CAPABILITY_STATES = new Set(["bound", "partial", "mock", "unbound", "disabled"]);
const ENVIRONMENTS = new Set(["development", "test", "staging", "production"]);

const isPlain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const sha256 = value => createHash("sha256").update(String(value), "utf8").digest("hex");
const bad = (status, reason, extra = {}) => Object.freeze({ ok: false, status, reason, ...extra });

function validRequestId(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 128 && ID.test(value);
}

function safeOperationRef(prefix, value) {
  if (typeof value !== "string" || !value || !SAFE_REF.test(value) || value.includes("..") || value.includes("://")) {
    return null;
  }
  const ref = prefix + "/" + value;
  return SAFE_REF.test(ref) && !ref.includes("..") && !ref.includes("://") ? ref : null;
}

function outputReference(result) {
  const value = result?.run?.runId ?? result?.runId ?? result?.record_id ?? result?.recordId ?? null;
  return safeOperationRef("phase11/result", value);
}

/**
 * Composes Phase 11's governed lifecycle with the Wave 10 append-only
 * runtime observatory. The Phase 11 engine remains the only authority for
 * policy, approvals and repository writes; this adapter adds durable
 * operation telemetry and correlation, not a second write path.
 */
export function createPhase11Wave10Integration({
  phaseEngine,
  observabilityStore,
  semanticPipeline = null,
  clock = () => new Date(),
  makeId = () => randomUUID(),
  environment = "development",
  runtimeVersion = "phase11-wave10-bridge-1.0.0",
  capabilityState = "partial",
  evidenceRefs = []
} = {}) {
  if (!phaseEngine || typeof phaseEngine.propose !== "function" ||
      typeof phaseEngine.execute !== "function" || typeof phaseEngine.commitApproved !== "function") {
    throw new TypeError("PHASE11_ENGINE_CONTRACT_REQUIRED");
  }
  if (!observabilityStore || typeof observabilityStore.append !== "function") {
    throw new TypeError("WAVE10_OBSERVABILITY_STORE_REQUIRED");
  }
  if (semanticPipeline !== null && typeof semanticPipeline.run !== "function") {
    throw new TypeError("PHASE11_SEMANTIC_PIPELINE_CONTRACT_INVALID");
  }
  if (typeof clock !== "function" || typeof makeId !== "function") {
    throw new TypeError("PHASE11_WAVE10_CLOCK_AND_ID_FACTORY_REQUIRED");
  }
  if (!ENVIRONMENTS.has(environment) || !CAPABILITY_STATES.has(capabilityState) ||
      typeof runtimeVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(runtimeVersion)) {
    throw new TypeError("PHASE11_WAVE10_RUNTIME_METADATA_INVALID");
  }
  if (typeof evidenceRefs !== "function" && !Array.isArray(evidenceRefs)) {
    throw new TypeError("PHASE11_WAVE10_EVIDENCE_REFS_INVALID");
  }

  const observed = createObservedOperationRunner({
    store: observabilityStore,
    clock,
    makeEventId: () => makeId()
  });

  function refsFor(step, input) {
    const refs = typeof evidenceRefs === "function" ? evidenceRefs({ step, input }) : evidenceRefs;
    if (!Array.isArray(refs) || refs.length > 32) throw new TypeError("PHASE11_WAVE10_EVIDENCE_REFS_INVALID");
    return structuredClone(refs);
  }

  async function invoke(step, input, execute) {
    const requestId = input?.requestId;
    if (!validRequestId(requestId)) return bad("BLOCKED", "PHASE11_REQUEST_ID_INVALID");

    const operationId = "phase11-" + step.toLowerCase() + "-" + makeId();
    if (!ID.test(operationId)) return bad("BLOCKED", "PHASE11_OPERATION_ID_INVALID");
    const correlationId = "phase11-" + sha256(requestId).slice(0, 40);
    const inputRef = safeOperationRef("phase11/request", sha256(requestId).slice(0, 40));
    if (!inputRef) return bad("BLOCKED", "PHASE11_OPERATION_INPUT_REF_INVALID");

    let operationFailure = null;
    const outcome = await observed.run({
      operation_id: operationId,
      correlation_id: correlationId,
      module_id: "kratt.phase11.integration",
      adapter_id: "wave10.runtime-observatory",
      capability: "phase_upgrade",
      capability_state: capabilityState,
      environment,
      runtime_version: runtimeVersion,
      input_ref: inputRef,
      evidence_refs: refsFor(step, input),
      execute: async () => {
        const result = await execute();
        if (!isPlain(result) || result.ok !== true) {
          operationFailure = typeof result?.reason === "string" ? result.reason :
            typeof result?.status === "string" ? result.status : "PHASE11_STEP_REJECTED";
          throw new Error("PHASE11_STEP_REJECTED");
        }
        return result;
      },
      outputRef: outputReference
    });

    const observation = Object.freeze({
      operationId,
      correlationId,
      moduleId: "kratt.phase11.integration",
      runtimeVersion,
      status: outcome.status === "COMPLETED" ? "succeeded" : outcome.operation_status ?? outcome.status
    });

    if (outcome.status !== "COMPLETED") {
      const uncertainCommit = step === "COMMIT_APPROVED" && outcome.status === "OUTCOME_UNRECORDED";
      return bad(
        outcome.status,
        uncertainCommit ? "COMMIT_OUTCOME_UNRECORDED_RECONCILIATION_REQUIRED" :
          operationFailure ?? outcome.reason ?? "PHASE11_OBSERVED_OPERATION_FAILED",
        {
          operationId,
          observation,
          sideEffectMayHaveCompleted: uncertainCommit
        }
      );
    }

    return Object.freeze({ ...outcome.result, observation });
  }

  async function propose(input = {}) {
    return invoke("PROPOSE", input, () => phaseEngine.propose(input));
  }

  async function execute(input = {}) {
    return invoke("EXECUTE", input, () => phaseEngine.execute(input));
  }

  async function commitApproved(input = {}) {
    return invoke("COMMIT_APPROVED", input, () => phaseEngine.commitApproved(input));
  }

  async function runSemanticPipeline(input = {}) {
    if (!semanticPipeline) return bad("BLOCKED", "SEMANTIC_PIPELINE_NOT_CONFIGURED");
    return invoke("SEMANTIC_PIPELINE", input, () => semanticPipeline.run(input));
  }

  return Object.freeze({
    version: PHASE11_WAVE10_INTEGRATION_VERSION,
    propose,
    execute,
    commitApproved,
    runSemanticPipeline,
    getRun: typeof phaseEngine.getRun === "function" ? phaseEngine.getRun.bind(phaseEngine) : undefined,
    watchEvents: typeof phaseEngine.watchEvents === "function" ? phaseEngine.watchEvents.bind(phaseEngine) : undefined
  });
}
