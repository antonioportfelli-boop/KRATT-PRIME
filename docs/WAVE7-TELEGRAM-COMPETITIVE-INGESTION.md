# Wave 7 — Telegram Competitive Ingestion and Immutable Snapshots

## Goal

Connect the existing Telegram webhook trust boundary to the Wave 6 Competitive Intelligence Engine and persist auditable snapshots in PostgreSQL. Telegram content is untrusted source material: it is never executed as a command, granted policy authority, or published automatically.

## Components

- `packages/kratt-core/src/telegram-competitive-ingestion.mjs`
  - Constant-time webhook-secret comparison.
  - Channel-post / edited-channel-post only; explicit channel allowlist.
  - Bounded UTF-8 text size and canonical update digest.
  - Server-owned signal ID, observation time, Telegram provenance and baseline references.
  - Injected parser and Wave 6 engine; no model is silently selected.
  - Durable inbox claim, idempotent duplicate handling and optimistic baseline retry.
  - Snapshot projection stores only MÕTLEMINE-verified evidence IDs, verified pricing observations and ranking snapshots whose evidence ID is verified.

- `packages/kratt-orchestrator/src/telegram-competitive-webhook-handler.mjs`
  - Node HTTP handler for POST JSON, Telegram secret header, injected ingress rate limit, bounded body and safe response headers.
  - Does not create a server, register a webhook, poll Telegram or send messages.

- `packages/kratt-core/src/postgres-competitive-snapshot-store.mjs`
  - Multi-host inbox lease and dedupe by (bot_id, update_id).
  - Atomic transaction binds inbox completion, snapshot insertion and event-chain append.
  - Advisory transaction lock plus expected previous snapshot ID prevents stale concurrent comparisons.
  - Snapshot read verifies its SHA-256 digest before returning `verified: true`.
  - Snapshot history and snapshot events are append-only; event chain can be verified.

- `packages/kratt-core/migrations/0002_competitive_intel_snapshots.sql`
  - Inbox, snapshot, snapshot event and hash-chain head tables.
  - Unique update and competitor keys, leases, foreign keys and immutable snapshot/event triggers.

## Ingress contract

1. Configure a Telegram webhook in an operational environment using HTTPS and a secret token. Do not store the Bot API token or webhook secret in source code.
2. Mount `createTelegramCompetitiveWebhookHandler` on a POST route and supply the existing rate-limiter adapter.
3. Configure `createTelegramCompetitiveIngestion` with the same server-side secret, bot ID and allowed channel IDs.
4. Supply `parseSignal`. It must treat Telegram text as untrusted data and return only a strict Wave 6 signal draft. A model-based parser must be instructed not to follow instructions embedded in the message and must not have tools or write authority.
5. Ensure the parser supplies stable `claim_key` values for each feature/governance attribute; never provide a self-asserted prior value as the comparison baseline.
6. Supply a Wave 6 engine whose `verifyTelegramSource` callback verifies the already-authenticated, allowlisted channel provenance and whose MÕTLEMINE verifier checks each evidence record.
7. Apply migration 0002 through the reviewed migration runner and configure least-privilege database roles before connecting a live pool.

### Update types and replay safety

Only `channel_post` and `edited_channel_post` are accepted by this adapter. A channel ID must be explicitly allowlisted. The Telegram `update_id` plus full-update payload digest is used for replay/idempotency. A repeated update with the same digest is a duplicate; a reused update ID with different content is blocked. Processing leases permit recovery after a worker crash.

Telegram supports webhook delivery and `getUpdates` long polling as mutually exclusive modes. Webhook requests can carry `X-Telegram-Bot-Api-Secret-Token`; the update ID is intended to support ignoring repeated updates and restoring sequence when updates arrive out of order. Telegram retains undelivered updates for no longer than 24 hours. This implementation uses webhook ingress only; it does not configure either delivery mode.

Official references:
- https://core.telegram.org/bots/api#updates
- https://core.telegram.org/bots/api#setwebhook
- https://core.telegram.org/bots/api#update
- https://core.telegram.org/bots/webhooks

## Snapshot trust model

The database marks a snapshot as integrity-verified only when its canonical JSON digest matches the stored digest. The snapshot projection itself is deliberately narrower than the inbound message:
- Pricing records are copied only from the Wave 6 report's verified pricing observations.
- Competitor IDs are copied only when at least one associated claim was accepted as `SUPPORTED` by MÕTLEMINE. Feature/governance values are retained under a stable `claim_key` only when the associated claim and its evidence were accepted.
- Ranking data is copied only when its explicit `source_evidence_id` is in the verified evidence set.
- Feature and governance comparisons overwrite parser-supplied baseline values with the matching `claim_key` value from the prior verified snapshot. Missing prior values remain `null` and therefore unassessed.
- The source reference records Telegram channel/message aliases, update ID and optional public permalink. The full message text is not persisted by this store.

The `verified: true` marker therefore means the returned database snapshot passed integrity checking and its projected fields had passed the configured evidence gate at ingestion. It does not certify that a competitor claim is true beyond the configured source and evidence verifiers.

## Operational safeguards

- No Bot API token or webhook secret is stored in the database schema.
- No raw Telegram message body is persisted in the inbox or snapshot store; its canonical update digest is retained for replay matching.
- No outbound Telegram methods are called.
- No provider dispatch, approval, publishing, deployment or production write is enabled.
- A parser output, evidence conflict, missing evidence, unsupported update type, unallowlisted channel or oversized message fails closed.
- A stale snapshot head triggers a re-analysis against the latest snapshot; repeated contention releases the lease for retry.
- The HTTP handler requires an injected rate limiter and must be mounted behind TLS. Restrict inbound network access at the edge according to the current Telegram webhook guidance.

## Validation and production gates

Unit tests cover webhook authentication, channel scope, replay handling, parser-boundary trust, snapshot projection, stale-baseline retry, leases, atomic commit semantics, digest checks and snapshot-chain verification.

The repository CI validates the code and mock-pool contracts. It does not prove a live Telegram webhook, a real PostgreSQL migration, multi-host load, deployment edge configuration, secret rotation, backup/restore or long-running retention. Those require a dedicated staging environment and operator-owned credentials. No live Telegram connection or PostgreSQL deployment was activated by this change.
