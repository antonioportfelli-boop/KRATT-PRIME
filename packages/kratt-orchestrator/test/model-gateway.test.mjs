import test from "node:test";
import assert from "node:assert/strict";
import { createModelGateway } from "../src/model-gateway.mjs";

function makeAdapter(provider, calls) {
  return Object.freeze({
    async respond(args) {
      calls.push({ provider, args });
      return {
        provider,
        id: "resp-" + provider,
        model: args.model,
        outputText: provider + " answer",
        usage: { output_tokens: 2 },
      };
    },
    async *stream(args) {
      calls.push({ provider, args });
      yield { type: "text_delta", delta: provider + " says " };
      yield { type: "text_delta", delta: "hello" };
      yield { type: "completed", response: { id: "resp-" + provider, model: args.model } };
    },
  });
}

function setup(overrides = {}) {
  const calls = [];
  const auditRecords = [];
  const providers = {
    openai: makeAdapter("openai", calls),
    xai: makeAdapter("xai", calls),
  };
  const gateway = createModelGateway({
    providers,
    authenticate: async () => ({ id: "principal-1" }),
    authorize: async () => true,
    rateLimit: async () => true,
    audit: async (record) => { auditRecords.push(record); return true; },
    ...overrides,
  });
  return { gateway, calls, auditRecords };
}

const body = (overrides = {}) => ({
  provider: "openai",
  model: "gpt-example",
  agentId: "research-agent",
  input: "Find reliable evidence",
  maxOutputTokens: 100,
  ...overrides,
});

test("respond gateway authenticates, authorizes, rate-limits and durably audits before dispatch", async () => {
  const { gateway, calls, auditRecords } = setup();
  const response = await gateway.handle(new Request("https://example.test/api/agents/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body()),
  }));
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.status, "COMPLETED");
  assert.equal(result.responses.openai.outputText, "openai answer");
  assert.equal(calls.length, 1);
  assert.equal(auditRecords[0].eventType, "model.request.accepted");
  assert.equal(auditRecords[1].eventType, "model.response.completed");
  assert.equal(Object.hasOwn(auditRecords[0], "input"), false);
});

test("unauthorized agent cannot reach either provider", async () => {
  const { gateway, calls } = setup({ authorize: async () => false });
  const response = await gateway.handle(new Request("https://example.test/api/agents/respond", {
    method: "POST", body: JSON.stringify(body()),
  }));
  assert.equal(response.status, 403);
  assert.equal(calls.length, 0);
});

test("durable audit outage fails closed before a model request", async () => {
  const { gateway, calls } = setup({ audit: async () => false });
  const response = await gateway.handle(new Request("https://example.test/api/agents/respond", {
    method: "POST", body: JSON.stringify(body()),
  }));
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});

test("both providers can stream through one SSE channel with provider attribution", async () => {
  const { gateway, calls, auditRecords } = setup();
  const response = await gateway.handle(new Request("https://example.test/api/agents/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body({
      provider: "both",
      models: { openai: "gpt-example", xai: "grok-example" },
    })),
  }));
  const streamText = await response.text();
  assert.equal(response.status, 200);
  assert.match(streamText, /"provider":"openai"/);
  assert.match(streamText, /"provider":"xai"/);
  assert.match(streamText, /openai says /);
  assert.match(streamText, /xai says /);
  assert.match(streamText, /"type":"done"/);
  assert.equal(calls.length, 2);
  assert.equal(auditRecords.filter((record) => record.eventType === "model.request.accepted").length, 2);
});

test("missing credentials or model adapters block dual-provider invocation before dispatch", async () => {
  const { gateway, calls } = setup({ providers: { openai: makeAdapter("openai", []) } });
  const response = await gateway.handle(new Request("https://example.test/api/agents/respond", {
    method: "POST",
    body: JSON.stringify(body({
      provider: "both",
      models: { openai: "gpt-example", xai: "grok-example" },
    })),
  }));
  assert.equal(response.status, 503);
  assert.equal(calls.length, 0);
});
