import { createResponsesApiAdapter } from "./responses-api-adapter.mjs";

export function createOpenAIResponsesAdapter(options = {}) {
  return createResponsesApiAdapter({ ...options, providerId: "openai" });
}
