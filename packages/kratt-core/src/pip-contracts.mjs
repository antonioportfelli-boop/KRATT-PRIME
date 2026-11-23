export const PIP_SCHEMA_VERSION = "pip/v1";

export const PIP_MODALITIES = Object.freeze(["IMAGE", "TEXT", "AUDIO", "STRUCTURE"]);
export const PIP_PROVENANCE_TYPES = Object.freeze([
  "USER_INPUT", "MODEL_OUTPUT", "HUMAN_REVIEW", "RETRIEVED_SOURCE"
]);
export const PIP_INTERPRETATION_KINDS = Object.freeze(["SOURCE_CLAIM", "HYPOTHESIS"]);
export const PIP_VALIDATION_STATES = Object.freeze([
  "UNVERIFIED", "SUPPORTED", "CONTRADICTED", "INSUFFICIENT_EVIDENCE", "BLOCKED"
]);
export const PIP_EVENT_TYPES = Object.freeze([
  "chiro.session.created",
  "chiro.observation.recorded",
  "chiro.interpretation.proposed",
  "chiro.validation.completed"
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || !allowed.has(key))) return false;
  if (required.some(key => !Object.hasOwn(value, key))) return false;
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && !descriptor.get && !descriptor.set;
  });
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validText(value, max = 2000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function validTimestamp(value) {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
}

function validIdArray(value, max = 64) {
  return Array.isArray(value) && value.length <= max &&
    value.every(validId) && new Set(value).size === value.length;
}

function validUnitInterval(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === "object" && !seen.has(value)) {
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
    Object.freeze(value);
  }
  return value;
}

function finish(ok, errors, value) {
  return ok
    ? { ok: true, value: deepFreeze(structuredClone(value)) }
    : { ok: false, errors: [...new Set(errors)] };
}

export function validatePIPPrivacy(input) {
  const keys = [
    "consent_granted",
    "processing_mode",
    "remote_processing_approved",
    "retain_raw_input",
    "retention_approved",
    "model_training_opt_in"
  ];
  if (!exactKeys(input, keys)) return { ok: false, errors: ["PIP_PRIVACY_SHAPE_INVALID"] };

  const errors = [];
  if (input.consent_granted !== true) errors.push("PIP_CONSENT_REQUIRED");
  if (!["LOCAL_ONLY", "REMOTE_APPROVED"].includes(input.processing_mode))
    errors.push("PIP_PROCESSING_MODE_INVALID");
  if (typeof input.remote_processing_approved !== "boolean" ||
      typeof input.retain_raw_input !== "boolean" ||
      typeof input.retention_approved !== "boolean" ||
      typeof input.model_training_opt_in !== "boolean")
    errors.push("PIP_PRIVACY_FLAGS_INVALID");
  if (input.processing_mode === "REMOTE_APPROVED" && input.remote_processing_approved !== true)
    errors.push("PIP_REMOTE_PROCESSING_NOT_APPROVED");
  if (input.retain_raw_input && input.retention_approved !== true)
    errors.push("PIP_RAW_RETENTION_NOT_APPROVED");

  return finish(errors.length === 0, errors, input);
}

export function validatePIPObservation(input) {
  const required = ["id", "modality", "feature_type", "extraction_confidence", "provenance"];
  const optional = ["region", "label", "note", "model_id", "model_version"];
  if (!exactKeys(input, required, optional))
    return { ok: false, errors: ["PIP_OBSERVATION_SHAPE_INVALID"] };

  const errors = [];
  if (!validId(input.id) || !PIP_MODALITIES.includes(input.modality) || !validId(input.feature_type))
    errors.push("PIP_OBSERVATION_IDENTIFIER_INVALID");
  if (!validUnitInterval(input.extraction_confidence))
    errors.push("PIP_EXTRACTION_CONFIDENCE_INVALID");
  if (input.label !== undefined && !validText(input.label, 160))
    errors.push("PIP_OBSERVATION_LABEL_INVALID");
  if (input.note !== undefined && (!validText(input.note, 2000)))
    errors.push("PIP_OBSERVATION_NOTE_INVALID");
  if (input.model_id !== undefined && !validId(input.model_id))
    errors.push("PIP_MODEL_ID_INVALID");
  if (input.model_version !== undefined && !validText(input.model_version, 128))
    errors.push("PIP_MODEL_VERSION_INVALID");

  const p = input.provenance;
  if (!exactKeys(p, ["source_type", "source_id", "observed_at"], ["content_digest"]) ||
      !PIP_PROVENANCE_TYPES.includes(p.source_type) ||
      !validId(p.source_id) || !validTimestamp(p.observed_at) ||
      (p.content_digest !== undefined && (typeof p.content_digest !== "string" || !DIGEST.test(p.content_digest))))
    errors.push("PIP_OBSERVATION_PROVENANCE_INVALID");

  if (input.region !== undefined) {
    const r = input.region;
    if (!exactKeys(r, ["x", "y", "width", "height"]) ||
        ![r.x, r.y, r.width, r.height].every(validUnitInterval) ||
        r.width <= 0 || r.height <= 0 || r.x + r.width > 1 || r.y + r.height > 1)
      errors.push("PIP_NORMALIZED_REGION_INVALID");
  }

  return finish(errors.length === 0, errors, input);
}

