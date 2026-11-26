import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const HASH = /^[a-f0-9]{64}$/;
const ZERO = "0".repeat(64);
const validId = value => typeof value === "string" && ID.test(value);
const validHash = value => typeof value === "string" && HASH.test(value);
const fail = reason => ({ ok: false, reason });

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (!value || typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    throw new TypeError("ACK_AUDIT_RECORD_NOT_JSON");
  const keys = Object.keys(value).sort();
  if (keys.length > 128 || keys.some(key => ["__proto__", "constructor", "prototype"].includes(key)))
    throw new TypeError("ACK_AUDIT_RECORD_KEYS_INVALID");
  return "{" + keys.map(key => JSON.stringify(key) + ":" + stable(value[key])).join(",") + "}";
}

function auditHash(sequence, previous, json) {
  return createHash("sha256").update(String(sequence) + "\n" + previous + "\n" + json, "utf8").digest("hex");
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    if (result === false || (result && result.ok === false)) {
      await client.query("ROLLBACK");
      return result;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export function createPostgresFabricAcknowledgementStore(pool, { clock = () => new Date() } = {}) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function")
    throw new TypeError("POSTGRES_POOL_REQUIRED");
  if (typeof clock !== "function") throw new TypeError("TRUSTED_CLOCK_REQUIRED");

  function nowIso() {
    const value = clock();
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new TypeError("TRUSTED_CLOCK_INVALID");
    return date.toISOString();
  }

  async function appendAudit(client, record) {
    const json = stable(record);
    if (Buffer.byteLength(json, "utf8") > 32768) throw new TypeError("ACK_AUDIT_RECORD_TOO_LARGE");
    const head = await client.query("SELECT sequence,hash FROM kratt_audit_head WHERE singleton=TRUE FOR UPDATE");
    const sequence = Number(head.rows[0]?.sequence ?? 0) + 1;
    const previous = head.rows[0]?.hash ?? ZERO;
    const hash = auditHash(sequence, previous, json);
    await client.query(
      "INSERT INTO kratt_audit_events(sequence,event_id,event_type,created_at,record_json,previous_hash,hash) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)",
      [sequence, record.event_id, record.event_type, record.created_at, json, previous, hash]
    );
    await client.query("UPDATE kratt_audit_head SET sequence=$1,hash=$2 WHERE singleton=TRUE", [sequence, hash]);
    return { sequence, hash };
  }

  async function applyReceiverAcknowledgement({
    outboxId, leaseToken, acknowledgement, authenticatedReceiver, receivedAt
  } = {}) {
    const ack = acknowledgement;
    if (!validId(outboxId) || typeof leaseToken !== "string" || leaseToken.length < 16 || leaseToken.length > 128 ||
      !ack || !validId(ack.ack_id) || !validId(ack.event_id) || !validId(ack.source_node) ||
      !validId(ack.receiver_node) || !validId(ack.key_id) || !validId(ack.policy_revision) ||
      !Number.isSafeInteger(ack.source_sequence) || ack.source_sequence < 1 ||
      !Number.isSafeInteger(ack.delivery_attempt) || ack.delivery_attempt < 1 ||
      !validHash(ack.event_digest) || !validHash(ack.content_digest) ||
      !["ACCEPTED", "REJECTED", "DUPLICATE", "UNKNOWN"].includes(ack.result) ||
      !authenticatedReceiver || authenticatedReceiver.key_id !== ack.key_id ||
      authenticatedReceiver.node_id !== ack.receiver_node || authenticatedReceiver.content_digest !== ack.content_digest ||
      !["ACTIVE", "VERIFY_ONLY"].includes(authenticatedReceiver.status)) return fail("ACK_STORE_INPUT_INVALID");

    const at = receivedAt ?? nowIso();
    if (typeof at !== "string" || !Number.isFinite(Date.parse(at))) return fail("ACK_RECEIVED_TIME_INVALID");

    try {
      return await transaction(pool, async client => {
        const identity = await client.query(
          "SELECT i.task_id FROM kratt_dispatch_outbox o JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key WHERE o.outbox_id=$1",
          [outboxId]
        );
        if (identity.rowCount !== 1) return fail("ACK_OUTBOX_NOT_FOUND");
        const taskId = identity.rows[0].task_id;
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [taskId]);

        const existing = await client.query(
          "SELECT ack_id,outbox_id,delivery_attempt,content_digest,result FROM kratt_fabric_receiver_acknowledgements " +
          "WHERE ack_id=$1 OR (outbox_id=$2 AND delivery_attempt=$3) FOR UPDATE",
          [ack.ack_id, outboxId, ack.delivery_attempt]
        );
        if (existing.rowCount) {
          const same = existing.rows.length === 1 && existing.rows[0].ack_id === ack.ack_id &&
            existing.rows[0].outbox_id === outboxId &&
            Number(existing.rows[0].delivery_attempt) === ack.delivery_attempt &&
            existing.rows[0].content_digest === ack.content_digest &&
            existing.rows[0].result === ack.result;
          if (same) return { ok: true, duplicate: true, status: existing.rows[0].result, outbox_status: null };
          return fail("ACK_REPLAY_CONFLICT");
        }

        const row = await client.query(
          "SELECT o.status,o.provider,o.attempts,o.lease_token,o.delivery_started_at,o.delivery_lease_token," +
          "o.idempotency_key,i.task_id,i.status AS intent_status," +
          "e.event_id,e.source_node,e.destination_node,e.source_sequence,e.content_digest " +
          "FROM kratt_dispatch_outbox o " +
          "JOIN kratt_dispatch_intents i ON i.idempotency_key=o.idempotency_key " +
          "JOIN kratt_fabric_outbound_events e ON e.idempotency_key=o.idempotency_key " +
          "WHERE o.outbox_id=$1 FOR UPDATE OF o,i",
          [outboxId]
        );
        if (row.rowCount !== 1) return fail("ACK_FABRIC_EVENT_NOT_FOUND");
        const item = row.rows[0];
        if (item.task_id !== taskId || item.provider !== "fabric" || item.intent_status !== "INTENT_COMMITTED")
          return fail("ACK_TASK_OR_PROVIDER_BINDING_INVALID");
        if (!["LEASED", "RECONCILE"].includes(item.status) || !item.delivery_started_at ||
          item.delivery_lease_token !== leaseToken || (item.status === "LEASED" && item.lease_token !== leaseToken))
          return fail("ACK_DELIVERY_FENCE_MISMATCH");
        if (Number(item.attempts) !== ack.delivery_attempt) return fail("ACK_ATTEMPT_MISMATCH");
        if (item.event_id !== ack.event_id || item.source_node !== ack.source_node ||
          item.destination_node !== ack.receiver_node || Number(item.source_sequence) !== ack.source_sequence ||
          item.content_digest !== ack.event_digest) return fail("ACK_EVENT_BINDING_MISMATCH");
        const cancelled = await client.query("SELECT task_id FROM kratt_cancelled_tasks WHERE task_id=$1", [taskId]);
        if (cancelled.rowCount) return fail("ACK_TASK_CANCELLED");

        await client.query(
          "INSERT INTO kratt_fabric_receiver_acknowledgements(" +
          "ack_id,outbox_id,idempotency_key,event_id,source_node,receiver_node,source_sequence,event_digest," +
          "delivery_attempt,result,policy_revision,key_id,content_digest,issued_at,received_at,ack_json) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)",
          [ack.ack_id,outboxId,item.idempotency_key,ack.event_id,ack.source_node,ack.receiver_node,
            ack.source_sequence,ack.event_digest,ack.delivery_attempt,ack.result,ack.policy_revision,ack.key_id,
            ack.content_digest,ack.issued_at,at,JSON.stringify(ack)]
        );

        const confirmed = ack.result === "ACCEPTED" || ack.result === "DUPLICATE";
        const auditRecord = {
          schema_version: "kratt-audit/v1",
          event_id: "fabric-ack:" + createHash("sha256").update(ack.ack_id).digest("hex"),
          event_type: confirmed ? "fabric.receiver_ack.confirmed" : "fabric.receiver_ack.reconcile_required",
          created_at: at,
          actor_id: ack.receiver_node,
          task_id: taskId,
          provider: "fabric",
          outbox_id: outboxId,
          event_id_remote: ack.event_id,
          source_sequence: ack.source_sequence,
          event_digest: ack.event_digest,
          delivery_attempt: ack.delivery_attempt,
          acknowledgement_id: ack.ack_id,
          acknowledgement_digest: ack.content_digest,
          acknowledgement_result: ack.result,
          policy_revision: ack.policy_revision,
          key_id: ack.key_id
        };
        await appendAudit(client, auditRecord);

        if (confirmed) {
          const intent = await client.query(
            "UPDATE kratt_dispatch_intents SET status='COMPLETED',updated_at=$1 " +
            "WHERE idempotency_key=$2 AND status='INTENT_COMMITTED' RETURNING idempotency_key",
            [at,item.idempotency_key]
          );
          if (intent.rowCount !== 1) throw new Error("ACK_INTENT_STATE_CONFLICT");
          const outbox = await client.query(
            "UPDATE kratt_dispatch_outbox SET status='DONE',lease_owner=NULL,lease_token=NULL,lease_until=NULL," +
            "last_error_code=NULL,updated_at=$1 WHERE outbox_id=$2 AND status IN ('LEASED','RECONCILE') RETURNING outbox_id",
            [at,outboxId]
          );
          if (outbox.rowCount !== 1) throw new Error("ACK_OUTBOX_STATE_CONFLICT");
          return { ok: true, duplicate: false, status: ack.result, outbox_status: "DONE" };
        }

        const errorCode = ack.result === "REJECTED" ? "RECEIVER_REJECTED" : "RECEIVER_OUTCOME_UNKNOWN";
        const outbox = await client.query(
          "UPDATE kratt_dispatch_outbox SET status='RECONCILE',lease_owner=NULL,lease_token=NULL,lease_until=NULL," +
          "last_error_code=$1,updated_at=$2 WHERE outbox_id=$3 AND status IN ('LEASED','RECONCILE') RETURNING outbox_id",
          [errorCode,at,outboxId]
        );
        if (outbox.rowCount !== 1) throw new Error("ACK_OUTBOX_STATE_CONFLICT");
        return { ok: true, duplicate: false, status: ack.result, outbox_status: "RECONCILE", reconciliation_required: true };
      });
    } catch (error) {
      if (error?.code === "23505") return fail("ACK_REPLAY_CONFLICT");
      throw error;
    }
  }

  return Object.freeze({ applyReceiverAcknowledgement });
}
