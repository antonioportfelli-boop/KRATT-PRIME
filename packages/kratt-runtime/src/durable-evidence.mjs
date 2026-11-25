import { createHash } from "node:crypto";
import { PrimeStore } from "../../kratt-core/src/prime-store.mjs";
import { EvidenceLedger } from "../../kratt-core/src/evidence-ledger.mjs";
import { createEvidenceCard } from "./evidence-kernel.mjs";
import { KrattRuntimeError } from "./errors.mjs";

export const DURABLE_EVIDENCE_SCHEMA = "kratt-durable-evidence/v1";
const RECORD_KEY = "evidence.card.v1";
const ID_KEY = eventId => `eck-${createHash("sha256").update(eventId).digest("hex")}`;

function normalizeCard(value) {
  if (!value || value.schemaVersion !== "kratt-eck-card/v1" ||
      typeof value.rootId !== "string" || typeof value.branchId !== "string" ||
      !value.evidence || typeof value.evidence !== "object") return null;
  const created = createEvidenceCard({ rootId: value.rootId, branchId: value.branchId, ...value.evidence });
  if (!created.ok || created.card.cardId !== value.cardId || created.card.contentDigest !== value.contentDigest) return null;
  return created.card;
}

function normalizeEnvelope(value) {
  if (!value || value.schemaVersion !== DURABLE_EVIDENCE_SCHEMA) return null;
  return normalizeCard(value.card);
}

/**
 * Durable single-process evidence projection over PrimeStore's fsync'd local journal.
 * No database migrations are performed in place; records carry a schema version and
 * future versions must be replayed into a new projection.
 */
export class DurableEvidenceRepository {
  #store;
  #ledger = new EvidenceLedger();
  #cards = new Map();
  #tail = Promise.resolve();
  #openPromise = null;

  constructor({ path, store } = {}) {
    if ((path === undefined) === (store === undefined)) throw new TypeError("STORE_PATH_OR_ADAPTER_REQUIRED");
    this.#store = store ?? new PrimeStore({ path });
    if (!this.#store || typeof this.#store.open !== "function" || typeof this.#store.readAll !== "function" ||
        typeof this.#store.put !== "function" || typeof this.#store.status !== "function" || typeof this.#store.verify !== "function") {
      throw new TypeError("PRIMESTORE_ADAPTER_INVALID");
    }
  }

  open() {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = (async () => {
      await this.#store.open();
      const entries = await this.#store.readAll();
      for (const entry of entries) {
        if (entry.key !== RECORD_KEY) continue;
        const card = normalizeEnvelope(entry.value);
        if (!card || entry.id !== ID_KEY(card.cardId)) throw new KrattRuntimeError("DURABLE_EVIDENCE_CORRUPT", "Evidence journal contains an invalid ECK record");
        const appended = this.#ledger.append(card.evidence);
        if (!appended.ok) throw new KrattRuntimeError("DURABLE_EVIDENCE_CORRUPT", "Evidence journal contains a duplicate or invalid event");
        this.#cards.set(card.cardId, card);
      }
      return this;
    })().catch(error => {
      this.#openPromise = null;
      this.#ledger = new EvidenceLedger();
      this.#cards = new Map();
      throw error;
    });
    return this.#openPromise;
  }

  append(input) {
    const operation = this.#tail.then(async () => {
      await this.open();
      const created = createEvidenceCard(input);
      if (!created.ok) return created;
      const card = created.card;
      const existing = this.#cards.get(card.cardId);
      if (existing) return existing.contentDigest === card.contentDigest
        ? Object.freeze({ ok: true, duplicate: true, card: structuredClone(existing) })
        : Object.freeze({ ok: false, reason: "EVIDENCE_IDEMPOTENCY_CONFLICT" });

      const envelope = { schemaVersion: DURABLE_EVIDENCE_SCHEMA, card };
      const persisted = await this.#store.put({ idempotencyKey: ID_KEY(card.cardId), key: RECORD_KEY, value: envelope });
      if (persisted?.ok !== true) return Object.freeze({ ok: false, reason: "EVIDENCE_PERSISTENCE_FAILED" });
      if (persisted.duplicate) {
        const entries = await this.#store.readAll();
        const previous = entries.find(entry => entry.id === ID_KEY(card.cardId));
        const normalized = normalizeEnvelope(previous?.value);
        if (!normalized || normalized.contentDigest !== card.contentDigest) return Object.freeze({ ok: false, reason: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
        const projected = this.#ledger.append(normalized.evidence);
        if (!projected.ok) return Object.freeze({ ok: false, reason: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
        this.#cards.set(normalized.cardId, normalized);
        return Object.freeze({ ok: true, duplicate: true, card: structuredClone(normalized) });
      }

      const appended = this.#ledger.append(card.evidence);
      if (!appended.ok) throw new KrattRuntimeError("EVIDENCE_PROJECTION_FAILED", "Persisted evidence could not be projected");
      this.#cards.set(card.cardId, card);
      return Object.freeze({ ok: true, duplicate: false, sequence: appended.entry.sequence,
        storageSequence: persisted.sequence, card: structuredClone(card) });
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async list({ afterSequence = 0, limit = 100 } = {}) {
    await this.#tail;
    await this.open();
    const journal = await this.#store.verify();
    if (journal?.ok !== true) return Object.freeze({ ok: false, reason: "JOURNAL_VERIFICATION_FAILED" });
    if (!Number.isInteger(afterSequence) || afterSequence < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return { ok: false, reason: "LEDGER_QUERY_INVALID" };
    }
    return Object.freeze({ ok: true, cards: Object.freeze([...this.#cards.values()].slice(afterSequence, afterSequence + limit).map(card => structuredClone(card))),
      count: this.#cards.size });
  }

  async verify() {
    await this.#tail;
    await this.open();
    const ledger = this.#ledger.verify();
    const journal = await this.#store.verify();
    const store = await this.#store.status();
    return Object.freeze({ ok: ledger.ok && journal.ok, schemaVersion: DURABLE_EVIDENCE_SCHEMA,
      eventCount: ledger.count, evidenceHeadHash: ledger.headHash,
      journalEntries: journal.count, journalHeadHash: journal.headHash,
      encrypted: store.encrypted === true, remoteSync: store.remoteSync === true,
      scope: "SINGLE_PROCESS_LOCAL_JOURNAL" });
  }
}
