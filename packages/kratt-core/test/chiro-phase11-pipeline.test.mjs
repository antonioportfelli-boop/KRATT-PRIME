import test from "node:test";
import assert from "node:assert/strict";
import { createChiroPhase11Pipeline } from "../src/chiro-phase11-pipeline.mjs";

const at = "2026-11-23T18:00:00Z";
const privacy = {
  consent_granted: true,
  processing_mode: "LOCAL_ONLY",
  remote_processing_approved: false,
  retain_raw_input: false,
  retention_approved: false,
  model_training_opt_in: false
};
const observation = {
  id: "obs-pipeline-1",
  modality: "IMAGE",
  feature_type: "PALM_LINE",
  extraction_confidence: 0.91,
  provenance: {
    source_type: "MODEL_OUTPUT",
    source_id: "asset-1",
    observed_at: at
  },
  model_id: "vision-local",
  model_version: "test"
};
const interpretation = {
  id: "claim-pipeline-1",
  observation_ids: ["obs-pipeline-1"],
  domain: "CHIROMANCY_TRADITIONS",
  statement: "A named historical source associates this visual feature with a symbolic reading.",
  kind: "SOURCE_CLAIM",
  source_refs: ["historical-source-1"],
  alternatives: ["Other traditions use a different symbolic reading."],
  producer_id: "interpreter-test"
};
const request = {
  requestId: "request-1",
  sessionId: "session-pipeline-1",
  assetRef: "asset-1",
  privacy,
  domain: "CHIROMANCY_TRADITIONS"
};
const verifier = item => ({
  state: "SUPPORTED",
  verifiedSourceRefs: [...item.source_refs],
  reasonCode: "TEST_SOURCE_VERIFIED"
});

test("Phase 11 semantic pipeline orchestrates injected vision and interpretation providers", async () => {
  const events = [];
  const calls = [];
  let next = 0;
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: {
      async extractObservations(input) {
        calls.push({ stage: "vision", input });
        return [observation];
      }
    },
    interpretationProvider: {
      async proposeInterpretations(input) {
        calls.push({ stage: "interpretation", input });
        return [interpretation];
      }
    },
    verifyInterpretation: verifier,
    eventSink: { append: async event => events.push(event) },
    clock: () => new Date(at),
    makeId: () => "pipeline-event-" + (++next)
  });

  const result = await pipeline.run(request);
  assert.equal(result.ok, true);
  assert.equal(result.status, "SOURCE_CLAIMS_SUPPORTED");
  assert.equal(result.workflow.state, "SUCCEEDED");
  assert.deepEqual(calls.map(call => call.stage), ["vision", "interpretation"]);
  assert.equal(calls[0].input.assetRef, "asset-1");
  assert.equal(events.length, 4);
  assert.equal(events.some(event => JSON.stringify(event).includes("image_bytes")), false);
});

test("Phase 11 pipeline blocks remote processing without separate approval before calling providers", async () => {
  let providerCalls = 0;
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: { async extractObservations() { providerCalls++; return []; } },
    interpretationProvider: { async proposeInterpretations() { providerCalls++; return []; } },
    clock: () => new Date(at),
    makeId: () => "pipeline-event"
  });
  const result = await pipeline.run({
    ...request,
    privacy: { ...privacy, processing_mode: "REMOTE_APPROVED", remote_processing_approved: false }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, "BLOCKED");
  assert.equal(providerCalls, 0);
});

test("Phase 11 pipeline rejects raw image bytes in request objects", async () => {
  let providerCalls = 0;
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: { async extractObservations() { providerCalls++; return []; } },
    interpretationProvider: { async proposeInterpretations() { providerCalls++; return []; } },
    clock: () => new Date(at),
    makeId: () => "pipeline-event"
  });
  const result = await pipeline.run({ ...request, imageBytes: "not-allowed" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CHIRO_REQUEST_SHAPE_INVALID");
  assert.equal(providerCalls, 0);
});

test("Phase 11 pipeline keeps outputs unverified when independent verifier is absent", async () => {
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: { async extractObservations() { return [observation]; } },
    interpretationProvider: { async proposeInterpretations() { return [interpretation]; } },
    clock: () => new Date(at),
    makeId: (() => { let i = 0; return () => "no-verify-" + (++i); })()
  });
  const result = await pipeline.run(request);
  assert.equal(result.ok, true);
  assert.equal(result.status, "REVIEW_REQUIRED");
  assert.equal(result.report.reviews[0].state, "UNVERIFIED");
});

test("Phase 11 pipeline rejects invalid vision output before interpretation", async () => {
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: { async extractObservations() { return [{ ...observation, extraction_confidence: 10 }]; } },
    interpretationProvider: { async proposeInterpretations() { return [interpretation]; } },
    clock: () => new Date(at),
    makeId: (() => { let i = 0; return () => "invalid-output-" + (++i); })()
  });
  const result = await pipeline.run(request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CHIRO_VISION_RESULT_INVALID");
});


test("vision observations are validated and frozen before the interpreter receives them", async () => {
  let receivedFrozenObservation = false;
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: { async extractObservations() { return [observation]; } },
    interpretationProvider: {
      async proposeInterpretations(input) {
        receivedFrozenObservation = Object.isFrozen(input.observations[0]);
        assert.equal(Object.isFrozen(input.observations), true);
        return [interpretation];
      }
    },
    verifyInterpretation: verifier,
    clock: () => new Date(at),
    makeId: (() => { let i = 0; return () => "freeze-" + (++i); })()
  });
  const result = await pipeline.run(request);
  assert.equal(result.ok, true);
  assert.equal(receivedFrozenObservation, true);
});

test("vision provider cannot forward raw image fields to the interpreter", async () => {
  let interpreterCalled = false;
  const pipeline = createChiroPhase11Pipeline({
    visionProvider: {
      async extractObservations() {
        return [{ ...observation, raw_image_bytes: "forbidden" }];
      }
    },
    interpretationProvider: {
      async proposeInterpretations() {
        interpreterCalled = true;
        return [interpretation];
      }
    },
    clock: () => new Date(at),
    makeId: (() => { let i = 0; return () => "raw-block-" + (++i); })()
  });
  const result = await pipeline.run(request);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CHIRO_VISION_RESULT_INVALID");
  assert.equal(interpreterCalled, false);
});
