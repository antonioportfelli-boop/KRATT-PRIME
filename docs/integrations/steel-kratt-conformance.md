# STEEL ↔ KRATT PRIME — Conformance Audit

Date: 2026-11-27  
Repository: \`3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP-\`  
Audited branch: \`feat/kratt-dual-ai-wave444\`  
Audited revision: \`ad7b347d4c7f89140acd1c20137aecbe60fbc141\`

## Existing STEEL contract

Inspected files:

- \`factory/protocol/types.ts\`
- \`factory/protocol/spec.ts\`
- \`factory/protocol/protocol.schema.json\`
- \`factory/tests/protocol.test.ts\`

The protocol uses JSON Schema 2020-12 generated from a declarative TypeScript schema DSL. Validation is closed-object oriented and checks exact own data properties, rejects unexpected fields/accessors/prototype tricks, and enforces task/agent/factory, forbidden-action, scope, resource-budget, receipt and timestamp semantics. The generated schema is not a second source of truth.

## Semantic mapping

| KRATT | STEEL | Compatibility |
|---|---|---|
| Task Envelope | TaskEnvelope | same broad purpose, different structure |
| individual Evidence Record | EvidenceBundle | not one-to-one; STEEL aggregates evidence digests/provenance |
| execution outcome | ActionReceipt | related receipt, different schema/authority |
| correlation ID | task/action identity/provenance | requires transport trace context |
| policy authorization | allowed/forbidden actions and verification state | not a substitute for KRATT WP-01 |

STEEL TaskEnvelope includes factory, agent, objective, repository, branch, base SHA, scope, allowed/forbidden actions, required evidence, resource budget, and protocol version. KRATT task contracts use actor/action/target/constraints/required evidence/requested authority and their own lifecycle fields. Map by a deliberate adapter, not by field renaming.

ActionReceipt is not a KRATT authorization receipt. EvidenceBundle is an aggregate and must not be silently converted to independently verified evidence records.

## Required bridge

1. Validate with STEEL's authoritative generated-schema/DSL validator.
2. Reject extra fields, accessors and malformed nested data exactly as STEEL does.
3. Bind repository, branch, base SHA and path scope to the KRATT task.
4. Reject forbidden-action overlap; treat resource budgets as hard ceilings.
5. Map evidence digests to actual KRATT evidence records and run the trusted verifier.
6. Carry correlation/trace context outside the closed v1 TaskEnvelope, or version the STEEL contract itself.
7. Require KRATT request-bound authorization for every external write.
8. Emit ActionReceipt only after verified and durably recorded outcome.
9. Preserve cancellation, idempotency, timeout, retry and failure semantics.

## Required tests

- both validators accept the intended mapping;
- additional properties, accessors, symbols, prototype tricks and malformed values rejected;
- wrong repository, branch, base SHA and path rejected;
- forbidden action and budget overflow rejected;
- evidence digest/source mismatch rejected;
- duplicate task/idempotency replay deterministic;
- cancellation before/during execution propagated;
- no STEEL UI, factory dispatcher or receipt path bypasses KRATT authorization.

## Disposition

Read-only conformance audit only. No STEEL schema, branch, or main change is claimed in Wave 4.1. Next step is a small KRATT-side adapter and cross-validator suite after the write path and permissions are explicitly verified. Do not duplicate the generated schema.
