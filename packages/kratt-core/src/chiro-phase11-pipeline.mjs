import { randomUUID } from "node:crypto";
import { createChiroEvent, createChiroWorkflow, evaluateChiroBundle, transitionChiroWorkflow } from "./chiro-x.mjs";
import { PIP_SCHEMA_VERSION, validatePIPBundle, validatePIPPrivacy } from "./pip-contracts.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const REQUEST_KEYS = ["requestId", "sessionId", "assetRef", "privacy"];
const OPTIONAL_REQUEST_KEYS = ["domain"];

function isPlain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRequest(input) {
  if (!isPlain(input)) return { ok: false, reason: "CHIRO_REQUEST_INVALID" };
  const allowed = new Set([...REQUEST_KEYS, ...OPTIONAL_REQUEST_KEYS]);
  const keys = Reflect.ownKeys(input);
  if (keys.some(key => typeof key !== "string" || !allowed.has(key)) ||
      REQUEST_KEYS.some(key => !Object.hasOwn(input, key)) ||
      keys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(input, key); return !descriptor || !("value" in descriptor) || descriptor.get || descriptor.set; })) {
    return { ok: false, reason: "CHIRO_REQUEST_SHAPE_INVALID" };
  }
  if (![input.requestId, input.sessionId, input.assetRef].every(value =>
      typeof value === "string" && ID.test(value))) {
    return { ok: false, reason: "CHIRO_REQUEST_IDENTIFIER_INVALID" };
  }
  if (input.domain !== undefined && (typeof input.domain !== "string" || !ID.test(input.domain))) {
    return { ok: false, reason: "CHIRO_DOMAIN_INVALID" };
  }
  const privacy = validatePIPPrivacy(input.privacy);
  if (!privacy.ok) return { ok: false, reason: privacy.errors[0], errors: privacy.errors };
  return { ok: true, value: { ...input, privacy: privacy.value } };
}

function readTime(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("CHIRO_CLOCK_INVALID");
  return date.toISOString();
}

/**
 * Creates a provider-neutral PIP pipeline compatible with Phase 11's
 * semanticPipeline.run(input) contract.
 *
 * AURA selects and injects the providers. The pipeline itself never stores
 * image bytes, never selects credentials, and never performs external writes.
 */
