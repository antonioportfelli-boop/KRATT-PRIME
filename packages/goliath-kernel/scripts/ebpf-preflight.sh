#!/usr/bin/env bash
set -euo pipefail
missing=0
for tool in clang llvm-strip bpftool; do
  if command -v "$tool" >/dev/null 2>&1; then printf 'FOUND %s: %s\n' "$tool" "$(command -v "$tool")"; else printf 'MISSING %s\n' "$tool"; missing=1; fi
done
if [[ -r /sys/kernel/btf/vmlinux ]]; then echo "FOUND kernel BTF"; else echo "MISSING kernel BTF (/sys/kernel/btf/vmlinux)"; missing=1; fi
if command -v uname >/dev/null 2>&1; then printf 'KERNEL %s\n' "$(uname -r)"; fi
if [[ "$missing" -ne 0 ]]; then echo "eBPF preflight incomplete; no build or attach attempted"; exit 2; fi
echo "eBPF toolchain prerequisites present; verifier/build step still required"
