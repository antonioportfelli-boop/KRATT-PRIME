import test from "node:test";
import assert from "node:assert/strict";
import { createOrchestrator } from "../src/orchestrator.mjs";

test("local intake records provenance metadata without network access", () => {
  const orchestrator = createOrchestrator({ now: () => "2026-11-10T12:00:00.000Z" });
  const accepted = orchestrator.recordLocalIntake({
    label: "Baltic infrastructure watch",
    sourceType: "rss_atom",
    actor: "architect",
  });
  assert.equal(accepted.status, "OK");
  assert.equal(accepted.intake.networkAccess, false);
  assert.equal(accepted.intake.state, "RECEIVED_LOCAL");
  assert.equal(orchestrator.snapshot().intakes.length, 1);
  assert.equal(orchestrator.snapshot().journal.at(-1).type, "LOCAL_INTAKE_RECORDED");
  assert.equal(orchestrator.verifyJournal().status, "OK");
});

test("local intake rejects unbounded or unsupported sources", () => {
  const orchestrator = createOrchestrator({ now: () => "2026-11-10T12:00:00.000Z" });
  assert.equal(orchestrator.recordLocalIntake({ label: "x", sourceType: "live_telegram" }).status, "DENY");
  assert.equal(orchestrator.recordLocalIntake({ label: "x".repeat(161), sourceType: "manual_url" }).status, "DENY");
});
