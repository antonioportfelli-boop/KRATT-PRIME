import test from "node:test";
import assert from "node:assert/strict";
import { createLocalServer } from "../src/local-server.mjs";

test("local server serves UI and loopback-only health/state APIs", async () => {
  const app = createLocalServer({ port: 0, host: "127.0.0.1" });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const healthResponse = await fetch(`${origin}/api/health`);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.mode, "local-development");
    assert.equal(health.externalConnections, false);
    assert.equal(health.externalWrites, false);

    const page = await fetch(origin);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /KRATT PRIME — Intelligence Operations/);

    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.adapters.length, 5);
    assert.ok(state.adapters.every(adapter => adapter.state === "DISCOVERED"));

    const verification = await (await fetch(`${origin}/api/verify`)).json();
    assert.equal(verification.status, "OK");
    assert.equal(verification.eventCount, 5);
  } finally {
    await app.close();
  }
});

test("local server accepts bounded intake and rejects malformed source contracts", async () => {
  const app = createLocalServer({ port: 0, host: "127.0.0.1" });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const accepted = await fetch(`${origin}/api/intake`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ label:"Baltic infrastructure watch", sourceType:"rss_atom" }),
    });
    assert.equal(accepted.status, 201);
    const result = await accepted.json();
    assert.equal(result.intake.networkAccess, false);

    const rejected = await fetch(`${origin}/api/intake`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({ label:"Live Telegram poll", sourceType:"telegram_live" }),
    });
    assert.equal(rejected.status, 400);
  } finally {
    await app.close();
  }
});

test("local server refuses non-loopback bind addresses", () => {
  assert.throws(() => createLocalServer({ host:"0.0.0.0" }), /LOCAL_SERVER_MUST_BIND_LOOPBACK/);
});


test("local intake automatically segments supplied text and records provenance metadata", async () => {
  const app = createLocalServer({ port: 0, host: "127.0.0.1" });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/intake`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        label:"Evidence segmentation pilot",
        sourceType:"manual_url",
        sourceUrl:"https://example.test/brief",
        content:"First paragraph contains a supported statement.\n\nSecond paragraph contains a separate unreviewed statement.",
      }),
    });
    assert.equal(response.status, 201);
    const payload = await response.json();
    assert.equal(payload.segmentation.segmentCount, 2);
    assert.equal(payload.segmentation.segments[0].reviewState, "UNREVIEWED");
    assert.equal(payload.segmentation.segments[0].sourceId, payload.intake.sourceId);

    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.segmentations.length, 1);
    assert.equal(state.journal.at(-1).type, "KNOWLEDGE_SEGMENTED");
    assert.equal(state.journal.at(-1).source, payload.intake.sourceId);
  } finally {
    await app.close();
  }
});

test("invalid segmentation input is rejected before an intake is recorded", async () => {
  const app = createLocalServer({ port: 0, host: "127.0.0.1" });
  const address = await app.listen();
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/api/intake`, {
      method:"POST",
      headers:{ "Content-Type":"application/json" },
      body:JSON.stringify({
        label:"Invalid text",
        sourceType:"manual_url",
        content:"   ",
      }),
    });
    assert.equal(response.status, 400);
    const state = await (await fetch(`${origin}/api/state`)).json();
    assert.equal(state.intakes.length, 0);
  } finally {
    await app.close();
  }
});
