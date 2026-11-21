# Linux Operations Intelligence — KRATT PRIME / GOLIATH

**Status:** Read-only diagnostic contract and local collector proposal, implemented on the hardware-aware feature branch. Not a production network controller.

## Objective

Turn the supplied Linux terminal reference into a safe, typed operations capability. GOLIATH observes hardware, interfaces, routes and available tools. KRATT correlates the observations with policy, memory and evidence. Neither layer treats an observation as permission to change the host.

## 1. Capability domains

| Domain | Source commands / files | Intended result |
|---|---|---|
| OS identity | `/etc/os-release`, `uname` | Distribution, version, kernel and architecture |
| Interface inventory | `ip -j -br address`, `ip -s -j link show` | Interface names, address families, link state and counters |
| Routing | `ip -j route show table all`, `ip -j -6 route show table all` | IPv4/IPv6 route inventory |
| Policy routing | `ip -j rule show`, `ip -j -6 rule show` | Rules, marks, priorities and lookup tables |
| Neighbours | `ip -j neigh show` | ARP/ND entries; sensitive network metadata |
| Route resolution | `ip route get`, `ip -6 route get` | Kernel route lookup for representative destinations; no packet is sent |
| NetworkManager | `nmcli general status`, `nmcli device status`, configuration path metadata | Daemon and device state without reading saved connection secrets |
| Manager coexistence | `systemctl is-active` for NetworkManager, systemd-networkd and ConnMan | Detect multiple active services for review |
| Arch netctl | `netctl --version` | Detect tool presence; do not enumerate potentially private profile names automatically |
| Development tools | PATH detection for nano, micro, vim, bash, ShellCheck, tmux and package managers | Environment capabilities, not installation permission |

Prefer `ip -j` JSON output for machine parsing. `-br` is useful for human display, and `-s` exposes counters. `routel` is a display wrapper around `ip route`, so it should not be the canonical machine interface.

### Route lookup meaning

`ip route get ADDRESS` resolves how the kernel would route a packet with the supplied lookup attributes. It does not send a packet. The result may differ from a plain route-table listing because policy rules, source, input/output interface, mark, VRF, protocol and ports can affect lookup. This is route selection evidence, not proof that the remote host is reachable.

## 2. NetworkManager and netctl

- `NetworkManager.conf` is daemon-wide configuration, not a saved Wi-Fi profile.
- Prefer a uniquely named drop-in such as `/etc/NetworkManager/conf.d/90-goliath-managed.conf` over editing a distribution-owned main file.
- Drop-ins are parsed in filename order; later values may override earlier values. Never assume a proposed snippet wins without inspecting the complete effective configuration.
- The collector records only whether the main file exists and the names of `.conf` drop-ins. It never reads `system-connections` or configuration contents.
- Use NetworkManager's supported D-Bus API or `nmcli` for status/integration rather than rewriting keyfiles.
- `netctl` is an Arch Linux profile manager. Do not manage the same interface concurrently through netctl and NetworkManager. Detect active managers and require an explicit migration plan before any change.

No automatic restart or reload is performed. NetworkManager supports selective configuration reload mechanisms, but their applicability depends on the setting and installed version.

## 3. Command risk model

| Class | Examples | KRATT treatment |
|---|---|---|
| READ_ONLY | `ip address show`, `ip route show`, `ip route get`, `uname`, `man`, `tldr` | Allow through fixed allowlist, bounded output and rate limits |
| SENSITIVE_READ | `ip neighbour show`, interface counters, `history`, process listings | Minimize, redact, keep local; history and full process command lines are not collected |
| LOCAL_WRITE | Save in editor, persistent shell alias, cron edit, append redirection | Require scoped local-write policy, backup and preview |
| PRIVILEGED | `sudo ip address add/del`, link up/down, route add/replace/delete, NetworkManager reload, netctl start/stop, package install | Require exact approval, pre-state capture and rollback plan |
| IRREVERSIBLE | `ip route flush`, package purge/remove, overwrite redirection, destructive history cleanup, unknown shell command | Deny by default; separate high-impact approval and recovery review |

The action identifier, not free-form command text, must determine policy. Never interpolate user input into a shell command. Use a fixed executable plus a validated argument array with shell execution disabled.

## 4. Editor and shell workflow

- Nano and Micro are optional operator tools, not runtime dependencies.
- Nano configuration belongs in `~/.nanorc`; Micro settings belong in `~/.config/micro/settings.json`. Do not write these automatically.
- Use `bash -n` for syntax validation and ShellCheck when installed. Validation does not prove a script safe.
- Quote variable expansions, prefer `"$@"`, use explicit error handling, bounded timeouts and cleanup traps.
- `>` overwrites, `>>` appends. A generated configuration must be previewed, backed up and written atomically; never use blind overwrite.
- `history` may contain tokens, passwords, private addresses and commands. KRATT must not ingest shell history by default.
- `ps`, `kill` and `xkill` may expose sensitive process data or terminate applications. They are outside read-only diagnostics.
- `tmux`, cron and background processes introduce persistence. They require an explicit lifecycle, owner, stop mechanism and approval.

## 5. Package-manager detection

Detect tools such as apt/dpkg, dnf/rpm, pacman, zypper, apk, emerge, pkg, brew, snap and flatpak. Detection must not call install, upgrade, remove, purge, repository-add or auto-clean commands. Package-manager choice is based on the actual OS, not merely whichever executable appears first in PATH.

## 6. Android environment caveat

A Linux terminal environment is not guaranteed on every Android 15 device. Android's Android 15 QPR1 release notes describe the experimental VM-backed Linux development environment on selected Pixel devices with AVF support. Treat it as an optional platform capability; discover the actual environment rather than assuming it exists on Android 15 generally.

## 7. Repository implementation

- `packages/kratt-core/src/linux-operations.mjs`: fixed command catalog, operation risk mapping and read-only collector.
- `packages/kratt-core/src/linux-diagnostics-cli.mjs`: local JSON report entry point.
- `packages/kratt-core/test/linux-operations.test.mjs`: unit tests with an injected fake runner; tests do not invoke host commands.
- `packages/goliath-kernel`: packet event and eBPF telemetry. The network diagnostics and eBPF event streams are complementary, not interchangeable.

Run locally on Linux:

```bash
node packages/kratt-core/src/linux-diagnostics-cli.mjs
```

The report may include local IP addresses, MAC addresses, route details and interface names. It prints to stdout only; do not paste or upload it without reviewing and redacting private network metadata.

Run unit tests:

```bash
node --test packages/kratt-core/test/*.test.mjs
```

## 8. Explicit non-goals

This slice does not execute arbitrary shell commands, install packages, write aliases, create cron jobs, kill processes, change NetworkManager or netctl profiles, add/delete/flush routes, attach eBPF, probe internet reachability, or export diagnostics automatically.

## 9. Acceptance gates for future write adapters

1. A read-only baseline and evidence digest exist.
2. The proposed diff and exact target paths are shown to the operator.
3. Network-manager ownership is unambiguous for each interface.
4. A request-bound approval names the exact provider, operation and target.
5. Credentials are not stored in profile exports or logs.
6. A rollback action and timeout are tested.
7. Reconnect and IPv4/IPv6 route verification pass.
8. Evidence says CONFIGURED, EXECUTED or VERIFIED accurately; a generated plan is not execution evidence.
