# KRATT PRIME Console — V1 Preview

This is a standalone, local-first product console for the KRATT PRIME Signal-to-Evidence workstream.

## Run the visual preview

From the repository root:

```bash
node packages/kratt-orchestrator/src/local-server.mjs
```

Open `http://127.0.0.1:4174`. The UI and local API are served from the same loopback-only process. Set `KRATT_PORT` to use another local port.

For a static UI-only preview without the API:

```bash
python3 -m http.server 4173 --directory products/kratt-prime-console
```

No package install is required for either preview.

## What is included

- Overview dashboard with signal, claim, evidence and contradiction metrics.
- Six-stage pipeline visualization.
- Signal stream with local search and state filtering.
- Evidence relationship graph with support and counter-evidence examples.
- Orchestration view with governed execution lanes and hard invariants.
- Connector registry showing lifecycle states and capability boundaries.
- Governance screen for READ/WRITE separation and human approval.
- Local event journal demo with Web Crypto SHA-256 chain verification.
- Intake dialog that appends a local sample record and event.

## Important boundary

The UI is a **local demonstration shell**, not a connected production console. Its records are synthetic. It does not call Telegram, GitHub, Slack, RSS, remote services, or the KRATT orchestrator. It stores no credentials and cannot perform external writes.

The backend orchestration contract is implemented separately in:

- `packages/kratt-orchestrator/src/orchestrator.mjs`
- `packages/kratt-orchestrator/test/orchestrator.test.mjs`

The next integration step is a reviewed local API adapter between this UI and the orchestrator, followed by source-specific read adapters. Credentials must remain server-side. External writes must remain request-bound, signed, scoped and fail-closed.

## Design principles

- Dark, high-contrast operations UI consistent with the Trinitywayve/AURA dark-grid visual language while keeping KRATT PRIME's product identity distinct.
- Information hierarchy prioritizes evidence quality and review decisions over raw activity counts.
- Unverified, contested, verified and approved are visually distinct states.
- The UI never describes a model suggestion as a verified fact.
- Responsive layout for desktop and mobile.
- No AURA root app files are modified by this console.
