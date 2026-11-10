import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { attachEvidenceCardDigest } from "../src/evidence-integrity.mjs";
import { createTelegramClaimProjectionService } from "../src/telegram-claim-projection.mjs";

const digest = value => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;

function fixture({ tamperSource = false, tamperExcerpt = false, tamperClaim = false } = {}) {
  const content = "The source reports that the prototype passed 14 validation tests. A later section lists two unresolved limitations.";
  const startOffset = content.indexOf("The source");
  const endOffset = content.indexOf(".") + 1;
  const exactExcerpt = content.slice(startOffset, endOffset);
  const sourceDigest = digest(content);
  const excerptDigest = digest(exactExcerpt);
  let claim = attachEvidenceCardDigest({
    claimId: "claim-projection-01",
    normalizedText: "The prototype passed 14 validation tests.",
    claimStatus: "UNREVIEWED",
    sourceRefs: [{
      sourceId: "source-01",
      sourceDigest: tamperSource ? digest("wrong source") : sourceDigest,
      startOffset,
      endOffset,
      excerptDigest: tamperExcerpt ? digest("wrong excerpt") : excerptDigest,
    }],
  });
  if (tamperClaim) claim = { ...claim, normalizedText: "tampered after digest" };
  const link = attachEvidenceCardDigest({
    claimId: "claim-projection-01",
    evidenceId: "evidence-01",
    relation: "SUPPORTS",
    rationale: "The excerpt directly supports the proposition.",
  });
  const artifact = attachEvidenceCardDigest({
    evidenceId: "evidence-01",
    sourceId: "source-01",
    excerpt: exactExcerpt,
    sourceLineageId: "lineage-01",
    independenceGroupId: "group-01",
  });
  const service = createTelegramClaimProjectionService({
    claimRepository: { async getById() { return claim; } },
    evidenceRepository: {
      async listLinksForClaim() { return [link]; },
      async getArtifact() { return artifact; },
    },
    sourceRepository: {
      async getById() {
        return {
          sourceId: "source-01",
          publisher: "Example Publisher",
          title: "Validation Report",
          canonicalUrl: "https://example.test/report",
          content,
          capturedAt: "2026-11-10T11:00:00.000Z",
          observedAt: "2026-11-10T11:01:00.000Z",
        };
      },
    },
    rootProvider: {
      async getSnapshot() { return { rootVersion: 4, rootDigest: digest("root-snapshot") }; },
    },
  });
  return { service, exactExcerpt };
}

test("projection verifies claim/evidence digests and exact UTF-16 source excerpt provenance", async () => {
  const { service, exactExcerpt } = fixture();
  const projection = await service.get("claim-projection-01");
  assert.equal(projection.claimStatus, "UNREVIEWED");
  assert.equal(projection.sourceRefs[0].excerpt, exactExcerpt);
  assert.equal(projection.sourceRefs[0].startOffset, 0);
  assert.equal(projection.evidenceLinks[0].integrityStatus, "VALID");
  assert.equal(projection.truthVerdict, "NOT_ASSERTED");
  assert.equal(projection.readOnly, true);
  assert.match(projection.evidenceSnapshotDigest, /^sha256:[0-9a-f]{64}$/);
});

test("projection fails closed on changed source digest or excerpt digest", async () => {
  const sourceTamper = fixture({ tamperSource: true });
  await assert.rejects(sourceTamper.service.get("claim-projection-01"), /SOURCE_DIGEST_OR_OFFSET_MISMATCH/);
  const excerptTamper = fixture({ tamperExcerpt: true });
  await assert.rejects(excerptTamper.service.get("claim-projection-01"), /EXCERPT_DIGEST_MISMATCH/);
});

test("projection fails closed when claim card digest no longer matches", async () => {
  const { service } = fixture({ tamperClaim: true });
  await assert.rejects(service.get("claim-projection-01"), /CLAIM_DIGEST_INVALID/);
});

test("projection requires all read-only repositories and a valid root snapshot", () => {
  assert.throws(() => createTelegramClaimProjectionService({}), /TELEGRAM_PROJECTION_READ_ADAPTERS_REQUIRED/);
  const { service } = fixture();
  assert.equal(typeof service.get, "function");
});
