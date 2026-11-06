# Telegram Adapter Contract
Status: Integration target; live Bot API production use is not enabled

## Ingress
Verify webhook secret token using constant-time comparison where applicable. Enforce bounded body size, content type and JSON schema. Reject ambiguous duplicate security headers. Validate Telegram update shape and preserve update ID as idempotency key. Validate Mini App initData using Telegram's documented signature/HMAC algorithm, canonical ordering and supported optional fields.

## Dispatch
1. Validate ingress.
2. Convert update to canonical, versioned KRATT task envelope.
3. Claim update in durable inbox using unique lease/fencing token.
4. Ask trusted KRATT composition root for policy authorization.
5. Persist decision and execution intent.
6. Execute only through narrowly scoped Telegram capability.
7. Persist outcome and audit record idempotently.
8. Acknowledge only after durable state is established.

## Reliability
Duplicate update IDs must not cause duplicate side effects. Expired/superseded workers fail fencing checks. Use transactional outbox for outbound messages. Test PostgreSQL concurrency and crash recovery. Retry only operations with defined idempotency semantics.

## Security and production gates
Bot token only in approved secret manager; never in logs/code/tests/docs. Production webhook, payments, refunds and outbound writes remain disabled until explicit approval. Validate with sandbox bot and non-production environment first.

## Acceptance
Contract tests, HMAC vectors, malformed ingress, replay, stale lease, real PostgreSQL concurrency, outbox recovery and end-to-end sandbox webhook tests must pass.