# Wave 4.1 — Security Regression Matrix

Date: 2026-11-27  
Verified revision: \`ef7f178ba4e95d44412765aeae9948f83a3450d8\`

## Security invariants

1. External writes are authorized against the current actor, task, target, scope, trusted context, required evidence, request-bound approval and expiry.
2. Signature verification and durable nonce consumption remain in the trusted authorization runtime.
3. Unknown or stale authorization, evidence, scope, lease, or storage state remains fail-closed.
4. Provider dispatch cannot precede durable intent.
5. Durable outcome follows dispatch. If outcome persistence fails after a provider side effect, return OUTCOME_UNRECORDED rather than false success.
6. Running cancellation requires worker acknowledgement.
7. Stale execution workers fail current-lease/fencing validation.
8. PrimeStore and PostgreSQL remain distinct coordination models.
9. Telemetry is non-authoritative, allow-listed and bounded; it excludes payloads and secrets.
10. A fingerprint, adapter registration, provider connection, prior ALLOW or telemetry record does not confer write authority.

## Regression coverage

| Fault / attack | Control | Evidence |
|---|---|---|
| malformed task | envelope validation | KRATT core tests |
| wrong actor | principal/task actor binding | authorized-dispatch tests |
| authentication failure | durable denied decision, no provider call | added dispatch regression |
| missing trusted input | BLOCKED and durable decision | dispatch regression |
| explicit DENY / BLOCKED | fail-closed policy and durable decision | dispatch tests |
| policy exception | BLOCKED | dispatch tests |
| missing provider adapter | BLOCKED, no dispatch | dispatch tests |
| intent write failure | provider not called | dispatch tests |
| duplicate intent | durable idempotency claim | command-store/dispatch tests |
| provider exception | failed outcome where store is available | dispatch tests |
| outcome write failure | OUTCOME_UNRECORDED | dispatch tests |
| invalid correlation ID | deny before provider, safe audit ID | added dispatch test |
| sync telemetry exception | does not change dispatch result | telemetry/dispatch tests |
| async telemetry rejection | observed/counts failure | telemetry test |
| telemetry overflow | bounded ring/queue; drops observable | telemetry test |
| invalid/expired signed approval | signature/expiry verifier | trusted-runtime tests |
| reused nonce | durable unique consume | nonce-store/trusted-runtime tests |
| expired lease | current lease/fencing validation | governed-execution tests |
| stale fencing generation | old worker cannot start after takeover | added governed test |
| RUNNING cancel without acknowledgement | no terminal cancellation | added governed test |
| RUNNING cancel with acknowledgement | CANCELLED transition allowed | ledger/runtime tests |
| PostgreSQL expired lease finish/retry | server-time lease validity in row-locked transaction | outbox contract test |
| GOLIATH C/Rust ABI drift | size, alignment and field offsets asserted | Rust unit job |

## Not yet verified

- live PostgreSQL multi-connection / multi-process lock and transaction behavior;
- stale provider side effect after lease expiry (provider must enforce idempotency/fencing);
- real worker crash/restart and cancellation delivery/ack under process failure;
- complete queue capacity, overflow and retry/dead-letter matrix for every queue;
- end-to-end telemetry events from governed runtime, queue, lease and evidence verifier;
- BPF C build/verifier and kernel parser tests;
- STEEL/FRAME.9 adapter conformance tests at both validator boundaries.

## CI evidence

- [Node CI 46021742863](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742863) — success
- [Security 46021742846](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742846) — success
- [KRATT PRIME CI 46021742886](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021742886) — success
- [GOLIATH Rust tests 46021743006](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021743006) — success
- [Performance 46021732365](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021732365) — success

No production deployment, main write, secret change, role change, or privileged packet-processing action occurred.
