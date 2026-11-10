import { createHash } from "node:crypto";
import { verifyEvidenceCardDigest } from "./evidence-integrity.mjs";

const RELATIONS = new Set(["SUPPORTS","CONTRADICTS","CONTEXTUALIZES","DUPLICATES","DERIVED_FROM"]);
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stable(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(Object.is(value, -0) ? 0 : value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",") }]`;
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError("TELEGRAM_PROJECTION_NON_CANONICAL_VALUE");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string")) throw new TypeError("TELEGRAM_PROJECTION_SYMBOL_KEY");
  return `{${keys.sort().map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new TypeError("TELEGRAM_PROJECTION_ACCESSOR_REJECTED");
    return `${JSON.stringify(key)}:${stable(descriptor.value)}`;
  }).join(",")}}`;
}

function verifiedCard(record, label) {
  const result = verifyEvidenceCardDigest(record);
  if (!result.ok) throw new Error(`${label}_DIGEST_INVALID:${result.reason}`);
  return result.digest;
}

/**
 * Read-only projection builder. Repositories must be read-only adapters and
 * return immutable evidence cards carrying contentDigest. No truth promotion,
 * scoring, writes, or network fetches are performed here.
 */
export function createTelegramClaimProjectionService({
  claimRepository,
  evidenceRepository,
  sourceRepository,
  rootProvider,
  contradictionRepository,
} = {}) {
  if (!claimRepository || typeof claimRepository.getById !== "function" ||
      !evidenceRepository || typeof evidenceRepository.listLinksForClaim !== "function" ||
      typeof evidenceRepository.getArtifact !== "function" ||
      !sourceRepository || typeof sourceRepository.getById !== "function" ||
      !rootProvider || typeof rootProvider.getSnapshot !== "function") {
    throw new TypeError("TELEGRAM_PROJECTION_READ_ADAPTERS_REQUIRED");
  }
  if (contradictionRepository !== undefined &&
      (!contradictionRepository || typeof contradictionRepository.listForClaim !== "function")) {
    throw new TypeError("TELEGRAM_CONTRADICTION_READ_ADAPTER_INVALID");
  }

  return Object.freeze({
    async get(claimId) {
      if (typeof claimId !== "string" || claimId.length < 1 || claimId.length > 192) {
        throw new TypeError("TELEGRAM_PROJECTION_CLAIM_ID_INVALID");
      }
      const [claim, links, root] = await Promise.all([
        claimRepository.getById(claimId),
        evidenceRepository.listLinksForClaim(claimId),
        rootProvider.getSnapshot(),
      ]);
      if (!claim || claim.claimId !== claimId) throw new Error("TELEGRAM_PROJECTION_CLAIM_NOT_FOUND");
      const claimDigest = verifiedCard(claim, "CLAIM");
      if (!Array.isArray(claim.sourceRefs) || claim.sourceRefs.length === 0 || claim.sourceRefs.length > 32) {
        throw new Error("TELEGRAM_PROJECTION_SOURCE_REFS_REQUIRED");
      }
      if (!Array.isArray(links) || links.length > 64) throw new Error("TELEGRAM_PROJECTION_EVIDENCE_LINKS_INVALID");
      if (!root || !DIGEST.test(root.rootDigest ?? "") || !Number.isSafeInteger(root.rootVersion) || root.rootVersion < 0) {
        throw new Error("TELEGRAM_PROJECTION_ROOT_SNAPSHOT_INVALID");
      }

      const sourceRefs = [];
      const sourceDigests = [];
      for (const reference of claim.sourceRefs) {
        if (!reference || typeof reference.sourceId !== "string" ||
            !Number.isSafeInteger(reference.startOffset) || !Number.isSafeInteger(reference.endOffset) ||
            reference.startOffset < 0 || reference.endOffset <= reference.startOffset ||
            !DIGEST.test(reference.sourceDigest ?? "") || !DIGEST.test(reference.excerptDigest ?? "")) {
          throw new Error("TELEGRAM_PROJECTION_SOURCE_REFERENCE_INVALID");
        }
        const source = await sourceRepository.getById(reference.sourceId);
        if (!source || typeof source.content !== "string") throw new Error("TELEGRAM_PROJECTION_SOURCE_NOT_FOUND");
        const actualSourceDigest = sha256(source.content);
        if (actualSourceDigest !== reference.sourceDigest || reference.endOffset > source.content.length) {
          throw new Error("TELEGRAM_PROJECTION_SOURCE_DIGEST_OR_OFFSET_MISMATCH");
        }
        const exactExcerpt = source.content.slice(reference.startOffset, reference.endOffset);
        if (!exactExcerpt || sha256(exactExcerpt) !== reference.excerptDigest) {
          throw new Error("TELEGRAM_PROJECTION_EXCERPT_DIGEST_MISMATCH");
        }
        sourceDigests.push(actualSourceDigest);
        sourceRefs.push(Object.freeze({
          sourceId: reference.sourceId,
          publisher: source.publisher ?? "Unknown publisher",
          title: source.title ?? "",
          canonicalUrl: source.canonicalUrl ?? null,
          excerpt: exactExcerpt,
          digest: actualSourceDigest,
          excerptDigest: reference.excerptDigest,
          capturedAt: source.capturedAt ?? null,
          observedAt: source.observedAt ?? null,
          startOffset: reference.startOffset,
          endOffset: reference.endOffset,
        }));
      }

      const evidenceLinks = [];
      const evidenceDigests = [];
      for (const link of links) {
        if (!link || link.claimId !== claimId || !RELATIONS.has(link.relation) ||
            typeof link.evidenceId !== "string") throw new Error("TELEGRAM_PROJECTION_EVIDENCE_LINK_INVALID");
        const linkDigest = verifiedCard(link, "EVIDENCE_LINK");
        const artifact = await evidenceRepository.getArtifact(link.evidenceId);
        if (!artifact || artifact.evidenceId !== link.evidenceId) throw new Error("TELEGRAM_PROJECTION_EVIDENCE_ARTIFACT_MISSING");
        const artifactDigest = verifiedCard(artifact, "EVIDENCE_ARTIFACT");
        evidenceDigests.push(linkDigest, artifactDigest);
        evidenceLinks.push(Object.freeze({
          evidenceId: artifact.evidenceId,
          sourceId: artifact.sourceId,
          relation: link.relation,
          summary: link.rationale ?? artifact.summary ?? "",
          excerpt: artifact.excerpt ?? "",
          digest: artifactDigest,
          integrityStatus: "VALID",
          sourceLineageId: artifact.sourceLineageId ?? null,
          independenceGroupId: artifact.independenceGroupId ?? null,
        }));
      }

      const contradictions = contradictionRepository
        ? await contradictionRepository.listForClaim(claimId)
        : [];
      if (!Array.isArray(contradictions) || contradictions.length > 32) {
        throw new Error("TELEGRAM_PROJECTION_CONTRADICTIONS_INVALID");
      }
      const evidenceSnapshotDigest = sha256(stable({
        claimDigest,
        sourceDigests: sourceDigests.slice().sort(),
        evidenceDigests: evidenceDigests.slice().sort(),
        rootDigest: root.rootDigest,
        rootVersion: root.rootVersion,
      }));

      return Object.freeze({
        schemaVersion: "kratt-telegram-claim-projection/v1",
        claimId,
        claimText: claim.normalizedText ?? claim.claimText ?? "",
        claimStatus: claim.claimStatus ?? "UNREVIEWED",
        claimDigest,
        evidenceSnapshotDigest,
        rootDigest: root.rootDigest,
        rootVersion: root.rootVersion,
        sourceRefs: Object.freeze(sourceRefs),
        evidenceLinks: Object.freeze(evidenceLinks),
        contradictions: Object.freeze(contradictions.map(item => Object.freeze({
          candidateId: item.candidateId,
          summary: item.summary ?? item.description ?? "Unreviewed contradiction candidate",
          status: item.status ?? "UNREVIEWED",
        }))),
        truthVerdict: "NOT_ASSERTED",
        readOnly: true,
      });
    },
  });
}
