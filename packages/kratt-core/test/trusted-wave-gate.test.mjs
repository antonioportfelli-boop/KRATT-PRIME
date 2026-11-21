import test from "node:test";
import assert from "node:assert/strict";
import { getWaveById } from "../src/wave-progression.mjs";
import { evaluateTrustedWaveGate } from "../src/trusted-wave-gate.mjs";

function evidenceFor(waveId) {
  return getWaveById(waveId).requiredEvidence.map((kind, index) => ({
    kind, ref: "evidence/" + waveId.toLowerCase() + "/" + index, verified: true,
  }));
}

const acceptEvidence = async (record, context) =>
  record.ref.startsWith("evidence/") &&
  context.purpose === "wave-evidence";

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
  assert.equal(result.reason, "WAVE_EVIDENCE_RECORD_INVALID");
});

test("only records accepted by the injected verifier satisfy evidence requirements", async () => {
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: evidenceFor("WAVE-01"),
    verifyEvidence: acceptEvidence,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.verificationTimedOut, false);
});

test("caller-supplied verified true is stripped before verifier invocation", async () => {
  let sawVerified = false;
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: evidenceFor("WAVE-01"),
    verifyEvidence: async (record) => {
      sawVerified ||= Object.hasOwn(record, "verified");
      return record.ref.startsWith("evidence/");
    },
  });
  assert.equal(result.eligible, true);
  assert.equal(sawVerified, false);
});

test("verifier exceptions deny evidence instead of trusting a verified flag", async () => {
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: evidenceFor("WAVE-01"),
    verifyEvidence: async () => { throw new Error("verifier unavailable"); },
  });
  assert.equal(result.eligible, false);
  assert.equal(result.missingEvidence.length, 3);
});

test("a hung verifier is bounded by the shared verification deadline", async () => {
  const started = Date.now();
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: evidenceFor("WAVE-01"),
    verificationTimeoutMs: 30,
    verifyEvidence: () => new Promise(() => {}),
  });
  assert.equal(result.eligible, false);
  assert.equal(result.verificationTimedOut, true);
  assert.ok(Date.now() - started < 500);
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

test("accessor-backed verifier options fail without executing getters", async () => {
  let invoked = false;
  const options = {};
  Object.defineProperty(options, "evidence", {
    enumerable: true,
    get() { invoked = true; return evidenceFor("WAVE-01"); },
  });
  Object.defineProperty(options, "verifyEvidence", {
    enumerable: true,
    value: async () => true,
  });
  const result = await evaluateTrustedWaveGate("WAVE-01", options);
  assert.equal(invoked, false);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "WAVE_GATE_INPUT_INVALID");
});

test("accessor-backed evidence records fail without executing getters", async () => {
  let invoked = false;
  const record = {
    kind: "contract-tests",
    get ref() { invoked = true; return "evidence/wave-01/contract"; },
  };
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: [record],
    verifyEvidence: async () => true,
  });
  assert.equal(invoked, false);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "WAVE_EVIDENCE_RECORD_INVALID");
});

test("sparse arrays and oversized evidence collections fail closed", async () => {
  const sparse = [];
  sparse.length = 1;
  const sparseResult = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: sparse, verifyEvidence: async () => true,
  });
  assert.equal(sparseResult.eligible, false);

  const oversizedResult = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: Array.from({ length: 129 }, (_, index) => ({
      kind: "extra", ref: "evidence/extra/" + index,
    })),
    verifyEvidence: async () => true,
  });
  assert.equal(oversizedResult.eligible, false);
});

test("proxy traps cannot escape the gate as uncaught exceptions", async () => {
  const hostile = new Proxy([], {
    ownKeys() { throw new Error("blocked"); },
  });
  const result = await evaluateTrustedWaveGate("WAVE-01", {
    evidence: hostile,
    verifyEvidence: async () => true,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "WAVE_GATE_INPUT_INVALID");
});
