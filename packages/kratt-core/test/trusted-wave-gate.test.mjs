import test from "node:test";
import assert from "node:assert/strict";
import { getWaveById } from "../src/wave-progression.mjs";
import { evaluateTrustedWaveGate } from "../src/trusted-wave-gate.mjs";

function evidenceFor(waveId) {
  return getWaveById(waveId).requiredEvidence.map((kind, index) => ({
    kind, ref: "evidence/" + waveId.toLowerCase() + "/" + index, verified: true,
  }));
}

test("missing trusted verifier denies self-asserted verified evidence", async () => {
  const result = await evaluateTrustedWaveGate("WAVE-01", { evidence: evidenceFor("WAVE-01") });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "TRUSTED_VERIFIER_REQUIRED");
});

test("malformed evidence references cannot satisfy the gate", async () => {
  const evidence = evidenceFor("WAVE-01");
  evidence[0].ref = "../escape";
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence, verifyEvidence: async () => true,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.missingEvidence.includes("contract-tests"));
});

test("only records accepted by the injected verifier satisfy evidence requirements", async () => {
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: evidenceFor("WAVE-01"),
    verifyEvidence: async (record, context) =>
      record.ref.startsWith("evidence/") &&
      context.purpose === "wave-evidence" &&
      context.waveId === "WAVE-01",
  });
  assert.equal(result.eligible, true);
});

test("verifier exceptions deny evidence instead of trusting a verified flag", async () => {
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: evidenceFor("WAVE-01"),
    verifyEvidence: async () => { throw new Error("verifier unavailable"); },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.missingEvidence.length, 3);
});

test("dependencies require independently verified completion attestations", async () => {
  const evidence = evidenceFor("WAVE-02");
  const blocked = await evaluateTrustedWaveGate("WAVE-02", {
    evidence, verifyEvidence: async () => true,
  });
  assert.deepEqual(blocked.missingDependencies, ["WAVE-01"]);
  const completionEvidence = [{
    kind: "wave-completion", waveId: "WAVE-01",
    ref: "attestations/wave-01/release",
  }];
  const accepted = await evaluateTrustedWaveGate("WAVE-02", {
    evidence, completionEvidence,
    verifyEvidence: async (record, context) =>
      context.purpose === "wave-completion"
        ? record.waveId === "WAVE-01"
        : record.kind !== "untrusted",
  });
  assert.equal(accepted.eligible, true);
});

test("unknown wave and malformed collections are denied", async () => {
  assert.equal((await evaluateTrustedWaveGate("WAVE-99")).reason, "WAVE_NOT_FOUND");
  assert.equal((await evaluateTrustedWaveGate("WAVE-01", {
    evidence: null, verifyEvidence: async () => true,
  })).reason, "WAVE_GATE_INPUT_INVALID");
});

test("completion evidence for another wave cannot satisfy a dependency", async () => {
  const result = await evaluateTrustedWaveGate("WAVE-02", {
    evidence: evidenceFor("WAVE-02"),
    completionEvidence: [{
      kind: "wave-completion", waveId: "WAVE-99", ref: "attestations/wave-99/release",
    }],
    verifyEvidence: async () => true,
  });
  assert.deepEqual(result.missingDependencies, ["WAVE-01"]);
});
