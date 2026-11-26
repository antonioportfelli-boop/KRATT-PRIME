import { createHash } from "node:crypto";
import { PrimeStore } from "../../kratt-core/src/prime-store.mjs";
import { EvidenceLedger } from "../../kratt-core/src/evidence-ledger.mjs";
import { createEvidenceCard } from "./evidence-kernel.mjs";
import { KrattRuntimeError } from "./errors.mjs";

export const DURABLE_EVIDENCE_SCHEMA = "kratt-durable-evidence/v1";
const RECORD_KEY = "evidence.card.v1";
const ID_KEY = eventId => "eck-" + createHash("sha256").update(eventId).digest("hex");
const JOURNAL_HASH = /^[a-f0-9]{64}$/;

function normalizeCard(value) {
  if (!value || value.schemaVersion !== "kratt-eck-card/v1" ||
      typeof value.rootId !== "string" || typeof value.branchId !== "string" ||
      !value.evidence || typeof value.evidence !== "object") return null;
  const created = createEvidenceCard({
    rootId: value.rootId,
    branchId: value.branchId,
    ...value.evidence
  });
  if (!created.ok || created.card.cardId !== value.cardId ||
      created.card.contentDigest !== value.contentDigest) return null;
  return created.card;
}

function normalizeEnvelope(value) {
  if (!value || value.schemaVersion !== DURABLE_EVIDENCE_SCHEMA) return null;
  return normalizeCard(value.card);
}

function journalSnapshotIsValid(snapshot) {
  return snapshot?.ok === true &&
    Number.isSafeInteger(snapshot.count) && snapshot.count >= 0 &&
    typeof snapshot.headHash === "string" && JOURNAL_HASH.test(snapshot.headHash);
}

/**
 * Durable Evidence Card projection over a PrimeStore-compatible append-only journal.
 *
 * The local default is fsync'd PrimeStore. An injected shared adapter (for example
 * PostgreSQL) is refreshed before reads and mutations so one runtime instance sees
 * ECK records appended by other instances. Projection state is rebuilt from one
 * stable journal snapshot; it is not treated as a trusted cache or trust decision.
 */
export class DurableEvidenceRepository {
  #store;
  #ledger = new EvidenceLedger();
  #cards = new Map();
  #tail = Promise.resolve();
  #openPromise = null;

  constructor({ path, store } = {}) {
    if ((path === undefined) === (store === undefined)) {
      throw new TypeError("STORE_PATH_OR_ADAPTER_REQUIRED");
    }
    this.#store = store ?? new PrimeStore({ path });
    if (!this.#store || typeof this.#store.open !== "function" ||
        typeof this.#store.readAll !== "function" || typeof this.#store.put !== "function" ||
        typeof this.#store.status !== "function" || typeof this.#store.verify !== "function") {
      throw new TypeError("PRIMESTORE_ADAPTER_INVALID");
    }
  }

  async #refreshProjection() {
    await this.#store.open();
    let unstableSnapshot = false;

    // A concurrent writer may append between verify/read/verify. Retry a bounded
    // number of times and fail closed rather than projecting a mixed journal view.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const before = await this.#store.verify();
      if (!journalSnapshotIsValid(before)) {
        throw new KrattRuntimeError(
          "DURABLE_EVIDENCE_JOURNAL_UNVERIFIED",
          "Evidence journal failed integrity verification"
        );
      }

      const entries = await this.#store.readAll();
      const after = await this.#store.verify();
      if (!Array.isArray(entries) || !journalSnapshotIsValid(after) ||
          entries.length !== before.count || entries.length !== after.count ||
          before.headHash !== after.headHash) {
        unstableSnapshot = true;
        continue;
      }

      const ledger = new EvidenceLedger();
      const cards = new Map();
      for (const entry of entries) {
        if (entry.key !== RECORD_KEY) continue;
        const card = normalizeEnvelope(entry.value);
        if (!card || entry.id !== ID_KEY(card.cardId) || cards.has(card.cardId)) {
          throw new KrattRuntimeError(
            "DURABLE_EVIDENCE_CORRUPT",
            "Evidence journal contains an invalid or duplicate ECK record"
          );
        }
        const appended = ledger.append(card.evidence);
        if (!appended.ok) {
          throw new KrattRuntimeError(
            "DURABLE_EVIDENCE_CORRUPT",
            "Evidence journal contains a duplicate or invalid event"
          );
        }
        cards.set(card.cardId, card);
      }

