import { createHash } from "node:crypto";

const API_ROOTS = Object.freeze({
  openai: "https://api.openai.com/v1",
  xai: "https://api.x.ai/v1",
});
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RESPONSE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const ROLES = new Set(["user", "assistant"]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateInput(input) {
  if (typeof input === "string") {
    if (!input.trim() || input.length > 100_000) throw new TypeError("MODEL_INPUT_INVALID");
    return input;
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new TypeError("MODEL_INPUT_INVALID");
  }
  return input.map((item) => {
    if (!isPlainObject(item) || !ROLES.has(item.role) ||
        typeof item.content !== "string" || !item.content.trim() ||
        item.content.length > 50_000 ||
        Object.keys(item).some((key) => !["role", "content"].includes(key))) {
      throw new TypeError("MODEL_INPUT_MESSAGE_INVALID");
    }
    return Object.freeze({ role: item.role, content: item.content });
  });
}

function validateRequest({ model, input, instructions, maxOutputTokens, previousResponseId }, limits) {
  if (typeof model !== "string" || !MODEL_ID.test(model) || !limits.allowedModels.has(model)) {
    throw new TypeError("MODEL_NOT_ALLOWLISTED");
  }
  const safeInput = validateInput(input);
  if (instructions !== undefined &&
      (typeof instructions !== "string" || instructions.length > 20_000)) {
    throw new TypeError("MODEL_INSTRUCTIONS_INVALID");
  }
  const outputTokens = maxOutputTokens ?? limits.defaultMaxOutputTokens;
  if (!Number.isInteger(outputTokens) || outputTokens < 1 || outputTokens > limits.maxOutputTokens) {
    throw new TypeError("MODEL_OUTPUT_BUDGET_INVALID");
  }
  if (previousResponseId !== undefined &&
      (typeof previousResponseId !== "string" || !RESPONSE_ID.test(previousResponseId))) {
    throw new TypeError("MODEL_PREVIOUS_RESPONSE_ID_INVALID");
  }
  return { model, input: safeInput, instructions, maxOutputTokens: outputTokens, previousResponseId };
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJsonBounded(response, maxBytes = 2_000_000) {
  if (!response.body) throw new Error("PROVIDER_RESPONSE_BODY_MISSING");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("PROVIDER_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
}

function normalizeUsage(usage) {
  if (!isPlainObject(usage)) return null;
  const result = {};
  for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
    if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) result[key] = usage[key];
  }
  return Object.keys(result).length ? Object.freeze(result) : null;
}

function extractOutputText(response) {
  if (typeof response?.output_text === "string") return response.output_text;
  const parts = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function summarizeResponse(response) {
  return Object.freeze({
    id: typeof response?.id === "string" ? response.id : null,
    model: typeof response?.model === "string" ? response.model : null,
    outputText: extractOutputText(response),
    usage: normalizeUsage(response?.usage),
  });
}

function parseSseBlock(block) {
  let eventName = "";
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (!data.length) return null;
  const raw = data.join("\n");
  if (raw === "[DONE]") return { type: "done" };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error("PROVIDER_STREAM_EVENT_INVALID");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("PROVIDER_STREAM_EVENT_INVALID");
  }
  return { ...payload, type: payload.type ?? eventName };
}

export function createResponsesApiAdapter({
  providerId,
  apiKey,
  fetchImpl = globalThis.fetch,
  allowedModels,
  timeoutMs = 900_000,
  maxOutputTokens = 4096,
  defaultMaxOutputTokens = 1024,
  reasoningEffort = "medium",
} = {}) {
  const apiRoot = API_ROOTS[providerId];
  if (!apiRoot) throw new TypeError("MODEL_PROVIDER_UNSUPPORTED");
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new TypeError("MODEL_PROVIDER_KEY_REQUIRED");
  if (typeof fetchImpl !== "function") throw new TypeError("MODEL_FETCH_REQUIRED");
  if (!Array.isArray(allowedModels) || allowedModels.length === 0 ||
      !allowedModels.every((model) => typeof model === "string" && MODEL_ID.test(model)) ||
      new Set(allowedModels).size !== allowedModels.length) {
    throw new TypeError("MODEL_ALLOWLIST_REQUIRED");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 250 || timeoutMs > 1_800_000) {
    throw new TypeError("MODEL_TIMEOUT_INVALID");
  }
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 32_000 ||
      !Number.isInteger(defaultMaxOutputTokens) || defaultMaxOutputTokens < 1 ||
      defaultMaxOutputTokens > maxOutputTokens) {
    throw new TypeError("MODEL_OUTPUT_BUDGET_INVALID");
  }

  if (typeof reasoningEffort !== "string" || !/^[a-z]{2,16}$/.test(reasoningEffort)) {
    throw new TypeError("MODEL_REASONING_EFFORT_INVALID");
  }
  const limits = {
    allowedModels: new Set(allowedModels),
    maxOutputTokens,
    defaultMaxOutputTokens,
    reasoningEffort,
  };

  async function send(path, options) {
    let response;
    try {
      response = await fetchImpl(apiRoot + path, {
        ...options,
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          Accept: options?.headers?.Accept ?? "application/json",
        },
        signal: requestSignal(options?.signal, timeoutMs),
      });
    } catch (error) {
      if (options?.signal?.aborted) throw new Error("PROVIDER_REQUEST_ABORTED");
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new Error("PROVIDER_REQUEST_TIMEOUT");
      }
      throw new Error("PROVIDER_NETWORK_ERROR");
    }
    if (!response.ok) {
      throw Object.assign(new Error("PROVIDER_HTTP_ERROR"), { status: response.status });
    }
    return response;
  }

  async function respond(args = {}) {
    const request = validateRequest(args, limits);
    const payload = {
      model: request.model,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
      reasoning: { effort: limits.reasoningEffort },
      stream: false,
    };
    if (request.instructions !== undefined) payload.instructions = request.instructions;
    if (request.previousResponseId !== undefined) {
      payload.previous_response_id = request.previousResponseId;
    }
    const response = await send("/responses", {
      method: "POST",
      body: JSON.stringify(payload),
      signal: args.signal,
    });
    const body = await readJsonBounded(response);
    return Object.freeze({
      provider: providerId,
      ...summarizeResponse(body),
    });
  }

  async function* stream(args = {}) {
    const request = validateRequest(args, limits);
    const payload = {
      model: request.model,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
      reasoning: { effort: limits.reasoningEffort },
      stream: true,
    };
    if (request.instructions !== undefined) payload.instructions = request.instructions;
    if (request.previousResponseId !== undefined) {
      payload.previous_response_id = request.previousResponseId;
    }
    const response = await send("/responses", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: { Accept: "text/event-stream" },
      signal: args.signal,
    });
    if (!response.body) throw new Error("PROVIDER_STREAM_BODY_MISSING");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finished = false;
    try {
      while (!finished) {
        const item = await reader.read();
        buffer += decoder.decode(item.value ?? new Uint8Array(), { stream: !item.done });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          const match = buffer.slice(boundary).match(/^\r?\n\r?\n/);
          buffer = buffer.slice(boundary + match[0].length);
          const event = parseSseBlock(block);
          if (event?.type === "done") {
            finished = true;
            break;
          }
          if (!event) {
            boundary = buffer.search(/\r?\n\r?\n/);
            continue;
          }
          if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
            yield Object.freeze({ type: "text_delta", delta: event.delta });
          } else if (event.type === "response.completed") {
            yield Object.freeze({
              type: "completed",
              response: Object.freeze({
                id: typeof event.response?.id === "string" ? event.response.id : null,
                model: typeof event.response?.model === "string" ? event.response.model : request.model,
                usage: normalizeUsage(event.response?.usage),
              }),
            });
          } else if (event.type === "response.failed" || event.type === "error") {
            throw new Error("PROVIDER_STREAM_FAILED");
          }
          boundary = buffer.search(/\r?\n\r?\n/);
        }
        if (item.done) break;
      }
      if (!finished && buffer.trim()) {
        const event = parseSseBlock(buffer);
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
          yield Object.freeze({ type: "text_delta", delta: event.delta });
        } else if (event?.type === "response.failed" || event?.type === "error") {
          throw new Error("PROVIDER_STREAM_FAILED");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function healthCheck({ signal } = {}) {
    const response = await send("/models", { method: "GET", headers: { Accept: "application/json" }, signal });
    const body = await readJsonBounded(response, 1_000_000);
    const available = new Set(Array.isArray(body?.data)
      ? body.data.map((item) => item?.id).filter((id) => typeof id === "string")
      : []);
    return Object.freeze({
      provider: providerId,
      ok: true,
      modelCatalogAvailable: available.size > 0,
      configuredModels: Object.freeze([...allowedModels]),
      unavailableConfiguredModels: Object.freeze([...allowedModels].filter((model) => available.size && !available.has(model))),
      checkedAt: new Date().toISOString(),
    });
  }

  return Object.freeze({
    providerId,
    capabilities: Object.freeze(["model.invoke", "model.stream"]),
    respond,
    stream,
    healthCheck,
  });
}
