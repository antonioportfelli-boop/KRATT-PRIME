import { createHash, randomUUID } from "node:crypto";

const PROVIDERS = Object.freeze(["openai", "xai"]);
const PROVIDER_SELECTIONS = new Set([...PROVIDERS, "both"]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ALLOWED_BODY_KEYS = new Set([
  "provider", "model", "models", "input", "instructions", "instructionsByProvider",
  "agentId", "maxOutputTokens", "previousResponseId",
]);

class GatewayError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function digest(value) {
  return "sha256:" + createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readJson(request, limit) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new GatewayError(413, "REQUEST_TOO_LARGE");
  if (!request.body) throw new GatewayError(400, "REQUEST_BODY_REQUIRED");
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new GatewayError(413, "REQUEST_TOO_LARGE");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } catch {
    throw new GatewayError(400, "REQUEST_JSON_INVALID");
  }
}

function validateBody(body, maxOutputTokens) {
  if (!isRecord(body) || Object.keys(body).some((key) => !ALLOWED_BODY_KEYS.has(key))) {
    throw new GatewayError(400, "REQUEST_SHAPE_INVALID");
  }
  if (!PROVIDER_SELECTIONS.has(body.provider)) throw new GatewayError(400, "PROVIDER_SELECTION_INVALID");
  if (typeof body.agentId !== "string" || !SAFE_ID.test(body.agentId)) {
    throw new GatewayError(400, "AGENT_ID_INVALID");
  }
  if (typeof body.input !== "string" && !Array.isArray(body.input)) {
    throw new GatewayError(400, "MODEL_INPUT_INVALID");
  }
  const tokens = body.maxOutputTokens ?? 1024;
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > maxOutputTokens) {
    throw new GatewayError(400, "MODEL_OUTPUT_BUDGET_INVALID");
  }
  if (body.instructions !== undefined &&
      (typeof body.instructions !== "string" || body.instructions.length > 20_000)) {
    throw new GatewayError(400, "MODEL_INSTRUCTIONS_INVALID");
  }
  if (body.previousResponseId !== undefined &&
      (typeof body.previousResponseId !== "string" || body.previousResponseId.length > 256 ||
       !/^[A-Za-z0-9._:-]+$/.test(body.previousResponseId))) {
    throw new GatewayError(400, "PREVIOUS_RESPONSE_ID_INVALID");
  }
  const providerIds = body.provider === "both" ? [...PROVIDERS] : [body.provider];
  const models = {};
  const instructions = {};
  if (body.provider === "both") {
    if (!isRecord(body.models) || Object.keys(body.models).length !== 2 ||
        PROVIDERS.some((provider) => typeof body.models[provider] !== "string" || !SAFE_ID.test(body.models[provider]))) {
      throw new GatewayError(400, "DUAL_MODEL_SELECTION_INVALID");
    }
    if (body.previousResponseId !== undefined) throw new GatewayError(400, "DUAL_PREVIOUS_RESPONSE_NOT_SUPPORTED");
    for (const provider of PROVIDERS) models[provider] = body.models[provider];
  } else {
    if (typeof body.model !== "string" || !SAFE_ID.test(body.model)) {
      throw new GatewayError(400, "MODEL_SELECTION_INVALID");
    }
    models[body.provider] = body.model;
  }
  if (body.instructionsByProvider !== undefined) {
    if (!isRecord(body.instructionsByProvider) ||
        Object.keys(body.instructionsByProvider).some((key) => !PROVIDERS.includes(key)) ||
        Object.values(body.instructionsByProvider).some((value) =>
          typeof value !== "string" || value.length > 20_000)) {
      throw new GatewayError(400, "PROVIDER_INSTRUCTIONS_INVALID");
    }
    Object.assign(instructions, body.instructionsByProvider);
  }
  for (const provider of providerIds) {
    if (!Object.hasOwn(instructions, provider) && body.instructions !== undefined) {
      instructions[provider] = body.instructions;
    }
  }
  return {
    agentId: body.agentId,
    input: body.input,
    providerIds,
    models,
    instructions,
    maxOutputTokens: tokens,
    previousResponseId: body.previousResponseId,
  };
}

