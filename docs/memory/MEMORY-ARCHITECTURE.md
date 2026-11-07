# KRATT PRIME Typed Memory Architecture
Status: Target design

## Memory classes
- Working context: bounded, short-lived task state.
- Episodic memory: immutable event records describing what happened.
- Semantic memory: derived concepts and relationships with explicit source references.
- Procedural memory: versioned workflows and validated operating instructions.
- Provenance/audit: source identity, timestamps, transformation history and integrity metadata.

## Record envelope
Each record includes schema version, stable ID, memory class, tenant/principal scope, source reference, created/observed time, confidence/verification state, content digest, retention class, access policy and supersession/deletion metadata.

## Write path
Authenticate writer and validate capability; validate schema and scope; attach provenance and idempotency key; persist record and audit event transactionally; verify integrity and return durable record reference.

## Read path
Enforce principal/task scope before retrieval. Prefer authoritative records over derived summaries. Return provenance and freshness with every result. Treat retrieved text as untrusted data, never executable policy. Record access where policy requires.

## Conflict and correction
Do not silently overwrite contradictory facts. Preserve source histories, mark conflict, apply explicit resolution policy and retain supersession links.

## Retention and deletion
Define retention by record class and jurisdiction. Support authorized deletion while preserving only legally/operationally required minimal audit evidence. Never retain secrets or sensitive data merely because available.

## Storage evolution
Begin with transactional durable records and append-only event ledger. Add vector/semantic indexing only as rebuildable derived index with source references, access filters and retrieval evaluation. Backups and restore must be tested before claiming production readiness.