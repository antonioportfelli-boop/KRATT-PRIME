import { createOpenAIResponsesAdapter } from "./adapters/openai-responses.mjs";
import { createXAIResponsesAdapter } from "./adapters/xai-responses.mjs";
import { createModelGateway } from "./model-gateway.mjs";

function parseModelAllowlist(value, variableName) {
  const models = String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
  if (models.length === 0) throw new Error(variableName + "_REQUIRED");
  if (new Set(models).size !== models.length) throw new Error(variableName + "_DUPLICATE");
  return models;
}

/**
 * Build the shared gateway for a Netlify Server entrypoint.
 *
 * Authentication, agent policy, rate limiting and durable audit are injected
 * from the host application. This module intentionally refuses to create
 * development identities or an in-memory audit fallback.
 */
export function createNetlifyAgentGateway({
  env = process.env,
  fetchImpl = globalThis.fetch,
  authenticate,
  resolveInstructions,
  authorize,
  rateLimit,
  audit,
} = {}) {
  const providers = {};
  if (typeof env.OPENAI_API_KEY === "string" && env.OPENAI_API_KEY.trim()) {
    providers.openai = createOpenAIResponsesAdapter({
      apiKey: env.OPENAI_API_KEY,
      allowedModels: parseModelAllowlist(env.OPENAI_MODELS, "OPENAI_MODELS"),
      reasoningEffort: env.OPENAI_REASONING_EFFORT ?? "medium",
      fetchImpl,
    });
  }
  if (typeof env.XAI_API_KEY === "string" && env.XAI_API_KEY.trim()) {
    providers.xai = createXAIResponsesAdapter({
      apiKey: env.XAI_API_KEY,
      allowedModels: parseModelAllowlist(env.XAI_MODELS, "XAI_MODELS"),
      reasoningEffort: env.XAI_REASONING_EFFORT ?? "medium",
      fetchImpl,
    });
  }
  if (!providers.openai || !providers.xai) throw new Error("OPENAI_AND_XAI_SERVER_KEYS_REQUIRED");
  return createModelGateway({
    providers,
    authenticate,
    resolveInstructions,
    authorize,
    rateLimit,
    audit,
  });
}
