# FRAME.9 ↔ KRATT PRIME — Conformance Audit

Date: 2026-11-27  
Repository: \`antonioportfelli-boop/FRAME.9\`  
Scope: main and relevant development/factory branches, read-only

## Existing FRAME.9 surface

The inspected project describes a Node.js 22 / React 19 application with signal modules, local adapters and observation-oriented data structures. The main branch includes frame/signal models and a browser-side store. Synthetic/demo data is explicitly labelled.

A declared source type such as live Wi-Fi, BLE, RTT, VPN or host telemetry is not evidence that a physical sensor or collector is connected, permissioned, or exercised. The inspected Android collector is an interface/contract slice, not proof of a functioning physical-device collector. The inspected SQL schema is a proposal and not proof of an applied live migration or row-level security configuration.

The observation model includes identifiers/session, wall-clock and monotonic time, source/collector identity, protocol/subject, attributes, privacy class and confidence. Those fields do not themselves establish KRATT authorization or trusted evidence provenance.

## Required normalized event

A versioned adapter should carry:

- observation/event identity;
- correlation ID propagated from the initiating task/trace;
- wall-clock observation time and monotonic time where available;
- source and collector identity;
- privacy class enforced before export;
- confidence as descriptive metadata only;
- optional KRATT task/capability identity;
- explicit verification state.

An observation is not trusted evidence. Before policy use it must pass the KRATT evidence verifier and bind to the required subject, claim, revision, source and request.

## Safe integration boundary

FRAME.9 source/UI → typed Observation → privacy/provenance adapter → KRATT event intake → evidence verification / governed task → authorized action.

FRAME.9 UI may request a task and display its status. It must not call an external write provider directly or duplicate the KRATT authorization runtime. Signal scores, confidence and source labels never grant authority.

Correlation should be carried through a transport/trace wrapper or a separately versioned schema change, not silently inserted into a closed contract.

## Required conformance tests

1. Synthetic and physical-source states explicitly distinguished.
2. Missing permission/capability produces an unavailable/error state, not fabricated live data.
3. Observation IDs and wall-clock/monotonic fields validated.
4. Unknown sources and unexpected fields rejected.
5. Privacy class enforced before export.
6. Confidence and signal score never grant authorization.
7. Provenance, signature and request binding required before evidence is trusted.
8. KRATT cancellation/status propagated to the UI.
9. Duplicate event delivery is idempotent.
10. No UI/adapter bypasses the KRATT write gate.

## Disposition

Read-only audit. No FRAME.9 source, branch or database migration change is claimed. Next step is a small KRATT-side versioned observation adapter and conformance fixture, followed by a separately authorized FRAME.9 feature-branch change if required.
