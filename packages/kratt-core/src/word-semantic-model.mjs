export const WORD_SEMANTIC_MODEL_VERSION = "2.1.0";
export const WORD_SEMANTIC_SCHEMA = "kratt-word-semantics/v2";
export const AMBIGUITY_CONFIDENCE_THRESHOLD = 0.8;

// A source occurrence is the root. Reflection is a derived operation, never origin.
export const SEMANTIC_LAYERS = Object.freeze([
  "FORM",
  "CONTENT",
  "SENSE",
  "PRINCIPLE",
  "INTENT",
  "SPEECH_ACT",
  "EFFECT",
  "POWER",
  "AUTHORITY"
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DIGEST = /^[a-f0-9]{64}$/i;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const bounded = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const refs = value => Array.isArray(value) && value.length <= 64
  && value.every(item => typeof item === "string" && ID.test(item))
  && new Set(value).size === value.length;
const fail = reason => Object.freeze({ ok: false, reason });
const validDateOrNull = value => value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
const confidence = value => Number.isFinite(value) && value >= 0 && value <= 1;

const TOP_LEVEL_KEYS = [
  "schema_version", "record_id", "source", "context_id", "created_at", "form",
  "contents", "senses", "principles", "intents", "speech_acts", "effects", "powers", "authorities"
];
const FORM_KEYS = ["token_id", "surface", "language", "normalization", "span"];
const SOURCE_KEYS = ["source_ref", "source_digest", "source_evidence_id"];
const CONTENT_KEYS = [
  "content_id", "content_type", "payload", "language", "domain", "referent_refs",
  "evidence_refs", "attribution", "confidence"
];
const LAYER_KEYS = {
  senses: ["sense_id", "content_refs", "definition", "language", "domain", "concept_ref", "confidence", "evidence_refs"],
  principles: ["principle_id", "statement", "norm_type", "jurisdiction", "valid_from", "valid_until", "source_refs"],
  intents: ["intent_id", "actor_ref", "goal", "audience_refs", "context_ref", "attribution_kind", "confidence", "evidence_refs"],
  speech_acts: ["act_id", "act_type", "speaker_ref", "addressee_refs", "content_refs", "evidence_refs", "felicity_conditions"],
  effects: ["effect_id", "effect_type", "target_refs", "direction", "magnitude", "evidence_refs", "measurement_refs", "causal_status"],
  powers: ["power_id", "power_type", "holder_ref", "target_refs", "mechanism", "scope", "evidence_refs"],
  authorities: ["authority_id", "authority_type", "issuer_ref", "subject_ref", "action_scope", "resource_scope", "jurisdiction", "valid_from", "valid_until", "evidence_refs", "status"]
};

function validInterval(start, end) {
  if (!validDateOrNull(start) || !validDateOrNull(end)) return false;
  return start === null || end === null || Date.parse(end) > Date.parse(start);
}

function uniqueNodeIds(record) {
  const ids = [record.form.token_id];
  for (const [layer, keys] of Object.entries(LAYER_KEYS)) {
    for (const row of record[layer]) ids.push(row[keys[0]]);
  }
  ids.push(...record.contents.map(row => row.content_id));
  return ids.every(id => ID.test(id)) && new Set(ids).size === ids.length;
}

export function validateWordSemanticRecord(record) {
  if (!exact(record, TOP_LEVEL_KEYS) || record.schema_version !== WORD_SEMANTIC_SCHEMA
      || !ID.test(record.record_id ?? "") || !exact(record.source, SOURCE_KEYS)
      || !bounded(record.source.source_ref, 1000) || !DIGEST.test(record.source.source_digest ?? "") || !ID.test(record.source.source_evidence_id ?? "")
      || !ID.test(record.context_id ?? "") || !Number.isFinite(Date.parse(record.created_at ?? ""))) {
    return fail("SOURCE_OCCURRENCE_INVALID");
  }

  if (!exact(record.form, FORM_KEYS) || !ID.test(record.form.token_id ?? "")
      || !bounded(record.form.surface, 256) || !bounded(record.form.language, 24)
      || !bounded(record.form.normalization, 64) || !exact(record.form.span, ["start", "end"])
      || !Number.isInteger(record.form.span.start) || !Number.isInteger(record.form.span.end)
      || record.form.span.start < 0 || record.form.span.end <= record.form.span.start) {
    return fail("WORD_FORM_INVALID");
  }

  if (!Array.isArray(record.contents) || record.contents.length > 64) return fail("CONTENT_INVALID");
  for (const content of record.contents) {
    if (!exact(content, CONTENT_KEYS) || !ID.test(content.content_id ?? "")
        || !["PROPOSITION", "TOPIC", "CONCEPT", "REFERENT", "QUOTED_TEXT", "NARRATIVE", "OTHER"].includes(content.content_type)
        || !bounded(content.payload, 4000) || !bounded(content.language, 24) || !bounded(content.domain, 128)
        || !refs(content.referent_refs) || !refs(content.evidence_refs)
        || !exact(content.attribution, ["kind", "actor_ref"])
        || !["SOURCE", "QUOTED", "REPORTED", "TRANSLATED", "INFERRED", "UNKNOWN"].includes(content.attribution.kind)
        || !(content.attribution.actor_ref === null || ID.test(content.attribution.actor_ref))
        || !confidence(content.confidence)) return fail("CONTENT_FIELDS_INVALID");
  }
  const contentIds = new Set(record.contents.map(item => item.content_id));

  for (const [layer, keys] of Object.entries(LAYER_KEYS)) {
    const rows = record[layer];
    if (!Array.isArray(rows) || rows.length > 64) return fail(layer.toUpperCase() + "_INVALID");
    for (const row of rows) {
      if (!exact(row, keys) || !ID.test(row[keys[0]] ?? "")) return fail(layer.toUpperCase() + "_SHAPE_INVALID");
    }
  }

  for (const sense of record.senses) {
    if (!refs(sense.content_refs) || sense.content_refs.length === 0
        || sense.content_refs.some(id => !contentIds.has(id))
        || !bounded(sense.definition, 2000) || !bounded(sense.language, 24)
        || !bounded(sense.domain, 128) || !(sense.concept_ref === null || ID.test(sense.concept_ref))
        || !confidence(sense.confidence) || !refs(sense.evidence_refs)) return fail("SENSE_FIELDS_INVALID");
  }
  for (const principle of record.principles) {
    if (!bounded(principle.statement, 3000)
        || !["LEGAL", "POLICY", "ETHICAL", "DOMAIN", "OPERATIONAL", "CUSTOM"].includes(principle.norm_type)
        || !(principle.jurisdiction === null || bounded(principle.jurisdiction, 128))
        || !refs(principle.source_refs) || !validInterval(principle.valid_from, principle.valid_until)) {
      return fail("PRINCIPLE_FIELDS_INVALID");
    }
  }
  for (const intent of record.intents) {
    if (!bounded(intent.actor_ref, 192) || !bounded(intent.goal, 1000)
        || !refs(intent.audience_refs) || !bounded(intent.context_ref, 192)
        || !["EXPLICIT", "INFERRED", "UNKNOWN"].includes(intent.attribution_kind)
        || !confidence(intent.confidence) || !refs(intent.evidence_refs)) return fail("INTENT_FIELDS_INVALID");
  }
  for (const act of record.speech_acts) {
    if (!["ASSERT", "REQUEST", "DIRECTIVE", "PROMISE", "WARNING", "DECLARATION", "QUESTION", "EXPRESSIVE", "OTHER"].includes(act.act_type)
        || !bounded(act.speaker_ref, 192) || !refs(act.addressee_refs) || !refs(act.content_refs) || !refs(act.evidence_refs)
        || act.content_refs.some(id => !contentIds.has(id)) || !plain(act.felicity_conditions)) {
      return fail("SPEECH_ACT_FIELDS_INVALID");
    }
  }
  for (const effect of record.effects) {
    if (!["BEHAVIORAL", "INFORMATIONAL", "ECONOMIC", "LEGAL", "SOCIAL", "TECHNICAL", "SAFETY", "OTHER"].includes(effect.effect_type)
        || !refs(effect.target_refs) || !["POSITIVE", "NEGATIVE", "MIXED", "UNKNOWN"].includes(effect.direction)
        || !(effect.magnitude === null || (Number.isFinite(effect.magnitude) && effect.magnitude >= 0))
        || !refs(effect.evidence_refs) || !refs(effect.measurement_refs)
        || !["ASSERTED", "OBSERVED", "CAUSALLY_SUPPORTED", "CAUSALLY_ESTABLISHED", "UNKNOWN"].includes(effect.causal_status)) {
      return fail("EFFECT_FIELDS_INVALID");
    }
  }
  for (const power of record.powers) {
    if (!["COERCIVE", "INSTITUTIONAL", "ECONOMIC", "EXPERT", "AGENDA_SETTING", "INFORMATIONAL", "NETWORK", "OTHER"].includes(power.power_type)
        || !bounded(power.holder_ref, 192) || !refs(power.target_refs)
        || !bounded(power.mechanism, 1000) || !bounded(power.scope, 1000)
        || !refs(power.evidence_refs)) return fail("POWER_FIELDS_INVALID");
  }
  for (const authority of record.authorities) {
    if (!["LEGAL", "CONTRACTUAL", "ORGANIZATIONAL", "DELEGATED", "TECHNICAL", "NONE", "UNKNOWN"].includes(authority.authority_type)
        || !bounded(authority.issuer_ref, 192) || !bounded(authority.subject_ref, 192)
        || !bounded(authority.action_scope, 1000) || !bounded(authority.resource_scope, 1000)
        || !(authority.jurisdiction === null || bounded(authority.jurisdiction, 128))
        || !validInterval(authority.valid_from, authority.valid_until) || !refs(authority.evidence_refs)
        || !["CANDIDATE", "VERIFIED", "REVOKED", "EXPIRED", "UNKNOWN"].includes(authority.status)) {
      return fail("AUTHORITY_FIELDS_INVALID");
    }
  }

  if (!uniqueNodeIds(record)) return fail("SEMANTIC_NODE_ID_COLLISION");
  return Object.freeze({ ok: true, value: Object.freeze(record) });
}

export function evaluateWordSemantics(record, {
  now = new Date().toISOString(),
  requiredLayers = ["CONTENT", "SENSE"]
} = {}) {
  const checked = validateWordSemanticRecord(record);
  if (!checked.ok) return checked;
  if (!Number.isFinite(Date.parse(now)) || !Array.isArray(requiredLayers)
      || requiredLayers.some(layer => !SEMANTIC_LAYERS.includes(layer))) return fail("EVALUATION_CONTEXT_INVALID");

  const time = Date.parse(now);
  const activeAuthorityCandidates = record.authorities.filter(authority => authority.status === "VERIFIED"
    && (authority.valid_from === null || Date.parse(authority.valid_from) <= time)
    && (authority.valid_until === null || Date.parse(authority.valid_until) > time));
  const layerCounts = Object.freeze({
    FORM: 1,
    CONTENT: record.contents.length,
    SENSE: record.senses.length,
    PRINCIPLE: record.principles.length,
    INTENT: record.intents.length,
    SPEECH_ACT: record.speech_acts.length,
    EFFECT: record.effects.length,
    POWER: record.powers.length,
    AUTHORITY: activeAuthorityCandidates.length
  });
  const missingLayers = requiredLayers.filter(layer => layer !== "FORM" && layerCounts[layer] === 0);
  const highConfidenceSensesByContent = new Map();
  for (const sense of record.senses) {
    if (sense.confidence < AMBIGUITY_CONFIDENCE_THRESHOLD) continue;
    for (const contentId of sense.content_refs) {
      const existing = highConfidenceSensesByContent.get(contentId) ?? [];
      existing.push(sense.sense_id);
      highConfidenceSensesByContent.set(contentId, existing);
    }
  }
  const ambiguousSenseIds = [...new Set(
    [...highConfidenceSensesByContent.values()]
      .filter(senseIds => senseIds.length > 1)
      .flat()
  )];
  const hasAmbiguousSenses = ambiguousSenseIds.length > 0;
  const revokedAuthorityConflict = record.authorities.some(authority => authority.status === "REVOKED" && authority.authority_type !== "NONE");
  const effectsWithoutCausalEstablishment = record.effects
    .filter(effect => !["CAUSALLY_SUPPORTED", "CAUSALLY_ESTABLISHED"].includes(effect.causal_status))
    .map(effect => effect.effect_id);

  const status = revokedAuthorityConflict ? "AUTHORITY_CONFLICT"
    : (missingLayers.length > 0 || hasAmbiguousSenses ? "SEMANTIC_REVIEW_REQUIRED" : "SEMANTICALLY_STRUCTURED");

  return Object.freeze({
    ok: true,
    status,
    schema_version: record.schema_version,
    record_id: record.record_id,
    token_id: record.form.token_id,
    surface: record.form.surface,
    evaluated_at: now,
    required_layers: Object.freeze([...requiredLayers]),
    layer_counts: layerCounts,
    missing_layers: Object.freeze(missingLayers),
    ambiguous_sense_ids: Object.freeze(ambiguousSenseIds),
    content_ids: Object.freeze(record.contents.map(content => content.content_id)),
    effects_without_causal_establishment: Object.freeze(effectsWithoutCausalEstablishment),
    authority_candidates: Object.freeze(activeAuthorityCandidates.map(authority => authority.authority_id)),
    authorization_granted: false,
    policy_authority: false,
    note: "CONTENT is the source-grounded payload; SENSE is its contextual interpretation. Principle, intent, speech act, effect, power and authority remain separate typed objects. Semantic evaluation never authorizes execution."
  });
}

export function createWordSemanticRecord({
  recordId, sourceRef, sourceDigest, sourceEvidenceId, contextId, form, createdAt,
  contents = [], senses = [], principles = [], intents = [], speechActs = [],
  effects = [], powers = [], authorities = []
} = {}) {
  return validateWordSemanticRecord({
    schema_version: WORD_SEMANTIC_SCHEMA,
    record_id: recordId,
    source: { source_ref: sourceRef, source_digest: sourceDigest, source_evidence_id: sourceEvidenceId },
    context_id: contextId,
    created_at: createdAt,
    form,
    contents,
    senses,
    principles,
    intents,
    speech_acts: speechActs,
    effects,
    powers,
    authorities
  });
}

// v1 records cannot be auto-migrated: content must be supplied from the original source,
// never reconstructed by copying a sense definition into the content layer.
export function validateV1MigrationReadiness(record) {
  if (!plain(record) || record.schema_version !== "kratt-word-semantics/v1") return fail("V1_RECORD_REQUIRED");
  return fail("EXPLICIT_CONTENT_REAUTHORING_REQUIRED");
}
