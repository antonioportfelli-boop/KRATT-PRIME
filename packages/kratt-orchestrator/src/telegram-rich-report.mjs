const MAX_MESSAGE_BYTES = 32_768;

function escapeMarkdown(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\_*\[\]()~`#+\-=|{}.!])/g, "\\$1");
}

function safeUrl(value) {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    return ["https:", "http:"].includes(parsed.protocol) ? parsed.toString().replaceAll("(", "%28").replaceAll(")", "%29") : null;
  } catch { return null; }
}

function excerpt(value, max = 700) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sourceBlock(source, index) {
  const publisher = escapeMarkdown(excerpt(source.publisher ?? source.sourceId ?? `Source ${index + 1}`, 128));
  const title = escapeMarkdown(excerpt(source.title ?? "", 200));
  const url = safeUrl(source.canonicalUrl ?? source.url);
  const heading = url ? `[${publisher}](${url})` : publisher;
  const quote = excerpt(source.excerpt ?? source.text);
  const digest = /^sha256:[0-9a-f]{64}$/.test(source.digest ?? "") ? source.digest : "not supplied";
  const times = [
    source.capturedAt ? `captured ${escapeMarkdown(source.capturedAt)}` : null,
    source.observedAt ? `observed ${escapeMarkdown(source.observedAt)}` : null,
    source.sourceLineageId ? `lineage ${escapeMarkdown(source.sourceLineageId)}` : null,
    source.independenceGroupId ? `independence group ${escapeMarkdown(source.independenceGroupId)}` : null,
  ].filter(Boolean).join(" · ");
  return [
    `**${index + 1}. ${heading}**`,
    title ? `_${title}_` : null,
    quote ? `> ${escapeMarkdown(quote)}` : "> No excerpt supplied.",
    times || null,
    `Digest: \`${digest}\``,
  ].filter(Boolean).join("\n");
}

/**
 * Render a source-grounded, non-verdict evidence report for Telegram Rich
 * Messages. Evidence integrity and claim assessment are stated separately.
 */
export function renderTelegramEvidenceReport({ projection, generatedAt } = {}) {
  if (!projection || typeof projection !== "object" ||
      typeof projection.claimId !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(projection.claimDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(projection.evidenceSnapshotDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(projection.rootDigest ?? "")) {
    throw new TypeError("TELEGRAM_EVIDENCE_REPORT_PROJECTION_INVALID");
  }
  const claim = escapeMarkdown(excerpt(projection.claimText ?? projection.proposition ?? projection.claimId, 4000));
  const status = escapeMarkdown(projection.claimStatus ?? "UNREVIEWED");
  const sources = (Array.isArray(projection.sourceRefs) ? projection.sourceRefs : []).slice(0, 12);
  const evidence = (Array.isArray(projection.evidenceLinks) ? projection.evidenceLinks : []).slice(0, 16);
  const contradictions = (Array.isArray(projection.contradictions) ? projection.contradictions : []).slice(0, 8);

  const support = evidence.filter(item => item.relation === "SUPPORTS");
  const oppose = evidence.filter(item => item.relation === "CONTRADICTS");
  const unknown = evidence.filter(item => !["SUPPORTS", "CONTRADICTS"].includes(item.relation));

  const parts = [
    "# KRATT PRIME — Evidence Review",
    `**Claim:** ${claim}`,
    `**Assessment state:** ${status}`,
    `**Generated:** ${escapeMarkdown(generatedAt ?? new Date().toISOString())}`,
    "",
    "## Evidence integrity",
    "Source integrity and claim truth are separate assessments. This report does not convert source presence into a truth verdict.",
    `- Claim digest: \`${projection.claimDigest}\``,
    `- Evidence snapshot: \`${projection.evidenceSnapshotDigest}\``,
    `- Root snapshot: \`${projection.rootDigest}\``,
    "",
    "## Source lineage",
    sources.length ? sources.map(sourceBlock).join("\n\n") : "No source references are attached.",
    "",
    "## Evidence relations",
    `- Supporting links: ${support.length}`,
    `- Contradicting links: ${oppose.length}`,
    `- Other / unclassified links: ${unknown.length}`,
    ...evidence.map((item, index) => {
      const relation = escapeMarkdown(item.relation ?? "UNCLASSIFIED");
      const id = escapeMarkdown(item.evidenceId ?? item.sourceId ?? `evidence-${index + 1}`);
      const detail = escapeMarkdown(excerpt(item.summary ?? item.excerpt ?? "", 240));
      return `- **${relation}** — ${id}${detail ? `: ${detail}` : ""}`;
    }),
    "",
    "## Contradiction candidates",
    contradictions.length ? contradictions.map((item, index) =>
      `${index + 1}. ${escapeMarkdown(excerpt(item.summary ?? item.description ?? item.candidateId, 400))}`
    ).join("\n") : "No contradiction candidates are currently attached.",
    "",
    "## Review boundary",
    "A Telegram widget action is a decision intent only. A final decision requires a separate request-bound Ed25519 signature and durable KRATT audit persistence.",
  ];
  const markdown = parts.join("\n");
  if (Buffer.byteLength(markdown, "utf8") > MAX_MESSAGE_BYTES) {
    throw new RangeError("TELEGRAM_EVIDENCE_REPORT_TOO_LARGE");
  }
  return Object.freeze({ markdown, bytes: Buffer.byteLength(markdown, "utf8") });
}

export function createTelegramEvidenceReporter({ botApiClient } = {}) {
  if (!botApiClient || typeof botApiClient.sendRichMessage !== "function") {
    throw new TypeError("TELEGRAM_RICH_MESSAGE_CLIENT_REQUIRED");
  }
  return Object.freeze({
    async send({ chatId, projection, generatedAt } = {}) {
      const report = renderTelegramEvidenceReport({ projection, generatedAt });
      const message = await botApiClient.sendRichMessage({
        chatId,
        markdown: report.markdown,
        protectContent: true,
      });
      return Object.freeze({
        status: "OK",
        reason: "TELEGRAM_EVIDENCE_REPORT_SENT",
        messageId: message?.message_id ?? null,
        bytes: report.bytes,
      });
    },
  });
}
