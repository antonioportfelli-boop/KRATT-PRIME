# KRATT PRIME 5x Runtime v3

Status: experimental implementation slice on a dedicated feature branch. It is not a production agent runtime and it does not execute host or provider operations.

## Design objective

Extend the existing KRATT Core contracts, hardware-aware compute planner, GOLIATH packet telemetry and Linux read-only diagnostics into one reviewable planning surface. The 5x target means five cooperating planes with typed boundaries, not five copies of the same UI.

## Five runtime planes

1. Host and network observation — Linux diagnostics gather fixed-argument iproute2, NetworkManager and systemd state. Adaptive profiling normalizes distribution, CPU, memory, package manager, interfaces and route-table facts. It never changes host state.
2. Hardware capability planning — existing hardware-capabilities contract validates CPU/GPU/NPU metadata and makes stage-aware route proposals. A route proposal is not inference execution.
3. Adapter and provider governance — adapter-registry validates provider manifests, capability scopes, target resources, timeouts and side-effect classes. The provider catalogue names GitHub, Slack, TinyFish, Lovable, Data, SciSpace, Base44, Linear, Canva and Template Creator without asserting that each is connected or write-enabled.
4. Cognitive workflow and templates — workflow-orchestrator defines architect, builder, parallel tester/auditor, integrator and release stages. template-registry produces structured, schema-checked payloads; it does not evaluate code or shell templates.
5. Evidence, audit and metrics — evidence-ledger creates a local append-only SHA-256 hash chain for deterministic simulation and tests. Metrics count OBSERVED, INFERRED, CONFIGURED, EXECUTED, VERIFIED and BLOCKED events without inventing a reliability score.

## Runtime flow

Host snapshot -> adaptive profile -> hardware validation -> compute route proposal -> adapter inventory and policy result -> evidence requirements -> workflow plan -> operator review.

Execution, provider writes, NetworkManager edits, package installation, privileged commands, XDP attachment and deployment are deliberately outside this slice.

## Provider integration states

| Provider | Intended role | Default treatment |
|---|---|---|
| GitHub | Repository, branch, PR and CI evidence | Read-only inventory; branch writes remain request-scoped |
| Slack | Engineering discussion and status evidence | Search/read only |
| TinyFish | Web research and browser retrieval | Research only; no credentials or browser actions are assumed |
| Lovable | Existing application/editor source | Read-only source reference; no publish/deploy |
| Data | Metrics, quality checks and reports | Typed analysis input; no invented KPI |
| SciSpace | Scholarly research | Paper search/fetch; research is not code verification |
| Base44 | Integration hub/app builder | Existing app observed; current app status error and sandbox bridge unavailable |
| Linear | Project and issue tracking | Read-only discovery until a scoped comment/write is separately approved |
| Canva | Visual/design artifacts and brand templates | Search-only; no existing KRATT template was found |
| Template Creator | Local reusable structured templates | Local registry; no external rendering action |

A provider in the catalogue is only DISCOVERED. CONNECTED_UNVERIFIED, VERIFIED_READ_ONLY and WRITE_ENABLED require separate evidence. No connector listing or tool availability is proof of account scope.

## Security and integrity boundaries

- The model or caller cannot self-assign authority. Principal, agent and task scopes are intersected.
- A write operation remains inert unless the adapter manifest is explicitly WRITE_ENABLED and a server-verified approval matches provider, operation, resource target and expiry.
- Privileged and irreversible operations are not supported by the initial adapter executor contract.
- Shell interpolation, arbitrary command strings, sudo, package installs, service restarts, route changes and process termination are not part of the collector.
- Network addresses, MAC addresses, route details and interface names are sensitive. Diagnostics stay local by default; export requires review and approval.
- The evidence ledger in this slice is in-memory and hash-chained, not durable or signed. A hash chain detects accidental or unauthorized edits when a trusted head is retained, but it does not provide signer identity, remote transparency, atomic persistence or availability.
- Workflow state transitions and runtime plans do not call agents or external tools. A plan is not an execution receipt.

## Known limitations

- Linux system discovery is read-only and Linux-specific; Windows, macOS and Android adapters remain future work.
- The Linux collector does not read shell history, saved Wi-Fi connection profiles or NetworkManager configuration contents.
- Route lookup reports kernel path selection, not internet reachability.
- eBPF C has not been built with a BPF toolchain or checked by a target kernel verifier in this workstream.
- Current packet parser limitations remain: IPv6 extension chains, VLAN tags, tunnels and some fragments need separate parser work.
- No production benchmark or performance gain is claimed.
- Durable evidence storage, cryptographic approval verification, credential broker, distributed idempotency and real executor are not implemented here.

## Validation

CI runs Node 22 syntax checks and the complete KRATT Core Node test suite for this branch and its stacked pull request. This does not replace Rust Cargo tests, BPF compilation, kernel verifier checks, host integration tests or independent security review.

## Acceptance gates for future implementation

1. Linux snapshots parse bounded JSON from a fixed allowlist and include source timestamps.
2. Hardware snapshots reject unknown fields, malformed values and duplicate device identifiers.
3. A malformed or absent trusted policy result produces BLOCKED.
4. Adapter operations require the intersection of principal, agent and task scopes.
5. Write approvals bind exact provider, operation, target, issue time, expiry and revocation state.
6. Workflow release cannot start without a verified, request-bound approval and all upstream evidence.
7. Evidence events reject secret-like values, duplicates and tampered hash-chain entries.
8. A failed or missing durable store blocks execution rather than returning success.
9. No `main` write, merge, deployment, release or publication occurs without a separate release gate.
