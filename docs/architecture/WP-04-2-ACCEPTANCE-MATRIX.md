# WP-04.2 — Acceptance and Adversarial Test Matrix

| Boundary | Adversarial input / race | Expected outcome | Evidence |
|---|---|---|---|
| Manifest | Unknown fields, malformed schema or unsupported critical version | Reject before source lookup | Adapter contract and registration tests |
| Source identity | Reader returns another repository, revision or path | Reject; no record or audit append | Registration source-binding tests |
| Source integrity | Returned bytes do not match manifest SHA-256 | Reject with digest mismatch | Registration digest test |
| Provenance | Missing, false, malformed or verifier-error receipt | Reject; do not create registration | Provenance receipt tests |
| Persistence | Duplicate adapter ID | Reject without overwriting the existing record | Duplicate registration test |
| Persistence | Atomic create/audit operation fails | Do not report success | Store failure test |
| Persistence | Read-back record has a bad digest or source binding | Reject the read-back | Tamper/read-back tests |
| Conformance | No host conformance verifier | Remain CONNECTED_UNVERIFIED | Missing verifier test |
| Conformance | False or malformed conformance receipt | No lifecycle transition | Failed attestation test |
| Conformance | Registration revision changes while verifier runs | CAS conflict; no successful promotion | Revision mismatch test |
| Lifecycle | Conformance passes | Use existing transition to VERIFIED_READ_ONLY only | Verified state test |
| Authorization | Read before read-only verification | Deny | Unverified-state test |
| Authorization | Write in CONNECTED_UNVERIFIED or VERIFIED_READ_ONLY | Deny, including with request-shaped approval | Fail-closed WRITE tests |
| API surface | Caller probes for execute/load/enableWrite | Method is absent | API-surface assertions |
| Audit | State transition | Minimal, append-only event bound to revision and evidence reference | Audit event assertions |
| Disable | Arbitrary free-text reason that could contain secrets | Reject; accept stable reason codes only | Reason-code test |
| Recovery | Store update returns non-success | Report failure; do not claim a transition | CAS/store outcome tests |

## Exit criteria

- Registration binds a contract to exact source bytes and an immutable source revision.
- The artifact digest is recomputed by the runtime, not trusted from the manifest.
- The host provenance verifier and host conformance verifier are independent injected authorities.
- The existing integration lifecycle is the only lifecycle state machine.
- A verified adapter is READ-only; no external write is reachable from this package.
- Record updates and audit events use an atomic persistence contract and optimistic revision checks.
- The test double verifies service behavior; the production persistence implementation remains a separate acceptance gate.
