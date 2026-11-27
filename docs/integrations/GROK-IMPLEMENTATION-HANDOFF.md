# Grok implementation handoff — KRATT OpenAI/xAI bridge

Use this file as the handoff brief for a Grok engineering agent. It is not a claim that a Grok chat session was invoked automatically.

## Task

Continue branch feature/agent-provider-bridge-openai-xai-2026-11-27 in antonioportfelli-boop/KRATT-PRIME. Inspect the committed adapter/gateway modules and extend the actual kratt-fabric Netlify application only after its source repository has been positively identified.

## Shared provider contract

The current bridge lives in:

- packages/kratt-orchestrator/src/adapters/responses-api-adapter.mjs
- packages/kratt-orchestrator/src/adapters/openai-responses.mjs
- packages/kratt-orchestrator/src/adapters/xai-responses.mjs
- packages/kratt-orchestrator/src/model-gateway.mjs
- packages/kratt-orchestrator/src/netlify-agent-gateway.mjs

Use the Responses API for OpenAI and xAI. Do not regress to legacy Chat Completions. Never put provider secrets in browser code. Models must be explicit allowlist entries from server configuration. Do not enable provider tools or execute model-returned code.

## Required Netlify work

1. Identify the exact Git repository and deploy context backing https://kratt-fabric.netlify.app. Do not assume the repository named main or the public KRATT-PRIME repository is the source of that website.
2. Reuse the site's existing identity/session mechanism. Inject the real authenticate, authorize, rateLimit and durable audit callbacks into createNetlifyAgentGateway. Never create an unauthenticated preview identity or an in-memory audit fallback.
3. Mount /api/agents/respond and /api/agents/stream on Netlify Server, or document a compatible hosted backend if Netlify Server is not enabled for the site. Keep the frontend same-origin.
4. Add a provider health panel that reflects actual server-side model catalog checks. A configured key alone must never render as CONNECTED or VERIFIED.
5. Add user-initiated controls for OpenAI, Grok and parallel mode. Show provider, model, correlation ID, budget and run state. Stream text through SSE with reconnection; persist runs and event offsets outside a single server instance.
6. Treat tool proposals from either model as untrusted data. Map a proposal to a KRATT task envelope and require the existing policy evaluator, trusted evidence, request-bound approval, idempotent dispatch and durable audit before any repository or external write.
7. Keep repository Forge operations scoped to the user-selected owner/repo, branch and path. Preserve the rule that editor drafts do not push. Never attempt the forbidden repositories already excluded by the project brief.
8. Keep main and production untouched. Use a separate feature branch and draft PR. Do not deploy or enable external writes.

## Acceptance gates

- Unit tests pass for both adapters and the gateway.
- Typecheck/build pass for the actual Netlify application.
- A mocked-provider integration test proves both response streams can multiplex without losing provider attribution.
- Unauthenticated, unauthorized, over-budget, missing-audit and missing-key tests all fail closed.
- Browser tests on desktop and mobile confirm SSE reconnect, cancellation, no secret leakage and readable agent status.
- The public site is not called live until a real deploy and live provider health checks have succeeded.

If the Netlify source repository is not available, stop after producing a source-to-deploy mapping report. Do not guess a repository and do not deploy.
