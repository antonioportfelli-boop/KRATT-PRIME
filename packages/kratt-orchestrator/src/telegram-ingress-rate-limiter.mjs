import { createHash } from "node:crypto";

/**
 * Durable fixed-window ingress limiter. It hashes the socket peer address with
 * an operator-supplied salt and never persists raw IP addresses or forwarded
 * headers. The caller must supply the trusted socket remoteAddress only.
 */
export function createSqliteTelegramIngressRateLimiter(database, {
  salt,
  limit = 30,
  windowMs = 60_000,
  now = () => Date.now(),
} = {}) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("SQLITE_DATABASE_SYNC_REQUIRED");
  }
  if (typeof salt !== "string" || salt.length < 16 || salt.length > 256) {
    throw new TypeError("TELEGRAM_RATE_LIMIT_SALT_REQUIRED");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000 ||
      !Number.isInteger(windowMs) || windowMs < 1000 || windowMs > 24 * 60 * 60_000 ||
      typeof now !== "function" || !Number.isFinite(now())) {
    throw new TypeError("TELEGRAM_RATE_LIMIT_CONFIG_INVALID");
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS kratt_telegram_ingress_rate_limits (
      bucket_hash TEXT PRIMARY KEY,
      window_start_ms INTEGER NOT NULL,
      request_count INTEGER NOT NULL CHECK(request_count >= 0)
    );
  `);
  const get = database.prepare("SELECT window_start_ms,request_count FROM kratt_telegram_ingress_rate_limits WHERE bucket_hash=?");
  const insert = database.prepare("INSERT INTO kratt_telegram_ingress_rate_limits (bucket_hash,window_start_ms,request_count) VALUES (?,?,1)");
  const update = database.prepare("UPDATE kratt_telegram_ingress_rate_limits SET request_count=? WHERE bucket_hash=? AND window_start_ms=?");
  const reset = database.prepare("UPDATE kratt_telegram_ingress_rate_limits SET window_start_ms=?,request_count=1 WHERE bucket_hash=?");
  const purge = database.prepare("DELETE FROM kratt_telegram_ingress_rate_limits WHERE window_start_ms + ? < ?");

  function transaction(fn) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = fn(); database.exec("COMMIT"); return result; }
    catch (error) { try { database.exec("ROLLBACK"); } catch {} throw error; }
  }

  return function allowTelegramIngress({ remoteAddress, method } = {}) {
    if (typeof remoteAddress !== "string" || remoteAddress.length < 1 || remoteAddress.length > 128 || method !== "POST") return false;
    let current;
    try { current = now(); } catch { return false; }
    if (!Number.isFinite(current)) return false;
    const bucketHash = createHash("sha256").update(salt, "utf8").update("\0").update(remoteAddress, "utf8").digest("hex");
    try {
      return transaction(() => {
        purge.run(windowMs * 2, current);
        const row = get.get(bucketHash);
        if (!row) { insert.run(bucketHash, current); return true; }
        if (current - Number(row.window_start_ms) >= windowMs || current < Number(row.window_start_ms)) {
          reset.run(current, bucketHash);
          return true;
        }
        if (Number(row.request_count) >= limit) return false;
        update.run(Number(row.request_count) + 1, bucketHash, row.window_start_ms);
        return true;
      });
    } catch { return false; }
  };
}
