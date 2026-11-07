# GOLIATH Kernel telemetry slice (KRATT PRIME)

Status: experimental, user-space analysis library plus an XDP/eBPF source specimen. Not a Linux kernel, firewall, production network monitor, or deployable agent.

## Scope

- `PacketEvent` is the C-layout event ABI shared with the BPF source: 56 bytes, 8-byte alignment.
- `KineticResonanceEngine` is a deterministic, configurable telemetry score. It is an analytical heuristic, not a physical measurement, security verdict, or validated anomaly detector.
- The XDP source observes Ethernet IPv4/IPv6 and emits bounded events to a ring buffer. It always returns `XDP_PASS`; it does not drop, redirect, or mutate packets.
- The BPF config map supports schema version 1, a bounded sampling rate, and an optional TCP/UDP port filter. Updating this map is not yet wired to an authorized userspace control plane.

## Important parser limits

The initial BPF slice parses IPv4 options using IHL and IPv6 base headers with direct TCP/UDP next-header values. IPv6 extension-header chains, non-first IP fragments, VLAN-tagged Ethernet frames, tunnels, and other L4 protocols are not fully decoded. Unsupported/truncated packets are counted and passed unchanged. Add dedicated parser tests before claiming broader IPv6 support.

## Safety and rollout

- No automatic XDP attach, privileged operation, NetworkManager modification, firewall action, or production deployment is included.
- Loading/attaching XDP requires a separately authorized privileged host operation and a tested detach/rollback path.
- Event payloads contain network addresses and ports; collection, retention, access, and export need explicit policy and redaction controls.
- Ring-buffer loss is observable through counters; consumers must not assume every packet produces an event.
- The BPF config map is not itself an authorization boundary. Only a narrowly scoped, policy-checked control plane may update it.

## Build and test

`cargo test --manifest-path packages/goliath-kernel/Cargo.toml`

The eBPF C object is not built by this crate's Cargo workflow. It requires a Linux BPF toolchain, generated `vmlinux.h`, target-specific build steps, and verifier testing on supported kernels.
## Kernel and BPF compatibility gates

- The ring-buffer map used by this sample requires Linux kernel 5.8 or later. Capacity must be a power of two and satisfy the target page-size constraints.
- There is no Perf Event Array fallback in this slice. On kernels without ring-buffer support, a loader must report telemetry as unavailable.
- CO-RE requires compatible BTF data, normally exposed at /sys/kernel/btf/vmlinux. BTF portability does not guarantee that every helper, map type or XDP attach mode exists on the target kernel.
- Verifier acceptance is required for each supported kernel/configuration. It is not a substitute for kernel patching, threat review or runtime observation.
- Common verifier constraints include a 512-byte BPF stack. The one-million complexity budget applies to kernels from 5.2 onward; older kernels have lower limits.
- Newer Aya releases deprecate Bpf and BpfLogger in favour of Ebpf and EbpfLogger. A future loader must pin a reviewed Aya release and use its supported API.
- Generic, native and offloaded XDP modes have different driver/hardware requirements. This sample only observes and returns XDP_PASS.

References:
- https://docs.kernel.org/bpf/ringbuf.html
- https://docs.kernel.org/bpf/verifier.html
- https://aya-rs.dev/book/
- https://aya-rs.dev/book/programs/xdp.html
