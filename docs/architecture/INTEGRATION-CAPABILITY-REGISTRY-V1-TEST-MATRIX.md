# Integration Capability Registry v1 — Acceptance Matrix

| Area | Case | Expected result |
|---|---|---|
| Context | Missing trusted context | BLOCK |
| Descriptor | Secret-like field present | Reject |
| Descriptor | Read/write scope overlap | Reject |
| Lifecycle | DISCOVERED / CONNECTED_UNVERIFIED | BLOCK |
| Lifecycle | DISABLED / ERROR | BLOCK |
| Read | VERIFIED_READ_ONLY + read scope | Permit read |
| Scope | Principal/agent/connector intersection | Effective grants only |
| Scope | Read-only grant requests write | BLOCK |
| Resource | Target outside allow scope or in deny list | BLOCK |
| Provider | Provider mismatch | BLOCK |
| Approval | Missing/unverified/mismatched/expired | BLOCK |
| Destructive | Missing destructive approval | BLOCK |
| Audit | Minimal record projection | No secret or arbitrary payload |

This is a local policy contract only; server-side cryptographic verification, durable replay/revocation control, credential isolation, provider idempotency and crash-recovery tests remain mandatory.
