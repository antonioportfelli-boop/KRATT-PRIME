import { createSaga, transitionSaga } from "./saga.mjs";
import {
  PIP_SCHEMA_VERSION,
  PIP_VALIDATION_STATES,
  validatePIPBundle,
  validatePIPEvent
} from "./pip-contracts.mjs";

export const CHIRO_AGENT_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: "chiro-vision",
    scopes: Object.freeze(["pip.session.read", "pip.observation.write"]),
    status: "active"
  }),
  Object.freeze({
    id: "chiro-interpreter",
    scopes: Object.freeze(["pip.observation.read", "pip.interpretation.write"]),
    status: "active"
  }),
  Object.freeze({
    id: "chiro-skeptic",
    scopes: Object.freeze(["pip.interpretation.read", "pip.source.read", "pip.validation.write"]),
    status: "active"
  })
]);

export const CHIRO_TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({ name: "pip.observation.create", requiredScopes: Object.freeze(["pip.observation.write"]) }),
  Object.freeze({ name: "pip.interpretation.propose", requiredScopes: Object.freeze(["pip.interpretation.write"]) }),
  Object.freeze({ name: "pip.analysis.verify", requiredScopes: Object.freeze(["pip.validation.write"]) })
]);

export const CHIRO_LIMITATIONS = Object.freeze([
  "Visual detection confidence is not evidence that a symbolic interpretation is true.",
  "Chiromancy traditions are represented as historical or symbolic claims, not scientific predictions.",
  "The system must not infer identity, health, lifespan, personality, employability, creditworthiness, or future events from palm images.",
  "Raw images are not part of PIP bundles; retain them only under explicit, separate user approval.",
  "Model agreement is not proof of truth."
]);

export function registerChiroAgents(registry) {
  if (!registry || typeof registry.registerAgent !== "function" ||
      typeof registry.registerTool !== "function") {
    return { ok: false, errors: ["CHIRO_AGENT_REGISTRY_REQUIRED"] };
  }

  const agentResults = CHIRO_AGENT_DEFINITIONS.map(agent => ({
    id: agent.id,
    ...registry.registerAgent({ id: agent.id, scopes: [...agent.scopes], status: agent.status })
  }));
  const toolResults = CHIRO_TOOL_DEFINITIONS.map(tool => ({
    name: tool.name,
    ...registry.registerTool({ name: tool.name, requiredScopes: [...tool.requiredScopes] })
  }));
  const errors = [
    ...agentResults.filter(result => !result.ok).map(result => "AGENT_" + result.id.toUpperCase().replaceAll("-", "_") + "_" + result.reason),
    ...toolResults.filter(result => !result.ok).map(result => "TOOL_" + result.name.toUpperCase().replaceAll(".", "_") + "_" + result.reason)
  ];
  return { ok: errors.length === 0, agents: agentResults, tools: toolResults, errors };
}

function normalizedStatement(value) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function findSurfaceDivergence(interpretations) {
  const groups = new Map();
  for (const item of interpretations) {
    const observationKey = [...item.observation_ids].sort().join(",");
    const key = item.domain + "|" + observationKey;
    if (!groups.has(key)) {
      groups.set(key, {
        domain: item.domain,
        observation_ids: [...item.observation_ids].sort(),
        candidates: [],
        statements: new Set(),
        producers: new Set()
      });
    }
    const group = groups.get(key);
    group.candidates.push(item.id);
    group.statements.add(normalizedStatement(item.statement));
    group.producers.add(item.producer_id);
  }
  return [...groups.values()]
    .filter(group => group.producers.size > 1 && group.statements.size > 1)
    .map(group => Object.freeze({
      domain: group.domain,
      observation_ids: Object.freeze(group.observation_ids),
      candidate_ids: Object.freeze(group.candidates),
      producer_count: group.producers.size,
      distinct_statement_count: group.statements.size,
      meaning: "SURFACE_DIVERGENCE_REQUIRES_REVIEW"
    }));
}

/**
 * Validates an incoming PIP bundle and applies a separately injected trusted
 * verifier. The bundle itself cannot declare an interpretation SUPPORTED.
 *
 * verifyInterpretation must be a synchronous, independently controlled
 * function. It returns { state, verifiedSourceRefs, reasonCode }.
 */