export function createChiroPhase11Pipeline({
  visionProvider,
  interpretationProvider,
  verifyInterpretation,
  eventSink = null,
  clock = () => new Date(),
  makeId = () => randomUUID()
} = {}) {
  if (!visionProvider || typeof visionProvider.extractObservations !== "function")
    throw new TypeError("CHIRO_VISION_PROVIDER_REQUIRED");
  if (!interpretationProvider || typeof interpretationProvider.proposeInterpretations !== "function")
    throw new TypeError("CHIRO_INTERPRETATION_PROVIDER_REQUIRED");
  if (verifyInterpretation !== undefined && typeof verifyInterpretation !== "function")
    throw new TypeError("CHIRO_TRUSTED_VERIFIER_INVALID");
  if (eventSink !== null && typeof eventSink !== "function" &&
      typeof eventSink.append !== "function")
    throw new TypeError("CHIRO_EVENT_SINK_INVALID");
  if (typeof clock !== "function" || typeof makeId !== "function")
    throw new TypeError("CHIRO_CLOCK_AND_ID_FACTORY_REQUIRED");

  async function emit(eventType, request, payload, occurredAt) {
    const event = createChiroEvent({
      event_id: makeId(),
      event_type: eventType,
      occurred_at: occurredAt,
      correlation_id: request.requestId,
      session_id: request.sessionId,
      actor: { type: "SYSTEM", id: "chiro-runtime" },
      payload
    });
    if (!event.ok) throw new Error("CHIRO_EVENT_INVALID");
    if (eventSink === null) return;
    if (typeof eventSink === "function") await eventSink(event.value);
    else await eventSink.append(event.value);
  }

  async function run(input = {}) {
    const checked = validateRequest(input);
    if (!checked.ok) return Object.freeze({ ok: false, status: "BLOCKED", reason: checked.reason, errors: checked.errors ?? [] });
    const request = checked.value;
    let saga;

    try {
      const createdAt = readTime(clock);
      saga = createChiroWorkflow({
        id: "chiro:" + request.sessionId,
        sessionId: request.sessionId,
        createdAt
      });
      const started = transitionChiroWorkflow(saga, "RUNNING", {
        id: makeId(), at: createdAt, kind: "observation_started"
      });
      if (!started.ok) return Object.freeze({ ok: false, status: "BLOCKED", reason: started.reason });
      saga = started.value;
      await emit("chiro.session.created", request, {
        processing_mode: request.privacy.processing_mode,
        domain: request.domain ?? "CHIROMANCY_TRADITIONS"
      }, createdAt);
    } catch {
      return Object.freeze({ ok: false, status: "BLOCKED", reason: "CHIRO_SESSION_INITIALIZATION_FAILED" });
    }

    let observations;
    try {
      observations = await visionProvider.extractObservations(Object.freeze({
        assetRef: request.assetRef,
        sessionId: request.sessionId,
        processingMode: request.privacy.processing_mode,
        privacy: request.privacy,
        correlationId: request.requestId
      }));
    } catch {
      return Object.freeze({ ok: false, status: "FAILED", reason: "CHIRO_VISION_PROVIDER_FAILED", workflow: { id: saga.id, state: saga.state } });
    }
    if (!Array.isArray(observations)) {
      return Object.freeze({ ok: false, status: "FAILED", reason: "CHIRO_VISION_RESULT_INVALID", workflow: { id: saga.id, state: saga.state } });
    }

    // Validate and freeze observations before exposing them to a second model.
    // This prevents provider output from smuggling raw assets or mutating evidence.
    const observedBundle = validatePIPBundle({
      schema_version: PIP_SCHEMA_VERSION,
      session_id: request.sessionId,
      created_at: readTime(clock),
      privacy: request.privacy,
      observations,
      interpretations: []
    });
    if (!observedBundle.ok) {
      return Object.freeze({
        ok: false, status: "FAILED", reason: "CHIRO_VISION_RESULT_INVALID",
        errors: observedBundle.errors, workflow: { id: saga.id, state: saga.state }
      });
    }
    observations = observedBundle.value.observations;

    const observationStep = transitionChiroWorkflow(saga, "RUNNING", {
      id: makeId(), at: readTime(clock), kind: "observation_completed",
      meta: { observation_count: observations.length }
    });
    if (!observationStep.ok) return Object.freeze({ ok: false, status: "FAILED", reason: observationStep.reason });
    saga = observationStep.value;

    let interpretations;
    try {
      interpretations = await interpretationProvider.proposeInterpretations(Object.freeze({
        sessionId: request.sessionId,
        domain: request.domain ?? "CHIROMANCY_TRADITIONS",
        observations,
        correlationId: request.requestId
      }));
    } catch {
      return Object.freeze({ ok: false, status: "FAILED", reason: "CHIRO_INTERPRETATION_PROVIDER_FAILED", workflow: { id: saga.id, state: saga.state } });
    }
    if (!Array.isArray(interpretations)) {
      return Object.freeze({ ok: false, status: "FAILED", reason: "CHIRO_INTERPRETATION_RESULT_INVALID", workflow: { id: saga.id, state: saga.state } });
    }

    let report;
    try {
      const bundle = {
        schema_version: PIP_SCHEMA_VERSION,
        session_id: request.sessionId,
        created_at: readTime(clock),
        privacy: request.privacy,
        observations,
        interpretations
      };
      report = evaluateChiroBundle(bundle, { verifyInterpretation });
      if (!report.ok) {
        return Object.freeze({
          ok: false, status: "BLOCKED", reason: "CHIRO_PIP_VALIDATION_FAILED",
          errors: report.errors, workflow: { id: saga.id, state: saga.state }
        });
      }
      await emit("chiro.observation.recorded", request, { observation_count: observations.length }, readTime(clock));
      await emit("chiro.interpretation.proposed", request, { interpretation_count: interpretations.length }, readTime(clock));
      await emit("chiro.validation.completed", request, {
        report_status: report.status,
        requires_human_review: report.requires_human_review
      }, readTime(clock));
    } catch {
      return Object.freeze({ ok: false, status: "FAILED", reason: "CHIRO_PIPELINE_FINALIZATION_FAILED", workflow: { id: saga.id, state: saga.state } });
    }

    const completed = transitionChiroWorkflow(saga, "SUCCEEDED", {
      id: makeId(), at: readTime(clock), kind: "analysis_completed",
      meta: { report_status: report.status }
    });
    if (!completed.ok) return Object.freeze({ ok: false, status: "FAILED", reason: completed.reason });

    return Object.freeze({
      ok: true,
      status: report.status,
      report,
      workflow: Object.freeze({
        id: completed.value.id,
        state: completed.value.state,
        version: completed.value.version
      })
    });
  }

  return Object.freeze({
    version: "chiro-phase11-pipeline/1.0.0",
    run
  });
}
