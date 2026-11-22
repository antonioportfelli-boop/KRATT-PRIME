import { createPhaseUpgradeEngine } from "../../kratt-core/src/phase-upgrade-engine.mjs";
import { createPhase11Wave10Integration } from "../../kratt-core/src/phase11-wave10-integration.mjs";

export const PHASE11_RUNTIME_VERSION = "1.0.0";

const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Application composition root for Phase 11.
 *
 * The underlying engine is intentionally kept private. Callers receive only
 * the Wave 10-observed facade, so propose/execute/commit cannot accidentally
 * bypass runtime observability by using a raw engine reference.
 */
export function createPhase11Runtime({
  phaseStore,
  observabilityStore,
  phaseEngineOptions = {},
  semanticPipeline = null,
  clock = () => new Date(),
  makeId,
  environment = "development",
  runtimeVersion = "phase11-runtime-1.0.0",
  capabilityState = "partial",
  evidenceRefs = []
} = {}) {
  if (!plain(phaseEngineOptions)) throw new TypeError("PHASE11_ENGINE_OPTIONS_INVALID");
  if (typeof clock !== "function") throw new TypeError("PHASE11_CLOCK_REQUIRED");

  const engine = createPhaseUpgradeEngine({
    ...phaseEngineOptions,
    store: phaseStore,
    clock
  });

  const observed = createPhase11Wave10Integration({
    phaseEngine: engine,
    observabilityStore,
    semanticPipeline,
    clock,
    ...(makeId === undefined ? {} : { makeId }),
    environment,
    runtimeVersion,
    capabilityState,
    evidenceRefs
  });

  return Object.freeze({
    version: PHASE11_RUNTIME_VERSION,
    propose: observed.propose,
    execute: observed.execute,
    commitApproved: observed.commitApproved,
    runSemanticPipeline: observed.runSemanticPipeline,
    getRun: observed.getRun,
    watchEvents: observed.watchEvents
  });
}