export function evaluateChiroBundle(bundle, { verifyInterpretation } = {}) {
  const checked = validatePIPBundle(bundle);
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const value = checked.value;
  const observationById = new Map(value.observations.map(item => [item.id, item]));
  const reviews = value.interpretations.map(interpretation => {
    if (typeof verifyInterpretation !== "function") {
      return Object.freeze({
        interpretation_id: interpretation.id,
        state: "UNVERIFIED",
        reason_code: "TRUSTED_INTERPRETER_NOT_CONFIGURED",
        verified_source_refs: Object.freeze([])
      });
    }

    let result;
    try {
      result = verifyInterpretation(interpretation, {
        session_id: value.session_id,
        observations: interpretation.observation_ids.map(id => observationById.get(id))
      });
    } catch {
      result = null;
    }

    if (result && typeof result.then === "function") {
      return Object.freeze({
        interpretation_id: interpretation.id,
        state: "BLOCKED",
        reason_code: "ASYNC_VERIFIER_REQUIRES_ASYNC_RUNTIME",
        verified_source_refs: Object.freeze([])
      });
    }

    if (!result || !PIP_VALIDATION_STATES.includes(result.state) ||
        !Array.isArray(result.verifiedSourceRefs) ||
        result.verifiedSourceRefs.some(ref => typeof ref !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(ref))) {
      return Object.freeze({
        interpretation_id: interpretation.id,
        state: "BLOCKED",
        reason_code: "VERIFIER_RESULT_INVALID",
        verified_source_refs: Object.freeze([])
      });
    }

    let state = result.state;
    let reasonCode = typeof result.reasonCode === "string" && result.reasonCode.length <= 128
      ? result.reasonCode
      : "VERIFIER_COMPLETED";

    // A symbolic hypothesis cannot be promoted to a validated factual claim.
    if (interpretation.kind === "HYPOTHESIS" && state === "SUPPORTED") {
      state = "BLOCKED";
      reasonCode = "HYPOTHESIS_CANNOT_BE_PROMOTED_TO_SOURCE_FACT";
    }

    if (interpretation.kind === "SOURCE_CLAIM" && state === "SUPPORTED" &&
        interpretation.source_refs.some(ref => !result.verifiedSourceRefs.includes(ref))) {
      state = "BLOCKED";
      reasonCode = "SOURCE_REFERENCE_NOT_VERIFIED";
    }

    return Object.freeze({
      interpretation_id: interpretation.id,
      state,
      reason_code: reasonCode,
      verified_source_refs: Object.freeze([...new Set(result.verifiedSourceRefs)])
    });
  });

  const divergence = findSurfaceDivergence(value.interpretations);
  const requiresHumanReview = value.interpretations.length === 0 || reviews.some(item => item.state !== "SUPPORTED") || divergence.length > 0;
  const status = value.interpretations.length === 0 ? "NO_INTERPRETATIONS" : requiresHumanReview ? "REVIEW_REQUIRED" : "SOURCE_CLAIMS_SUPPORTED";

  return Object.freeze({
    ok: true,
    schema_version: PIP_SCHEMA_VERSION,
    session_id: value.session_id,
    status,
    observations: value.observations,
    interpretations: value.interpretations,
    reviews: Object.freeze(reviews),
    surface_divergence: Object.freeze(divergence),
    requires_human_review: requiresHumanReview,
    privacy: value.privacy,
    limitations: CHIRO_LIMITATIONS
  });
}

export function createChiroEvent(input) {
  const checked = validatePIPEvent({
    ...input,
    schema_version: PIP_SCHEMA_VERSION
  });
  if (!checked.ok) return checked;
  return { ok: true, value: checked.value };
}

export function createChiroWorkflow({ id, sessionId, createdAt }) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(sessionId)) {
    throw new TypeError("CHIRO_SESSION_ID_INVALID");
  }
  return createSaga({
    id,
    goal: "CHIRO-X interpretation session " + sessionId,
    createdAt
  });
}

export function transitionChiroWorkflow(saga, nextState, event) {
  if (!event || typeof event.kind !== "string" || !event.kind.trim()) {
    return { ok: false, reason: "CHIRO_WORKFLOW_EVENT_INVALID" };
  }
  return transitionSaga(saga, nextState, {
    ...event,
    kind: "CHIRO_" + event.kind.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
  });
}
