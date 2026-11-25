import { createHash } from "node:crypto";

export const WORKER_LEASE_SCHEMA = "kratt-worker-lease/v1";
const RECORD_KEY = "worker.lease.operation.v1";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 15 * 60 * 1_000;
const STORE_QUEUES = new WeakMap();
const HASH = value => createHash("sha256").update(value).digest("hex");
const OPERATION_ID = id => `wlease-${HASH(id).slice(0, 48)}`;
const isIdentifier = value => typeof value === "string" && IDENTIFIER.test(value);
const isDigest = value => typeof value === "string" && DIGEST.test(value);
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const exact = (value, fields) => {
  try {
    return plain(value) && Reflect.ownKeys(value).length === fields.length && fields.every(field => {
      const d = Object.getOwnPropertyDescriptor(value, field);
      return Boolean(d && "value" in d && d.get === undefined && d.set === undefined);
    });
  } catch { return false; }
};
const isUtc = value => typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value));
const clone = value => structuredClone(value);

function enqueueForStore(store, operation) {
  const previous = STORE_QUEUES.get(store) ?? Promise.resolve();
  const task = previous.then(operation);
  STORE_QUEUES.set(store, task.catch(() => {}));
  return task;
}

function validateStore(store) {
  return Boolean(store && typeof store.open === "function" && typeof store.readAll === "function" && typeof store.put === "function");
}

function validateEntry(entry) {
  const fields = ["schemaVersion", "operationId", "operationDigest", "operation", "reservation", "result"];
  if (!exact(entry, fields) || entry.schemaVersion !== WORKER_LEASE_SCHEMA || !isIdentifier(entry.operationId) ||
      !isDigest(entry.operationDigest) || !["acquire", "renew", "release"].includes(entry.operation) ||
      !exact(entry.reservation, ["schemaVersion", "reservationKey", "taskDigest", "fence", "status", "lease"]) ||
      entry.reservation.schemaVersion !== WORKER_LEASE_SCHEMA || !isIdentifier(entry.reservation.reservationKey) ||
      !isDigest(entry.reservation.taskDigest) || !Number.isSafeInteger(entry.reservation.fence) || entry.reservation.fence < 0 ||
      !["AVAILABLE", "LEASED"].includes(entry.reservation.status) || !plain(entry.result) || entry.result.dispatch !== false ||
      typeof entry.result.ok !== "boolean" || typeof entry.result.state !== "string") return false;
  if (entry.reservation.lease === null) return entry.reservation.status === "AVAILABLE";
  return entry.reservation.status === "LEASED" && entry.reservation.fence > 0 &&
    exact(entry.reservation.lease, ["ownerId", "expiresAt"]) &&
    isIdentifier(entry.reservation.lease.ownerId) && isUtc(entry.reservation.lease.expiresAt);
}

/**
 * Durable local lease and fencing ledger. This coordinates calls made through one
 * PrimeStore instance in one process; it does not claim cross-process transactions.
 * It never starts workers or sends work to a remote service.
 */
