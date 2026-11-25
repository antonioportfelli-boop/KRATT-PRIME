import { verifyConstructionTask } from "./construction-protocol.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESULTS = new Set(["PASS", "FAIL"]);

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}

/**
 * Produce a deterministic reflection report from host-verified observations.
 * This function does not verify evidence authenticity, change task state, create
 * follow-up tasks, or invoke tools. The caller must supply observations only
 * after validating their provenance through the trusted runtime.
 */
export function reflectConstructionTask(task, observations) {
  const integrity = verifyConstructionTask(task);
  if (!integrity.ok) return { ok: false, reason: "TASK_INTEGRITY_INVALID", detail: integrity.reason };
  if (!["IMPLEMENTED", "VERIFIED"].includes(task.status))
    return { ok: false, reason: "TASK_NOT_READY_FOR_REFLECTION" };
  if (!plain(observations) || !Array.isArray(observations.evidence) ||
      !Array.isArray(observations.failed_checks ?? []))
    return { ok: false, reason: "INVALID_REFLECTION_INPUT" };

  const required = [...new Set(task.required_evidence)];
  const seen = new Set();
  const evidence = [];
  for (const item of observations.evidence) {
    if (!plain(item) || !ID.test(item.evidence_id ?? "") ||
        !required.includes(item.requirement) || !RESULTS.has(item.result) ||
        seen.has(item.evidence_id))
      return { ok: false, reason: "INVALID_EVIDENCE_OBSERVATION" };
    seen.add(item.evidence_id);
    evidence.push({
      evidence_id: item.evidence_id,
      requirement: item.requirement,
      result: item.result
    });
  }

  const failedChecks = observations.failed_checks ?? [];
  if (failedChecks.some(x => typeof x !== "string" || !x.trim() || x.length > 300))
    return { ok: false, reason: "INVALID_FAILED_CHECK" };

  const passedRequirements = new Set(evidence.filter(x => x.result === "PASS").map(x => x.requirement));
  const failedRequirements = new Set(evidence.filter(x => x.result === "FAIL").map(x => x.requirement));
  const missingRequirements = required.filter(x => !passedRequirements.has(x));
  const failures = [...new Set([
    ...failedChecks,
    ...[...failedRequirements].map(x => `EVIDENCE_FAILED:${x}`)
  ])].sort();

  let outcome;
  if (failures.length) outcome = "NEEDS_REWORK";
  else if (missingRequirements.length) outcome = "INSUFFICIENT_EVIDENCE";
  else if (task.status === "IMPLEMENTED") outcome = "READY_FOR_INDEPENDENT_VERIFICATION";
  else outcome = "COMPLETE";

  const report = {
    schema_version: "kratt-reflection/v1",
    task_id: task.task_id,
    task_digest: integrity.task_digest,
    revision: task.revision,
    outcome,
    evidence_refs: evidence.map(x => x.evidence_id).sort(),
    passed_requirements: [...passedRequirements].sort(),
    missing_requirements: missingRequirements,
    failed_checks: failures,
    follow_up: outcome === "NEEDS_REWORK" || outcome === "INSUFFICIENT_EVIDENCE"
      ? {
          kind: "REWORK_PROPOSAL",
          parent_task_id: task.task_id,
          goal: outcome === "NEEDS_REWORK"
            ? "Address the failed checks and submit a revised implementation for independent review."
            : "Collect the missing required evidence before requesting independent verification.",
          unresolved: [...failures, ...missingRequirements.map(x => `MISSING_EVIDENCE:${x}`)].sort()
        }
      : null
  };
  return { ok: true, report: freezeDeep(report) };
}
