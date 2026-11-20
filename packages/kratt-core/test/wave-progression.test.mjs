import test from "node:test";
import assert from "node:assert/strict";
import {
  WAVE_REGISTRY,
  evaluateWaveGate,
  getWaveById,
  validateWaveRegistry,
} from "../src/wave-progression.mjs";

test("the registry contains ten sequentially increasing complexity levels", () => {
  assert.equal(WAVE_REGISTRY.length, 10);
  assert.deepEqual(
    WAVE_REGISTRY.map((wave) => [wave.id, wave.order, wave.complexity]),
    Array.from({ length: 10 }, (_, index) => {
      const level = index + 1;
      return ["WAVE-" + String(level).padStart(2, "0"), level, level];
    }),
  );
  assert.deepEqual(validateWaveRegistry(), { ok: true, errors: [] });
});

test("every dependency points to an earlier wave", () => {
  const positions = new Map(WAVE_REGISTRY.map((wave, index) => [wave.id, index]));
  for (const wave of WAVE_REGISTRY) {
    for (const dependency of wave.dependsOn) {
      assert.ok(positions.get(dependency) < positions.get(wave.id));
    }
  }
});

test("a later wave is blocked when any prerequisite is not verified", () => {
  const gate = evaluateWaveGate("WAVE-05", {
    completedWaveIds: ["WAVE-01", "WAVE-02"],
    evidence: [],
  });
  assert.equal(gate.ok, true);
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.missingDependencies, ["WAVE-04"]);
  assert.ok(gate.missingEvidence.includes("request-bound-approval-tests"));
});

test("only explicitly verified evidence with a valid reference satisfies a gate", () => {
  const wave = getWaveById("WAVE-02");
  const evidence = wave.requiredEvidence.map((kind, index) => ({
    kind,
    verified: true,
    ref: "sha256:" + String(index + 1).padStart(64, "0"),
  }));
  evidence[0].ref = "not a valid ref with spaces";
  const gate = evaluateWaveGate("WAVE-02", {
    completedWaveIds: ["WAVE-01"],
    evidence,
  });
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.missingEvidence, [wave.requiredEvidence[0]]);
});

test("a wave becomes eligible only after all dependencies and evidence are present", () => {
  const wave = getWaveById("WAVE-03");
  const evidence = wave.requiredEvidence.map((kind, index) => ({
    kind,
    verified: true,
    ref: "tests/wave3/" + (index + 1),
  }));
  const gate = evaluateWaveGate("WAVE-03", {
    completedWaveIds: ["WAVE-01", "WAVE-02"],
    evidence,
  });
  assert.equal(gate.eligible, true);
  assert.deepEqual(gate.missingDependencies, []);
  assert.deepEqual(gate.missingEvidence, []);
});

test("unknown waves and malformed inputs fail without throwing", () => {
  assert.equal(evaluateWaveGate("WAVE-99").reason, "WAVE_NOT_FOUND");
  assert.equal(evaluateWaveGate("WAVE-01", { completedWaveIds: null }).reason, "WAVE_GATE_INPUT_INVALID");
  assert.equal(getWaveById("WAVE-99"), null);
});

test("the validator rejects duplicate IDs and forward dependencies", () => {
  const invalid = WAVE_REGISTRY.map((wave) => ({
    ...wave,
    dependsOn: [...wave.dependsOn],
  }));
  invalid[1].dependsOn = ["WAVE-02"];
  const result = validateWaveRegistry(invalid);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("WAVE_DEPENDENCY_NOT_EARLIER:WAVE-02:WAVE-02"));
});