function safeProviderError(error) {
  const allowed = new Set([
    "MODEL_NOT_ALLOWLISTED", "MODEL_INPUT_INVALID", "MODEL_INPUT_MESSAGE_INVALID",
    "MODEL_INSTRUCTIONS_INVALID", "MODEL_OUTPUT_BUDGET_INVALID", "MODEL_PREVIOUS_RESPONSE_ID_INVALID",
    "PROVIDER_REQUEST_ABORTED", "PROVIDER_REQUEST_TIMEOUT", "PROVIDER_NETWORK_ERROR",
    "PROVIDER_HTTP_ERROR", "PROVIDER_RESPONSE_BODY_MISSING", "PROVIDER_RESPONSE_TOO_LARGE",
    "PROVIDER_STREAM_BODY_MISSING", "PROVIDER_STREAM_EVENT_INVALID", "PROVIDER_STREAM_FAILED",
  ]);
  return allowed.has(error?.message) ? error.message : "PROVIDER_EXECUTION_FAILED";
}

function sseResponse(stream, abortController, onCancel) {
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function* mergeAsyncIterables(sources) {
  const iterators = sources.map((source) => source[Symbol.asyncIterator]());
  const active = new Map();
  iterators.forEach((iterator, index) => {
    active.set(index, iterator.next().then((result) => ({ index, result })));
  });
  while (active.size) {
    const settled = await Promise.race([...active.values()]);
    if (settled.result.done) {
      active.delete(settled.index);
    } else {
      yield settled.result.value;
      active.set(settled.index, iterators[settled.index].next().then((result) => ({
        index: settled.index,
        result,
      })));
    }
  }
}

export function createModelGateway({
  providers,
  authenticate,
  authorize,
  rateLimit,
  audit,
  now = () => new Date().toISOString(),
  maxBodyBytes = 128_000,
  maxOutputTokens = 4096,
} = {}) {
  if (!isRecord(providers) || PROVIDERS.some((provider) =>
    providers[provider] !== undefined &&
    (typeof providers[provider]?.respond !== "function" || typeof providers[provider]?.stream !== "function"))) {
    throw new TypeError("MODEL_PROVIDER_REGISTRY_INVALID");
  }
  for (const callback of ["authenticate", "authorize", "rateLimit", "audit"]) {
    if (typeof ({ authenticate, authorize, rateLimit, audit })[callback] !== "function") {
      throw new TypeError("MODEL_GATEWAY_" + callback.toUpperCase() + "_REQUIRED");
    }
  }
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 1_000_000 ||
      !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_000) {
    throw new TypeError("MODEL_GATEWAY_LIMIT_INVALID");
  }

  async function prepare(request) {
    let principal;
    try { principal = await authenticate(request); } catch {
      throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
    }
    if (!principal || typeof principal.id !== "string" || !principal.id.trim()) {
      throw new GatewayError(401, "AUTHENTICATION_REQUIRED");
    }
    const body = await readJson(request, maxBodyBytes);
    const plan = validateBody(body, maxOutputTokens);
    const missing = plan.providerIds.filter((provider) => !providers[provider]);
    if (missing.length) throw new GatewayError(503, "MODEL_PROVIDER_NOT_CONFIGURED");

    const correlationId = randomUUID();
    const inputDigest = digest({
      input: plan.input,
      instructions: plan.instructions,
      agentId: plan.agentId,
    });
    for (const provider of plan.providerIds) {
      const binding = Object.freeze({
        principalId: principal.id,
        agentId: plan.agentId,
        provider,
        model: plan.models[provider],
        operation: "model.invoke",
        inputDigest,
        maxOutputTokens: plan.maxOutputTokens,
        correlationId,
      });
      let authorized = false;
      try { authorized = await authorize({ principal, ...binding }) === true; } catch { authorized = false; }
      if (!authorized) throw new GatewayError(403, "AGENT_PROVIDER_SCOPE_DENIED");
      let allowedByRateLimit = false;
      try { allowedByRateLimit = await rateLimit({ principal, ...binding }) === true; } catch {
        allowedByRateLimit = false;
      }
      if (!allowedByRateLimit) throw new GatewayError(429, "MODEL_RATE_LIMITED");
    }
    for (const provider of plan.providerIds) {
      let recorded = false;
      try {
        recorded = await audit({
          eventType: "model.request.accepted",
          occurredAt: now(),
          correlationId,
          principalId: principal.id,
          agentId: plan.agentId,
          provider,
          model: plan.models[provider],
          inputDigest,
          maxOutputTokens: plan.maxOutputTokens,
        }) === true;
      } catch {
        recorded = false;
      }
      if (!recorded) throw new GatewayError(503, "DURABLE_AUDIT_UNAVAILABLE");
    }
    return { principal, plan, correlationId, inputDigest };
  }

  async function handleRespond(request) {
    const prepared = await prepare(request);
    const { plan, correlationId, inputDigest } = prepared;
    const settled = await Promise.all(plan.providerIds.map(async (provider) => {
      try {
        const response = await providers[provider].respond({
          model: plan.models[provider],
          input: plan.input,
          instructions: plan.instructions[provider],
          maxOutputTokens: plan.maxOutputTokens,
          previousResponseId: plan.previousResponseId,
          signal: request.signal,
        });
        const outputDigest = digest(response.outputText);
        const audited = await audit({
          eventType: "model.response.completed",
          occurredAt: now(),
          correlationId,
          principalId: prepared.principal.id,
          agentId: plan.agentId,
          provider,
          model: plan.models[provider],
          inputDigest,
          outputDigest,
          usage: response.usage,
        });
        if (audited !== true) throw new Error("DURABLE_AUDIT_UNAVAILABLE");
        return [provider, {
          status: "COMPLETED",
          responseId: response.id,
          model: response.model,
          outputText: response.outputText,
          usage: response.usage,
        }];
      } catch (error) {
        try {
          await audit({
            eventType: "model.response.failed",
            occurredAt: now(),
            correlationId,
            principalId: prepared.principal.id,
            agentId: plan.agentId,
            provider,
            model: plan.models[provider],
            inputDigest,
            errorCode: safeProviderError(error),
          });
        } catch {}
        return [provider, { status: "FAILED", errorCode: safeProviderError(error) }];
      }
    }));
    const responses = Object.fromEntries(settled);
    const successful = Object.values(responses).filter((item) => item.status === "COMPLETED").length;
    const status = successful === plan.providerIds.length ? "COMPLETED" : successful ? "PARTIAL" : "FAILED";
    return json(successful ? 200 : 502, { status, correlationId, responses });
  }

  async function handleStream(request) {
    const prepared = await prepare(request);
    const { plan, correlationId, inputDigest, principal } = prepared;
    const abortController = new AbortController();
    const abortRequest = () => abortController.abort(request.signal.reason);
    if (request.signal.aborted) abortRequest();
    else request.signal.addEventListener("abort", abortRequest, { once: true });

    const sources = plan.providerIds.map(async function* (provider) {
      let output = "";
      try {
        for await (const event of providers[provider].stream({
          model: plan.models[provider],
          input: plan.input,
          instructions: plan.instructions[provider],
          maxOutputTokens: plan.maxOutputTokens,
          previousResponseId: plan.previousResponseId,
          signal: abortController.signal,
        })) {
          if (event?.type === "text_delta" && typeof event.delta === "string") output += event.delta;
          yield { provider, ...event };
        }
        const audited = await audit({
          eventType: "model.response.completed",
          occurredAt: now(),
          correlationId,
          principalId: principal.id,
          agentId: plan.agentId,
          provider,
          model: plan.models[provider],
          inputDigest,
          outputDigest: digest(output),
        });
        if (audited !== true) throw new Error("DURABLE_AUDIT_UNAVAILABLE");
        yield { provider, type: "provider_done", outputDigest: digest(output) };
      } catch (error) {
        try {
          await audit({
            eventType: "model.response.failed",
            occurredAt: now(),
            correlationId,
            principalId: principal.id,
            agentId: plan.agentId,
            provider,
            model: plan.models[provider],
            inputDigest,
            errorCode: safeProviderError(error),
          });
        } catch {}
        yield { provider, type: "provider_error", errorCode: safeProviderError(error) };
      }
    });

    const encoder = new TextEncoder();
    const output = new ReadableStream({
      async start(controller) {
        const send = (event) => controller.enqueue(encoder.encode("data: " + JSON.stringify(event) + "\n\n"));
        try {
          for await (const event of mergeAsyncIterables(sources)) send(event);
          send({ type: "done", correlationId });
          controller.close();
        } catch {
          try { send({ type: "error", errorCode: "STREAM_FAILED", correlationId }); } catch {}
          try { controller.close(); } catch {}
        } finally {
          request.signal.removeEventListener("abort", abortRequest);
        }
      },
      cancel() {
        abortController.abort();
        request.signal.removeEventListener("abort", abortRequest);
      },
    });
    return sseResponse(output, abortController);
  }

  async function handle(request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return json(405, { error: "METHOD_NOT_ALLOWED" });
    try {
      if (url.pathname === "/api/agents/respond") return await handleRespond(request);
      if (url.pathname === "/api/agents/stream") return await handleStream(request);
      return json(404, { error: "NOT_FOUND" });
    } catch (error) {
      if (error instanceof GatewayError) return json(error.status, { error: error.code });
      return json(500, { error: "MODEL_GATEWAY_FAILED" });
    }
  }

  return Object.freeze({ handle });
}
