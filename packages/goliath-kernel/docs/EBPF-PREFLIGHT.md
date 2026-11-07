# GOLIATH eBPF preflight
The preflight script checks for clang, llvm-strip, bpftool and kernel BTF. It does not compile, load, attach, pin, detach, or modify XDP programs. Tool presence is not verifier acceptance.

Next gated stage: pin a reviewed clang/LLVM toolchain and target architecture, generate or select compatible vmlinux.h, compile the actual BPF source with strict warnings, inspect the object with bpftool, then run verifier/load tests only in an isolated disposable Linux runner. Never attach to a user host from CI. Record kernel release, BTF identity, compiler versions, verifier log and artifact digest.