export function validatePIPInterpretation(input) {
  const required = [
    "id", "observation_ids", "domain", "statement", "kind",
    "source_refs", "alternatives", "producer_id"
  ];
  if (!exactKeys(input, required))
    return { ok: false, errors: ["PIP_INTERPRETATION_SHAPE_INVALID"] };

  const errors = [];
  if (!validId(input.id) || !validId(input.domain) || !validId(input.producer_id))
    errors.push("PIP_INTERPRETATION_IDENTIFIER_INVALID");
  if (!validText(input.statement, 4000))
    errors.push("PIP_INTERPRETATION_STATEMENT_INVALID");
  if (!PIP_INTERPRETATION_KINDS.includes(input.kind))
    errors.push("PIP_INTERPRETATION_KIND_INVALID");
  if (!validIdArray(input.observation_ids, 64) || input.observation_ids.length === 0)
    errors.push("PIP_INTERPRETATION_OBSERVATIONS_INVALID");
  if (!validIdArray(input.source_refs, 64))
    errors.push("PIP_SOURCE_REFERENCES_INVALID");
  if (input.kind === "SOURCE_CLAIM" && Array.isArray(input.source_refs) && input.source_refs.length === 0)
    errors.push("PIP_SOURCE_CLAIM_REQUIRES_REFERENCES");
  if (!Array.isArray(input.alternatives) || input.alternatives.length > 16 ||
      input.alternatives.some(value => !validText(value, 1000)))
    errors.push("PIP_ALTERNATIVES_INVALID");

  return finish(errors.length === 0, errors, input);
}

export function validatePIPBundle(input) {
  const required = [
    "schema_version", "session_id", "created_at",
    "privacy", "observations", "interpretations"
  ];
  if (!exactKeys(input, required))
    return { ok: false, errors: ["PIP_BUNDLE_SHAPE_INVALID"] };

  const errors = [];
  if (input.schema_version !== PIP_SCHEMA_VERSION) errors.push("PIP_SCHEMA_UNSUPPORTED");
  if (!validId(input.session_id)) errors.push("PIP_SESSION_ID_INVALID");
  if (!validTimestamp(input.created_at)) errors.push("PIP_TIMESTAMP_INVALID");

  const privacy = validatePIPPrivacy(input.privacy);
  if (!privacy.ok) errors.push(...privacy.errors);

  if (!Array.isArray(input.observations) || input.observations.length > 200)
    errors.push("PIP_OBSERVATIONS_INVALID");
  if (!Array.isArray(input.interpretations) || input.interpretations.length > 200)
    errors.push("PIP_INTERPRETATIONS_INVALID");

  const observations = Array.isArray(input.observations) ? input.observations : [];
  const interpretations = Array.isArray(input.interpretations) ? input.interpretations : [];
  const observationIds = new Set();

  for (const observation of observations) {
    const result = validatePIPObservation(observation);
    if (!result.ok) errors.push(...result.errors);
    else if (observationIds.has(result.value.id)) errors.push("PIP_DUPLICATE_OBSERVATION_ID");
    else observationIds.add(result.value.id);
  }

  const interpretationIds = new Set();
  for (const interpretation of interpretations) {
    const result = validatePIPInterpretation(interpretation);
    if (!result.ok) errors.push(...result.errors);
    else {
      if (interpretationIds.has(result.value.id)) errors.push("PIP_DUPLICATE_INTERPRETATION_ID");
      interpretationIds.add(result.value.id);
      if (result.value.observation_ids.some(id => !observationIds.has(id)))
        errors.push("PIP_UNKNOWN_OBSERVATION_REFERENCE");
    }
  }

  if (errors.length) return { ok: false, errors: [...new Set(errors)] };
  return finish(true, [], input);
}

export function validatePIPEvent(input) {
  const required = [
    "schema_version", "event_id", "event_type", "occurred_at",
    "correlation_id", "session_id", "actor", "payload"
  ];
  if (!exactKeys(input, required)) return { ok: false, errors: ["PIP_EVENT_SHAPE_INVALID"] };

  const errors = [];
  if (input.schema_version !== PIP_SCHEMA_VERSION) errors.push("PIP_EVENT_SCHEMA_UNSUPPORTED");
  if (!validId(input.event_id) || !validId(input.correlation_id) || !validId(input.session_id))
    errors.push("PIP_EVENT_IDENTIFIER_INVALID");
  if (!PIP_EVENT_TYPES.includes(input.event_type)) errors.push("PIP_EVENT_TYPE_INVALID");
  if (!validTimestamp(input.occurred_at)) errors.push("PIP_EVENT_TIME_INVALID");
  if (!exactKeys(input.actor, ["type", "id"]) ||
      !["USER", "AGENT", "SYSTEM"].includes(input.actor.type) ||
      !validId(input.actor.id))
    errors.push("PIP_EVENT_ACTOR_INVALID");
  if (!plainObject(input.payload) || Object.keys(input.payload).length > 32)
    errors.push("PIP_EVENT_PAYLOAD_INVALID");

  return finish(errors.length === 0, errors, input);
}
