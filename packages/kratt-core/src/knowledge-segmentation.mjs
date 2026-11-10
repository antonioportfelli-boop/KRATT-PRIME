import { createHash } from "node:crypto";

const SEGMENT_SCHEMA = "kratt-segment/v1";
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function trimBounds(text, start, end) {
  while (start < end && /\s/u.test(text[start])) start += 1;
  while (end > start && /\s/u.test(text[end - 1])) end -= 1;
  return { start, end, text: text.slice(start, end) };
}

function paragraphRanges(content) {
  const ranges = [];
  const matcher = /\S[\s\S]*?(?=\r?\n[\t ]*\r?\n|$)/gu;
  for (const match of content.matchAll(matcher)) {
    const start = match.index ?? 0;
    const trimmed = trimBounds(content, start, start + match[0].length);
    if (trimmed.text) ranges.push(trimmed);
  }
  return ranges;
}

function sentenceRanges(text, baseOffset, locale) {
  let units;
  try {
    const segmenter = new Intl.Segmenter(locale || "und", { granularity: "sentence" });
    units = [...segmenter.segment(text)].map(item => ({
      start: baseOffset + item.index,
      end: baseOffset + item.index + item.segment.length,
    }));
  } catch {
    units = [];
    const matcher = /[^.!?。！？]+[.!?。！？]?/gu;
    for (const match of text.matchAll(matcher)) {
      units.push({ start: baseOffset + (match.index ?? 0), end: baseOffset + (match.index ?? 0) + match[0].length });
    }
  }
  return units.map(range => trimBounds(text, range.start - baseOffset, range.end - baseOffset))
    .filter(range => range.text)
    .map(range => ({ start: baseOffset + range.start, end: baseOffset + range.end }));
}

function splitOversized(text, start, maxChars) {
  const output = [];
  let cursor = start;
  const end = start + text.length;
  while (cursor < end) {
    let next = Math.min(cursor + maxChars, end);
    if (next < end) {
      const relative = next - start;
      const whitespace = text.lastIndexOf(" ", relative);
      const newline = text.lastIndexOf("\n", relative);
      const boundary = Math.max(whitespace, newline);
      if (boundary > relative * 0.55) next = start + boundary;
    }
    if (next <= cursor) next = Math.min(cursor + maxChars, end);
    const range = trimBounds(text, cursor - start, next - start);
    if (range.text) output.push({ start: start + range.start, end: start + range.end, kind: "FRAGMENT" });
    cursor = next;
    while (cursor < end && /\s/u.test(text[cursor - start])) cursor += 1;
  }
  return output;
}

/**
 * Deterministically divide bounded source text into provenance-preserving
 * knowledge segments. This is structural segmentation, not fact verification
 * or semantic claim extraction.
 */
export function segmentKnowledge({
  sourceId,
  sourceUrl = null,
  observedAt = new Date().toISOString(),
  content,
  locale = "und",
  maxSegmentChars = 1200,
} = {}) {
  if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) {
    throw new TypeError("SEGMENT_SOURCE_ID_INVALID");
  }
  if (typeof content !== "string" || !content.trim() || content.length > 500_000) {
    throw new TypeError("SEGMENT_CONTENT_INVALID");
  }
  if (!Number.isInteger(maxSegmentChars) || maxSegmentChars < 120 || maxSegmentChars > 4000) {
    throw new TypeError("SEGMENT_SIZE_INVALID");
  }
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) {
    throw new TypeError("SEGMENT_OBSERVED_AT_INVALID");
  }
  if (sourceUrl !== null && (typeof sourceUrl !== "string" || sourceUrl.length > 2048)) {
    throw new TypeError("SEGMENT_SOURCE_URL_INVALID");
  }

  const ranges = [];
  for (const paragraph of paragraphRanges(content)) {
    const paragraphText = content.slice(paragraph.start, paragraph.end);
    if (paragraphText.length <= maxSegmentChars) {
      ranges.push({ start: paragraph.start, end: paragraph.end, kind: "PARAGRAPH" });
      continue;
    }

    const sentences = sentenceRanges(paragraphText, paragraph.start, locale);
    if (!sentences.length) {
      ranges.push(...splitOversized(paragraphText, paragraph.start, maxSegmentChars));
      continue;
    }

    let groupStart = null;
    let groupEnd = null;
    for (const sentence of sentences) {
      const sentenceLength = sentence.end - sentence.start;
      if (sentenceLength > maxSegmentChars) {
        if (groupStart !== null) {
          ranges.push({ start: groupStart, end: groupEnd, kind: "SENTENCE_GROUP" });
          groupStart = null;
          groupEnd = null;
        }
        ranges.push(...splitOversized(content.slice(sentence.start, sentence.end), sentence.start, maxSegmentChars));
        continue;
      }
      if (groupStart === null) {
        groupStart = sentence.start;
        groupEnd = sentence.end;
      } else if (sentence.end - groupStart <= maxSegmentChars) {
        groupEnd = sentence.end;
      } else {
        ranges.push({ start: groupStart, end: groupEnd, kind: "SENTENCE_GROUP" });
        groupStart = sentence.start;
        groupEnd = sentence.end;
      }
    }
    if (groupStart !== null) ranges.push({ start: groupStart, end: groupEnd, kind: "SENTENCE_GROUP" });
  }

  const segments = ranges.map((range, index) => {
    const text = content.slice(range.start, range.end);
    const contentDigest = sha256(text);
    const segmentId = sha256(`${sourceId}\0${range.start}\0${range.end}\0${contentDigest}`);
    return Object.freeze({
      schemaVersion: SEGMENT_SCHEMA,
      segmentId,
      sourceId,
      sourceUrl,
      observedAt,
      ordinal: index + 1,
      startOffset: range.start,
      endOffset: range.end,
      kind: range.kind,
      text,
      contentDigest,
      reviewState: "UNREVIEWED",
      claims: Object.freeze([]),
    });
  });

  return Object.freeze({
    schemaVersion: SEGMENT_SCHEMA,
    sourceId,
    sourceUrl,
    observedAt,
    sourceDigest: sha256(content),
    segmentCount: segments.length,
    segments: Object.freeze(segments),
  });
}
