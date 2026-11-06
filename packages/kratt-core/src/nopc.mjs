/**
 * KRATT PRIME — Neuro-Organic Polymorphic Core (NOPC), v0.1
 *
 * Pure proposal layer only. It may adapt presentation preferences and propose
 * bounded task ordering/agent assignment. It NEVER authorizes or executes work.
 * Every proposed operation must pass the existing KRATT policy/runtime gates.
 */

export const NOPC_MODES = Object.freeze([
  "LOW_STIMULATION",
  "STANDARD",
  "DEEP_FOCUS",
  "CUSTOM"
]);

export const NOPC_DENSITIES = Object.freeze(["COMPACT", "COMFORTABLE", "SPACIOUS"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const hasOnlyKeys = (value, allowed) =>
  value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));
const isStringArray = value =>
  Array.isArray(value) && value.length <= 64 &&
  value.every(item => typeof item === "string" && item.length > 0 && item.length <= 128);

/**
 * Validate and normalize user-selected UI preferences.
 * No diagnosis, emotion, mood or health inference is performed.
 */
export function createInteractionPreferences(input = {}) {
  const allowed = ["mode", "density", "reducedMotion", "quietNotifications", "textScale"];
  if (!hasOnlyKeys(input, allowed)) {
    return { ok: false, reason: "PREFERENCES_SHAPE_INVALID" };
  }
  const mode = input.mode ?? "STANDARD";
  const density = input.density ?? "COMFORTABLE";
  const reducedMotion = input.reducedMotion ?? false;
  const quietNotifications = input.quietNotifications ?? false;
  const textScale = input.textScale ?? 1;

  if (!NOPC_MODES.includes(mode)) return { ok: false, reason: "MODE_UNSUPPORTED" };
  if (!NOPC_DENSITIES.includes(density)) return { ok: false, reason: "DENSITY_UNSUPPORTED" };
  if (typeof reducedMotion !== "boolean" || typeof quietNotifications !== "boolean") {
    return { ok: false, reason: "PREFERENCE_FLAG_INVALID" };
  }
  if (typeof textScale !== "number" || !Number.isFinite(textScale) || textScale < 0.8 || textScale > 2) {
    return { ok: false, reason: "TEXT_SCALE_OUT_OF_RANGE" };
  }

  return {
    ok: true,
    value: Object.freeze({
      mode, density, reducedMotion, quietNotifications, textScale,
      source: "USER_SELECTED"
    })
  };
}

const validTask = task =>
  task && typeof task === "object" && !Array.isArray(task) &&
  ID.test(task.id ?? "") &&
  isStringArray(task.requiredCapabilities ?? []) &&
  isStringArray(task.dependsOn ?? []) &&
  Number.isFinite(task.priority ?? 0) &&
  (task.status === undefined || task.status === "PENDING" || task.status === "COMPLETED");

const validAgent = agent =>
  agent && typeof agent === "object" && !Array.isArray(agent) &&
  ID.test(agent.id ?? "") &&
  isStringArray(agent.capabilities ?? []) &&
  Number.isInteger(agent.maxConcurrent ?? 1) && agent.maxConcurrent >= 1 &&
  (agent.enabled === undefined || typeof agent.enabled === "boolean");

/**
 * Deterministic bounded planner. Capability matching is a scheduling hint,
 * not authorization. Returned assignments are proposals and are not executed.
 */
export function proposeAgentPlan({ tasks, agents, maxConcurrent = 4 } = {}) {
  if (!Array.isArray(tasks) || tasks.length > 256 || !tasks.every(validTask)) {
    return { ok: false, reason: "TASK_SET_INVALID" };
  }
  if (!Array.isArray(agents) || agents.length > 128 || !agents.every(validAgent)) {
    return { ok: false, reason: "AGENT_SET_INVALID" };
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) {
    return { ok: false, reason: "CONCURRENCY_LIMIT_INVALID" };
  }

  const taskIds = new Set(tasks.map(task => task.id));
  if (taskIds.size !== tasks.length) return { ok: false, reason: "DUPLICATE_TASK_ID" };
  const agentIds = new Set(agents.map(agent => agent.id));
  if (agentIds.size !== agents.length) return { ok: false, reason: "DUPLICATE_AGENT_ID" };

  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    if (task.dependsOn.some(id => !taskIds.has(id) || id === task.id)) {
      return { ok: false, reason: "DEPENDENCY_INVALID" };
    }
  }

  const completed = new Set(tasks.filter(t => t.status === "COMPLETED").map(t => t.id));
  const pending = new Set(tasks.filter(t => t.status !== "COMPLETED").map(t => t.id));
  const assignedCounts = new Map(agents.map(agent => [agent.id, 0]));
  const active = agents.filter(agent => agent.enabled !== false);
  const assignments = [];
  const blocked = [];
  let rounds = 0;

  while (pending.size && rounds++ <= tasks.length) {
    const ready = [...pending]
      .map(id => byId.get(id))
      .filter(task => task.dependsOn.every(dep => completed.has(dep)))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));

    if (!ready.length) break;

    for (const task of ready) {
      if (assignments.length >= maxConcurrent) {
        blocked.push({ taskId: task.id, reason: "PLAN_CONCURRENCY_LIMIT" });
        continue;
      }
      const required = new Set(task.requiredCapabilities ?? []);
      const candidates = active
        .filter(agent =>
          [...required].every(cap => agent.capabilities.includes(cap)) &&
          assignedCounts.get(agent.id) < agent.maxConcurrent
        )
        .sort((a, b) =>
          assignedCounts.get(a.id) - assignedCounts.get(b.id) || a.id.localeCompare(b.id)
        );
      if (!candidates.length) {
        blocked.push({ taskId: task.id, reason: "NO_CAPABLE_AGENT" });
        continue;
      }
      const agent = candidates[0];
      assignments.push(Object.freeze({
        taskId: task.id,
        agentId: agent.id,
        requiredCapabilities: Object.freeze([...required].sort()),
        state: "PROPOSED"
      }));
      assignedCounts.set(agent.id, assignedCounts.get(agent.id) + 1);
      completed.add(task.id);
      pending.delete(task.id);
    }
    if (assignments.length >= maxConcurrent) break;
  }

  for (const id of pending) {
    if (!blocked.some(item => item.taskId === id)) {
      blocked.push({ taskId: id, reason: "DEPENDENCY_CYCLE_OR_UNRESOLVED_DEPENDENCY" });
    }
  }

  return {
    ok: true,
    plan: Object.freeze({
      state: "PROPOSAL_ONLY",
      requiresPolicyEvaluation: true,
      requiresApprovalPerExistingPolicy: true,
      assignments: Object.freeze(assignments),
      blocked: Object.freeze(blocked),
      unassignedTaskIds: Object.freeze([...pending]),
      agentPrivilegeChanges: false,
      executionStarted: false
    })
  };
}
