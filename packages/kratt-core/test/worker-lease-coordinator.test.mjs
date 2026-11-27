import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrimeStore } from "../src/prime-store.mjs";
import { createWorkerLeaseCoordinator } from "../../kratt-runtime/src/worker-lease-coordinator.mjs";

const taskDigest = "sha256:" + "a".repeat(64);
const reservationKey = "reservation-one";
const ttlMs = 60_000;

async function withCoordinator(run) {
  const directory = await mkdtemp(join(tmpdir(), "kratt-worker-lease-"));
  try {
    const store = new PrimeStore({ path: join(directory, "prime.ndjson") });
    let current = Date.parse("2026-11-27T12:00:00.000Z");
    const now = () => new Date(current).toISOString();
    const coordinator = createWorkerLeaseCoordinator({ store, now });
    await coordinator.open();
    await run({ store, coordinator, now, advance(ms) { current += ms; } });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const acquire = (ownerId, operationId, overrides = {}) => ({
  operationId, reservationKey, taskDigest, ownerId, ttlMs, ...overrides
});

test("serializes competing acquisitions through one shared PrimeStore instance", async () => withCoordinator(async ({ coordinator }) => {
  const results = await Promise.all([
    coordinator.acquire(acquire("worker-a", "acquire-worker-a")),
    coordinator.acquire(acquire("worker-b", "acquire-worker-b"))
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.ok(results.some(result => result.reason === "WORKER_LEASE_HELD"));
  const status = await coordinator.status();
  assert.equal(status.reservationCount, 1);
  assert.equal(status.activeLeaseCount, 1);
}));

test("makes lease operations idempotent and rejects operation-id rebinding", async () => withCoordinator(async ({ coordinator }) => {
  const request = acquire("worker-a", "acquire-stable");
  const first = await coordinator.acquire(request);
  assert.equal(first.ok, true);
  const replay = await coordinator.acquire(request);
  assert.equal(replay.ok, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.fencingToken, first.fencingToken);

  const rebound = await coordinator.acquire(acquire("worker-b", "acquire-stable"));
  assert.equal(rebound.ok, false);
  assert.equal(rebound.reason, "WORKER_LEASE_OPERATION_ID_REUSED");
}));

test("increments fencing generation after expiry and rejects an old worker", async () => withCoordinator(async ({ coordinator, advance }) => {
  const first = await coordinator.acquire(acquire("worker-a", "acquire-first"));
  assert.equal(first.ok, true);
  assert.equal(first.fencingToken, 1);
  advance(ttlMs + 1);
  const second = await coordinator.acquire(acquire("worker-b", "acquire-second"));
  assert.equal(second.ok, true);
  assert.equal(second.fencingToken, 2);

  const staleRelease = await coordinator.release({
    operationId: "release-stale-worker",
    reservationKey,
    taskDigest,
    ownerId: "worker-a",
    fencingToken: first.fencingToken
  });
  assert.equal(staleRelease.ok, false);
  assert.equal(staleRelease.reason, "WORKER_FENCING_TOKEN_STALE");
}));

test("restores the active lease and fencing token from the durable journal", async () => withCoordinator(async ({ store, coordinator }) => {
  const first = await coordinator.acquire(acquire("worker-a", "acquire-restart"));
  assert.equal(first.ok, true);
  const recovered = createWorkerLeaseCoordinator({
    store,
    now: () => "2026-11-27T12:00:01.000Z"
  });
  await recovered.open();
  const inspected = await recovered.inspect(reservationKey);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.reservation.fence, first.fencingToken);
  assert.equal(inspected.reservation.lease.ownerId, "worker-a");
  assert.equal((await recovered.status()).activeLeaseCount, 1);
}));

test("same-store coordinator instances serialize and reload before each acquisition", async () => withCoordinator(async ({ store }) => {
  const left = createWorkerLeaseCoordinator({ store, now: () => "2026-11-27T12:00:00.000Z" });
  const right = createWorkerLeaseCoordinator({ store, now: () => "2026-11-27T12:00:00.000Z" });
  const results = await Promise.all([
    left.acquire(acquire("worker-a", "acquire-left")),
    right.acquire(acquire("worker-b", "acquire-right"))
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.ok(results.some(result => result.reason === "WORKER_LEASE_HELD"));
}));
