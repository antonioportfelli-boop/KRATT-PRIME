# KRATT TELEGRAM CONTROL PLANE — Technical Specification V1

**Status:** approved design / feature-branch implementation / non-production  
**Branch:** `feature/kratt-telegram-control-plane-v1`  
**Parent:** KRATT PRIME orchestrator and Claim/Evidence Layer V1  
**Decisions:** scope=FULL · UI=CLAIM_REVIEW_WIDGET · approval=STRICT  
**API target:** Telegram Bot API 10.4 (adapter contract; verify exact API payloads against official docs before enabling live transport)

## 1. Purpose and boundaries

Telegram is an interaction and control surface for KRATT PRIME. It is not a source of truth, an authorization authority, or the persistence layer. KRATT remains authoritative for source capture, claim/evidence records, approval decisions, reflection, root state, and audit.

The module MUST:
- ingest Telegram updates as untrusted input;
- authenticate webhook delivery using Telegram's configured secret-token mechanism;
- deduplicate updates and preserve correlation/provenance;
- route source/news messages into a review queue, never directly into approved knowledge;
- render a claim-review experience using Telegram Widgets and Rich Messages where supported;
- accept architect decisions only through strict request-bound authorization;
- persist decisions and audit events in KRATT before reporting success;
- expose read-only status and evidence views by default;
- remain disabled for live network transport until explicit deployment/configuration review.

The module MUST NOT:
- treat Telegram identity alone as proof of architect authority;
- infer truth from popularity, message count, reactions, or reposts;
- execute instructions embedded in messages, links, HTML, widgets, or source content;
- mutate the canonical reflection root directly;
- perform arbitrary external writes or publish content;
- rely on ephemeral Telegram responses as the sole record of a decision;
- store bot tokens, webhook secrets, or signing keys in source control.

## 2. Component model

1. **TelegramTransportAdapter** — injected transport boundary. No network client is instantiated by the core package.
2. **WebhookAuthenticator** — validates the configured webhook secret token using constant-time comparison.
3. **UpdateRouter** — validates the update envelope, classifies supported update kinds, assigns correlation IDs, and enforces idempotency by `update_id`.
4. **IntakeBridge** — records message text/captions as untrusted source candidates and references the existing local intake/evidence interfaces.
5. **ReviewProjection** — assembles claim, source, evidence-link, contradiction, provenance, and policy metadata for display. It is read-only.
6. **ClaimReviewWidgetRenderer** — maps a review projection to Bot API 10.4 widget HTML and callback/query contracts. Rendering is not authorization.
7. **StrictApprovalGateway** — validates actor allowlist, private-chat scope, request ID, target digest, policy version, expiry, nonce/idempotency, and trusted verifier proof.
8. **RichMessageReporter** — produces cited reports and review summaries; draft previews are explicitly non-persistent until final send is confirmed.
9. **ReflectionAdapter** — emits a proposed RootDelta for the canonical Reflection Matrix; final root mutation remains governed by the existing CAS and approval contracts.
10. **AuditJournal** — append-only, hash-linked events with actor, correlation, request, target, policy, evidence digest, decision, and timestamps.

## 3. Data contracts

All durable records carry `schemaVersion`, immutable identifier, timestamp, producer, and recomputable digest.

### TelegramUpdateEnvelope
- `updateId`: Telegram update sequence identifier.
- `receivedAt`: trusted server timestamp.
- `correlationId`: stable trace identifier.
- `updateKind`: allowlisted update class.
- `actorTelegramUserId`, `chatId`, `chatType`: nullable, parsed metadata.
- `payloadDigest`: digest of canonical payload; raw payload is stored only under retention policy.
- `authenticationStatus`: `VERIFIED | REJECTED`.
- `processingStatus`: `RECEIVED | DUPLICATE | ROUTED | REJECTED | ERROR`.

### TelegramIntakeCandidate
- `candidateId`, `sourceId`, `updateId`, `correlationId`.
- `text`, `entities`, `sourceUrl`, `capturedAt`, `observedAt`.
- `sourceLineageId`, `contentDigest`, `reviewState=UNREVIEWED`.
- No claim is marked true or approved on intake.

