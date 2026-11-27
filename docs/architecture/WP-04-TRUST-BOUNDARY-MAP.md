# WP-04 — Trust Boundary and Dependency Map

Date: 2026-11-27

## Control plane

- WP-04.1: closed declarative adapter contract and exact-version compatibility.
- WP-04.2: host-owned registration, immutable source/artifact digest and provenance.
- WP-04.3: trusted principal/agent/integration grants, versioned capability intersection, request-digest-bound approval, nonce consumption and decision audit.
- WP-04.4: current registration check, short-lived grant check, supervisor attestation, execution fence and durable execution start/outcome evidence.

## Data plane

Only a WP-04.3 branded grant may pass the WP-04.4 invocation boundary. The runner:
1. Re-reads adapter registration and compares the exact revision/digests.
2. Requires VERIFIED_READ_ONLY and a READ operation.
3. Requires PROCESS_ISOLATED mode.
4. Requires a trusted attestation of the OS process/container restrictions.
5. Revalidates current policy/cancellation before launch.
6. Persists start evidence.
7. Passes only pinned source coordinates, request digest, scopes and bounded execution limits.
8. Validates the worker's bounded result and persists its terminal state.

## Isolation profile

The host supervisor must enforce:
- separate unprivileged OS identity / container boundary;
- provider-specific allowlisted egress only;
- read-only artifact mount and ephemeral bounded temp storage;
- no raw secrets in worker context;
- memory and wall-clock limits;
- process kill/termination and cleanup;
- artifact digest verification before code load.

Node Worker Threads and JavaScript object freezing are not considered OS security boundaries.

## Reuse map

| Layer | Existing owner | WP-04 additions |
|---|---|---|
| Contract | adapter-contract.mjs | WP-04.1 |
| Registration | adapter-registration.mjs + integration-registry.mjs | WP-04.2 |
| Authorization | integration-capability-registry.mjs + approval-evidence.mjs | WP-04.3 |
| Dispatch | authorized-dispatch.mjs and WP-03 outbox | Remains the only effect/dispatch layer |
| Process execution | Host process/container supervisor | WP-04.4 invocation contract only |
| Audit/recovery | host durable stores and WP-03 reconciliation contracts | WP-04.2–04.4 storage interfaces |

## Not yet established

- A real supervisor implementation or OS policy profile.
- Transactional production registration, approval replay, execution and audit stores.
- Trusted verifier key lifecycle and live context loading.
- Credential broker; no raw credentials are passed.
- Tenant ID as a mandatory partition key.
- Live provider or current STEEL protocol conformance.
