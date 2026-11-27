# WP-04.4 — Acceptance and Adversarial Test Matrix

| Boundary | Adversarial condition | Expected |
|---|---|---|
| Authorization | Plain object imitates the grant shape | Reject brand |
| Registration | Revision/contract/artifact changes after authorization | Reject before start |
| Lifecycle | Registration not VERIFIED_READ_ONLY | Deny |
| Operation | WRITE or destructive operation | Deny |
| Execution mode | IN_PROCESS_TRUSTED or WORKER_ISOLATED | Deny |
| Supervisor | Missing or malformed isolation profile | Deny |
| Isolation | Network or filesystem unrestricted, raw secrets permitted | Deny |
| Attestation | Missing, false, malformed or verifier-error receipt | Deny |
| Cancellation/policy | Pre-start fence fails | Do not commit start or invoke worker |
| Audit | Start commit fails | Do not invoke worker |
| Resource bounds | Declared timeout exceeds host limit | Clamp to host max |
| Worker result | Unknown, malformed, missing digest or invalid reference | Record UNKNOWN; never success |
| Postflight | Cancellation/revocation fence fails | Quarantine result |
| Finish audit | Terminal outcome commit fails | Do not report success |
| Output | Worker attempts to return arbitrary/raw payload | Reject closed result schema |
| Replay | Invocation/start uniqueness conflict | Store refuses start |
| Secrets | Invocation contains credential material or raw approval | Not present in schema |

## Exit criteria

- Only a WP-04.3 branded grant can pass the start boundary.
- Current registration and execution fences are checked immediately before launch.
- The worker supervisor is independently attested for the exact OS process/container policy.
- Only PROCESS_ISOLATED and READ operations are accepted.
- Execution start and terminal outcome are persisted atomically with audit evidence.
- Unknown results are not automatically retried or reported as success.
- The real supervisor, store and verifier still require staging validation before any external data is handled.