      const projected = ledger.verify();
      if (projected?.ok !== true || projected.count !== cards.size) {
        throw new KrattRuntimeError(
          "DURABLE_EVIDENCE_PROJECTION_INVALID",
          "Evidence projection does not match its verified journal records"
        );
      }

      // Replace the visible projection only after the entire snapshot has passed.
      this.#ledger = ledger;
      this.#cards = cards;
      return Object.freeze({
        eventCount: projected.count,
        evidenceHeadHash: projected.headHash,
        journalEntries: after.count,
        journalHeadHash: after.headHash
      });
    }

    throw new KrattRuntimeError(
      "DURABLE_EVIDENCE_SNAPSHOT_UNSTABLE",
      unstableSnapshot
        ? "Evidence journal changed repeatedly while a stable projection was being read"
        : "Evidence journal snapshot could not be established"
    );
  }

  open() {
    if (this.#openPromise) return this.#openPromise;
    this.#openPromise = (async () => {
      await this.#refreshProjection();
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

      // Refresh before checking the card ID: another process may already have
      // appended this same card or a conflicting card with the same identity.
      await this.#refreshProjection();
      const existing = this.#cards.get(card.cardId);
      if (existing) {
        return existing.contentDigest === card.contentDigest
          ? Object.freeze({ ok: true, duplicate: true, card: structuredClone(existing) })
          : Object.freeze({ ok: false, reason: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
      }

      const envelope = { schemaVersion: DURABLE_EVIDENCE_SCHEMA, card };
      const persisted = await this.#store.put({
        idempotencyKey: ID_KEY(card.cardId),
        key: RECORD_KEY,
        value: envelope
      });
      if (persisted?.ok !== true) {
        return Object.freeze({ ok: false, reason: "EVIDENCE_PERSISTENCE_FAILED" });
      }

      // Rebuild after persistence whether this call inserted or observed a
      // concurrent duplicate. This includes other writers' ECK records too.
      await this.#refreshProjection();
      const saved = this.#cards.get(card.cardId);
      if (!saved || saved.contentDigest !== card.contentDigest) {
        return Object.freeze({ ok: false, reason: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
      }
      const sequence = [...this.#cards.keys()].indexOf(card.cardId) + 1;
      return Object.freeze({
        ok: true,
        duplicate: persisted.duplicate === true,
        sequence,
        storageSequence: persisted.sequence ?? null,
        card: structuredClone(saved)
      });
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async list({ afterSequence = 0, limit = 100 } = {}) {
    await this.#tail;
    await this.open();
    if (!Number.isInteger(afterSequence) || afterSequence < 0 ||
        !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      return Object.freeze({ ok: false, reason: "LEDGER_QUERY_INVALID" });
    }
    try {
      const snapshot = await this.#refreshProjection();
      return Object.freeze({
        ok: true,
        cards: Object.freeze(
          [...this.#cards.values()]
            .slice(afterSequence, afterSequence + limit)
            .map(card => structuredClone(card))
        ),
        count: snapshot.eventCount,
        journalHeadHash: snapshot.journalHeadHash
      });
    } catch {
      return Object.freeze({ ok: false, reason: "JOURNAL_VERIFICATION_FAILED" });
    }
  }

  async verify() {
    await this.#tail;
    await this.open();
    try {
      const snapshot = await this.#refreshProjection();
      const store = await this.#store.status();
      const ledger = this.#ledger.verify();
      return Object.freeze({
        ok: ledger.ok && ledger.count === snapshot.eventCount,
        schemaVersion: DURABLE_EVIDENCE_SCHEMA,
        eventCount: snapshot.eventCount,
        evidenceHeadHash: snapshot.evidenceHeadHash,
        journalEntries: snapshot.journalEntries,
        journalHeadHash: snapshot.journalHeadHash,
        encrypted: typeof store.encrypted === "boolean" ? store.encrypted : null,
        remoteSync: typeof store.remoteSync === "boolean" ? store.remoteSync : null,
        scope: typeof store.scope === "string" ? store.scope : "SINGLE_PROCESS_LOCAL_JOURNAL"
      });
    } catch {
      return Object.freeze({
        ok: false,
        schemaVersion: DURABLE_EVIDENCE_SCHEMA,
        reason: "JOURNAL_VERIFICATION_FAILED",
        eventCount: this.#cards.size,
        dispatch: false
      });
    }
  }
}
