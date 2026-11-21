/**
 * KRATT PRIME — Hardware capability contract v0.2.0
 *
 * Pure data validation and selection only. Platform discovery belongs in
 * explicitly permissioned adapters. This module never changes device settings,
 * grants authorization, loads secrets or starts inference.
 */

export const HARDWARE_CONTRACT_VERSION = "0.2.0";
export const COMPUTE_BACKENDS = Object.freeze(["CPU", "GPU", "NPU", "ANE", "HTP", "REMOTE"]);
export const INFERENCE_STAGES = Object.freeze(["PREFILL", "DECODE", "EMBEDDING", "VISION", "AUDIO", "CREATIVE"]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLATFORMS = new Set(["linux", "windows", "macos", "android", "unknown"]);
const PROVIDER_STATES = new Set(["AVAILABLE", "UNAVAILABLE", "DETECTED", "NOT_TESTED"]);
const isPlainObject = value => value !== null && typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finiteNonNegative = value => Number.isFinite(value) && value >= 0;
const boundedString = (value, max = 128) => typeof value === "string" && value.length > 0 && value.length <= max;
const invalid = reason => Object.freeze({ ok: false, reason });

/** Validate an immutable snapshot emitted by a platform adapter. */
export function validateHardwareSnapshot(input) {
  if (!isPlainObject(input)) return invalid("SNAPSHOT_NOT_PLAIN_OBJECT");
  const allowed = ["schemaVersion", "platform", "architecture", "observedAt", "devices"];
  if (Object.keys(input).some(key => !allowed.includes(key))) return invalid("SNAPSHOT_UNKNOWN_FIELD");
  if (input.schemaVersion !== HARDWARE_CONTRACT_VERSION) return invalid("SCHEMA_VERSION_UNSUPPORTED");
  if (!PLATFORMS.has(input.platform)) return invalid("PLATFORM_UNSUPPORTED");
  if (!boundedString(input.architecture, 64)) return invalid("ARCHITECTURE_INVALID");
  if (!Number.isFinite(input.observedAt) || input.observedAt <= 0) return invalid("OBSERVED_AT_INVALID");
  if (!Array.isArray(input.devices) || input.devices.length > 64) return invalid("DEVICE_LIST_INVALID");

  const deviceIds = new Set();
  for (const device of input.devices) {
    if (!isPlainObject(device)) return invalid("DEVICE_INVALID");
    const deviceKeys = ["id", "kind", "vendor", "model", "memoryBytes", "driverVersion", "state", "backends"];
    if (Object.keys(device).some(key => !deviceKeys.includes(key))) return invalid("DEVICE_UNKNOWN_FIELD");
    if (!ID.test(device.id ?? "")) return invalid("DEVICE_ID_INVALID");
    if (deviceIds.has(device.id)) return invalid("DEVICE_ID_DUPLICATE");
    deviceIds.add(device.id);
    if (!COMPUTE_BACKENDS.includes(device.kind) || device.kind === "REMOTE") return invalid("DEVICE_KIND_INVALID");
    if (!PROVIDER_STATES.has(device.state)) return invalid("DEVICE_STATE_INVALID");
    for (const key of ["vendor", "model", "driverVersion"]) {
      if (device[key] !== undefined && !boundedString(device[key], 256)) return invalid("DEVICE_METADATA_INVALID");
    }
    if (device.memoryBytes !== undefined && !finiteNonNegative(device.memoryBytes)) return invalid("DEVICE_MEMORY_INVALID");
    if (!Array.isArray(device.backends) || device.backends.length > 32) return invalid("BACKEND_LIST_INVALID");
    const backendIds = new Set();
    for (const backend of device.backends) {
      if (!isPlainObject(backend)) return invalid("BACKEND_INVALID");
      const backendKeys = ["id", "kind", "state", "precisions", "stages"];
      if (Object.keys(backend).some(key => !backendKeys.includes(key))) return invalid("BACKEND_UNKNOWN_FIELD");
      if (!ID.test(backend.id ?? "") || backendIds.has(backend.id)) return invalid("BACKEND_ID_INVALID");
      backendIds.add(backend.id);
      if (!boundedString(backend.kind, 96)) return invalid("BACKEND_PROVIDER_INVALID");
      if (!PROVIDER_STATES.has(backend.state)) return invalid("BACKEND_STATE_INVALID");
      if (backend.precisions !== undefined && (!Array.isArray(backend.precisions) || backend.precisions.length > 16 || !backend.precisions.every(x => boundedString(x, 16)))) return invalid("BACKEND_PRECISIONS_INVALID");
      if (backend.stages !== undefined && (!Array.isArray(backend.stages) || backend.stages.length > INFERENCE_STAGES.length || !backend.stages.every(x => INFERENCE_STAGES.includes(x)))) return invalid("BACKEND_STAGES_INVALID");
    }
  }

  const devices = input.devices.map(device => Object.freeze({
    ...device,
    backends: Object.freeze(device.backends.map(backend => Object.freeze({
      ...backend,
      precisions: Object.freeze([...new Set(backend.precisions ?? [])]),
      stages: Object.freeze([...new Set(backend.stages ?? [])])
    })))
  }));
  return Object.freeze({ ok: true, snapshot: Object.freeze({
    schemaVersion: input.schemaVersion, platform: input.platform, architecture: input.architecture,
    observedAt: input.observedAt, devices: Object.freeze(devices)
  }) });
}

/** Route proposal only. Caller must still run policy, approval and model compatibility gates. */
export function proposeComputeRoute({ snapshot, stage, allowedBackends, requireLocal = false } = {}) {
  if (!snapshot || !isPlainObject(snapshot) || snapshot.schemaVersion !== HARDWARE_CONTRACT_VERSION) return invalid("SNAPSHOT_REQUIRED");
  if (!INFERENCE_STAGES.includes(stage)) return invalid("INFERENCE_STAGE_INVALID");
  if (!Array.isArray(allowedBackends) || allowedBackends.length === 0 || allowedBackends.some(x => !COMPUTE_BACKENDS.includes(x))) return invalid("BACKEND_ALLOWLIST_INVALID");
  if (typeof requireLocal !== "boolean") return invalid("LOCALITY_FLAG_INVALID");
  const allow = new Set(allowedBackends.filter(x => x !== "REMOTE"));
  const candidates = [];
  for (const device of snapshot.devices ?? []) {
    if (!["AVAILABLE", "DETECTED"].includes(device.state) || !allow.has(device.kind)) continue;
    for (const backend of device.backends ?? []) {
      if (!["AVAILABLE", "DETECTED"].includes(backend.state)) continue;
      if (backend.stages.length && !backend.stages.includes(stage)) continue;
      candidates.push({ device, backend });
    }
  }
  const order = stage === "PREFILL" || stage === "VISION" || stage === "CREATIVE"
    ? ["NPU", "HTP", "GPU", "ANE", "CPU"]
    : stage === "DECODE" ? ["GPU", "CPU", "NPU", "HTP", "ANE"] : ["CPU", "GPU", "NPU", "HTP", "ANE"];
  const rank = kind => { const index = order.indexOf(kind); return index < 0 ? 999 : index; };
  candidates.sort((a, b) => rank(a.device.kind) - rank(b.device.kind) || a.device.id.localeCompare(b.device.id) || a.backend.id.localeCompare(b.backend.id));
  if (candidates.length) {
    const { device, backend } = candidates[0];
    return Object.freeze({ ok: true, proposal: Object.freeze({ state: "PROPOSED", stage, target: device.kind, deviceId: device.id, backendId: backend.id, locality: "LOCAL", reason: "AVAILABLE_DECLARED_BACKEND", policyEvaluationRequired: true, modelCompatibilityCheckRequired: true, executionStarted: false }) });
  }
  if (!requireLocal && allowedBackends.includes("REMOTE")) {
    return Object.freeze({ ok: true, proposal: Object.freeze({ state: "PROPOSED", stage, target: "REMOTE", locality: "REMOTE", reason: "NO_COMPATIBLE_LOCAL_BACKEND", policyEvaluationRequired: true, userDataTransferApprovalRequired: true, executionStarted: false }) });
  }
  return Object.freeze({ ok: true, proposal: Object.freeze({ state: "BLOCKED", stage, reason: requireLocal ? "LOCAL_BACKEND_REQUIRED_BUT_UNAVAILABLE" : "NO_COMPATIBLE_BACKEND", executionStarted: false }) });
}

/** Honest state labels: configuration, discovery and execution are separate facts. */
export function classifyRuntimeState({ adapterConfigured = false, snapshot, route, lastError } = {}) {
  if (lastError) return "ERROR";
  if (!adapterConfigured) return "NOT_CONFIGURED";
  if (!snapshot) return "CONFIGURED_NOT_DISCOVERED";
  if (route?.state === "BLOCKED") return "BLOCKED";
  if (route?.state === "PROPOSED") return "ROUTE_PROPOSED_NOT_EXECUTED";
  return "DISCOVERED_NOT_EXECUTED";
}