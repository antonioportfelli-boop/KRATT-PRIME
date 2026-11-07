# 5x Runtime v3 — technical research decisions

Research source: TinyFish technical report completed 2026-11-07 (66 sources).
https://agent.tinyfish.ai/research/01a1b3bd-ac2a-72de-81a8-b31b8197fcb6

## Evidence labels

- FACT: supported by the cited technical documentation or paper.
- DECISION: implementation boundary adopted by KRATT PRIME.
- DEFERRED: future option, not code shipped by this branch.

## 1. Linux network management

FACT: rtnetlink is the Linux kernel interface for link, address, route and neighbour operations. iproute2 is a user-facing client for these interfaces. ip route get resolves a kernel route lookup; it does not prove remote reachability.

FACT: NetworkManager exposes nmcli, D-Bus and libnm interfaces. Device objects include statistics, wireless/wired state and checkpoint support. NetworkManager's libnm documentation discourages synchronous D-Bus calls for stateful client work because ordering and cache consistency can be affected.

DECISION: current discovery uses fixed-argument iproute2 and nmcli calls only. A future write adapter should use an asynchronous D-Bus/libnm path or a typed declarative library such as nmstate, with manager-ownership detection, pre-state capture, rollback and explicit approval. Do not edit saved profile files or restart services directly.

FACT: NetworkManager daemon configuration and saved connection profiles are separate; profiles may contain credentials and private network data.

DECISION: the current collector records only config path presence and drop-in filenames. It does not read NetworkManager.conf contents or system-connections profiles.

Sources:
- https://networkmanager.dev/docs/api/latest/
- https://www.networkmanager.dev/docs/libnm/1.30.6/usage.html
- https://nmstate.io/devel/design/networking-api.html
- https://man7.org/linux/man-pages/man7/rtnetlink.7.html
- https://docs.kernel.org/userspace-api/netlink/intro.html

## 2. eBPF/XDP and GOLIATH

FACT: XDP runs on ingress before the standard socket-buffer allocation path. XDP_PASS allows a packet to continue through the normal networking stack; XDP_DROP discards it. Generic, native and offloaded modes have different driver and hardware requirements.

FACT: BPF_MAP_TYPE_RINGBUF was introduced in Linux 5.8. Its capacity must be a power of two and page-size compatible. It is a multi-producer/single-consumer queue. Records become visible in reservation order, so an earlier producer can delay later records. Buffer exhaustion must be counted explicitly.

FACT: verifier acceptance is a safety gate, not proof that all verifier implementations are bug-free. Research has documented verifier logic bugs and eBPF memory-safety challenges. Kernel version, configuration, helpers, map types, BTF data and attachment mode affect compatibility.

FACT: common verifier constraints include a 512-byte stack; the one-million complexity budget applies to kernels from 5.2 onward, while older kernels have lower limits. Complexity depends on explored program paths, not just source line count.

DECISION: keep the current GOLIATH XDP sample pass-only. Preserve bounded parsing, per-CPU diagnostics and ring-buffer loss counters. The configured 256 KiB ring buffer is a power-of-two size; a loader still needs to check target page-size constraints and kernel feature availability.

DECISION: before live attach, add kernel/BTF preflight, XDP mode detection, verifier log capture, link-FD lifecycle, detach-on-shutdown and tested rollback. Build and verify on a declared kernel matrix. Do not add unreviewed XDP_DROP or XDP_REDIRECT responses.

FACT: Aya is a Rust eBPF framework with Tokio integration. Newer Aya releases deprecate Bpf and BpfLogger names in favour of Ebpf and EbpfLogger.

DECISION: a future loader must pin a reviewed Aya release and use that release's supported API. The current Rust packet-event library does not load or attach eBPF.

Sources:
- https://docs.kernel.org/bpf/ringbuf.html
- https://docs.kernel.org/bpf/verifier.html
- https://docs.ebpf.io/linux/map-type/BPF_MAP_TYPE_RINGBUF/
- https://docs.ebpf.io/linux/program-type/BPF_PROG_TYPE_XDP/
- https://aya-rs.dev/book/
- https://aya-rs.dev/book/programs/xdp.html
- https://consensus.app/papers/sok-challenges-and-paths-toward-memory-safety-for-ebpf-huang-payer/10154d4f2fde5d09b11cbeea21c24d47/

## 3. Host sandboxing

FACT: systemd service hardening supports NoNewPrivileges, CapabilityBoundingSet, ProtectSystem, ProtectHome, PrivateTmp, ProtectProc, RestrictAddressFamilies and SystemCallFilter. Availability and semantics depend on systemd/kernel versions.

