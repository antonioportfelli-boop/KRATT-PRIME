# GOLIATH OS — Observability Source and Safety Status

Date: 2026-11-27

## Source recovery

The small \`tkynnap-creator/GOLIATH-OS\` repository does not contain the expected Rust/eBPF source. The actual source is present in KRATT PRIME:

- \`packages/goliath-kernel/Cargo.toml\`
- \`packages/goliath-kernel/src/lib.rs\`
- \`packages/goliath-kernel/bpf/goliath_xdp.c\`
- \`packages/goliath-kernel/README.md\`

This is an experimental user-space event model/analysis library plus an XDP/eBPF source specimen. It is not a full operating system kernel, production firewall or deployable network monitor.

## Packet event ABI

Rust \`PacketEvent\` is \`#[repr(C)]\`, 56 bytes, 8-byte aligned. Wave 4.1 asserts field offsets:

| Field | Offset |
|---|---:|
| ts_ns | 0 |
| proto | 8 |
| ip_version | 9 |
| pad | 10 |
| saddr | 12 |
| daddr | 28 |
| sport | 44 |
| dport | 46 |
| pkt_len | 48 |

The Rust tests also cover size/alignment and rejection of unsupported IP versions. The C and Rust event structures are checked for layout compatibility.

## Current XDP specimen

- Parses Ethernet, IPv4/IPv6, and direct TCP/UDP.
- IPv4 header length/options are considered.
- IPv6 extension-header chains, non-first IPv4 fragments, VLAN frames, tunnels and other L4 protocols are not fully decoded.
- Unsupported/truncated packets are counted and passed through.
- Ring buffer is bounded at 256 KiB; emit can fail when full and increments a loss metric.
- XDP returns \`XDP_PASS\`; it does not drop, redirect, filter or mutate packets.
- The configuration map is not an authorization boundary and is not wired to a trusted control plane.

## CI and limitations

Wave 4.1 added ABI field-offset tests and a feature-branch push trigger to the Rust workflow. Rust unit tests succeeded:

[GOLIATH Kernel Rust checks — run 46021743006](https://github.com/antonioportfelli-boop/KRATT-PRIME/actions/runs/46021743006)

Cargo tests do not compile the BPF C source. A separate Linux BPF toolchain, generated \`vmlinux.h\`, pinned compiler, kernel verifier tests and synthetic packet fixtures remain required.

## Safety

No XDP program was attached. No privileged load, map update, firewall action, packet drop/redirect, system configuration change or production deployment occurred.

## Next gates

1. Synthetic packet fixtures for IPv4 options/fragments, IPv6 extension headers, VLAN, truncation and non-TCP/UDP.
2. Pinned BPF build and verifier workflow on supported Linux kernels.
3. Load only inside an isolated ephemeral network namespace, with explicit authorization and detach rollback.
4. Measure CPU, event rate, ring-buffer losses and memory against a no-XDP control.
5. Keep packet handling read-only / XDP_PASS pending a separate security review.
