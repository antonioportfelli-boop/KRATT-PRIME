# Wave 9 — Resilient Staging Operations v1

**Repository:** `antonioportfelli-boop/KRATT-PRIME`  
**Branch:** `feature/wave9-resilient-staging-operations-v1`  
**Status:** implementation branch; staging-only, no production deployment.

## Objective

Complete the operational boundary after Wave 8 by making ingress protection durable across replicas, tightening health contracts, and ensuring the complete staging schema can be applied and verified reproducibly.

Wave 9 composes the two previously divergent Wave 8 branches. It does not replace the existing AURA UI, collapse STEEL into PRIME, publish competitive reports, configure Telegram webhooks automatically, or dispatch external providers.

## Implemented changes

1. **Shared Telegram ingress limiter**
   - Live webhook traffic now uses `createPostgresTelegramIngressRateLimiter` rather than a process-local map.
   - Only a keyed HMAC of the trusted socket peer address is persisted; forwarded headers and raw peer addresses are not stored.
   - Rate limiting fails closed when PostgreSQL is unavailable.
   - Defaults: 30 requests per peer per 60,000 ms. Bounds: 1–10,000 requests and 1,000 ms–24 hours.

2. **Startup and preflight schema gate**
   - Both the staging server and read-only connection check require the shared limiter table in addition to the inbox, snapshot, event and chain-head tables.
   - A missing Wave 9 table prevents the service from starting or a preflight from passing.

3. **Safe readiness contract**
   - Readiness requires a successful PostgreSQL snapshot-chain verification and Telegram API reachability.
   - The webhook state remains a separate boolean so the service can be started before explicitly setting the webhook.
   - Public health JSON no longer includes configured/active webhook URLs or internal database/chain diagnostics.

4. **Ordered migration**
   - The explicitly enabled staging migration command applies `0002_competitive_intel_snapshots.sql` and `0003_telegram_ingress_rate_limits.sql` in order.
   - It requires `APP_ENV=staging`, a separate `DATABASE_MIGRATION_URL`, and a database-name match.
   - New opt-in variables are `WAVE9_APPLY_STAGING_MIGRATIONS=true` and `WAVE9_EXPECTED_DATABASE`. Existing Wave 8 variable names remain accepted for compatibility.
   - The runtime role needs SELECT/INSERT/UPDATE/DELETE on `kratt_telegram_ingress_rate_limits` because the limiter performs bounded cleanup; it does not need DDL rights.

5. **Verification**
   - Config tests cover defaults and rejected out-of-range limits.
   - Staging-server tests verify the PostgreSQL limiter is actually used by the live webhook route and health JSON does not expose URLs or raw diagnostics.
   - `npm run wave9:verify` runs the full Node test suite, the existing app typecheck and the production build without deploying anything.

## Staging procedure

1. Configure secrets only in the staging secret manager or ignored `.env.wave8`; never commit real values.
2. Provision PostgreSQL with separate migration-admin and least-privilege runtime roles.
3. Apply migrations with explicit approval:
   ```sh
   WAVE9_APPLY_STAGING_MIGRATIONS=true node --env-file=.env.wave8 scripts/wave8-apply-migration.mjs
   ```
4. Run the read-only preflight:
   ```sh
   node --env-file=.env.wave8 scripts/wave8-check-connections.mjs
   ```
5. Start the staging server only behind a trusted HTTPS reverse proxy.
6. Configure Telegram webhook only as a separate, explicit staging action after DNS/TLS/routing and preflight checks pass.

## Acceptance criteria

- [ ] Node contract tests pass, including Wave 9 ingress and readiness tests.
- [ ] Application typecheck and build pass.
- [ ] CI confirms the same checks on the draft pull request.
- [ ] A staging PostgreSQL instance has migrations 0002 and 0003 applied using the migrator identity.
- [ ] The runtime identity can use the limiter table but cannot run DDL or mutate immutable snapshot/event rows.
- [ ] Telegram bot identity, webhook delivery, source allowlist, OpenAI consent and snapshot-chain behavior are checked in a supervised staging run.
- [ ] No production deployment, webhook write, secret rotation, permission change or main-branch update is part of this wave.

## Operational truth

Repository tests use fake HTTP/PostgreSQL adapters. Passing CI does not prove that external credentials, DNS, TLS, firewall rules, PostgreSQL privileges, Telegram delivery, OpenAI quota or model access are configured. Those checks require the operator-controlled staging environment.
