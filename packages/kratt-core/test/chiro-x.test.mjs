import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry } from "../src/agent-registry.mjs";
import {
  createChiroEvent,
  createChiroWorkflow,
  evaluateChiroBundle,
  registerChiroAgents,
  transitionChiroWorkflow
} from "../src/chiro-x.mjs";
import {
  PIP_SCHEMA_VERSION,
  validatePIPBundle,
  validatePIPObservation,
  validatePIPPrivacy
} from "../src/pip-contracts.mjs";

const at = "2026-11-23T18:00:00Z";

const privacy = () => ({
  consent_granted: true,
  processing_mode: "LOCAL_ONLY",
  remote_processing_approved: false,
  retain_raw_input: false,
  retention_approved: false,
  model_training_opt_in: false
});

const observation = (overrides = {}) => ({
  id: "obs-1",
  modality: "IMAGE",
  feature_type: "PALM_LINE",
  extraction_confidence: 0.93,
  region: { x: 0.1, y: 0.2, width: 0.3, height: 0.2 },
  provenance: {
    source_type: "MODEL_OUTPUT",
    source_id: "upload-1",
    observed_at: at,
    content_digest: "sha256:" + "a".repeat(64)
  },
  model_id: "vision-local",
  model_version: "1.0.0",
  ...overrides
});

const sourceClaim = (overrides = {}) => ({
  id: "claim-1",
  observation_ids: ["obs-1"],
  domain: "CHIROMANCY_TRADITIONS",
  statement: "A historical school associates this line with a symbolic theme.",
  kind: "SOURCE_CLAIM",
  source_refs: ["source-palmistry-01"],
  alternatives: ["Another school offers a different symbolic reading."],
  producer_id: "chiro-interpreter",
  ...overrides
});

const bundle = (overrides = {}) => ({
  schema_version: PIP_SCHEMA_VERSION,
  session_id: "session-1",
  created_at: at,
  privacy: privacy(),
  observations: [observation()],
  interpretations: [sourceClaim()],
  ...overrides
});

test("PIP accepts a consented local-first bundle with separate observations and source claims", () => {
  const result = validatePIPBundle(bundle());
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(result.value.observations[0].extraction_confidence, 0.93);
});

