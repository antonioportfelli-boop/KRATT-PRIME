import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  createRootSnapshot,
  createSqliteReflectionRootStore,
  restoreSqliteReflectionRootBackup,
  verifyReflectionRootBackup,
  validateRootDelta,
} from "../src/reflection-root-store.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
const root = () => ({ nodes: [{ id: "claim-1", status: "REVIEWED" }], edges: [], metadata: { schema: "test" } });
const delta = () => ({ schemaVersion: "kratt-root-delta/v1", operations: [{ op: "replace", path: "/nodes/0/status", value: "REFLECTED" }] });

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

function proposalFor(snapshot, rootDelta = delta()) {
  const rootDeltaDigest = digest(canonical(rootDelta));
  const payload = {
    schemaVersion: "kratt-telegram-reflection-proposal/v1",
    status: "PROPOSAL_ONLY", applyStatus: "NOT_APPLIED",
    decisionId: "decision-1", requestId: "request-1", claimId: "claim-1",
    targetDigest: digest("claim"), evidenceSnapshotDigest: digest("evidence"),
    policyVersion: "strict/v1", expectedRootVersion: snapshot.version,
    expectedRootDigest: snapshot.digest, rootDeltaDigest, rootDelta,
    createdFromVerifiedDecisionAt: "2026-11-10T14:00:00.000Z",
  };
  const proposalDigest = digest(canonical(payload));
  return Object.freeze({ ...payload, proposalId: `reflection-proposal:${proposalDigest.slice(7)}`, proposalDigest });
}

function setup({ verifyProposal = proposal => proposal.decisionId === "decision-1" } = {}) {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteReflectionRootStore(db, {
    initialSnapshot: createRootSnapshot(root()),
    verifyProposal,
    now: () => "2026-11-10T15:00:00.000Z",
  });
  return { db, store };
}

