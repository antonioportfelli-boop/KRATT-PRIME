import test from "node:test";
import assert from "node:assert/strict";
import {
  WAVE_REGISTRY,
  WAVE_SOURCE_SNAPSHOT,
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
    verifyEvidence: (item) => item.verified === true,
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
    verifyEvidence: (item) => item.verified === true,
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


test("Wave 10 source snapshot records merged PR #39/#40 and the unresolved branch divergence", () => {
  assert.equal(WAVE_SOURCE_SNAPSHOT.main.sha, "ef3422809bbc54381a9ca3a15904727074ca0b16");
  assert.equal(WAVE_SOURCE_SNAPSHOT.alignmentMergedInto.sha, "bdda0df167d529ddbb583afbbfde39482ab91f5d");
  assert.equal(WAVE_SOURCE_SNAPSHOT.parallelPhase10Candidate.sha, "de5e3f084464f8051f34544b5314bb22bc2a235a");
  assert.equal(WAVE_SOURCE_SNAPSHOT.reconciliationRequired, true);
  const wave10 = WAVE_REGISTRY.find((wave) => wave.id === "WAVE-10");
  assert.equal(wave10.pullRequests.find((pr) => pr.number === 39).merged, true);
  assert.equal(wave10.pullRequests.find((pr) => pr.number === 40).merged, true);
  assert.equal(wave10.pullRequests.find((pr) => pr.number === 38).merged, false);
});

test("client-supplied verified flags never satisfy a wave without an injected verifier", () => {
  const wave = getWaveById("WAVE-02");
  const evidence = wave.requiredEvidence.map((kind, index) => ({
    kind,
    verified: true,
    ref: "tests/wave2/" + (index + 1),
  }));
  const gate = evaluateWaveGate("WAVE-02", {
    completedWaveIds: ["WAVE-01"],
    evidence,
  });
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.missingEvidence, wave.requiredEvidence);
});

test("hostile evidence accessors are rejected without invoking getters", () => {
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, "kind", {
    enumerable: true,
    get() {
      getterCalls++;
      return "contract-tests";
    },
  });
  Object.defineProperty(hostile, "ref", { enumerable: true, value: "tests/wave1/1" });
  Object.defineProperty(hostile, "verified", { enumerable: true, value: true });
  const gate = evaluateWaveGate("WAVE-01", {
    completedWaveIds: [],
    evidence: [hostile],
    verifyEvidence: () => true,
  });
  assert.equal(gate.eligible, false);
  assert.equal(getterCalls, 0);
});

test("a throwing trusted evidence verifier fails closed", () => {
  const wave = getWaveById("WAVE-01");
  const evidence = wave.requiredEvidence.map((kind, index) => ({
    kind,
    verified: true,
    ref: "tests/wave1/" + (index + 1),
  }));
  const gate = evaluateWaveGate("WAVE-01", {
    completedWaveIds: [],
    evidence,
    verifyEvidence: () => {
      throw new Error("verifier unavailable");
    },
  });
  assert.equal(gate.eligible, false);
  assert.deepEqual(gate.missingEvidence, wave.requiredEvidence);
});
