import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPostgresRuntimeStore } from "../src/postgres-runtime-store.mjs";
import { createPostgresWorkerLeaseCoordinator } from "../../kratt-runtime/src/postgres-worker-lease-coordinator.mjs";

const connectionString = process.env.KRATT_TEST_DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationPath = join(here, "../migrations/0002_postgres_runtime_and_leases.sql");
const digest = "sha256:" + "a".repeat(64);

test("PostgreSQL shared journal and worker leases survive concurrent pools and process-style restart", {
  skip: !connectionString
}, async () => {
  const { Pool } = await import("pg");
  const poolA = new Pool({ connectionString, max: 4 });
  const poolB = new Pool({ connectionString, max: 4 });
  const admin = new Pool({ connectionString, max: 2 });

  try {
    await admin.query(
      "DROP TABLE IF EXISTS kratt_worker_lease_operations CASCADE;" +
      "DROP TABLE IF EXISTS kratt_worker_lease_reservations CASCADE;" +
      "DROP TABLE IF EXISTS kratt_runtime_journal_entries CASCADE;" +
      "DROP TABLE IF EXISTS kratt_runtime_journal_head CASCADE;" +
      "DROP FUNCTION IF EXISTS kratt_guard_worker_lease_reservation() CASCADE;" +
      "DROP FUNCTION IF EXISTS kratt_reject_worker_lease_operation_mutation() CASCADE;" +
      "DROP FUNCTION IF EXISTS kratt_reject_runtime_journal_mutation() CASCADE;" +
      "DROP FUNCTION IF EXISTS kratt_guard_runtime_journal_head() CASCADE;"
    );
    await admin.query(await readFile(migrationPath, "utf8"));

    const storeA = createPostgresRuntimeStore(poolA);
    const storeB = createPostgresRuntimeStore(poolB);
    await Promise.all([storeA.open(), storeB.open()]);

    const appended = await Promise.all([
      storeA.put({ idempotencyKey: "journal-entry-a", key: "runtime.test.v1", value: { part: "a", ordinal: 1 } }),
      storeB.put({ idempotencyKey: "journal-entry-b", key: "runtime.test.v1", value: { part: "b", ordinal: 2 } })
    ]);
    assert.equal(appended.filter(result => result.ok && !result.duplicate).length, 2);

    const verification = await storeA.verify();
    assert.equal(verification.ok, true);
    assert.equal(verification.count, 2);
    const entries = await storeB.readAll();
    assert.deepEqual(entries.map(entry => entry.sequence), [1, 2]);
    assert.equal(entries[1].previousHash, undefined);
    assert.equal(entries[1].hash.length, 64);

    await assert.rejects(
      poolA.query("UPDATE kratt_runtime_journal_entries SET record_key = 'tampered' WHERE sequence = 1"),
      /KRATT_RUNTIME_JOURNAL_APPEND_ONLY/
    );
    await assert.rejects(
      poolA.query("DELETE FROM kratt_runtime_journal_entries WHERE sequence = 1"),
      /KRATT_RUNTIME_JOURNAL_APPEND_ONLY/
    );
    assert.equal((await storeA.verify()).ok, true);

    const leasesA = createPostgresWorkerLeaseCoordinator(poolA);
    const leasesB = createPostgresWorkerLeaseCoordinator(poolB);
    await Promise.all([leasesA.open(), leasesB.open()]);

    const [first, competing] = await Promise.all([
      leasesA.acquire({
        operationId: "lease-race-a", reservationKey: "integration-task-1",
        taskDigest: digest, ownerId: "worker-integration-a", ttlMs: 5_000
      }),
      leasesB.acquire({
        operationId: "lease-race-b", reservationKey: "integration-task-1",
        taskDigest: digest, ownerId: "worker-integration-b", ttlMs: 5_000
      })
    ]);
    assert.equal([first, competing].filter(result => result.ok).length, 1);
    assert.equal([first, competing].find(result => !result.ok).reason, "WORKER_LEASE_HELD");
    const original = first.ok ? first : competing;
    const ownerId = original.ownerId;
    assert.equal(original.fencingToken, 1);

    // Simulate lease expiry using the database clock in an isolated test database.
    await admin.query(
      "UPDATE kratt_worker_lease_reservations SET expires_at = clock_timestamp() - interval '1 second' " +
      "WHERE reservation_key = $1",
      ["integration-task-1"]
    );
    const recovered = await leasesB.acquire({
      operationId: "lease-reacquire-after-expiry",
      reservationKey: "integration-task-1",
      taskDigest: digest,
      ownerId,
      ttlMs: 5_000
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.fencingToken, 2);

    const stale = await leasesA.renew({
      operationId: "lease-renew-stale-fence",
      reservationKey: "integration-task-1",
      taskDigest: digest,
      ownerId,
      fencingToken: original.fencingToken,
      ttlMs: 5_000
    });
    assert.equal(stale.reason, "WORKER_FENCING_TOKEN_STALE");

    const renewed = await leasesA.renew({
      operationId: "lease-renew-current-fence",
      reservationKey: "integration-task-1",
      taskDigest: digest,
      ownerId,
      fencingToken: recovered.fencingToken,
      ttlMs: 8_000
    });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.fencingToken, 2);

    const released = await leasesB.release({
      operationId: "lease-release-current-fence",
      reservationKey: "integration-task-1",
      taskDigest: digest,
      ownerId,
      fencingToken: renewed.fencingToken
    });
    assert.equal(released.ok, true);
    assert.equal(released.state, "RELEASED");

    // A distinct coordinator and pool see the durable state after restart-style recreation.
    const restarted = createPostgresWorkerLeaseCoordinator(poolB);
    const snapshot = await restarted.inspect("integration-task-1");
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.reservation.status, "AVAILABLE");
    assert.equal(snapshot.reservation.fence, 2);

    const status = await restarted.status();
    assert.equal(status.ok, true);
    assert.equal(status.reservationCount, 1);
    assert.equal(status.availableReservationCount, 1);

    const operationReuse = await restarted.acquire({
      operationId: "lease-reacquire-after-expiry",
      reservationKey: "integration-task-1",
      taskDigest: digest,
      ownerId,
      ttlMs: 9_000
    });
    assert.equal(operationReuse.reason, "WORKER_LEASE_OPERATION_ID_REUSED");
  } finally {
    await Promise.all([poolA.end(), poolB.end(), admin.end()]);
  }
});