test("seeds a canonical versioned root and validates restricted RootDelta v1", () => {
  const { store } = setup();
  const snap = store.getSnapshot();
  assert.equal(snap.status, "OK");
  assert.equal(snap.snapshot.version, 0);
  assert.match(snap.snapshot.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(validateRootDelta(delta()).ok, true);
  assert.equal(validateRootDelta({ schemaVersion: "kratt-root-delta/v1", operations: [{ op: "replace", path: "/__proto__/polluted", value: true }] }).ok, false);
  assert.equal(validateRootDelta({ schemaVersion: "kratt-root-delta/v1", operations: [{ op: "replace", path: "/nodes/99/status", value: "X" }] }).ok, true);
});

test("applies a verified proposal atomically and advances the root exactly once", () => {
  const { store } = setup();
  const proposal = proposalFor(store.getSnapshot().snapshot);
  const result = store.applyProposal(proposal);
  assert.equal(result.status, "APPLIED");
  assert.equal(result.appliedRootVersion, 1);
  assert.equal(store.getSnapshot().snapshot.document.nodes[0].status, "REFLECTED");
  assert.equal(store.verifyAudit().ok, true);
  assert.equal(store.verifyAudit().count, 2);
});

test("replay is idempotent and does not increment root version", () => {
  const { store } = setup();
  const proposal = proposalFor(store.getSnapshot().snapshot);
  assert.equal(store.applyProposal(proposal).status, "APPLIED");
  const replay = store.applyProposal(proposal);
  assert.equal(replay.status, "ALREADY_APPLIED");
  assert.equal(store.getSnapshot().snapshot.version, 1);
  assert.equal(store.verifyAudit().count, 2);
});

test("rejects stale root versions and changed proposal digests", () => {
  const { store } = setup();
  const proposal = proposalFor(store.getSnapshot().snapshot);
  assert.equal(store.applyProposal(proposal).status, "APPLIED");
  const stale = store.applyProposal(proposalFor({ ...store.getSnapshot().snapshot, version: 0 }));
  assert.equal(stale.status, "STALE");
  const tampered = { ...proposal, requestId: "changed" };
  assert.equal(store.applyProposal(tampered).status, "DENY");
});

test("fails closed without architect decision verification", () => {
  const { store } = setup({ verifyProposal: () => false });
  const proposal = proposalFor(store.getSnapshot().snapshot);
  assert.equal(store.applyProposal(proposal).reason, "REFLECTION_PROPOSAL_ARCHITECT_SIGNATURE_INVALID");
  assert.equal(store.getSnapshot().snapshot.version, 0);
});

test("persists root and applied proposal across store restart on the same database", () => {
  const db = new DatabaseSync(":memory:");
  const initialSnapshot = createRootSnapshot(root());
  const options = { initialSnapshot, verifyProposal: () => true, now: () => "2026-11-10T15:00:00.000Z" };
  const first = createSqliteReflectionRootStore(db, options);
  const proposal = proposalFor(first.getSnapshot().snapshot);
  assert.equal(first.applyProposal(proposal).status, "APPLIED");
  const second = createSqliteReflectionRootStore(db, options);
  assert.equal(second.getSnapshot().snapshot.version, 1);
  assert.equal(second.applyProposal(proposal).status, "ALREADY_APPLIED");
  assert.equal(second.verifyAudit().ok, true);
});

test("rejects invalid operations at apply time and requires an initial root", () => {
  const { store } = setup();
  const invalid = proposalFor(store.getSnapshot().snapshot, {
    schemaVersion: "kratt-root-delta/v1",
    operations: [{ op: "remove", path: "/nodes/77" }],
  });
  assert.equal(store.applyProposal(invalid).status, "DENY");
  assert.equal(store.getSnapshot().snapshot.version, 0);
  const db = new DatabaseSync(":memory:");
  assert.throws(() => createSqliteReflectionRootStore(db, { verifyProposal: () => true }), /REFLECTION_ROOT_INITIAL_SNAPSHOT_REQUIRED/);
});

test("requires a trusted proposal verifier and a valid initial root", () => {
  const db = new DatabaseSync(":memory:");
  assert.throws(() => createSqliteReflectionRootStore(db, { initialSnapshot: createRootSnapshot(root()) }), /REFLECTION_ROOT_STORE_ADAPTERS_REQUIRED/);
  assert.throws(() => createRootSnapshot({ nodes: [], edges: [] }), /ROOT_SNAPSHOT_INPUT_INVALID/);
});


test("verified root backup restores snapshot, idempotency ledger, migrations and audit chain", () => {
  const first = setup();
  const proposal = proposalFor(first.store.getSnapshot().snapshot);
  assert.equal(first.store.applyProposal(proposal).status, "APPLIED");
  const exported = first.store.exportBackup();
  assert.equal(exported.status, "OK");
  assert.equal(verifyReflectionRootBackup(exported.backup).ok, true);

  const restoredDb = new DatabaseSync(":memory:");
  try {
    const restored = restoreSqliteReflectionRootBackup(restoredDb, exported.backup, {
      verifyProposal: () => true,
      now: () => "2026-11-10T16:00:00.000Z",
    });
    assert.equal(restored.getSnapshot().snapshot.digest, first.store.getSnapshot().snapshot.digest);
    assert.equal(restored.getSnapshot().snapshot.version, 1);
    assert.equal(restored.applyProposal(proposal).status, "ALREADY_APPLIED");
    assert.equal(restored.verifyAudit().ok, true);
    assert.equal(restored.verifyAudit().count, first.store.verifyAudit().count);
    assert.deepEqual(restored.listMigrations().map(item => item.version), ["001_root_cas_v1"]);
  } finally {
    restoredDb.close();
    first.db.close();
  }
});

test("root backup rejects tampering and refuses to overwrite a non-empty database", () => {
  const first = setup();
  const exported = first.store.exportBackup();
  const tampered = structuredClone(exported.backup);
  tampered.snapshot.document.metadata.schema = "tampered";
  assert.equal(verifyReflectionRootBackup(tampered).ok, false);

  const targetDb = new DatabaseSync(":memory:");
  try {
    createSqliteReflectionRootStore(targetDb, {
      initialSnapshot: createRootSnapshot(root()),
      verifyProposal: () => true,
    });
    assert.throws(() => restoreSqliteReflectionRootBackup(targetDb, exported.backup, {
      verifyProposal: () => true,
    }), /REFLECTION_BACKUP_RESTORE_TARGET_NOT_EMPTY/);
  } finally {
    targetDb.close();
    first.db.close();
  }
});