export function createWorkerLeaseCoordinator({ store, now = () => new Date().toISOString() } = {}) {
  if (!validateStore(store)) throw new TypeError("WORKER_LEASE_STORE_REQUIRED");
  if (typeof now !== "function") throw new TypeError("WORKER_LEASE_CLOCK_REQUIRED");
  const operations = new Map();
  const reservations = new Map();

  async function refresh() {
    await store.open();
    const entries = await store.readAll();
    operations.clear();
    reservations.clear();
    for (const item of entries) {
      if (item.key !== RECORD_KEY) continue;
      const record = item.value;
      if (!validateEntry(record) || item.id !== OPERATION_ID(record.operationId)) throw new Error("WORKER_LEASE_JOURNAL_INVALID");
      const existingOperation = operations.get(record.operationId);
      if (existingOperation) throw new Error("WORKER_LEASE_OPERATION_ID_DUPLICATE");
      operations.set(record.operationId, record);
      reservations.set(record.reservation.reservationKey, record.reservation);
    }
  }

  async function execute(operation, request, fields) {
    if (!exact(request, fields) || !isIdentifier(request.operationId) || !isIdentifier(request.reservationKey) ||
        !isDigest(request.taskDigest) || !isIdentifier(request.ownerId)) {
      return Object.freeze({ ok: false, state: "BLOCKED", reason: "WORKER_LEASE_REQUEST_INVALID", dispatch: false });
    }
    if (["acquire", "renew"].includes(operation) && (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < MIN_TTL_MS || request.ttlMs > MAX_TTL_MS)) {
      return Object.freeze({ ok: false, state: "BLOCKED", reason: "WORKER_LEASE_TTL_INVALID", dispatch: false });
    }
    if (operation !== "acquire" && (!Number.isSafeInteger(request.fencingToken) || request.fencingToken < 1)) {
      return Object.freeze({ ok: false, state: "BLOCKED", reason: "WORKER_LEASE_FENCE_INVALID", dispatch: false });
    }
    const normalized = operation === "acquire"
      ? { operationId: request.operationId, reservationKey: request.reservationKey, taskDigest: request.taskDigest, ownerId: request.ownerId, ttlMs: request.ttlMs }
      : { operationId: request.operationId, reservationKey: request.reservationKey, taskDigest: request.taskDigest, ownerId: request.ownerId,
        fencingToken: request.fencingToken, ...(operation === "renew" ? { ttlMs: request.ttlMs } : {}) };
    const operationDigest = `sha256:${HASH(JSON.stringify({ operation, request: normalized }))}`;

    const task = enqueueForStore(store, async () => {
      await refresh();
      let instant;
      try { instant = now(); } catch { instant = null; }
      if (!isUtc(instant)) return Object.freeze({ ok: false, state: "BLOCKED", reason: "WORKER_LEASE_CLOCK_INVALID", dispatch: false });

      const prior = operations.get(request.operationId);
      if (prior) {
        if (prior.operationDigest !== operationDigest) return Object.freeze({ ok: false, state: "BLOCKED",
          reason: "WORKER_LEASE_OPERATION_ID_REUSED", dispatch: false });
        if (!prior.result.ok || prior.operation === "release") return Object.freeze({ ...clone(prior.result), duplicate: true });
        const current = reservations.get(request.reservationKey);
        const currentLease = current?.lease;
        if (current?.fence !== prior.result.fencingToken || currentLease?.ownerId !== request.ownerId ||
            Date.parse(currentLease.expiresAt) <= Date.parse(instant)) {
          return Object.freeze({ ok: false, state: "BLOCKED", reason: "WORKER_LEASE_REPLAY_STALE", duplicate: true, dispatch: false });
        }
        return Object.freeze({ ok: true, state: "LEASED", reservationKey: request.reservationKey, ownerId: request.ownerId,
          fencingToken: current.fence, expiresAt: currentLease.expiresAt, duplicate: true, dispatch: false, executionStarted: false });
      }

      let reservation = reservations.get(request.reservationKey) ?? {
        schemaVersion: WORKER_LEASE_SCHEMA, reservationKey: request.reservationKey, taskDigest: request.taskDigest,
        fence: 0, status: "AVAILABLE", lease: null
      };
      let result;
      if (reservation.taskDigest !== request.taskDigest) {
        result = { ok: false, state: "BLOCKED", reason: "WORKER_RESERVATION_PAYLOAD_CONFLICT", dispatch: false };
      } else if (operation === "acquire") {
        const active = reservation.lease && Date.parse(reservation.lease.expiresAt) > Date.parse(instant);
        if (active) result = { ok: false, state: "BLOCKED", reason: "WORKER_LEASE_HELD", fencingToken: reservation.fence, expiresAt: reservation.lease.expiresAt, dispatch: false };
        else if (reservation.fence >= Number.MAX_SAFE_INTEGER) result = { ok: false, state: "BLOCKED", reason: "WORKER_FENCE_EXHAUSTED", dispatch: false };
        else {
          const expiresAt = new Date(Date.parse(instant) + request.ttlMs).toISOString();
          reservation = { ...reservation, fence: reservation.fence + 1, status: "LEASED", lease: { ownerId: request.ownerId, expiresAt } };
          result = { ok: true, state: "LEASED", reservationKey: request.reservationKey, ownerId: request.ownerId,
            fencingToken: reservation.fence, expiresAt, dispatch: false, executionStarted: false };
        }
      } else {
        const active = reservation.lease && Date.parse(reservation.lease.expiresAt) > Date.parse(instant);
        if (!active) {
          if (reservation.lease) reservation = { ...reservation, status: "AVAILABLE", lease: null };
          result = { ok: false, state: "BLOCKED", reason: "WORKER_LEASE_EXPIRED", fencingToken: request.fencingToken, dispatch: false };
        } else if (reservation.lease.ownerId !== request.ownerId || reservation.fence !== request.fencingToken) {
          result = { ok: false, state: "BLOCKED", reason: reservation.fence !== request.fencingToken ? "WORKER_FENCING_TOKEN_STALE" : "WORKER_LEASE_OWNER_MISMATCH",
            fencingToken: reservation.fence, dispatch: false };
        } else if (operation === "renew") {
          const ttlMs = request.ttlMs;
          const expiresAt = new Date(Date.parse(instant) + ttlMs).toISOString();
          reservation = { ...reservation, lease: { ownerId: request.ownerId, expiresAt } };
          result = { ok: true, state: "LEASED", reservationKey: request.reservationKey, ownerId: request.ownerId,
            fencingToken: reservation.fence, expiresAt, dispatch: false, executionStarted: false };
        } else {
          reservation = { ...reservation, status: "AVAILABLE", lease: null };
          result = { ok: true, state: "RELEASED", reservationKey: request.reservationKey, ownerId: request.ownerId,
            fencingToken: request.fencingToken, dispatch: false, executionStarted: false };
        }
      }

      const record = { schemaVersion: WORKER_LEASE_SCHEMA, operationId: request.operationId, operationDigest, operation,
        reservation, result };
      const stored = await store.put({ idempotencyKey: OPERATION_ID(request.operationId), key: RECORD_KEY, value: record });
      if (stored?.ok !== true || stored.duplicate) throw new Error("WORKER_LEASE_PERSIST_FAILED");
      operations.set(request.operationId, record);
      reservations.set(request.reservationKey, reservation);
      return Object.freeze(result);
    });
    return task;
  }

  return Object.freeze({
    async open() {
      return enqueueForStore(store, async () => {
        await refresh();
        return Object.freeze({ ok: true, reservationCount: reservations.size, operationCount: operations.size });
      });
    },
    acquire(request) { return execute("acquire", request, ["operationId", "reservationKey", "taskDigest", "ownerId", "ttlMs"]); },
    renew(request) { return execute("renew", request, ["operationId", "reservationKey", "taskDigest", "ownerId", "fencingToken", "ttlMs"]); },
    release(request) { return execute("release", request, ["operationId", "reservationKey", "taskDigest", "ownerId", "fencingToken"]); },
    async inspect(reservationKey) {
      if (!isIdentifier(reservationKey)) return Object.freeze({ ok: false, reason: "WORKER_RESERVATION_KEY_INVALID" });
      return enqueueForStore(store, async () => {
        await refresh();
        const reservation = reservations.get(reservationKey);
        return reservation ? Object.freeze({ ok: true, reservation: clone(reservation), executionStarted: false, dispatch: false })
          : Object.freeze({ ok: true, reservation: null, executionStarted: false, dispatch: false });
      });
    },
    async status() {
      return enqueueForStore(store, async () => {
        try {
          await refresh();
          let instant;
          try { instant = now(); } catch { instant = null; }
          if (!isUtc(instant)) return Object.freeze({ ok: false, reason: "WORKER_LEASE_CLOCK_INVALID", dispatch: false });
          let activeLeaseCount = 0;
          let expiredLeaseCount = 0;
          let availableReservationCount = 0;
          for (const reservation of reservations.values()) {
            if (!reservation.lease) availableReservationCount += 1;
            else if (Date.parse(reservation.lease.expiresAt) > Date.parse(instant)) activeLeaseCount += 1;
            else expiredLeaseCount += 1;
          }
          return Object.freeze({ ok: true, reservationCount: reservations.size, activeLeaseCount,
            expiredLeaseCount, availableReservationCount, operationCount: operations.size, dispatch: false });
        } catch {
          return Object.freeze({ ok: false, reason: "WORKER_LEASE_JOURNAL_UNAVAILABLE", dispatch: false });
        }
      });
    }
  });
}

