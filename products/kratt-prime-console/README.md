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
- Intake dialog that records local source metadata and can structurally segment pasted text into provenance-linked, unreviewed knowledge units.
- Local API journal event for each segmentation batch.

## Important boundary

The UI is a **local development console**, not a production console. Its initial records are synthetic. When started with the Node local server, it calls the same-origin loopback API and can record bounded intake metadata in the local orchestration kernel. It does not call Telegram, GitHub, Slack, RSS or other external services. It stores no credentials and cannot perform external writes.

The local API and orchestration kernel are implemented in:

- `packages/kratt-orchestrator/src/local-server.mjs`
- `packages/kratt-orchestrator/src/orchestrator.mjs`
- `packages/kratt-orchestrator/test/`
- `packages/kratt-core/src/knowledge-segmentation.mjs`

The next integration step is to add individually reviewed source-specific read adapters with real identity verification, source provenance, retention controls and permission scopes. Credentials must remain server-side. External writes must remain request-bound, signed, scoped, expiring and fail-closed.

## Design principles

- Dark, high-contrast operations UI consistent with the Trinitywayve/AURA dark-grid visual language while keeping KRATT PRIME's product identity distinct.
- Information hierarchy prioritizes evidence quality and review decisions over raw activity counts.
- Unverified, contested, verified and approved are visually distinct states.
- The UI never describes a model suggestion as a verified fact.
- Responsive layout for desktop and mobile.
- No AURA root app files are modified by this console.
