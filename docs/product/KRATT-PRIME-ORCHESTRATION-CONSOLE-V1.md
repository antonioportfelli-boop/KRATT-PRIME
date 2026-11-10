# KRATT PRIME Orchestration and Console — V1

**Status:** Non-production local integration slice  
**Product:** KRATT PRIME Signal-to-Evidence  
**Console:** `products/kratt-prime-console`  
**Orchestration kernel:** `packages/kratt-orchestrator`

## 1. System boundary

The console is a separate KRATT PRIME product surface. It does not replace or rebrand the AURA root application. AURA, STEEL and FRAME.9 retain their separate product identities.

The local API is bound to loopback only (`127.0.0.1` by default). It serves the console and exposes a small local development API. It does not connect to Telegram, GitHub, Slack, RSS or other external systems. It stores no credentials and does not enable external writes.

## 2. Runtime layout

```text
KRATT PRIME Console (browser)
  ├── Overview / signal stream / evidence graph
  ├── Orchestration / connector registry
  ├── Governance / event journal
  └── Local intake preview
          │ same-origin HTTP, loopback only
          ▼
KRATT Local API
  ├── GET  /api/health
  ├── GET  /api/state
  ├── GET  /api/events
  ├── GET  /api/verify
  └── POST /api/intake
          │
          ▼
KRATT Orchestration Kernel
  ├── Adapter registry and lifecycle
  ├── Capability checks
  ├── Request-scoped write approval
  ├── Provenance envelopes
  └── Append-only in-memory hash-linked journal
```

## 3. Adapter lifecycle

The registry uses the following states:

- `DISCOVERED`: descriptor registered; no trust implied.
- `CONNECTED_UNVERIFIED`: transport may be configured, identity not yet trusted.
- `VERIFIED_READ_ONLY`: trusted verifier evidence accepted for read-only operations.
- `WRITE_PENDING_APPROVAL`: one scoped write request is awaiting approval.
- `WRITE_ENABLED`: reserved lifecycle state; generic transitions cannot set it.
- `DISABLED`: adapter deliberately disabled.
- `ERROR`: adapter fault; no execution allowed.

Adapter name, provider brand or successful connection is not proof of trust. Promotion to `VERIFIED_READ_ONLY` requires verifier evidence. The default local server registers connectors in `DISCOVERED` only.

## 4. Operation policy

### Read
- Adapter must be `VERIFIED_READ_ONLY` (or a separately governed write-enabled state).
- Adapter descriptor must explicitly grant read permission.
- Requested capability must be declared.
- Handler output receives a digest and provenance envelope.
- Failures return structured results without leaking stack traces.

### Write
- Adapter descriptor must explicitly declare write permission and capability.
- Adapter must be verified and in the read-only state before a write is requested.
- The request binds actor, adapter, capability, target, payload digest and correlation ID.
- A trusted synchronous approval verifier must validate a request-bound approval artifact.
- The write handler is invoked only after approval succeeds.
- Adapter returns to `VERIFIED_READ_ONLY` after the one request; no persistent broad write enablement.
- Missing verifier, mismatched approval, expired/replayed approval or unavailable handler fails closed.

The verifier implementation must be supplied by a trusted host and must validate a real signed artifact against trusted key material and durable one-time nonce storage. The local preview does not configure such a verifier, so external writes remain unavailable.

## 5. Local intake

`POST /api/intake` accepts bounded metadata only:
- `label` (1–160 characters)
- `sourceType`: `manual_url | rss_atom | json_csv | telegram_pending`
- `actor` (optional; defaults to `architect`)

This endpoint records an intake request in local memory with `networkAccess: false`. It does not fetch a URL, poll Telegram, parse a feed or import remote content. Those adapters must be implemented separately with explicit source permissions, rate limits, provenance capture, retention and security review.

## 6. Event journal

Every registry and intake action emits an event envelope with:
- monotonic sequence;
- event ID and correlation ID;
- UTC timestamp;
- event type and source;
- payload digest;
- previous event hash and current event hash.

The current journal is in-memory and process-local. It is not a durable database, digital signature, multi-process consensus log or tamper-proof external audit service. Durable storage integration remains a separate work package.

## 7. Run locally

From repository root:

```bash
node packages/kratt-orchestrator/src/local-server.mjs
```

Open `http://127.0.0.1:4174`.

Optional port override:

```bash
KRATT_PORT=4175 node packages/kratt-orchestrator/src/local-server.mjs
```

Run the orchestration tests:

```bash
node --test packages/kratt-orchestrator/test/*.test.mjs
```

## 8. Acceptance gates before production use

1. Integrate a real trusted adapter identity verifier.
2. Add source-specific read adapters with permission and licensing review.
3. Connect the evidence kernel to actual imported source payloads.
4. Persist journal and nonce state using a durable, crash-safe store.
5. Implement signed, request-bound approval verification with key rotation and replay protection.
6. Add tenant isolation, authentication, rate limiting, secrets handling, backup and restore.
7. Complete security review and independent penetration testing.
8. Validate with design partners and measured analyst outcomes.

No production readiness or live third-party integration is claimed by this V1 local slice.
