import { createResponsesApiAdapter } from "./responses-api-adapter.mjs";

export function createXAIResponsesAdapter(options = {}) {
  return createResponsesApiAdapter({ ...options, providerId: "xai" });
}
