# Wave 8 — Live Staging Connections and Runtime Assembly

## Objective

Assemble a runnable staging service around Wave 7:
- inbound Telegram Bot API webhook;
- outbound read-only Telegram Bot API checks (\`getMe\`, \`getWebhookInfo\`);
- OpenAI Responses API parser with strict JSON Schema output and no tools;
- allowlisted primary-source capture with SHA-256 evidence digests;
- MÕTLEMINE verification and the Wave 6 competitive analysis engine;
- PostgreSQL TLS pool and the Wave 7 immutable snapshot store;
- live/readiness endpoints, migration and webhook setup commands.

This is a staging runtime. It does not configure a production endpoint, publish analysis, or dispatch providers.

## Runtime files

- \`packages/kratt-orchestrator/src/wave8-live-connectors.mjs\`
  - environment validation, PostgreSQL pool factory, Telegram Bot API admin client, OpenAI parser, source capture/verifier, Telegram channel verifier and process-local ingress rate limiter.
- \`packages/kratt-orchestrator/src/wave8-server.mjs\`
  - assembles the Wave 7 store and ingress, checks PostgreSQL schema and Telegram bot identity, serves the webhook path and health endpoints.
- \`scripts/wave8-check-connections.mjs\`
  - read-only PostgreSQL / Telegram preflight and snapshot-chain validation.
- \`scripts/wave8-apply-migration.mjs\`
  - explicit staging-only migration using a separate database-admin URL.
- \`scripts/wave8-configure-webhook.mjs\`
  - explicit Telegram \`setWebhook\` call; refuses to replace another webhook URL unless separately approved.
- \`Dockerfile.wave8-staging\`
  - Node 22 staging image; installs pinned \`pg@8.23.1\` in the container layer because the main app lockfile does not include the runtime connector.
- \`.env.wave8.example\`
  - variable names and safe defaults only. Copy to an ignored \`.env.wave8\` in the staging host or use a secret manager.

## External connections and data flow

### Telegram

On startup the service calls \`getMe\` and \`getWebhookInfo\` using the server-side Bot API token. These are read-only checks. The inbound route is:

\`POST /webhooks/telegram/competitive\`

The webhook secret is validated by the Wave 7 ingestion service. Only allowlisted \`channel_post\` and \`edited_channel_post\` updates are accepted. The server does not call \`getUpdates\` and does not enable long polling.

Telegram webhook delivery requires an HTTPS endpoint and a supported TLS configuration. Telegram currently documents TLS 1.2+ and inbound ports 443, 80, 88 or 8443. Keep the Node server on a private upstream port and terminate TLS at a trusted reverse proxy or load balancer. The Bot API also documents that \`getUpdates\` and an outgoing webhook are mutually exclusive.

Official references:
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#getwebhookinfo
- https://core.telegram.org/bots/api#getme
- https://core.telegram.org/bots/webhooks

### OpenAI Responses API

The parser sends only the Telegram post text to \`https://api.openai.com/v1/responses\`. It does not send Telegram channel IDs, message IDs, chat IDs or user IDs. The request:
- sets \`store: false\`;
- sets \`tools: []\`;
- requests strict JSON Schema output;
- treats embedded instructions and URLs in the Telegram post as untrusted data;
- cannot authorize, publish, change policy or call any external tool.

The environment must explicitly set \`WAVE8_ALLOW_TELEGRAM_TEXT_TO_OPENAI=true\`. Without this consent flag, the service refuses to start. The Responses API call still sends the post text to OpenAI for processing; confirm that this data transfer fits the operator's privacy and data-handling requirements before enabling the flag.

Official reference:
- https://platform.openai.com/docs/api-reference/responses

### Evidence capture

The model may propose evidence URLs but cannot declare them verified. The runtime fetches each URL itself and requires:
- HTTPS;
- a host in \`COMPETITOR_SOURCE_ALLOWLIST\`;
- no URL credentials, port override, query string or fragment;
- no redirect;
- bounded response size and timeout.

The runtime hashes the fetched response bytes and creates a KRATT EvidenceRecord. MÕTLEMINE accepts only evidence records that match the in-memory server-side fetch attestation. The attestation cache is cleared after each analysis. A second, unrelated source is required by default (\`MIN_INDEPENDENT_SOURCES=2\`), so one vendor page alone cannot promote a claim to \`SUPPORTED\`.

The allowlist is an operator-owned trust boundary. Add only vendor or primary-source domains that have been reviewed. A model-suggested URL outside the allowlist is rejected.

### PostgreSQL

The runtime pool uses \`pg@8.23.1\`, TLS with \`rejectUnauthorized: true\`, bounded connections, connect timeout, statement timeout and query timeout. An optional CA file can be supplied for a private database CA. The connection string must not override TLS settings through query parameters.

The main server uses \`DATABASE_URL\` and must run under a least-privilege runtime role:
- inbox: SELECT / INSERT / UPDATE / DELETE (the release/lease lifecycle deletes only uncommitted inbox rows);
- snapshots: SELECT / INSERT only;
- snapshot events: SELECT / INSERT only;
- snapshot head: SELECT / UPDATE;
- no DDL permissions;
- no UPDATE or DELETE on immutable snapshot or event tables. Migration triggers also reject those mutations.

Migration uses the separate \`DATABASE_MIGRATION_URL\` and optional \`DATABASE_MIGRATION_CA_CERT_PATH\`. Use a short-lived migration-admin credential; never run the application with the migrator role.

Official driver references:
- https://node-postgres.com/features/connecting
- https://node-postgres.com/features/ssl
- https://node-postgres.com/apis/pool

## Staging setup sequence

1. Provision a PostgreSQL staging database and separate runtime / migration roles. Configure a trusted TLS certificate or provide the database CA file.
2. Create the staging secret set from \`.env.wave8.example\`. Keep the real file out of Git. Required values include:
   - \`TELEGRAM_BOT_TOKEN\`, \`TELEGRAM_WEBHOOK_SECRET\`, \`TELEGRAM_BOT_ID\`;
   - \`TELEGRAM_ALLOWED_CHANNEL_IDS\`, \`TELEGRAM_RATE_LIMIT_SALT\`;
   - \`DATABASE_URL\`, \`DATABASE_MIGRATION_URL\`;
   - \`OPENAI_API_KEY\`, \`OPENAI_MODEL\`;
   - \`WEBHOOK_PUBLIC_URL\`, \`COMPETITOR_SOURCE_ALLOWLIST\`;
   - explicit \`WAVE8_ALLOW_TELEGRAM_TEXT_TO_OPENAI=true\`.
3. Install Node.js 22. In a non-container staging runtime install the pinned PostgreSQL driver with \`npm install --no-save --package-lock=false pg@8.23.1\`. The provided Dockerfile performs this installation as part of the image build.
4. Apply migration 0002 only against the intended staging database:
   \`\`\`sh
   WAVE8_APPLY_STAGING_MIGRATIONS=true node --env-file=.env.wave8 scripts/wave8-apply-migration.mjs
   \`\`\`
   The command also requires \`APP_ENV=staging\` and \`WAVE8_EXPECTED_DATABASE\` to match the actual database name.
5. Start the server behind the HTTPS reverse proxy:
   \`\`\`sh
   node --env-file=.env.wave8 packages/kratt-orchestrator/src/wave8-server.mjs
   \`\`\`
6. Run the read-only connection check:
   \`\`\`sh
   node --env-file=.env.wave8 scripts/wave8-check-connections.mjs
   \`\`\`
   It verifies PostgreSQL schema, snapshot hash chain, Telegram bot identity and configured webhook URL.
7. Only after public DNS, TLS and reverse proxy routing are verified, explicitly configure Telegram:
   \`\`\`sh
   WAVE8_ENABLE_WEBHOOK_WRITES=true node --env-file=.env.wave8 scripts/wave8-configure-webhook.mjs
   \`\`\`
   If the bot currently points at a different webhook, inspect it first. Set \`WAVE8_ALLOW_WEBHOOK_REPLACE=true\` only when replacing that endpoint is intended. The setup does not drop pending updates.
8. Run the connection check again and wait for \`webhookMatches: true\`. Then send one low-risk test post in the allowlisted channel and verify the new snapshot and event-chain result in PostgreSQL.

## Health endpoints

- \`GET /health/live\` — process liveness.
- \`GET /health/ready\` — PostgreSQL, Telegram API and snapshot-chain readiness, plus the webhook configuration state.

Readiness is allowed before \`setWebhook\` so that the service can come online before Telegram is pointed at it. The connection-check script still reports webhook mismatch as a failed end-to-end preflight.

## Important operational boundaries

- No real credentials are committed in this branch.
- No webhook registration is performed during startup.
- No migration is run during startup.
- No model tool-calling is enabled.
- Telegram text is not stored in the PostgreSQL inbox or snapshot payload; the source text is hashed for replay matching.
- The local limiter is process-local; enforce shared rate limits at the reverse proxy / ingress gateway for multi-replica staging.
- Do not expose port 8787 publicly. Only the HTTPS reverse proxy should reach the Node upstream.
- There is no automatic webhook replacement or pending-update deletion.
- The first real staging run must be supervised and checked against the database logs and Telegram \`getWebhookInfo\`.

## Remaining checks before calling this “live”

The code is ready for configuration, but the actual external connections are not active from this repository session. They still require operator-owned:
- Telegram Bot API token and allowed channel IDs;
- public DNS + HTTPS endpoint and reverse-proxy route;
- PostgreSQL hostname, database, TLS CA and two distinct roles;
- OpenAI API key and a model enabled for that API project;
- explicit approval to send the Telegram post text to the OpenAI API.

The GitHub CI suite uses mocked HTTP and PostgreSQL adapters. A successful CI run does not certify real network reachability, database TLS, cloud firewall rules, webhook deliveries, API quota or account-specific model access.
