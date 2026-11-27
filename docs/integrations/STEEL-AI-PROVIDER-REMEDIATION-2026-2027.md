# STEEL AI provider hardening assessment

**Review date:** 2026-11-27  
**Reviewed source:** 3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP-  
**Reviewed main:** 1da5fd84d9ebb0a796326e3453d052ca73bc7650 (2026-11-11)  
**Reviewed AI branch:** feat/kratt-dual-ai-wave444 at ad7b347d4c7f89140acd1c20137aecbe60fbc141  
**Integration status:** feature-only; not part of STEEL main and no open PR was returned in this review

## 1. Source-of-truth findings

The actual organisation repository is a separate source from the Antonio-account fork. The connected account can read the organisation repository and its branch. Its metadata reports push permission, but the GitHub integration denied creation of a new branch with HTTP 403 (Resource not accessible by integration). No write was made to the organisation repository, its existing feature branch, or main.

The AI branch is one commit ahead and one commit behind STEEL main. The feature branch adds an OpenAI/xAI provider scaffold and tests, but does not make the integration production-ready. The similarly named feature/ai-access-hub-grok-openai-v1 branch was observed at the same SHA as main in this snapshot and is not evidence of a separate implementation.

## 2. Findings ranked by risk

### P0 — request timeout ends before response-body consumption

In src/server/ai/providers/http-provider.ts, send() starts an AbortController timer but clears the timer in its finally block immediately after fetch() returns headers. generate() reads response.json() only after send() has returned; stream() reads the response body after the timer has also been cleared. A slow or stalled response body therefore escapes the configured timeout.

**Required repair:** return a request handle containing response, controller and cleanup; keep the deadline active until JSON parsing or the entire stream terminates. Preserve caller cancellation, test timeout after headers, and cancel/release the reader on early consumer exit.

### P0 — write approval is caller-asserted, not independently verified

In src/server/ai/security/request-authorization.ts, approveExternalWrite() accepts booleans such as authenticated, humanApproved and trustedEvidence plus request IDs, a scope string and an expiry. This is useful as a local policy predicate, but those caller-supplied fields are not a cryptographic approval artifact and do not prove trusted evidence.

**Required repair:** do not use this boolean result as an authorization grant. Route every external write through KRATT WP-01: trusted subject/agent identity, canonical request digest, exact target and operation scope, verifier-issued approval, one-time nonce consumption, expiry and revocation check, effect-boundary revalidation, durable audit receipt and fencing/cancellation. Until that composition is implemented, the provider module remains READ-only.

### P1 — stream output is raw SSE transport, not normalized content

The stream() implementation yields TextDecoder chunks directly. Network chunks do not align with SSE event boundaries or token boundaries. Consumers receive raw data lines/JSON rather than stable OpenAI Responses or xAI Chat Completions text deltas. It also lacks a maximum event/buffer/output bound and does not flush the decoder at end-of-stream.

**Required repair:** parse SSE frames incrementally, handle split UTF-8 sequences and multi-line data fields, stop on [DONE], normalize the supported provider event shapes, enforce event/output byte ceilings and redact provider errors. Add chunk-boundary tests for both providers.

### P1 — in-memory rate limiting is unbounded and process-local

src/server/ai/security/rate-limiter.ts stores every key in an unbounded Map and retains timestamp arrays per key. Key cardinality and memory usage are not bounded; the limiter is not shared between processes or hosts. This does not defend a horizontally scaled API from distributed rate exhaustion.

**Required repair:** define a RateLimiter interface and a shared atomic store implementation (for example, Redis or PostgreSQL) with bounded key cardinality, per-subject/provider/model budgets, TTL, back-pressure and deterministic fail-closed/fail-open policy. Keep the in-memory limiter for tests or local development only.

### P1 — provider config is misleading and model/token budgets are not constrained

The registry passes baseUrl values, but http-provider.ts uses hard-coded endpoints and ignores baseUrl. Request.model and maxOutputTokens can override the defaults without a configured model allowlist or a strict token ceiling.

**Required repair:** either remove the unused baseUrl setting or validate it against the provider's fixed HTTPS origin and version path. Add explicit allowedModels, model fallback policy, prompt byte limits and maxOutputTokens bounds. Do not allow callers to choose arbitrary endpoints.

### P2 — provider registry silently overwrites an existing provider

ProviderRegistry.register() calls Map.set() without rejecting duplicate provider IDs. A second registration can silently replace an existing provider instance and its health/capability state.

**Required repair:** reject duplicate registration unless an explicit host-controlled replacement operation with audit evidence is used.

### P2 — provider readiness and fallback policy are incomplete

The router selects providers deterministically by purpose and the registry returns all registered IDs without a verified-health gate. A configured key is not proof of provider availability, and health checks currently make a real generation request.

**Required repair:** represent provider lifecycle states explicitly (NOT_CONFIGURED, CONNECTED_UNVERIFIED, VERIFIED, DEGRADED, DISABLED, ERROR), gate routing on a fresh health result and policy, implement per-provider circuit breaking and retry budgets, and ensure health probes are cost-bounded.

### P2 — secret redaction is not an observability architecture

The redaction helper covers a small set of token patterns, but a helper existing in the repository does not prove every log, exception, trace or provider response passes through it.

**Required repair:** structured allowlisted logging; never log prompt bodies, API keys, authorization headers, raw provider error bodies, or user data. Redact at the logging/export boundary and add canary tests that scan emitted logs.

## 3. Target implementation order

1. P0: integrate a real WP-01 verifier and disable external-write paths until this exists.
2. P0: repair body/stream deadlines and cancellation propagation.
3. P1: implement bounded SSE parsing and provider response normalization.
4. P1: add model/token budgets and fixed-origin validation.
5. P1: replace production in-memory rate limiting with a shared atomic limiter.
6. P2: make provider registration immutable/duplicate-safe, add verified health and circuit breaking.
7. P2: add redacted OpenTelemetry-compatible traces and provider cost/latency metrics.

## 4. Acceptance evidence required

- Unit tests for timeout before headers, timeout after headers, caller cancellation, stalled stream, partial UTF-8, split SSE frames, malformed frames and maximum-size rejection.
- Provider contract tests for OpenAI Responses and xAI Chat Completions success, 4xx/5xx, rate-limit, retry-after, timeout and duplicate idempotency.
- Security tests proving no raw key or prompt appears in logs and caller-supplied booleans cannot grant WRITE.
- Load tests with multiple workers to prove global rate limits and memory bounds.
- A draft PR against STEEL main with green typecheck, test, lint, build and secret scan.
- Explicit evidence that the AI feature branch has been reviewed and integrated; branch existence alone is not completion.

## 5. Integration boundary

KRATT PRIME is the authority for request-bound approval, trusted evidence, integration capability scope, durable audit, replay protection and governed execution. STEEL may request a provider operation and return a result receipt, but must not independently invent or elevate approval authority. The shared contract must carry correlation ID, provider identity, model/version, request digest, bounded usage metadata, normalized outcome and provenance—never raw credentials.

No STEEL changes were written in this pass because the connected GitHub integration rejected creation of a new organisation-repository branch. The existing organisation feature branch was not overwritten.