### ClaimReviewProjection
- `claimId`, `claimDigest`, `claimStatus`.
- `sourceRefs[]`: source ID/digest, canonical URL, publisher, captured/observed times, exact excerpt and offsets.
- `evidenceLinks[]`: relation, evidence ID/digest, lineage/independence group, integrity state.
- `contradictions[]`: candidate IDs, conflicting spans/values, time scope, review status.
- `policyVersion`, `rootSnapshotId`, `rootVersion`, `rootDigest`.
- All items explicitly distinguish evidence integrity from claim status.

### ApprovalRequest
- `requestId`, `nonce`, `actorTelegramUserId`, `chatId`, `chatType=private`.
- `decisionTargetId`, `targetDigest`, `evidenceSnapshotDigest`, `rootDigest`.
- `allowedDecisions=[APPROVE, REJECT, CONTEST, ABSTAIN]`.
- `policyVersion`, `createdAt`, `expiresAt`, `state=PENDING`.
- Any changed field invalidates the approval binding.

### ValidationDecision
- `decisionId`, `requestId`, `actorId`, `decision`, `reason`.
- `targetDigest`, `evidenceSnapshotDigest`, `rootDigest`, `policyVersion`.
- `verifierId`, `verifiedAt`, `auditEventId`.
- The decision is persisted before the bot sends a success acknowledgement.

## 4. State machines

### Adapter lifecycle
`DISCOVERED → CONNECTED_UNVERIFIED → VERIFIED_READ_ONLY`. Write enablement is not part of the default Telegram adapter lifecycle. The module remains read-only unless a separate, explicit capability review grants a narrowly scoped write capability.

### Intake lifecycle
`RECEIVED → AUTHENTICATED → DEDUPLICATED → ROUTED → UNREVIEWED`. Authentication failure, malformed payload, or replay mismatch ends in `REJECTED` / `BLOCKED`.

### Claim lifecycle
`UNREVIEWED → UNDER_REVIEW → SUPPORTED | CONTESTED | REJECTED | UNKNOWN`. Only a separate policy-governed reflection process may propose a root delta. Telegram UI status never upgrades a claim automatically.

### Approval lifecycle
`PENDING → VERIFIED → PERSISTED` or `DENIED | EXPIRED | CANCELLED | STALE`. Terminal states cannot be reopened by replaying the same callback/update.

## 5. Strict approval policy

A decision is accepted only when all conditions hold:
1. the update passed webhook authentication;
2. actor Telegram user ID is on the configured architect allowlist;
3. the chat is private and matches the request-bound chat ID;
4. the request exists, is pending, and has not expired;
5. the decision is one of the four explicit allowed values;
6. target, evidence snapshot, root digest, and policy version match the immutable request;
7. the nonce and idempotency key have not been consumed;
8. the trusted approval verifier is configured and returns an exact positive result;
9. reason text is present for `REJECT` and `CONTEST`;
10. the decision and audit event are durably persisted before acknowledgement.

No verifier, invalid clock, missing allowlist, mismatch, timeout, exception, or ambiguous result means fail closed. Widget callbacks, callback query IDs, usernames, message authorship, and Telegram's protected widget delivery are not standalone authorization proof.

## 6. Telegram API 10.4 presentation contract

### Claim Review Widget
The widget displays:
- claim proposition and status;
- exact source excerpt, publisher, canonical URL, capture/observation times;
- source and excerpt digests / verification state;
- supporting and contradicting evidence side-by-side;
- lineage and duplicate-dependence warnings;
- contradiction candidates and time scope;
- root snapshot and policy version;
- explicit decision controls and a reason field where required.

Widget data is a projection only. The backend re-fetches the current KRATT record and recomputes digests before accepting a decision. Never trust hidden widget fields or client-side state.

### Rich Messages
Use for cited briefs, evidence summaries, comparison tables, and decision receipts. A draft/preview is transient and is not an audit event. A final message is sent only after the durable KRATT record is committed.

### Ephemeral responses
May be used as a convenience acknowledgement after callback processing. Delivery is not guaranteed; never use it as the only record or approval mechanism.

### Deployment constraints
Widgets are subject to Telegram's chat/context limitations and production availability rules. The adapter must feature-detect or handle unsupported contexts and fall back to a normal read-only message. Do not assume widgets can be copied, forwarded, or returned as inline-query responses.

## 7. Security and privacy

