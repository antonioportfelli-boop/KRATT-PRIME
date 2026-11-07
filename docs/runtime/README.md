# KRATT PRIME — hardware-aware runtime workstream

This branch is a non-production implementation slice based on the TinyFish research report:
https://agent.tinyfish.ai/research/01a1b336-70ba-7a8c-84d1-d0dae4fe6294

## Scope
- Define a portable hardware capability contract (CPU/GPU/NPU/ANE/HTP).
- Keep discovery adapters platform-specific and read-only.
- Make capability labels scheduling hints, never authorization.
- Distinguish local, remote, stub and unavailable providers.
- Preserve Core policy, trusted-clock, approval, evidence and audit boundaries.
- Keep ARTHAUSE isolated; AURA, STEEL, FRAME.9 and CERBERUS remain separate products.

## Current truth
The repository root README and package manifest identify the root application as AURA / `trinitywayve-aura`. This branch does not rename or repurpose that app. KRATT Core source integration remains subject to source reconciliation against existing Draft PRs.

## Safety
No device settings, network interfaces, secrets, privileged permissions or external services are modified by this package. Discovery is descriptive only. No deployment, merge, publication or main-branch write is authorized.