test("PIP rejects missing consent", () => {
  const result = validatePIPPrivacy({ ...privacy(), consent_granted: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_CONSENT_REQUIRED"));
});

test("PIP rejects remote processing without explicit remote approval", () => {
  const result = validatePIPBundle(bundle({
    privacy: { ...privacy(), processing_mode: "REMOTE_APPROVED" }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_REMOTE_PROCESSING_NOT_APPROVED"));
});

test("PIP rejects raw-image retention without separate retention approval", () => {
  const result = validatePIPBundle(bundle({
    privacy: { ...privacy(), retain_raw_input: true }
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_RAW_RETENTION_NOT_APPROVED"));
});

test("PIP bundle is metadata-only and rejects unrecognized raw-image fields", () => {
  const rawImage = { ...observation(), image_bytes: "not-allowed" };
  const result = validatePIPObservation(rawImage);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_OBSERVATION_SHAPE_INVALID"));
});

test("PIP rejects confidence outside [0,1] and invalid normalized regions", () => {
  assert.equal(validatePIPObservation(observation({ extraction_confidence: 1.2 })).ok, false);
  assert.equal(validatePIPObservation(observation({
    region: { x: 0.9, y: 0.2, width: 0.3, height: 0.2 }
  })).ok, false);
});

test("PIP requires references for source claims", () => {
  const result = validatePIPBundle(bundle({
    interpretations: [sourceClaim({ source_refs: [] })]
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_SOURCE_CLAIM_REQUIRES_REFERENCES"));
});

test("PIP rejects interpretations that point to observations outside the session", () => {
  const result = validatePIPBundle(bundle({
    interpretations: [sourceClaim({ observation_ids: ["unknown-observation"] })]
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_UNKNOWN_OBSERVATION_REFERENCE"));
});

test("unconfigured independent verifier never treats model output as validated", () => {
  const result = evaluateChiroBundle(bundle());
  assert.equal(result.ok, true);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.reviews[0].state, "UNVERIFIED");
  assert.equal(result.requires_human_review, true);
});

test("source claims become supported only when trusted verifier confirms referenced sources", () => {
  const result = evaluateChiroBundle(bundle(), {
    verifyInterpretation: interpretation => ({
      state: "SUPPORTED",
      verifiedSourceRefs: [...interpretation.source_refs],
      reasonCode: "CURATED_SOURCE_CHECK_PASSED"
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "SOURCE_CLAIMS_SUPPORTED");
  assert.equal(result.reviews[0].state, "SUPPORTED");
  assert.equal(result.requires_human_review, false);
});

test("trusted verifier cannot promote an unsupported source reference", () => {
  const result = evaluateChiroBundle(bundle(), {
    verifyInterpretation: () => ({
      state: "SUPPORTED",
      verifiedSourceRefs: [],
      reasonCode: "SHOULD_NOT_PASS"
    })
  });
  assert.equal(result.reviews[0].state, "BLOCKED");
  assert.equal(result.reviews[0].reason_code, "SOURCE_REFERENCE_NOT_VERIFIED");
});

test("symbolic hypotheses cannot be promoted to factual source claims", () => {
  const result = evaluateChiroBundle(bundle({
    interpretations: [sourceClaim({
      kind: "HYPOTHESIS",
      source_refs: [],
      statement: "This could be read as a symbolic pattern."
    })]
  }), {
    verifyInterpretation: () => ({
      state: "SUPPORTED",
      verifiedSourceRefs: [],
      reasonCode: "MODEL_AGREEMENT"
    })
  });
  assert.equal(result.reviews[0].state, "BLOCKED");
  assert.equal(result.reviews[0].reason_code, "HYPOTHESIS_CANNOT_BE_PROMOTED_TO_SOURCE_FACT");
});

test("asynchronous verifier is blocked by the synchronous core contract", () => {
  const result = evaluateChiroBundle(bundle(), {
    verifyInterpretation: async () => ({ state: "SUPPORTED", verifiedSourceRefs: ["source-palmistry-01"] })
  });
  assert.equal(result.reviews[0].state, "BLOCKED");
  assert.equal(result.reviews[0].reason_code, "ASYNC_VERIFIER_REQUIRES_ASYNC_RUNTIME");
});

test("different model-produced statements for the same evidence trigger review", () => {
  const second = sourceClaim({
    id: "claim-2",
    statement: "A different tradition gives this observed line another symbolic interpretation.",
    producer_id: "second-model"
  });
  const result = evaluateChiroBundle(bundle({
    interpretations: [sourceClaim(), second]
  }), {
    verifyInterpretation: interpretation => ({
      state: "SUPPORTED",
      verifiedSourceRefs: [...interpretation.source_refs],
      reasonCode: "SOURCE_CHECK_PASSED"
    })
  });
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.surface_divergence.length, 1);
  assert.equal(result.surface_divergence[0].meaning, "SURFACE_DIVERGENCE_REQUIRES_REVIEW");
});

test("Chiro agents register least-privilege scopes in the existing AgentRegistry", () => {
  const registry = new AgentRegistry();
  const result = registerChiroAgents(registry);
  assert.equal(result.ok, true);
  assert.equal(registry.authorize("chiro-vision", "pip.observation.create", "pip.observation.write").allowed, true);
  assert.equal(registry.authorize("chiro-vision", "pip.analysis.verify", "pip.validation.write").allowed, false);
  assert.equal(registry.authorize("chiro-skeptic", "pip.analysis.verify", "pip.validation.write").allowed, true);
});

test("Chiro agents cannot register without the existing registry contract", () => {
  assert.equal(registerChiroAgents(null).ok, false);
});

test("Chiro events use the PIP versioned and correlated event envelope", () => {
  const result = createChiroEvent({
    event_id: "event-1",
    event_type: "chiro.session.created",
    occurred_at: at,
    correlation_id: "corr-1",
    session_id: "session-1",
    actor: { type: "AGENT", id: "chiro-vision" },
    payload: { processing_mode: "LOCAL_ONLY" }
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.schema_version, PIP_SCHEMA_VERSION);
  assert.equal(Object.isFrozen(result.value), true);
});

test("Chiro event rejects unknown event types and malformed actor scopes", () => {
  const result = createChiroEvent({
    event_id: "event-2",
    event_type: "chiro.future.prediction",
    occurred_at: at,
    correlation_id: "corr-1",
    session_id: "session-1",
    actor: { type: "ROOT", id: "untrusted" },
    payload: {}
  });
  assert.equal(result.ok, false);
});

test("Chiro workflow uses the existing Saga state machine and preserves transition rules", () => {
  let saga = createChiroWorkflow({ id: "saga-1", sessionId: "session-1", createdAt: at });
  const start = transitionChiroWorkflow(saga, "RUNNING", {
    id: "saga-event-1", at, kind: "observation_started"
  });
  assert.equal(start.ok, true);
  saga = start.value;
  const invalid = transitionChiroWorkflow(saga, "PENDING", {
    id: "saga-event-2", at, kind: "rewind"
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "INVALID_STATE_TRANSITION");
});


test("malformed null source references are rejected without throwing", () => {
  const result = validatePIPBundle(bundle({
    interpretations: [sourceClaim({ source_refs: null })]
  }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_SOURCE_REFERENCES_INVALID"));
});

test("a session with no interpretations cannot be reported as supported", () => {
  const result = evaluateChiroBundle(bundle({ interpretations: [] }));
  assert.equal(result.ok, true);
  assert.equal(result.status, "NO_INTERPRETATIONS");
  assert.equal(result.requires_human_review, true);
});

test("invalid digest types are rejected", () => {
  const result = validatePIPObservation({
    ...observation(),
    provenance: { ...observation().provenance, content_digest: { value: "fake" } }
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("PIP_OBSERVATION_PROVENANCE_INVALID"));
});

test("event helper pins the protocol version instead of accepting a caller override", () => {
  const result = createChiroEvent({
    schema_version: "attacker/version",
    event_id: "event-3",
    event_type: "chiro.session.created",
    occurred_at: at,
    correlation_id: "corr-3",
    session_id: "session-1",
    actor: { type: "SYSTEM", id: "kratt-runtime" },
    payload: {}
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.schema_version, PIP_SCHEMA_VERSION);
});
