import { createHash } from "node:crypto";
import { createSqliteNonceStore } from "../../kratt-core/src/sqlite-nonce-store.mjs";

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("TELEGRAM_STORE_VALUE_NOT_CANONICAL");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) throw new TypeError("TELEGRAM_STORE_SYMBOL_KEY");
  return `{${keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("TELEGRAM_STORE_ACCESSOR_REJECTED");
    return `${JSON.stringify(key)}:${stable(descriptor.value)}`;
  }).join(",")}}`;
}

function hash(value) {
  return `sha256:${createHash("sha256").update(stable(value), "utf8").digest("hex")}`;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

/**
 * Durable single-host Telegram persistence adapter.
 * Requires Node DatabaseSync or better-sqlite3. All state transitions use
 * SQLite transactions and uniqueness constraints; no in-memory fallback.
 */
export function createSqliteTelegramStore(database, { nonceStore = createSqliteNonceStore(database), leaseMs = 30_000 } = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("SQLITE_DATABASE_SYNC_REQUIRED");
  }
  if (!nonceStore || typeof nonceStore.consume !== "function") throw new TypeError("DURABLE_NONCE_STORE_REQUIRED");
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 5 * 60_000) throw new TypeError("TELEGRAM_UPDATE_LEASE_INVALID");

  database.exec(`
    CREATE TABLE IF NOT EXISTS kratt_telegram_updates (
      update_id INTEGER PRIMARY KEY,
      payload_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PROCESSING','COMPLETED')),
      lease_token TEXT,
      lease_until_ms INTEGER,
      result_json TEXT,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kratt_telegram_intakes (
      candidate_id TEXT PRIMARY KEY,
      update_id INTEGER NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      FOREIGN KEY(update_id) REFERENCES kratt_telegram_updates(update_id)
    );
    CREATE TABLE IF NOT EXISTS kratt_telegram_review_requests (
      request_id TEXT PRIMARY KEY,
      request_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('PENDING','PROCESSING','CONSUMED','CANCELLED'))
    );
    CREATE TABLE IF NOT EXISTS kratt_telegram_decisions (
      decision_id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL UNIQUE,
      decision_json TEXT NOT NULL,
      FOREIGN KEY(request_id) REFERENCES kratt_telegram_review_requests(request_id)
    );
    CREATE TABLE IF NOT EXISTS kratt_telegram_audit_events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL,
      previous_hash TEXT,
      event_hash TEXT NOT NULL UNIQUE
    );
  `);

  const nonce = nonceStore;
  const statements = {
    getUpdate: database.prepare("SELECT * FROM kratt_telegram_updates WHERE update_id = ?"),
    insertUpdate: database.prepare("INSERT OR IGNORE INTO kratt_telegram_updates (update_id,payload_digest,status,lease_token,lease_until_ms,result_json,received_at) VALUES (?,?,'PROCESSING',?,?,NULL,?)"),
    reclaimUpdate: database.prepare("UPDATE kratt_telegram_updates SET lease_token=?, lease_until_ms=? WHERE update_id=? AND payload_digest=? AND status='PROCESSING' AND lease_until_ms<=?"),
    completeUpdate: database.prepare("UPDATE kratt_telegram_updates SET status='COMPLETED', lease_token=NULL, lease_until_ms=NULL, result_json=? WHERE update_id=? AND payload_digest=? AND status='PROCESSING' AND lease_token=?"),
    releaseUpdate: database.prepare("DELETE FROM kratt_telegram_updates WHERE update_id=? AND status='PROCESSING' AND lease_token=?"),
    insertIntake: database.prepare("INSERT OR IGNORE INTO kratt_telegram_intakes (candidate_id,update_id,payload_json) VALUES (?,?,?)"),
    saveRequest: database.prepare("INSERT INTO kratt_telegram_review_requests (request_id,request_json,state) VALUES (?,?,'PENDING')"),
    getRequest: database.prepare("SELECT request_json,state FROM kratt_telegram_review_requests WHERE request_id=?"),
    claimRequest: database.prepare("UPDATE kratt_telegram_review_requests SET state='PROCESSING' WHERE request_id=? AND state='PENDING'"),
    releaseRequest: database.prepare("UPDATE kratt_telegram_review_requests SET state='PENDING' WHERE request_id=? AND state='PROCESSING'"),
    cancelRequest: database.prepare("UPDATE kratt_telegram_review_requests SET state='CANCELLED' WHERE request_id=? AND state='PENDING'"),
    consumeRequest: database.prepare("UPDATE kratt_telegram_review_requests SET state='CONSUMED' WHERE request_id=? AND state='PROCESSING'"),
    insertDecision: database.prepare("INSERT INTO kratt_telegram_decisions (decision_id,request_id,decision_json) VALUES (?,?,?)"),
    listIntakes: database.prepare("SELECT payload_json FROM kratt_telegram_intakes ORDER BY rowid"),
    listRequests: database.prepare("SELECT request_json,state FROM kratt_telegram_review_requests ORDER BY rowid"),
    listDecisions: database.prepare("SELECT decision_json FROM kratt_telegram_decisions ORDER BY rowid"),
    listEvents: database.prepare("SELECT event_json,event_hash,previous_hash FROM kratt_telegram_audit_events ORDER BY sequence"),
    lastEvent: database.prepare("SELECT sequence,event_hash FROM kratt_telegram_audit_events ORDER BY sequence DESC LIMIT 1"),
    insertEvent: database.prepare("INSERT INTO kratt_telegram_audit_events (sequence,event_id,event_json,previous_hash,event_hash) VALUES (?,?,?,?,?)"),
  };

  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      try { database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function appendAuditEvent(event) {
    if (!event || typeof event.eventId !== "string" || typeof event.type !== "string") return false;
    try {
      return transaction(() => {
        const previous = statements.lastEvent.get();
        const sequence = Number(previous?.sequence ?? 0) + 1;
        const previousHash = previous?.event_hash ?? null;
        const body = { ...event, sequence, previousHash };
        delete body.hash;
        const eventHash = hash(body);
        const stored = Object.freeze({ ...body, hash: eventHash });
        statements.insertEvent.run(sequence, stored.eventId, stable(stored), previousHash, eventHash);
        return true;
      });
    } catch { return false; }
  }

  function claimUpdate(updateId, payloadDigest, receivedAt, nowMs = Date.now()) {
    if (!Number.isSafeInteger(updateId) || updateId < 0 || !/^sha256:[0-9a-f]{64}$/.test(payloadDigest) ||
        typeof receivedAt !== "string" || !Number.isFinite(Date.parse(receivedAt)) || !Number.isFinite(nowMs)) {
      return Object.freeze({ status: "INVALID" });
    }
    const leaseToken = `telegram-lease:${hash({ updateId, payloadDigest, nowMs, salt: Math.random() })}`;
    try {
      return transaction(() => {
        const inserted = statements.insertUpdate.run(updateId, payloadDigest, leaseToken, nowMs + leaseMs, receivedAt);
        if (Number(inserted.changes) === 1) return Object.freeze({ status: "CLAIMED", leaseToken });
        const prior = statements.getUpdate.get(updateId);
        if (!prior || prior.payload_digest !== payloadDigest) return Object.freeze({ status: "MISMATCH" });
        if (prior.status === "COMPLETED") return Object.freeze({ status: "DUPLICATE", result: parseJson(prior.result_json) });
        const reclaimed = statements.reclaimUpdate.run(leaseToken, nowMs + leaseMs, updateId, payloadDigest, nowMs);
        return Number(reclaimed.changes) === 1
          ? Object.freeze({ status: "CLAIMED", leaseToken })
          : Object.freeze({ status: "PENDING" });
      });
    } catch { return Object.freeze({ status: "ERROR" }); }
  }

  function persistIntake(intake, { updateId, payloadDigest, leaseToken } = {}) {
    try {
      return transaction(() => {
        const inserted = statements.insertIntake.run(intake.candidateId, updateId, stable(intake));
        if (Number(inserted.changes) !== 1) return false;
        const result = { status: "OK", reason: "TELEGRAM_INTAKE_RECORDED_UNREVIEWED", intake };
        const completed = statements.completeUpdate.run(stable(result), updateId, payloadDigest, leaseToken);
        if (Number(completed.changes) !== 1) return false;
        return true;
      });
    } catch { return false; }
  }

  function completeUpdate({ updateId, payloadDigest, leaseToken, result }) {
    try {
      return transaction(() => Number(statements.completeUpdate.run(stable(result), updateId, payloadDigest, leaseToken).changes) === 1);
    } catch { return false; }
  }

  function releaseUpdate({ updateId, leaseToken }) {
    try { return Number(statements.releaseUpdate.run(updateId, leaseToken).changes) === 1; } catch { return false; }
  }

  function saveReviewRequest(request) {
    try { statements.saveRequest.run(request.requestId, stable(request)); return true; } catch { return false; }
  }

  function getReviewRequest(requestId) {
    const row = statements.getRequest.get(requestId);
    if (!row) return null;
    const request = parseJson(row.request_json);
    return request ? Object.freeze({ request, state: row.state }) : null;
  }

  function claimReviewRequest(requestId) {
    try { return Number(statements.claimRequest.run(requestId).changes) === 1; } catch { return false; }
  }

  function releaseReviewRequest(requestId) {
    try { return Number(statements.releaseRequest.run(requestId).changes) === 1; } catch { return false; }
  }

  function cancelReviewRequest(requestId) {
    try { return Number(statements.cancelRequest.run(requestId).changes) === 1; } catch { return false; }
  }

  function persistDecision(record, binding) {
    const proof = binding?.approvalProof;
    if (!proof || typeof proof !== "object" || typeof proof.key_id !== "string" ||
        typeof proof.nonce !== "string" || typeof proof.approval_id !== "string" ||
        typeof proof.expires_at !== "string") return false;
    try {
      return transaction(() => {
        const current = statements.getRequest.get(record.requestId);
        if (!current || current.state !== "PROCESSING") return false;
        const consumed = nonce.consume(proof.key_id, proof.nonce, proof.approval_id, proof.expires_at, Date.parse(record.verifiedAt));
        if (consumed !== true) return false;
        statements.insertDecision.run(record.decisionId, record.requestId, stable(record));
        if (Number(statements.consumeRequest.run(record.requestId).changes) !== 1) return false;
        return true;
      });
    } catch { return false; }
  }

  function snapshot() {
    return Object.freeze({
      intakes: statements.listIntakes.all().map(row => parseJson(row.payload_json)).filter(Boolean),
      reviewRequests: statements.listRequests.all().map(row => ({ request: parseJson(row.request_json), state: row.state })),
      decisions: statements.listDecisions.all().map(row => parseJson(row.decision_json)).filter(Boolean),
      journal: statements.listEvents.all().map(row => parseJson(row.event_json)).filter(Boolean),
    });
  }

  return Object.freeze({
    claimUpdate, persistIntake, completeUpdate, releaseUpdate,
    saveReviewRequest, getReviewRequest, claimReviewRequest,
    releaseReviewRequest, cancelReviewRequest, persistDecision,
    appendAuditEvent, snapshot,
  });
}
