import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createSqliteTelegramIngressRateLimiter } from "../../kratt-orchestrator/src/telegram-ingress-rate-limiter.mjs";

test("SQLite ingress limiter enforces a fixed window per salted socket peer", () => {
  const database = new DatabaseSync(":memory:");
  try {
    let current = 100_000;
    const allow = createSqliteTelegramIngressRateLimiter(database, {
      salt: "unit-test-only-rate-limit-salt",
      limit: 2,
      windowMs: 1000,
      now: () => current,
    });
    const request = { remoteAddress: "127.0.0.1", method: "POST" };
    assert.equal(allow(request), true);
    assert.equal(allow(request), true);
    assert.equal(allow(request), false);
    current += 1001;
    assert.equal(allow(request), true);
  } finally { database.close(); }
});

test("SQLite ingress limiter fails closed on missing peer, wrong method and DB/config failures", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const allow = createSqliteTelegramIngressRateLimiter(database, {
      salt: "unit-test-only-rate-limit-salt",
    });
    assert.equal(allow({ method: "POST" }), false);
    assert.equal(allow({ remoteAddress: "127.0.0.1", method: "GET" }), false);
    assert.throws(() => createSqliteTelegramIngressRateLimiter(database, { salt: "short" }), /TELEGRAM_RATE_LIMIT_SALT_REQUIRED/);
  } finally { database.close(); }
});
