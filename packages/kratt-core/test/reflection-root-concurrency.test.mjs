import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRootSnapshot,
  createSqliteReflectionRootStore,
} from "../src/reflection-root-store.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const root = () => ({ nodes: [{ id: "claim-1", status: "REVIEWED" }], edges: [], metadata: { schema: "test" } });
const delta = status => ({ schemaVersion: "kratt-root-delta/v1", operations: [{ op: "replace", path: "/nodes/0/status", value: status }] });
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
function proposalFor(snapshot, status) {
  const rootDelta = delta(status);
  const payload = {
    schemaVersion: "kratt-telegram-reflection-proposal/v1",
    status: "PROPOSAL_ONLY", applyStatus: "NOT_APPLIED",
    decisionId: `decision-${status}`, requestId: `request-${status}`, claimId: "claim-1",
    targetDigest: digest("claim"), evidenceSnapshotDigest: digest("evidence"),
    policyVersion: "strict/v1", expectedRootVersion: snapshot.version,
    expectedRootDigest: snapshot.digest, rootDeltaDigest: digest(canonical(rootDelta)), rootDelta,
    createdFromVerifiedDecisionAt: "2026-11-10T14:00:00.000Z",
  };
  const proposalDigest = digest(canonical(payload));
  return { ...payload, proposalId: `reflection-proposal:${proposalDigest.slice(7)}`, proposalDigest };
}
function openStore(path, initialSnapshot) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout=5000");
  const store = createSqliteReflectionRootStore(db, {
    initialSnapshot,
    verifyProposal: proposal => proposal.decisionId.startsWith("decision-"),
    now: () => "2026-11-10T15:00:00.000Z",
  });
  return { db, store };
}

test("independent SQLite connections serialize competing root CAS proposals", () => {
  const directory = mkdtempSync(join(tmpdir(), "kratt-root-cas-"));
  const path = join(directory, "root.sqlite");
  const initialSnapshot = createRootSnapshot(root());
  let first, second;
  try {
    first = openStore(path, initialSnapshot);
    second = openStore(path, initialSnapshot);
    const firstSnapshot = first.store.getSnapshot().snapshot;
    const secondSnapshot = second.store.getSnapshot().snapshot;
    assert.equal(firstSnapshot.digest, secondSnapshot.digest);
    assert.equal(firstSnapshot.version, secondSnapshot.version);
    assert.deepEqual(first.store.listMigrations().map(item => item.version), ["001_root_cas_v1"]);

    const proposalA = proposalFor(firstSnapshot, "REFLECTED_A");
    const proposalB = proposalFor(secondSnapshot, "REFLECTED_B");
    assert.equal(first.store.applyProposal(proposalA).status, "APPLIED");
    const losing = second.store.applyProposal(proposalB);
    assert.equal(losing.status, "STALE");
    assert.equal(second.store.getSnapshot().snapshot.version, 1);
    assert.equal(second.store.getSnapshot().snapshot.document.nodes[0].status, "REFLECTED_A");
    assert.equal(second.store.verifyAudit().ok, true);
    assert.equal(second.store.verifyAudit().count, 2);
  } finally {
    first?.db.close();
    second?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("separate connections observe durable idempotent replay after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "kratt-root-restart-"));
  const path = join(directory, "root.sqlite");
  const initialSnapshot = createRootSnapshot(root());
  let first, second;
  try {
    first = openStore(path, initialSnapshot);
    const proposal = proposalFor(first.store.getSnapshot().snapshot, "REFLECTED");
    assert.equal(first.store.applyProposal(proposal).status, "APPLIED");
    first.db.close();
    first = null;

    second = openStore(path, initialSnapshot);
    assert.equal(second.store.applyProposal(proposal).status, "ALREADY_APPLIED");
    assert.equal(second.store.getSnapshot().snapshot.version, 1);
    assert.equal(second.store.verifyAudit().ok, true);
  } finally {
    first?.db.close();
    second?.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
