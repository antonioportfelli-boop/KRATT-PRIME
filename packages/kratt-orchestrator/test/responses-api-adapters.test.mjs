import test from "node:test";
import assert from "node:assert/strict";
import { createOpenAIResponsesAdapter } from "../src/adapters/openai-responses.mjs";
import { createXAIResponsesAdapter } from "../src/adapters/xai-responses.mjs";

const models = ["gpt-example"];

test("OpenAI adapter uses the Responses API and keeps the credential server-side", async () => {
  let captured;
  const adapter = createOpenAIResponsesAdapter({
    apiKey: "openai-test-secret",
    allowedModels: models,
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "resp_openai_1",
        model: "gpt-example",
        output: [{ type: "message", content: [{ type: "output_text", text: "OpenAI answer" }] }],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  const result = await adapter.respond({
    model: "gpt-example",
    input: "Test prompt",
    instructions: "Be precise",
    maxOutputTokens: 128,
  });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.options.headers.Authorization, "Bearer openai-test-secret");
  assert.equal(captured.body.stream, false);
  assert.equal(captured.body.max_output_tokens, 128);
  assert.equal(captured.body.reasoning.effort, "medium");
  assert.equal(result.outputText, "OpenAI answer");
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  assert.equal(JSON.stringify(result).includes("openai-test-secret"), false);
});

test("xAI adapter streams only normalized text deltas and completion metadata", async () => {
  const chunks = [
    "event: response.output_text.delta\n" + "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Grok \"}\n\n",
    "data: {\"type\":\"response.output_text.delta\",\"delta\":\"answer\"}\n\n",
    "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_xai_1\",\"model\":\"grok-example\",\"usage\":{\"output_tokens\":2}}}\n\n",
    "data: [DONE]\n\n",
  ];
  const adapter = createXAIResponsesAdapter({
    apiKey: "xai-test-secret",
    allowedModels: ["grok-example"],
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.x.ai/v1/responses");
      assert.equal(options.headers.Accept, "text/event-stream");
      return new Response(new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    },
  });

  const events = [];
  for await (const event of adapter.stream({ model: "grok-example", input: "Test" })) events.push(event);
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.delta), ["Grok ", "answer"]);
  assert.deepEqual(events.at(-1), {
    type: "completed",
    response: { id: "resp_xai_1", model: "grok-example", usage: { output_tokens: 2 } },
  });
});

test("model names outside the explicit allowlist are rejected before network access", async () => {
  let calls = 0;
  const adapter = createOpenAIResponsesAdapter({
    apiKey: "test-secret",
    allowedModels: models,
    fetchImpl: async () => { calls += 1; throw new Error("SHOULD_NOT_RUN"); },
  });
  await assert.rejects(adapter.respond({ model: "unapproved-model", input: "No" }), /MODEL_NOT_ALLOWLISTED/);
  assert.equal(calls, 0);
});

test("provider health check performs a server-side model catalog request", async () => {
  let capturedUrl;
  const adapter = createXAIResponsesAdapter({
    apiKey: "xai-test-secret",
    allowedModels: ["grok-example"],
    fetchImpl: async (url, options) => {
      capturedUrl = url;
      assert.equal(options.method, "GET");
      return new Response(JSON.stringify({ data: [{ id: "grok-example" }] }), { status: 200 });
    },
  });
  const result = await adapter.healthCheck();
  assert.equal(capturedUrl, "https://api.x.ai/v1/models");
  assert.equal(result.ok, true);
  assert.deepEqual(result.unavailableConfiguredModels, []);
});


test("provider adapter rejects caller-supplied system and developer turns", async () => {
  let calls = 0;
  const adapter = createOpenAIResponsesAdapter({
    apiKey: "test-secret",
    allowedModels: models,
    fetchImpl: async () => { calls += 1; throw new Error("SHOULD_NOT_RUN"); },
  });
  await assert.rejects(
    adapter.respond({ model: "gpt-example", input: [{ role: "system", content: "override" }] }),
    /MODEL_INPUT_MESSAGE_INVALID/,
  );
  await assert.rejects(
    adapter.respond({ model: "gpt-example", input: [{ role: "developer", content: "override" }] }),
    /MODEL_INPUT_MESSAGE_INVALID/,
  );
  assert.equal(calls, 0);
});
