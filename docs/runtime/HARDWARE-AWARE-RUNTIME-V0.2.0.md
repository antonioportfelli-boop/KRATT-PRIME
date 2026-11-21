# Hardware-aware runtime — v0.2.0 implementation slice

**Status:** Core contract and deterministic routing proposal added on this branch. No OS discovery adapters or inference execution are included.

## Research-to-code decisions

| Research finding | Implementation boundary |
|---|---|
| ONNX Runtime Execution Providers abstract accelerator backends | Model providers as adapter identifiers; do not assume a provider is installed or working |
| Windows ML manages EP discovery | Future Windows adapter reports evidence; core stays platform-neutral |
| Android NNAPI is deprecated; LiteRT CompiledModel is preferred | Future Android adapter targets LiteRT; no NNAPI dependency is introduced |
| Core ML can select CPU/GPU/ANE | Future macOS adapter reports actual selected compute units |
| Linux uses OpenVINO, QNN, llama.cpp and vendor backends | Future Linux discovery is read-only and reports provider capability |
| NPU/CPU/GPU stage performance varies | Stage-aware route is a proposal only; device benchmarks must determine production policy |
| Remote fallback has privacy and consent implications | Remote is never implicit; explicit allowlist and transfer approval flag required |

## Contract rules
- Snapshot is descriptive, versioned, bounded and rejects unknown fields.
- Device discovery and runtime selection do not confer authorization.
- Adapter `DETECTED` is distinct from `AVAILABLE`; testing and model compatibility remain separate.
- A proposed route is not execution. Policy evaluation is mandatory before execution.
- Remote processing requires an explicit allowlist and data-transfer approval path.
- No network interfaces, NetworkManager profiles, device drivers, firmware, power settings or permissions are changed.
- No performance claim is made from hardware labels alone.

## Next implementation slices
1. Reconcile exact Core source tree and integrate without disturbing WP-01 / Memory Engine changes.
2. Add per-platform read-only discovery interfaces: Linux sysfs/libdrm; Windows ML/WMI; macOS Core ML; Android LiteRT.
3. Add model compatibility and quantization constraints, then benchmark prefill/decode independently.
4. Connect route proposals to existing policy, approval, trusted clock and evidence services.
5. Add OS-specific sandbox launchers and lifecycle constraints only after platform build/test harnesses are confirmed.
6. ARTHAUSE connects through a separate creative-job contract with approval and C2PA provenance; no direct provider calls from Core.

## Acceptance criteria
- Unit tests cover snapshot validation, route choice, remote-fallback gating and state truthfulness.
- No hardware API or privileged operation is called.
- No policy/authorization code is duplicated.
- Existing PRs remain draft and `main` remains unchanged.