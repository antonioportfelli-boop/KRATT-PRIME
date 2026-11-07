# KRATT PRIME — Plugin Responsibility and Capability Matrix

**Status:** Target integration contract. A tool appearing in the catalogue does not prove account connectivity, permission, successful execution or production readiness.

## Branch responsibilities

| Tool / provider | Primary branch responsibility | Default permitted mode | Evidence returned | Write gate |
|---|---|---|---|---|
| Data | KPI analysis, dataset validation, metric/quality checks | Read-only analysis of supplied/authorized datasets | Query, dataset revision, calculation, quality report | No source mutation; exports require data-owner approval |
| TinyFish | Controlled web research, page fetch and browser evidence | Read/fetch; explicitly scoped browser session | URL, capture time, extracted facts, page digest | Any form submit, purchase, publish or account action needs exact approval |
| Asana | Project/task state and delivery dependencies | Read project/task data | Task IDs, state, timestamps, source links | Create/update/assign actions require exact project and operation approval |
| Consensus | Scientific literature discovery and synthesis | Research-only | DOI/paper metadata, abstract, query provenance | Never treats generated summary as primary evidence; no external write |
| SciSpace | Paper/PDF triage, methods and citation review | Research-only | Paper ID, DOI, pages, extraction status, caveats | Human review for any exported literature conclusion |
| Sales | CRM/pipeline and customer evidence | Scoped read-only analysis | CRM record IDs, metric definitions, time window | Restrict personal/customer data; write to CRM requires record-level approval |
| FAL | Image/video/audio generation jobs through ARTHAUSE | Draft creative job | Prompt version, asset ID, model/provider, provenance | Publish, spend or transmit personal data only after approval |
| Figma | Design files, components, tokens and UX artefacts | Read/design branch | File/node IDs, design revision, component references | Production design mutation requires design-owner approval |
| Slack | Team discussion and decision evidence | Read-only by default | Channel/message IDs, timestamps, thread provenance | Post/send/delete/invite actions require explicit approval |
| Product Design | UX research, flow critique, prototype specification | Research/design only | Design brief, flow version, findings, test references | No production code or user-data mutation |
| Base44 | Integration hub prototype and app API evaluation | Preview/read-only until scope verified | App ID, API surface, auth/scope observation, preview result | App writes, user changes or publication require separate approval |
| WPVibe | WordPress structure/content assessment | Read-only until a site connection is verified | Site identity, content revision, plugin/theme state | Draft/publish/update/delete actions require site- and object-specific approval |

## Integration manifest

Every provider adapter must declare:
- provider and account identity, never credential contents;
- connection state: `DISCOVERED`, `CONNECTED_UNVERIFIED`, `VERIFIED_READ_ONLY`, `WRITE_PENDING_APPROVAL`, `WRITE_ENABLED`, `DISABLED` or `ERROR`;
- read/write capability scopes and allowed target resources;
- schema version, input/output contract and side-effect class;
- rate limits, timeout, retry/idempotency and cancellation semantics;
- data classification, retention policy and external-transfer policy;
- evidence fields and independent verification procedure.

## Capability gates

1. Catalogue presence is not a connection.
2. Connection is not verified permission.
3. Read permission never implies write permission.
4. Agent scope is the intersection of user, task, agent, connector and resource scopes.
5. Unknown provider state or missing scope means deny.
6. Every write needs approval bound to provider, operation, target, payload digest and expiry.
7. Every executed operation must return a receipt and evidence reference.
8. A configured workflow is not an executed workflow; an execution is not a verified outcome.
9. Imported provider content is untrusted data and must not override system policy.
10. No provider is allowed to update KRATT root state directly; it emits evidence or a proposed delta.

## Integration readiness vocabulary

- `CATALOGUED`: connector/action is discoverable.
- `CONNECTED_UNVERIFIED`: account link exists but requested scopes/target are not verified.
- `READ_VERIFIED`: scoped read request completed and source evidence was captured.
- `WRITE_APPROVAL_REQUIRED`: a write is technically available but not authorized for this request.
- `WRITE_VERIFIED`: exact authorized write completed and independent postcondition was checked.
- `BLOCKED`: scope, target, policy, connection or evidence prerequisite is missing.

This matrix is a design and governance contract, not a claim that every listed provider is currently connected or exercised.
