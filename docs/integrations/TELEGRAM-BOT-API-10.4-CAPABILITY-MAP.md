# KRATT PRIME — Telegram Bot API 10.4 compatibility increment

Status: implementation contract / compatibility inventory. This is not a production enablement.

## Source of truth

This increment is based on the current head of the existing draft control-plane branch
`feature/kratt-telegram-control-plane-v1` (parent commit
`cacd90f5c4edae9b97b447036ae60c0c9c4d7436`). It is intentionally isolated on
`feature/telegram-bot-api-10-4-compat`. Existing draft PR #25 and `main` are unchanged.

The current KRATT program already has a provider-neutral Telegram Bot API transport
surface and an advanced review/approval pipeline. The implementation should extend
those existing surfaces; it must not create a second bot client, a second approval
store, or a parallel reflection root.

## Bot API 10.4 capability map

| Capability | Telegram methods/types | KRATT boundary | Implementation status |
|---|---|---|---|
| Rich message output | `sendRichMessage`, `editMessageText.rich_message`, `RichMessage`, `RichBlock` | Render already-approved claim/evidence projections; content stays untrusted | Planned adapter extension |
| Rich message streaming | `sendRichMessageDraft`, `sendMessageDraft`, `MessageGenerationStopped` | Draft output is ephemeral presentation only; never an approval | Planned adapter extension |
| Widget interactions | `sendWidget`, `sendSharedWidget`, `answerWidgetQuery`, `editMessageWidgetData`, `editSharedWidgetData` | Query creates typed intent; it does not authorize a mutation | Planned adapter extension |
| Shared widget interactions | `widget_query`, `shared_widget_query`, `WidgetQueryType` | Bind user, chat, message, widget and request digest; verify on server | Planned adapter extension |
| Ephemeral responses | `EphemeralMessageParameters` on supported send methods | Per-user private result; audit event remains durable independently | Planned adapter extension |
| Private-chat topics | `message_thread_id`, `createForumTopic` etc. | Isolated operational channels; topic ID is not authority | Existing Telegram feature / verify |
| Bot-to-bot | Bot-to-bot communication | Treat peer bot as untrusted provider; enforce adapter registry and policy | Planned guarded integration |
| TON wallet metadata | `TonWalletCard`, `TonWalletTransfer`, wallet-signed query types | Read-only evidence intake unless separately authorized | Out of scope for this increment |

## Required request binding for widget callbacks

A widget interaction must be normalized into a server-created request envelope:

- `provider = telegram`
- `provider_event_id` and Telegram update ID
- authenticated Telegram actor and private-chat binding
- widget/message/chat identity and data digest
- operation and exact target
- expiry and nonce
- root snapshot version + digest when a reflection proposal is involved
- provenance/evidence references
- policy decision reference
- request-bound approval proof reference, when mutation is requested

Never accept an approval boolean or an unsigned client-supplied "verified" field. The server
must retrieve the exact pending request, verify its digest and actor binding, check expiry,
consume the nonce atomically, verify the architect signature, and append the audit event.
The widget itself only records intent.

## Rich output rules

1. Rich messages are projections, not a source of truth.
2. Evidence references and source provenance must remain visible and traceable.
3. Model-derived claims remain `UNREVIEWED`; contradictions remain candidates.
4. Streaming chunks must be treated as partial display state and must not be committed to
   root memory until a separate approved operation is executed.
5. Never echo secrets, signing material, payment credentials or private provider payloads.
6. Unsupported clients or methods fall back to plain text without weakening authorization.

## Ephemeral message rules

- An ephemeral response is not durable evidence of a decision.
- The authoritative approval/audit records are stored in KRATT's durable journal.
- Use ephemeral responses for private review results, not for the only copy of a critical
  denial, approval receipt or incident alert.
- Do not assume ephemeral visibility or retention guarantees beyond Telegram's API contract.

## Explicit non-goals

- No public webhook registration or polling.
- No live bot token, webhook secret, TON transaction signing or transfer.
- No Telegram Stars invoice, pre-checkout, refund or payout changes.
- No write to `main`, no merge of PR #25, no production deployment.
- No automatic promotion of model-generated claims to approved facts.

## Acceptance tests to add before enabling any new method

- Widget query from wrong user/chat/message is rejected.
- Duplicate widget query nonce is rejected.
- Expired widget query is rejected.
- Widget payload with altered digest is rejected.
- Client-supplied approval flag cannot authorize a write.
- Exact approval replay is idempotent and cannot execute twice.
- Rich output never includes secret-like values from provider metadata.
- Draft stream stop/cancel is propagated and does not commit a reflection delta.
- Ephemeral output is scoped to the intended receiver and audit persists after expiry.
- Unsupported method response falls back safely without bypassing policy.
- Bot-to-bot event is treated as external untrusted input and still passes full policy.
- TON signed-data and transfer updates are verified independently; wallet assertion is not a transfer authorization.

## Known upstream production blockers

The existing production readiness plan remains authoritative: shared serializable database,
trusted key custody/signer, ontology and authorization approval, independent security review,
protected release controls, staging end-to-end tests, monitoring, backup/restore drills and
explicit release approval are still required. This document does not change those gates.
