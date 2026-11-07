/** KRATT PRIME policy routing: pure planning only, never executes an operation. */
import { evaluateAdapterOperation } from "./adapter-registry.mjs";

const deny = reason => Object.freeze({ decision: "BLOCKED", reason, executionStarted: false });
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const record = value => value !== null && typeof value === "object" &&
  !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype ||
  Object.getPrototypeOf(value) === null);

/**
 * Only trusted server-side callers may supply the verified context.
 * A routing decision is not an authorization token or an execution grant.
 */
export function routePolicyOperation(request, trustedContext) {
  if (!record(request) || !record(trustedContext)) return deny("POLICY_CONTEXT_INVALID");
  if (Reflect.ownKeys(request).some(key => !["manifest", "operationId", "target"].includes(key)))
    return deny("POLICY_REQUEST_FIELDS_UNTRUSTED");
  if (Reflect.ownKeys(trustedContext).some(key =>
      !["principalScopes", "agentScopes", "taskScopes", "now", "approval"].includes(key)))
    return deny("POLICY_TRUSTED_CONTEXT_INVALID");
  for (const field of ["principalScopes", "agentScopes", "taskScopes", "now"]) {
    if (!own(trustedContext, field)) return deny("POLICY_TRUSTED_CONTEXT_INCOMPLETE");
  }
  try {
    const decision = evaluateAdapterOperation({
      manifest: request.manifest,
      operationId: request.operationId,
      target: request.target,
      principalScopes: trustedContext.principalScopes,
      agentScopes: trustedContext.agentScopes,
      taskScopes: trustedContext.taskScopes,
      now: trustedContext.now,
      approval: trustedContext.approval
    });
    if (!record(decision) || !["ALLOW", "DENY", "BLOCKED"].includes(decision.decision) ||
        decision.executionStarted !== false) return deny("POLICY_DECISION_INVALID");
    return decision;
  } catch {
    return deny("POLICY_EVALUATION_FAILED");
  }
}
