import { createHash, randomUUID } from "node:crypto";

export const CONSTRUCTION_STATES = Object.freeze([
  "PROPOSED", "IN_REVIEW", "APPROVED", "IMPLEMENTED", "VERIFIED", "BLOCKED", "CANCELLED"
]);

const TRANSITIONS = Object.freeze({
  PROPOSED: ["IN_REVIEW", "BLOCKED", "CANCELLED"],
  IN_REVIEW: ["APPROVED", "BLOCKED", "CANCELLED"],
  APPROVED: ["IMPLEMENTED", "BLOCKED", "CANCELLED"],
  IMPLEMENTED: ["VERIFIED", "IN_REVIEW", "BLOCKED"],
  VERIFIED: [],
  BLOCKED: ["IN_REVIEW", "CANCELLED"],
  CANCELLED: []
});

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{40,64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

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

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  throw new TypeError("UNSUPPORTED_CANONICAL_VALUE");
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stable(value), "utf8").digest("hex")}`;
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

/**
 * Create an immutable, evidence-oriented construction task.
 * This module describes workflow state only; it does not authorize tools,
 * execute code, or grant repository/production permissions.
 */
export function createConstructionTask(input, { now = () => new Date().toISOString(), id = randomUUID } = {}) {
  if (!plain(input)) return { ok: false, reason: "INVALID_TASK_INPUT" };
  const required = ["goal", "base_commit", "target_scope", "required_evidence", "builder_id"];
  if (required.some(key => !Object.hasOwn(input, key))) return { ok: false, reason: "MISSING_REQUIRED_FIELD" };
  if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.length > 4000)
    return { ok: false, reason: "INVALID_GOAL" };
  if (typeof input.base_commit !== "string" || !SHA.test(input.base_commit))
    return { ok: false, reason: "INVALID_BASE_COMMIT" };
  if (!Array.isArray(input.target_scope) || input.target_scope.length < 1 ||
      input.target_scope.some(x => typeof x !== "string" || !x.trim() || x.length > 300))
    return { ok: false, reason: "INVALID_TARGET_SCOPE" };
  if (!Array.isArray(input.required_evidence) || input.required_evidence.length < 1 ||
      input.required_evidence.some(x => typeof x !== "string" || !x.trim() || x.length > 300))
    return { ok: false, reason: "INVALID_REQUIRED_EVIDENCE" };
  if (!validId(input.builder_id)) return { ok: false, reason: "INVALID_BUILDER_ID" };
  if (input.parent_task_id !== undefined && !validId(input.parent_task_id))
    return { ok: false, reason: "INVALID_PARENT_TASK_ID" };

  let createdAt;
  try { createdAt = now(); } catch { return { ok: false, reason: "CLOCK_UNAVAILABLE" }; }
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))
    return { ok: false, reason: "INVALID_CLOCK_VALUE" };

  const task = {
    schema_version: "kratt-construction/v1",
    task_id: id(),
    ...(input.parent_task_id ? { parent_task_id: input.parent_task_id } : {}),
    goal: input.goal.trim(),
    base_commit: input.base_commit,
    target_scope: [...new Set(input.target_scope.map(x => x.trim()))].sort(),
    required_evidence: [...new Set(input.required_evidence.map(x => x.trim()))].sort(),
    builder_id: input.builder_id,
    status: "PROPOSED",
    created_at: createdAt,
    revision: 0,
    history: []
  };
  if (!validId(task.task_id)) return { ok: false, reason: "INVALID_TASK_ID" };
  return { ok: true, task: freezeDeep(task), task_digest: digest(task) };
}

/**
 * Apply a guarded state transition. Reviewer and verifier must be distinct
 * from the builder. Evidence references are opaque IDs supplied by trusted
 * host-side verification; this function does not authenticate them.
 */
export function transitionConstructionTask(taskInput, transition) {
  if (!plain(taskInput) || !plain(transition)) return { ok: false, reason: "INVALID_TRANSITION_INPUT" };
  const task = taskInput;
  if (task.schema_version !== "kratt-construction/v1" || !CONSTRUCTION_STATES.includes(task.status))
    return { ok: false, reason: "INVALID_TASK_STATE" };
  if (!TRANSITIONS[task.status]?.includes(transition.to))
    return { ok: false, reason: "TRANSITION_NOT_ALLOWED" };
  if (!validId(transition.actor_id)) return { ok: false, reason: "INVALID_ACTOR" };
  if (transition.to === "APPROVED" && transition.actor_id === task.builder_id)
    return { ok: false, reason: "BUILDER_CANNOT_APPROVE_OWN_TASK" };
  if (transition.to === "VERIFIED" && transition.actor_id === task.builder_id)
    return { ok: false, reason: "BUILDER_CANNOT_VERIFY_OWN_TASK" };
  if (["APPROVED", "VERIFIED"].includes(transition.to) &&
      (!Array.isArray(transition.evidence_refs) || transition.evidence_refs.length === 0 ||
       transition.evidence_refs.some(x => !validId(x))))
    return { ok: false, reason: "REQUIRED_EVIDENCE_REFERENCES_MISSING" };
  if (transition.to === "IMPLEMENTED" && !DIGEST.test(transition.change_digest ?? ""))
    return { ok: false, reason: "CHANGE_DIGEST_REQUIRED" };
  if (transition.to === "BLOCKED" && (typeof transition.reason !== "string" || !transition.reason.trim()))
    return { ok: false, reason: "BLOCK_REASON_REQUIRED" };

  let at;
  try { at = transition.at ?? new Date().toISOString(); } catch { return { ok: false, reason: "CLOCK_UNAVAILABLE" }; }
  if (typeof at !== "string" || !Number.isFinite(Date.parse(at)))
    return { ok: false, reason: "INVALID_TRANSITION_TIME" };

  const event = {
    revision: task.revision + 1,
    from: task.status,
    to: transition.to,
    actor_id: transition.actor_id,
    at,
    ...(transition.reason ? { reason: transition.reason } : {}),
    ...(transition.change_digest ? { change_digest: transition.change_digest } : {}),
    ...(transition.evidence_refs ? { evidence_refs: [...new Set(transition.evidence_refs)] } : {})
  };
  const next = {
    ...task,
    status: transition.to,
    revision: event.revision,
    history: [...task.history, event]
  };
  return { ok: true, task: freezeDeep(next), task_digest: digest(next) };
}

export function verifyConstructionTask(task) {
  if (!plain(task) || task.schema_version !== "kratt-construction/v1" ||
      !CONSTRUCTION_STATES.includes(task.status) || !Number.isInteger(task.revision) ||
      !Array.isArray(task.history) || task.revision !== task.history.length)
    return { ok: false, reason: "TASK_SHAPE_INVALID" };
  let previous = "PROPOSED";
  for (let i = 0; i < task.history.length; i += 1) {
    const event = task.history[i];
    if (!plain(event) || event.revision !== i + 1 || event.from !== previous ||
        !TRANSITIONS[previous]?.includes(event.to) || !validId(event.actor_id) ||
        typeof event.at !== "string" || !Number.isFinite(Date.parse(event.at)))
      return { ok: false, reason: "HISTORY_INVALID", revision: i + 1 };
    previous = event.to;
  }
  if (previous !== task.status) return { ok: false, reason: "STATUS_HISTORY_MISMATCH" };
  return { ok: true, task_digest: digest(task), revision: task.revision };
}