FACT: Landlock lets a process restrict its own filesystem and selected network rights without requiring a privileged policy writer.

DECISION: future local agent workers should run with a dedicated unprivileged identity, systemd hardening and minimum Landlock/seccomp policy. Feature-detect the requested isolation level and fail closed when unavailable. No sandbox launcher or privileged executor is included in this PR.

Sources:
- https://www.freedesktop.org/software/systemd/man/systemd.exec.html
- https://docs.kernel.org/userspace-api/landlock.html
- https://man7.org/linux/man-pages/man7/landlock.7.html

## 4. Evidence and supply-chain assurance

FACT: JSON Schema validates document structure but does not establish identity, authority, freshness, cross-record consistency or proof that a side effect occurred. A hash chain detects later changes only when a trusted head is retained; it does not sign the writer or provide durability.

FACT: SLSA defines provenance and build-attestation requirements for describing how artifacts were produced.

DECISION: EvidenceLedger v1 is an in-memory local/test reference. Production requires atomic durable writes, crash consistency, signer identity, key rotation/revocation, externally retained checkpoints, retention controls and replay protection. Build attestations should be a separate release-evidence layer.

Sources:
- https://json-schema.org/draft/2020-12
- https://slsa.dev/spec/draft/
- https://scispace.com/papers/agentic-execution-assurance-observation-bounded-g61nul8r7tt2

## 5. Local-first memory

FACT: CRDT systems such as Automerge can support concurrent local edits and eventual synchronization, but do not automatically provide multi-object transactions, authorization, secret handling or security-audit ordering.

DECISION: do not replace KRATT typed memory/job journal with a CRDT in this increment. First establish durable atomic storage and authority/provenance. CRDTs may later serve conflict-tolerant user documents or offline UI state, not approval revocation, nonce uniqueness or security audit ordering.

Sources:
- https://automerge.org/blog/automerge-2/
- https://automerge.org/blog/automerge-repo/
- https://loro.dev/blog/crdt-is-not-enough

## 6. Android and portable hardware

FACT: Android Virtualization Framework/pKVM is an ARM64-specific deployment capability. eBPF observing guest traffic should be considered inside the Linux guest; host-side eBPF should not be assumed to inspect guest internals.

DECISION: Android support remains a capability probe. Do not assume every Android 15 device exposes the same Linux terminal or AVF functionality. A future adapter must verify architecture, virtualization, memory/IO constraints and runtime permissions before proposing a guest runtime.

Sources:
- https://source.android.com/docs/core/virtualization
- https://source.android.com/docs/core/virtualization/architecture
- https://developer.android.com/ndk/guides/cpu-features

## 7. Provider integration

FACT: GitHub and Slack APIs have rate limits and delivery constraints. Canva integrations require declared scopes. Linear documents API/webhook interfaces. Base44 documents app APIs and webhook functions. Lovable's documented source integration is GitHub sync; the research did not confirm a general public project-management API for arbitrary direct control.

DECISION: provider catalogue entries are intended adapter identities, not a live connection inventory. Each provider must separately prove identity, granted scopes, target constraints, timeout, rate-limit handling, idempotency and evidence output. Base44 and Lovable remain unverified/read-only in this workstream; no webhook writes or deployment are enabled.

Sources:
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
- https://docs.slack.dev/apis/events-api/
- https://www.canva.dev/docs/apps/rest-apis/scopes/
- https://linear.app/docs/api-and-webhooks
- https://docs.base44.com/Building-your-app/your-apps-api-page
- https://docs.lovable.dev/integrations/github

## 8. Production acceptance matrix

| Area | Required before production enablement | Current v3 state |
|---|---|---|
| Linux host discovery | Real-host tests, privacy review, distro matrix | Read-only collector; not run on user's host |
| Hardware routing | Device/provider compatibility probes and benchmarks | Validates declarations; route is a proposal |
| eBPF | BPF toolchain, kernel verifier matrix, attach/detach and rollback tests | Source specimen only; not verifier-tested here |
| Adapter writes | Server credential broker and cryptographically verified exact-scope approval | Manifest/decision contracts only; no provider writes |
| Evidence ledger | Durable atomic store, signed checkpoints, recovery and tamper review | In-memory hash-chain reference |
| Agent workflow | Runtime isolation, budgets, cancellation, durable queue and effect evidence | Deterministic workflow state machine only |
| Android | Device/ABI/AVF checks and guest lifecycle tests | Not implemented |
| Release | Signed build provenance and independent release gate | No release/deployment in v3 |

Research caveat: this report synthesizes official documentation and papers/preprints. It is an engineering research input, not certification or a substitute for tests against the exact target kernels, library versions and device models.