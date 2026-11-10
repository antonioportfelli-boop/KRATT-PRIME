import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createTelegramWebhookHandler } from "../../kratt-orchestrator/src/telegram-webhook-handler.mjs";

const secret = "webhook-handler-test-secret";

async function withServer(handler, run) {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try { await run(`http://127.0.0.1:${address.port}`); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

function handlerFor({ allowRequest = async () => true, result = { status: "OK", reason: "TEST_ACCEPTED" }, maxBodyBytes = 64 * 1024 } = {}) {
  const received = [];
  const controlPlane = {
    async ingestAuthenticatedUpdate(args) {
      received.push(args);
      return result;
    },
  };
  return {
    received,
    handler: createTelegramWebhookHandler({ controlPlane, webhookSecret: secret, allowRequest, maxBodyBytes }),
  };
}

test("webhook ingress accepts authenticated bounded JSON and delegates to the control plane", async () => {
  const { handler, received } = handlerFor();
  await withServer(handler, async base => {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: 12, message: { text: "untrusted source" } }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "OK");
    assert.equal(received.length, 1);
    assert.equal(received[0].update.update_id, 12);
    assert.equal(received[0].receivedSecret, secret);
  });
});

test("webhook ingress rejects missing or incorrect secret before parsing", async () => {
  const { handler, received } = handlerFor();
  await withServer(handler, async base => {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).reason, "WEBHOOK_AUTHENTICATION_FAILED");
    assert.equal(received.length, 0);
  });
});

test("webhook ingress enforces method, content type and edge rate-limit contract", async () => {
  const { handler } = handlerFor({ allowRequest: async () => false });
  await withServer(handler, async base => {
    const method = await fetch(base);
    assert.equal(method.status, 405);
    const contentType = await fetch(base, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret }, body: "{}" });
    assert.equal(contentType.status, 415);
    const limited = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: "{}",
    });
    assert.equal(limited.status, 429);
  });
});

test("webhook ingress rejects malformed and oversized JSON bodies", async () => {
  const { handler } = handlerFor({ maxBodyBytes: 1024 });
  await withServer(handler, async base => {
    const malformed = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: "{invalid",
    });
    assert.equal(malformed.status, 400);
    const oversized = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: 1, message: { text: "x".repeat(2000) } }),
    });
    assert.equal(oversized.status, 413);
  });
});

test("webhook ingress maps duplicate and pending outcomes to retry-safe HTTP codes", async () => {
  const { handler: duplicateHandler } = handlerFor({ result: { status: "DUPLICATE", reason: "SEEN" } });
  await withServer(duplicateHandler, async base => {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: "{}",
    });
    assert.equal(response.status, 200);
  });
  const { handler: pendingHandler } = handlerFor({ result: { status: "PENDING", reason: "PROCESSING" } });
  await withServer(pendingHandler, async base => {
    const response = await fetch(base, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: "{}",
    });
    assert.equal(response.status, 202);
  });
});
