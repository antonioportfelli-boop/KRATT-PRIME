import test from "node:test";
import assert from "node:assert/strict";
import { validateHardwareSnapshot, proposeComputeRoute, classifyRuntimeState } from "../src/hardware-capabilities.mjs";

const sample = () => ({
  schemaVersion: "0.2.0", platform: "linux", architecture: "x86_64", observedAt: 1794000000000,
  devices: [
    { id: "cpu0", kind: "CPU", state: "AVAILABLE", backends: [{ id: "onnx-cpu", kind: "ONNXRuntime-CPU", state: "AVAILABLE", stages: ["PREFILL", "DECODE"] }] },
    { id: "gpu0", kind: "GPU", state: "AVAILABLE", backends: [{ id: "vulkan", kind: "Vulkan", state: "AVAILABLE", stages: ["PREFILL", "DECODE", "VISION"] }] },
    { id: "npu0", kind: "NPU", state: "DETECTED", backends: [{ id: "openvino-npu", kind: "OpenVINO", state: "AVAILABLE", stages: ["PREFILL", "VISION"] }] }
  ]
});

test("accepts and freezes a valid hardware snapshot", () => {
  const result = validateHardwareSnapshot(sample());
  assert.equal(result.ok, true);
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.devices), true);
});

test("rejects unknown fields, unsupported versions and duplicate device IDs", () => {
  const unknown = sample(); unknown.rootAccess = true;
  assert.equal(validateHardwareSnapshot(unknown).reason, "SNAPSHOT_UNKNOWN_FIELD");
  const badVersion = sample(); badVersion.schemaVersion = "99";
  assert.equal(validateHardwareSnapshot(badVersion).reason, "SCHEMA_VERSION_UNSUPPORTED");
  const duplicate = sample(); duplicate.devices.push({ ...duplicate.devices[0] });
  assert.equal(validateHardwareSnapshot(duplicate).reason, "DEVICE_ID_DUPLICATE");
});

test("prefers an advertised accelerator for prefill without claiming execution", () => {
  const snapshot = validateHardwareSnapshot(sample()).snapshot;
  const result = proposeComputeRoute({ snapshot, stage: "PREFILL", allowedBackends: ["CPU", "GPU", "NPU"] });
  assert.equal(result.ok, true);
  assert.equal(result.proposal.target, "NPU");
  assert.equal(result.proposal.executionStarted, false);
  assert.equal(result.proposal.policyEvaluationRequired, true);
});

test("decode route uses stage-aware preference", () => {
  const snapshot = validateHardwareSnapshot(sample()).snapshot;
  const result = proposeComputeRoute({ snapshot, stage: "DECODE", allowedBackends: ["CPU", "GPU", "NPU"] });
  assert.equal(result.proposal.target, "GPU");
});

test("remote route requires explicit allowlist and is blocked by local-only mode", () => {
  const snapshot = validateHardwareSnapshot(sample()).snapshot;
  const noDevices = Object.freeze({ ...snapshot, devices: Object.freeze([]) });
  const remote = proposeComputeRoute({ snapshot: noDevices, stage: "AUDIO", allowedBackends: ["CPU", "REMOTE"] });
  assert.equal(remote.proposal.target, "REMOTE");
  assert.equal(remote.proposal.userDataTransferApprovalRequired, true);
  const localOnly = proposeComputeRoute({ snapshot: noDevices, stage: "AUDIO", allowedBackends: ["CPU", "REMOTE"], requireLocal: true });
  assert.equal(localOnly.proposal.state, "BLOCKED");
});

test("distinguishes configured, discovered and executed states", () => {
  assert.equal(classifyRuntimeState({}), "NOT_CONFIGURED");
  assert.equal(classifyRuntimeState({ adapterConfigured: true }), "CONFIGURED_NOT_DISCOVERED");
  assert.equal(classifyRuntimeState({ adapterConfigured: true, snapshot: validateHardwareSnapshot(sample()).snapshot }), "DISCOVERED_NOT_EXECUTED");
});

test("rejects malformed route inputs", () => {
  assert.equal(proposeComputeRoute({ stage: "DECODE", allowedBackends: ["CPU"] }).reason, "SNAPSHOT_REQUIRED");
  const snapshot = validateHardwareSnapshot(sample()).snapshot;
  assert.equal(proposeComputeRoute({ snapshot, stage: "UNKNOWN", allowedBackends: ["CPU"] }).reason, "INFERENCE_STAGE_INVALID");
  assert.equal(proposeComputeRoute({ snapshot, stage: "DECODE", allowedBackends: ["ROOT"] }).reason, "BACKEND_ALLOWLIST_INVALID");
});