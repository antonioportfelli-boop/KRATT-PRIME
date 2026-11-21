# KRATT PRIME — Wave Control Desk

A standalone, read-only control-plane view for the Wave 1–10 inventory and Runtime Observatory.

## Product boundary

- This is a KRATT PRIME control-plane surface.
- AURA remains the separate lab visualizer; do not move this page into AURA's root application.
- The wave inventory is imported from \`packages/kratt-core/src/wave-progression.mjs\`.
- The Observatory panel calls same-origin \`GET\` routes only. It never creates operations, configures webhooks, dispatches providers or changes system state.

## Preview

Use the repository's Node 22 Vite dev server from the repository root:

\`\`\`sh
npm run dev -- --host 127.0.0.1
\`\`\`

Open:

\`\`\`text
/programs/web/kratt-control-desk/
\`\`\`

No additional package or build dependency is required. The root production build remains the AURA application; this isolated prototype is not added to its deployment bundle.

## Protected API

The dashboard expects a same-origin reverse-proxy or host mount for:

- \`GET /observatory/integrity\`
- \`GET /observatory/modules\`
- \`GET /observatory/operations?limit=20\`

The host must inject a real server-side \`authorizeRead\` policy before exposing the routes. The page uses same-origin credentials only and does not accept API keys or arbitrary endpoint URLs.

State behavior:

- \`200\` with a verified integrity result: show the protected read as verified.
- \`403\`: show denied; do not retry with elevated access.
- \`404\`: show unbound; no live data is assumed.
- \`503\`, timeout or malformed response: show degraded.

The UI displays operation identifiers, module IDs, status and timestamps only. It does not render raw request bodies, Telegram messages, secrets, exception text or hash-chain internals.

## Visual and accessibility contract

The page follows the Industrial Night specification: matte graphite surfaces, cyan active state, amber pending/degraded state, red critical/denied state, readable sans-serif body text and monospaced telemetry. Cards remain equal-weight and responsive. Every status has a text label; all controls are native keyboard-operable buttons; reduced-motion preferences are honored.
