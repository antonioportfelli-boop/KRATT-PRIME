import test from "node:test";
import assert from "node:assert/strict";
import { segmentKnowledge } from "../src/knowledge-segmentation.mjs";

const base = {
  sourceId:"source-001",
  sourceUrl:"https://example.test/report",
  observedAt:"2026-11-10T12:00:00.000Z",
};

test("knowledge segmentation preserves source offsets and exact text", () => {
  const content = "First statement. Second statement.\n\nThird paragraph with a separate fact.";
  const result = segmentKnowledge({ ...base, content, maxSegmentChars:120 });
  assert.equal(result.segmentCount, 2);
  for (const segment of result.segments) {
    assert.equal(content.slice(segment.startOffset, segment.endOffset), segment.text);
    assert.equal(segment.reviewState, "UNREVIEWED");
    assert.deepEqual(segment.claims, []);
  }
  assert.equal(result.segments[0].kind, "PARAGRAPH");
  assert.equal(result.segments[1].kind, "PARAGRAPH");
});

test("segment IDs and source digest are deterministic", () => {
  const input = { ...base, content:"Alpha. Beta. Gamma." };
  const first = segmentKnowledge(input);
  const second = segmentKnowledge(input);
  assert.equal(first.sourceDigest, second.sourceDigest);
  assert.deepEqual(first.segments.map(x => x.segmentId), second.segments.map(x => x.segmentId));
  assert.deepEqual(first.segments.map(x => x.contentDigest), second.segments.map(x => x.contentDigest));
});

test("oversized paragraphs are grouped at sentence boundaries", () => {
  const content = Array.from({ length:30 }, (_, index) => `Sentence number ${index + 1} describes a sample event.`).join(" ");
  const result = segmentKnowledge({ ...base, content, maxSegmentChars:120 });
  assert.ok(result.segmentCount > 1);
  assert.ok(result.segments.every(segment => segment.text.length <= 120));
  for (const segment of result.segments) {
    assert.equal(content.slice(segment.startOffset, segment.endOffset), segment.text);
  }
});

test("a long unbroken token is split into bounded fragments without offset drift", () => {
  const content = "X".repeat(301);
  const result = segmentKnowledge({ ...base, content, maxSegmentChars:120 });
  assert.equal(result.segmentCount, 3);
  assert.deepEqual(result.segments.map(x => x.text.length), [120,120,61]);
  let previousEnd = 0;
  for (const segment of result.segments) {
    assert.equal(segment.startOffset, previousEnd);
    assert.equal(content.slice(segment.startOffset, segment.endOffset), segment.text);
    previousEnd = segment.endOffset;
  }
});

test("Unicode sentence segmentation retains correct UTF-16 offsets", () => {
  const content = "KRATT tuvastab signaali. Tõend jääb kontrollimata.\n\n情報を確認します。証拠は未検証です。";
  const result = segmentKnowledge({ ...base, content, locale:"et", maxSegmentChars:120 });
  assert.ok(result.segmentCount >= 2);
  for (const segment of result.segments) {
    assert.equal(content.slice(segment.startOffset, segment.endOffset), segment.text);
  }
});

test("invalid source metadata, content and segment bounds are rejected", () => {
  assert.throws(() => segmentKnowledge({ ...base, sourceId:"", content:"text" }), /SEGMENT_SOURCE_ID_INVALID/);
  assert.throws(() => segmentKnowledge({ ...base, content:"  " }), /SEGMENT_CONTENT_INVALID/);
  assert.throws(() => segmentKnowledge({ ...base, content:"text", maxSegmentChars:40 }), /SEGMENT_SIZE_INVALID/);
  assert.throws(() => segmentKnowledge({ ...base, content:"text", observedAt:"yesterday" }), /SEGMENT_OBSERVED_AT_INVALID/);
});
