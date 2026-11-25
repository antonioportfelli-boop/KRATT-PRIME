# Durable Evidence Projection v1

**Status:** local reference adapter; single process only.  
**Baseline:** `feature/kernel-first-evidence-runtime-v1`.  
**Storage:** existing PrimeStore append-only, fsync'd, hash-chained local journal.

## Write and recovery path

1. Validate an ECK card using the existing evidence schema and sensitive-data checks.
2. Derive a bounded idempotency key from the evidence event ID.
3. Append the complete card to the `evidence.card.v1` PrimeStore stream and fsync it.
4. Update the in-memory `EvidenceLedger` projection only after the durable append succeeds.
5. On open, verify the PrimeStore journal chain, validate every stored card and rebuild the evidence projection. Corruption or duplicate events fail startup closed.

Repeated IDs with identical content return an idempotent result. Reusing an ID for different content returns `EVIDENCE_IDEMPOTENCY_CONFLICT`. The adapter does not repair or truncate a corrupt journal.

## Schema and migrations

Each stored value declares `kratt-durable-evidence/v1`; the nested ECK card and evidence event keep their own schema versions. The journal is append-only. Future schema changes must add a new reader/projection version and replay into a separate journal or derived projection. Do not rewrite v1 records in place. A migration needs compatibility fixtures, interrupted-replay recovery, count/hash reconciliation, backup/restore checks and explicit acceptance before a new version is adopted.

## Boundaries

- Local filesystem only; no network calls, external transfer, or cloud sync.
- No encryption claim. File permissions are delegated to PrimeStore and the operating system.
- No cross-process locking or distributed transaction guarantee; run one writer process per journal path.
- Hash chaining detects accidental or uncoordinated edits but does not provide signatures or protection against an attacker who can rewrite the whole journal.
- The core `EvidenceLedger` is still an in-memory projection. This wrapper does not alter its public contract.
