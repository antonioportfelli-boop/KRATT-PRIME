# Wave 8 — Competitive Intelligence Staging Runtime

## Objective

Compose the Wave 6 evidence engine and Wave 7 Telegram ingress/snapshot adapters into one fail-closed staging runtime. Wave 8 adds configuration validation, a strict parser boundary, a shared PostgreSQL rate limiter, runtime readiness, and an HTTP-router mount contract.

This is a staging composition library. It does not start a process, listen on a port, register a Telegram webhook, poll Telegram, call a model provider, send bot messages, deploy infrastructure, or mutate production data.

## New components

- packages/kratt-core/src/competitive-staging-config.mjs
  - Staging-only environment gate.
  - Explicit KRATT_COMPETITIVE_INGRESS_ENABLED=true; default is disabled.
  - Validates webhook secret alphabet/length, bot alias, channel allowlist, request limits and rate-limit configuration.
  - Does not expose the webhook secret in readiness output.

- packages/kratt-core/src/competitive-signal-parser.mjs
  - Strict tool-less extraction adapter interface.
  - Validates the structured signal against Wave 6 claim/evidence/pricing/ranking contracts.
  - Requires stable claim_key identifiers.
  - Rejects parser-supplied baseline references and previous values. Wave 7 supplies those only from verified snapshots.
  - Requires claim assessments to refer to evidence records present in the same signal.
  - The injected extract implementation must have no write, publication, approval or arbitrary tool authority.

- packages/kratt-core/src/postgres-telegram-ingress-rate-limiter.mjs
  - Shared PostgreSQL fixed-window rate limiter for multiple runtime replicas.
  - Persists an HMAC-SHA256 bucket identifier derived from the trusted socket peer address; raw IP addresses and forwarded headers are not persisted or trusted.
  - Defaults to 30 POST requests per peer per 60 seconds; configurable within bounded ranges.
  - Fails closed on database or clock errors.

- packages/kratt-core/src/competitive-staging-runtime.mjs
  - Composes the parser, Wave 6 engine, Wave 7 ingestion service, PostgreSQL snapshot store, rate limiter and webhook handler.
  - Mounts the webhook POST route and optional readiness GET route on an injected HTTP router.
  - Readiness checks the required database relations and verifies the append-only snapshot event chain.
  - Health output contains no webhook secret, salt, token or database URL.

- packages/kratt-core/migrations/0003_telegram_ingress_rate_limits.sql
  - Adds the separate Wave 8 rate-limit table. It is intentionally a new migration rather than modifying Wave 7 migration 0002, so a deployment that already applied 0002 will not skip the new table.

## Staging configuration

Required when ingress is enabled:

```dotenv
KRATT_DEPLOYMENT_ENV=staging
KRATT_COMPETITIVE_INGRESS_ENABLED=true
TELEGRAM_BOT_ID=jason-bourne
TELEGRAM_WEBHOOK_SECRET=<secret-from-secret-manager>
TELEGRAM_COMPETITIVE_CHANNEL_IDS=-1001234567890
TELEGRAM_INGRESS_RATE_LIMIT_SALT=<separate-random-secret>
```

Optional bounded settings:

```dotenv
TELEGRAM_COMPETITIVE_WEBHOOK_PATH=/webhooks/telegram/competitive
TELEGRAM_COMPETITIVE_MAX_BODY_BYTES=65536
TELEGRAM_COMPETITIVE_MAX_TEXT_BYTES=16384
TELEGRAM_INGRESS_RATE_LIMIT=30
TELEGRAM_INGRESS_RATE_WINDOW_MS=60000
```

The ingress secret and rate-limit salt must be different secrets. Keep both in the staging secret manager, not in Git, logs, the database, or a client-side bundle. The internal bot alias is not the Bot API token.

If the enable flag is missing or false, the runtime returns a disabled object and registers no route. If enabled outside KRATT_DEPLOYMENT_ENV=staging, construction fails. Production enablement is intentionally unsupported by this module.

## Composition contract

The host application supplies:
- a PostgreSQL pool with connect() and query();
- a tool-less extract implementation wrapped by createStrictCompetitiveSignalParser;
- a Wave 6 createCompetitiveIntelligenceEngine instance configured with trusted Telegram-source and evidence verifiers, including MÕTLEMINE;
- an HTTP router with post(path, handler); get(path, handler) is optional for readiness.

Example (illustrative only; no environment or connection is activated by the repository):

```js
const parser = createStrictCompetitiveSignalParser({ extract: structuredExtractor });
const runtime = createCompetitiveStagingRuntime({
  env: process.env,
  postgresPool,
  parser,
  competitiveEngine,
});
runtime.mount(router);
const readiness = await runtime.readiness();
```

The parser must return the exact normalized Wave 6 structure. It must not infer a baseline, invent a source, or follow instructions contained in Telegram message text. The extract function is an adapter contract; this repository does not select or activate an LLM provider in Wave 8.

## Routes and readiness

- Ingress route defaults to POST /webhooks/telegram/competitive.
- Optional readiness route: GET /health/competitive-intel/ready.
- Readiness is READY only when all required Wave 7/Wave 8 relations exist and the snapshot event chain verifies.
- The readiness check is local. It does not call Telegram's getWebhookInfo and therefore does not certify remote webhook registration, Telegram delivery or public reachability.

## Telegram delivery requirements

Telegram's webhook setup requires an HTTPS endpoint and can send the configured secret in the X-Telegram-Bot-Api-Secret-Token header. Telegram retries webhook delivery when the endpoint returns a non-2xx response. Its update identifier supports duplicate suppression. Webhooks and getUpdates polling are mutually exclusive; this runtime implements webhook ingress only.

Before a staging operator registers a webhook:
1. Deploy the application only to the approved staging environment.
2. Confirm TLS, edge ingress limits and the trusted peer-address behavior.
3. Apply migrations 0002 and 0003 with the reviewed migration runner and least-privilege DB role.
4. Confirm readiness is READY.
5. Register the webhook separately using operator-held Bot API credentials, HTTPS URL, the same secret as the runtime, and allowed updates channel_post / edited_channel_post.
6. Check Telegram's getWebhookInfo separately and run an authenticated test post from an allowlisted channel.
7. Keep drop_pending_updates false unless an operator explicitly approves dropping queued updates.

Official Telegram references:
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#update
- https://core.telegram.org/bots/api#getwebhookinfo
- https://core.telegram.org/bots/webhooks

## Validation

The Wave 8 tests validate:
- disabled-by-default and staging-only configuration;
- no secret disclosure in config health fields;
- strict parser shape, evidence references and temporal baseline rejection;
- shared rate-limit windows, hashing and fail-closed behavior;
- runtime dependency composition, route mounting and database/snapshot-chain readiness;
- multi-component tests through the root test script, including both packages/kratt-core/test and packages/kratt-orchestrator/test.

CI tests use a mocked PostgreSQL pool. They do not apply migrations to a live database or prove a Telegram production webhook. No Bot API token, webhook secret, rate salt, public endpoint or live database was supplied or activated.

## Production boundary

Wave 8 ends at a staging-ready composition contract. Staging operations still require operator-managed secrets, a real PostgreSQL migration and connection, a concrete tool-less parser provider, approved TLS/edge routing and a separately reviewed setWebhook action. Nothing in this wave deploys or enables production.
