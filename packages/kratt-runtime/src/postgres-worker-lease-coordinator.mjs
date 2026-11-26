import { createHash } from "node:crypto";

export const POSTGRES_WORKER_LEASE_SCHEMA = "kratt-worker-lease-postgres/v1";
const RESERVATIONS = "kratt_worker_lease_reservations";
const OPERATIONS = "kratt_worker_lease_operations";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const MIN_TTL_MS = 1_000;
const MAX_TTL_MS = 15 * 60 * 1_000;
const MAX_FENCE = Number.MAX_SAFE_INTEGER;

const fail = (reason, extra = {}) => Object.freeze({
  ok: false, state: "BLOCKED", reason, dispatch: false, executionStarted: false, ...extra
});
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactDataObject(value, fields) {
  try {
    if (!plain(value) || Reflect.ownKeys(value).length !== fields.length) return false;
    return fields.every(field => {
      const descriptor = Object.getOwnPropertyDescriptor(value, field);
      return Boolean(descriptor && Object.hasOwn(descriptor, "value") &&
        descriptor.get === undefined && descriptor.set === undefined);
    });
  } catch { return false; }
}
function canonical(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (budget.nodes > 20_000 || depth > 20) throw new TypeError("LEASE_VALUE_LIMIT");
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("LEASE_NON_FINITE_NUMBER");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new TypeError("LEASE_ARRAY_LIMIT");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length")) {
      throw new TypeError("LEASE_ARRAY_SHAPE_INVALID");
    }
    const values = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value")) {
        throw new TypeError("LEASE_ARRAY_ACCESSOR_OR_HOLE");
      }
      values.push(canonical(descriptor.value, depth + 1, budget));
    }
    return "[" + values.join(",") + "]";
  }
  if (!plain(value)) throw new TypeError("LEASE_VALUE_NOT_CANONICAL");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 1024 || keys.some(key => typeof key !== "string" ||
      ["__proto__", "constructor", "prototype"].includes(key))) {
    throw new TypeError("LEASE_KEYS_INVALID");
  }
  return "{" + keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError("LEASE_ACCESSOR_REJECTED");
    return JSON.stringify(key) + ":" + canonical(descriptor.value, depth + 1, budget);
  }).join(",") + "}";
}
function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}
function iso(value) {
  const date = asDate(value);
  return date ? date.toISOString() : null;
}
function safeFence(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function normalizeReservation(row) {
  if (!row) return null;
  const fence = safeFence(row.fence);
  const expiresAt = row.expires_at === null ? null : iso(row.expires_at);
  if (!ID.test(row.reservation_key ?? "") || !DIGEST.test(row.task_digest ?? "") ||
      !["AVAILABLE", "LEASED"].includes(row.status) || fence === null ||
      (row.status === "LEASED" && (!ID.test(row.owner_id ?? "") || !expiresAt)) ||
      (row.status === "AVAILABLE" && (row.owner_id !== null || row.expires_at !== null))) {
    throw new Error("POSTGRES_WORKER_LEASE_ROW_INVALID");
  }
  return Object.freeze({
    schemaVersion: POSTGRES_WORKER_LEASE_SCHEMA,
    reservationKey: row.reservation_key,
    taskDigest: row.task_digest,
    fence,
    status: row.status,
    lease: row.status === "LEASED" ? Object.freeze({ ownerId: row.owner_id, expiresAt }) : null
  });
}
async function transaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
async function databaseNow(client) {
  const result = await client.query("SELECT clock_timestamp() AS now");
  const value = iso(result.rows[0]?.now);
  if (!value) throw new Error("POSTGRES_WORKER_LEASE_CLOCK_INVALID");
  return value;
}

/**
 * Cross-process lease coordinator backed by PostgreSQL transactions.
 *
 * Each operation is serialized by an operation advisory lock and each
 * reservation is serialized by SELECT FOR UPDATE. A monotonically increasing
 * BIGINT fence is exposed only while it remains within JavaScript's safe
 * integer range. The caller must enforce this fence again at the side-effect
 * target; the coordinator never executes or dispatches work.
 */
export function createPostgresWorkerLeaseCoordinator(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("POSTGRES_POOL_REQUIRED");
  }

  async function open() {
    const result = await pool.query(
      "SELECT COUNT(*)::text AS count FROM " + RESERVATIONS
    );
    if (!result.rows?.[0]) throw new Error("POSTGRES_WORKER_LEASE_SCHEMA_UNAVAILABLE");
    return Object.freeze({ ok: true });
  }

  async function execute(operation, request, fields) {
    if (!exactDataObject(request, fields) || !ID.test(request.operationId ?? "") ||
        !ID.test(request.reservationKey ?? "") || !DIGEST.test(request.taskDigest ?? "") ||
        !ID.test(request.ownerId ?? "")) {
      return fail("WORKER_LEASE_REQUEST_INVALID");
    }
    if (["acquire", "renew"].includes(operation) &&
        (!Number.isSafeInteger(request.ttlMs) || request.ttlMs < MIN_TTL_MS || request.ttlMs > MAX_TTL_MS)) {
      return fail("WORKER_LEASE_TTL_INVALID");
    }
    if (operation !== "acquire" &&
        (!Number.isSafeInteger(request.fencingToken) || request.fencingToken < 1)) {
      return fail("WORKER_LEASE_FENCE_INVALID");
    }

    const normalizedRequest = operation === "acquire"
      ? {
          operationId: request.operationId, reservationKey: request.reservationKey,
          taskDigest: request.taskDigest, ownerId: request.ownerId, ttlMs: request.ttlMs
        }
      : {
          operationId: request.operationId, reservationKey: request.reservationKey,
          taskDigest: request.taskDigest, ownerId: request.ownerId,
          fencingToken: request.fencingToken,
          ...(operation === "renew" ? { ttlMs: request.ttlMs } : {})
        };
    const operationDigest = "sha256:" + hash(canonical({ operation, request: normalizedRequest }));

    return transaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "kratt-worker-lease-operation:" + request.operationId
      ]);

      const prior = await client.query(
        "SELECT operation_digest, operation, reservation_key, result_json FROM " +
        OPERATIONS + " WHERE operation_id = $1 FOR UPDATE",
        [request.operationId]
      );
      if (prior.rowCount > 0) {
        const saved = prior.rows[0];
        if (saved.operation_digest !== operationDigest) {
          return fail("WORKER_LEASE_OPERATION_ID_REUSED");
        }
        const savedResult = typeof saved.result_json === "string"
          ? JSON.parse(saved.result_json) : saved.result_json;
        if (!savedResult?.ok || saved.operation === "release") {
          return Object.freeze({ ...savedResult, duplicate: true });
        }
        const current = await client.query(
          "SELECT reservation_key, task_digest, fence, status, owner_id, expires_at FROM " +
          RESERVATIONS + " WHERE reservation_key = $1 FOR UPDATE",
          [saved.reservation_key]
        );
        const reservation = normalizeReservation(current.rows[0]);
        const now = await databaseNow(client);
        if (!reservation || reservation.taskDigest !== request.taskDigest ||
            reservation.status !== "LEASED" || reservation.lease.ownerId !== request.ownerId ||
            reservation.fence !== savedResult.fencingToken ||
            Date.parse(reservation.lease.expiresAt) <= Date.parse(now)) {
          return fail("WORKER_LEASE_REPLAY_STALE", { duplicate: true });
        }
        return Object.freeze({
          ok: true, state: "LEASED", reservationKey: reservation.reservationKey,
          ownerId: request.ownerId, fencingToken: reservation.fence,
          expiresAt: reservation.lease.expiresAt, duplicate: true,
          dispatch: false, executionStarted: false
        });
      }

      await client.query(
        "INSERT INTO " + RESERVATIONS +
        " (reservation_key, task_digest, fence, status, owner_id, expires_at) " +
        "VALUES ($1, $2, 0, 'AVAILABLE', NULL, NULL) ON CONFLICT (reservation_key) DO NOTHING",
        [request.reservationKey, request.taskDigest]
      );
      const locked = await client.query(
        "SELECT reservation_key, task_digest, fence, status, owner_id, expires_at FROM " +
        RESERVATIONS + " WHERE reservation_key = $1 FOR UPDATE",
        [request.reservationKey]
      );
      if (locked.rowCount !== 1) throw new Error("POSTGRES_WORKER_LEASE_RESERVATION_MISSING");
      let reservation = normalizeReservation(locked.rows[0]);
      const now = await databaseNow(client);
      let result;

      if (reservation.taskDigest !== request.taskDigest) {
        result = fail("WORKER_RESERVATION_PAYLOAD_CONFLICT");
      } else if (operation === "acquire") {
        const active = reservation.status === "LEASED" &&
          Date.parse(reservation.lease.expiresAt) > Date.parse(now);
        if (active) {
          result = fail("WORKER_LEASE_HELD", {
            fencingToken: reservation.fence, expiresAt: reservation.lease.expiresAt
          });
        } else if (reservation.fence >= MAX_FENCE) {
          result = fail("WORKER_FENCE_EXHAUSTED");
        } else {
          const expiresAt = new Date(Date.parse(now) + request.ttlMs).toISOString();
          await client.query(
            "UPDATE " + RESERVATIONS +
            " SET fence = $1, status = 'LEASED', owner_id = $2, expires_at = $3, updated_at = $4 " +
            "WHERE reservation_key = $5",
            [reservation.fence + 1, request.ownerId, expiresAt, now, request.reservationKey]
          );
          result = Object.freeze({
            ok: true, state: "LEASED", reservationKey: request.reservationKey,
            ownerId: request.ownerId, fencingToken: reservation.fence + 1,
            expiresAt, dispatch: false, executionStarted: false
          });
        }
      } else {
        const active = reservation.status === "LEASED" &&
          Date.parse(reservation.lease.expiresAt) > Date.parse(now);
        if (!active) {
          if (reservation.status === "LEASED") {
            await client.query(
              "UPDATE " + RESERVATIONS +
              " SET status = 'AVAILABLE', owner_id = NULL, expires_at = NULL, updated_at = $1 " +
              "WHERE reservation_key = $2",
              [now, request.reservationKey]
            );
          }
          result = fail("WORKER_LEASE_EXPIRED", { fencingToken: request.fencingToken });
        } else if (reservation.lease.ownerId !== request.ownerId) {
          result = fail("WORKER_LEASE_OWNER_MISMATCH", { fencingToken: reservation.fence });
        } else if (reservation.fence !== request.fencingToken) {
          result = fail("WORKER_FENCING_TOKEN_STALE", { fencingToken: reservation.fence });
        } else if (operation === "renew") {
          const expiresAt = new Date(Date.parse(now) + request.ttlMs).toISOString();
          await client.query(
            "UPDATE " + RESERVATIONS +
            " SET expires_at = $1, updated_at = $2 WHERE reservation_key = $3 AND fence = $4",
            [expiresAt, now, request.reservationKey, request.fencingToken]
          );
          result = Object.freeze({
            ok: true, state: "LEASED", reservationKey: request.reservationKey,
            ownerId: request.ownerId, fencingToken: request.fencingToken,
            expiresAt, dispatch: false, executionStarted: false
          });
        } else {
          await client.query(
            "UPDATE " + RESERVATIONS +
            " SET status = 'AVAILABLE', owner_id = NULL, expires_at = NULL, updated_at = $1 " +
            "WHERE reservation_key = $2 AND fence = $3 AND owner_id = $4",
            [now, request.reservationKey, request.fencingToken, request.ownerId]
          );
          result = Object.freeze({
            ok: true, state: "RELEASED", reservationKey: request.reservationKey,
            ownerId: request.ownerId, fencingToken: request.fencingToken,
            dispatch: false, executionStarted: false
          });
        }
      }

      await client.query(
        "INSERT INTO " + OPERATIONS +
        " (operation_id, operation_digest, operation, reservation_key, result_json, created_at) " +
        "VALUES ($1, $2, $3, $4, $5::jsonb, $6)",
        [request.operationId, operationDigest, operation, request.reservationKey, JSON.stringify(result), now]
      );
      return result;
    });
  }

  async function inspect(reservationKey) {
    if (!ID.test(reservationKey ?? "")) {
      return Object.freeze({ ok: false, reason: "WORKER_RESERVATION_KEY_INVALID" });
    }
    const result = await pool.query(
      "SELECT reservation_key, task_digest, fence, status, owner_id, expires_at, " +
      "(status = 'AVAILABLE' OR (status = 'LEASED' AND expires_at > clock_timestamp())) AS lease_active FROM " +
      RESERVATIONS + " WHERE reservation_key = $1",
      [reservationKey]
    );
    return Object.freeze({
      ok: true,
      reservation: result.rowCount === 1 && (result.rows[0].lease_active !== false)
        ? normalizeReservation(result.rows[0]) : null,
      executionStarted: false,
      dispatch: false
    });
  }

  async function status() {
    try {
      const result = await pool.query(
        "SELECT COUNT(*)::text AS reservations, " +
        "COUNT(*) FILTER (WHERE status = 'LEASED' AND expires_at > clock_timestamp())::text AS active, " +
        "COUNT(*) FILTER (WHERE status = 'LEASED' AND expires_at <= clock_timestamp())::text AS expired, " +
        "COUNT(*) FILTER (WHERE status = 'AVAILABLE')::text AS available, " +
        "(SELECT COUNT(*)::text FROM " + OPERATIONS + ") AS operations " +
        "FROM " + RESERVATIONS
      );
      const row = result.rows[0];
      const counts = [row.reservations, row.active, row.expired, row.available, row.operations].map(Number);
      if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) {
        return Object.freeze({ ok: false, reason: "WORKER_LEASE_STATUS_INVALID", dispatch: false });
      }
      return Object.freeze({
        ok: true, reservationCount: counts[0], activeLeaseCount: counts[1],
        expiredLeaseCount: counts[2], availableReservationCount: counts[3],
        operationCount: counts[4], dispatch: false
      });
    } catch {
      return Object.freeze({ ok: false, reason: "WORKER_LEASE_STORE_UNAVAILABLE", dispatch: false });
    }
  }

  return Object.freeze({
    open,
    acquire: request => execute("acquire", request,
      ["operationId", "reservationKey", "taskDigest", "ownerId", "ttlMs"]),
    renew: request => execute("renew", request,
      ["operationId", "reservationKey", "taskDigest", "ownerId", "fencingToken", "ttlMs"]),
    release: request => execute("release", request,
      ["operationId", "reservationKey", "taskDigest", "ownerId", "fencingToken"]),
    inspect,
    status
  });
}