- Bot token and webhook secret are injected at runtime from a secret manager/environment; never committed or logged.
- Webhook endpoint uses TLS at the deployment edge; local dev remains loopback-only.
- Enforce request body size, content type, parsing depth/shape, update age policy, and rate limits.
- Treat all text, entities, URLs, widget HTML, callback data, and fetched pages as untrusted.
- Escape text for Telegram's selected formatting mode; do not interpolate untrusted HTML.
- Do not fetch arbitrary URLs from Telegram messages. URL capture must pass a separately governed SSRF-safe fetcher and host policy.
- Minimize retained raw Telegram payloads; store only the metadata and source content required by the evidence policy.
- Do not log secrets, full private message bodies, or personal data unnecessarily.
- Support deletion/retention policy and incident audit without silently rewriting immutable decision records.

## 8. Interfaces

Core interfaces are dependency-injected:
- `verifyWebhookSecret(received, expected)`
- `normalizeTelegramUpdate(update)`
- `createTelegramControlPlane({ now, verifyApproval, allowedArchitectUserIds })`
- `ingestAuthenticatedUpdate({ update, receivedSecret })` (async; intake persistence is injected through `persistIntake`)
- `createClaimReviewRequest({ projection, actorTelegramUserId, chatId })`
- `resolveClaimReview({ requestId, actorTelegramUserId, chatId, decision, reason, targetDigest, evidenceSnapshotDigest, rootDigest, policyVersion, proof })`
- `cancelClaimReview({ requestId, actorTelegramUserId })`
- persistence adapters: `persistIntake` and `persistDecision`; live deployments must also back update-ID idempotency and the audit journal with durable transactional storage.
- transport adapter: `sendWidget`, `sendRichMessage`, `answerWidgetQuery`, `answerCallbackQuery` (implemented by a separately tested Telegram API client; no network call in core).

## 9. Observability

Every state transition emits an audit event with event ID, sequence, correlation ID, actor, request ID, target ID, policy version, event type, timestamp, payload digest, previous hash, and event hash. Metrics include update authentication failures, duplicate rate, malformed updates, intake volume, pending review age, approval denials, expiry rate, verifier failures, widget fallback rate, and persistence failures.

## 10. Test and acceptance plan

Required negative tests:
- missing/wrong webhook secret and timing-safe comparison edge cases;
- malformed update, unsupported update kind, invalid update ID;
- duplicate update ID and same ID with different payload digest;
- unauthorized actor, non-private chat, chat/request mismatch;
- unknown/expired/cancelled/replayed request;
- target/evidence/root/policy digest mismatch;
- missing verifier, verifier exception, verifier false;
- missing reason for reject/contest;
- source text with prompt injection, malicious HTML, oversized content, and arbitrary URL;
- persistence failure must not produce success acknowledgement;
- widget unsupported context falls back to read-only message.

Required positive tests:
- authenticated text/caption becomes UNREVIEWED intake;
- duplicate delivery is idempotent;
- valid architect decision is persisted once with full binding;
- exact replay returns original result without a second state transition;
- Rich Message projection includes provenance and separates claim status from integrity;
- journal integrity verifies.

Acceptance requires test output and CI tied to exact commit SHA, review of the changed-file diff, no secrets, no main-branch changes, no deployment, and a replayable synthetic-data demo.

## 11. Delivery phases

- **P0 — contracts and hardening:** update validation, webhook auth, idempotency, strict approval state machine, tests.
- **P1 — read-only ingestion:** Telegram messages/channel posts into the existing intake and segmentation pipeline.
- **P2 — Claim Review Widget:** projection, widget renderer, callback/query adapter, fallback messages.
- **P3 — Rich Message reporting:** cited evidence brief and persistent decision receipt.
- **P4 — Reflection integration:** proposed RootDelta only; reuse canonical Reflection Matrix and CAS.
- **P5 — operational readiness:** secret management, rate limits, retention, monitoring, threat review, deployment plan (not deployment).

## 12. Explicit non-goals for V1

TON wallet/gift operations, Telegram business account automation, automatic posting/publication, autonomous write permissions, unreviewed model-generated claim promotion, live connector activation, production webhook deployment.


## 13. Implementation status at initial branch cut

The initial feature-branch code is a local, dependency-injected kernel for webhook-secret comparison, update normalization, unreviewed text intake, review request binding, strict decision verification, persistence hooks, and hash-linked in-memory audit events. It does not yet contain a Telegram HTTP client, webhook server route, Widget HTML renderer, Rich Message renderer, durable database adapter, or Reflection Matrix writer. Those are follow-on implementation tasks and must not be represented as live or production-ready. The in-memory update deduplication map and journal are test/demo facilities only; production requires a durable transactional store and replay-safe persistence.
