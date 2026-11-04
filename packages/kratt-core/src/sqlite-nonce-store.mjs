const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * SQLite-backed one-time approval nonce store.
 *
 * Pass a synchronous SQLite connection (Node DatabaseSync or better-sqlite3).
 * The database file must be stored on durable local storage. SQLite's unique
 * constraints make each nonce/approval claim atomic across concurrent writers.
 * This adapter is suitable for a single-host runtime; multi-host deployments
 * should provide a shared transactional database adapter implementing consume().
 */
export function createSqliteNonceStore(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("SQLITE_DATABASE_SYNC_REQUIRED");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS kratt_approval_nonces (
      key_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      approval_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (key_id, nonce),
      UNIQUE (key_id, approval_id)
    ) WITHOUT ROWID
  `);

  const purgeExpired = database.prepare(
    "DELETE FROM kratt_approval_nonces WHERE expires_at_ms <= ?"
  );
  const insertClaim = database.prepare(
    "INSERT OR IGNORE INTO kratt_approval_nonces (key_id, nonce, approval_id, expires_at_ms) VALUES (?, ?, ?, ?)"
  );

  function consume(keyId, nonce, approvalId, expiresAt, nowMs) {
    if (![keyId, nonce, approvalId].every(value => typeof value === "string" && ID.test(value)) ||
        typeof expiresAt !== "string" || !ISO_UTC.test(expiresAt) || !Number.isFinite(Date.parse(expiresAt)) ||
        !Number.isFinite(nowMs)) return false;

    try {
      purgeExpired.run(nowMs);
      const result = insertClaim.run(keyId, nonce, approvalId, Date.parse(expiresAt));
      return Number(result.changes) === 1;
    } catch {
      return false;
    }
  }

  return Object.freeze({ consume });
}
