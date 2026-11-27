# OpenAI + xAI real-time agent gateway

Status: implementation on a feature branch; not connected to the public Netlify deployment yet.

## Runtime contract

The gateway exposes two same-origin POST endpoints:

- /api/agents/respond returns one provider response or a bounded parallel response from both providers.
- /api/agents/stream returns Server-Sent Events. The request may select openai, xai, or both; each event carries its provider identifier and text deltas.

The adapters use the OpenAI-compatible Responses API endpoint for each provider. They never accept an arbitrary base URL, never forward provider API keys to the browser, and only invoke explicitly allowlisted model IDs. Tool calling is intentionally disabled in this first bridge. Model output is data, not authority; any future tool request must be translated into a KRATT task and sent through the existing policy, approval, idempotency and audit path.

## Required host controls

The gateway constructor refuses to start without all four host callbacks:

1. authenticate(request) must resolve the existing signed user/session. Do not trust a user ID from JSON.
2. authorize(context) must check principal, agent ID, provider, model, operation, input digest and token budget against the existing KRATT policy and agent registry.
3. rateLimit(context) must apply per-principal and per-agent concurrency, token and spend budgets.
4. audit(record) must durably append the allow/dispatch/outcome record. It must return true only after the durable write succeeds.

All of these are fail-closed. The gateway stores only a digest of the input in its audit record, never the prompt or API key. A missing or failed audit write prevents provider dispatch. Provider invocation itself is billable external data transfer and must be separately authorized.

## Server-only environment

Configure these variables in the Netlify server/function runtime, not in client build variables:

- OPENAI_API_KEY
- XAI_API_KEY
- OPENAI_MODELS (comma-separated exact model IDs allowed for this application)
- XAI_MODELS (comma-separated exact model IDs allowed for this application)

Do not use VITE_OPENAI_API_KEY, VITE_XAI_API_KEY, NEXT_PUBLIC_*, or any browser-exposed setting. Do not paste credentials into source, commits, logs, prompts, or issue descriptions. Rotate any credential that has already been committed or exposed.

The composition helper in packages/kratt-orchestrator/src/netlify-agent-gateway.mjs creates both provider adapters from server environment variables. It intentionally requires both provider keys and explicit model allowlists. The host must inject real authentication, policy, rate-limit and durable-audit callbacks. There is no preview identity, mock authorizer or in-memory audit fallback.

## Netlify real-time deployment

For a continuously connected agent console, mount the gateway behind Netlify Server and use its SSE route for streamed model output. Netlify documents WebSockets and Server-Sent Events for Netlify Server, which is currently an Early Access product. Ordinary Functions are appropriate for discrete request/response work, but are not the long-lived connection host.

The public Netlify site source repository and its Netlify project configuration were not available during this implementation. Therefore this change does not add a speculative netlify/server entrypoint, does not alter the current static deploy, and does not claim that the public site is live-connected. The next integration step is to mount the handler in the actual kratt-fabric site repository after confirming that source repository and its existing session/auth/policy modules.

SSE streams must reconnect after network loss, deploy replacement or request-duration termination. Persist agent sessions, tasks, event offsets and audit records in a shared durable store; do not rely on one Netlify Server instance's memory. A stream connection is transport, not durable task state.

## Verification scope

The tests use injected fetch implementations and provider doubles. They verify API endpoint selection, auth header placement, model allowlisting, SSE parsing, authorization, rate limits, audit-before-dispatch and dual-provider stream attribution. They do not prove live API credentials, deployed Netlify availability, provider account quota, production latency or end-to-end UI wiring.
