export const KRATT_SCHEMA_VERSION = "kratt-prime/v0.1";
export const TASK_STATES = Object.freeze(["PENDING", "EVALUATED", "CANCELLED"]);
export const POLICY_DECISIONS = Object.freeze(["ALLOW", "DENY", "BLOCKED", "INSUFFICIENT_EVIDENCE"]);
export const EVIDENCE_RESULTS = Object.freeze(["VERIFIED", "REJECTED", "UNAVAILABLE"]);
export const EVIDENCE_CLAIMS = Object.freeze([
  "COMMIT_MERGED", "TESTS_PASSED", "BUILD_SUCCEEDED",
  "SECURITY_CONTROL_VERIFIED", "ARTIFACT_CREATED",
  "DEPLOYMENT_COMPLETED", "INTEGRATION_VERIFIED"
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_UTC = /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,3})?Z$/;

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys(value, required, optional = []) {
  if (!plainObject(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some(k => typeof k !== "string" || !allowed.has(k))) return false;
  if (required.some(k => !Object.hasOwn(value, k))) return false;
  return keys.every(k => {
    const d = Object.getOwnPropertyDescriptor(value, k);
    return d && "value" in d && !d.get && !d.set;
  });
}
const validId = v => typeof v === "string" && ID.test(v);
const validTime = v => typeof v === "string" && ISO_UTC.test(v) && Number.isFinite(Date.parse(v));
const validRevision = v => v === null || (typeof v === "string" && SHA.test(v));
const validScalar = v => v === null || typeof v === "boolean" ||
  (typeof v === "string" && v.length <= 512) ||
  (typeof v === "number" && Number.isFinite(v));

export function validateTaskEnvelope(input) {
  const keys = ["schema_version","task_id","actor","action","target","constraints","required_evidence","created_at","requested_authority","status"];
  if (!exactKeys(input, keys)) return { ok:false, errors:["TASK_SHAPE_INVALID"] };
  const errors = [];
  if (input.schema_version !== KRATT_SCHEMA_VERSION) errors.push("TASK_SCHEMA_UNSUPPORTED");
  if (!validId(input.task_id) || !validId(input.actor) || !validId(input.action)) errors.push("TASK_IDENTIFIER_INVALID");
  if (!exactKeys(input.target, ["resource_type","resource_id"]) ||
      !validId(input.target.resource_type) || typeof input.target.resource_id !== "string" ||
      input.target.resource_id.length < 1 || input.target.resource_id.length > 512) errors.push("TASK_TARGET_INVALID");
  if (!plainObject(input.constraints) || Object.keys(input.constraints).length > 32 ||
      Object.entries(input.constraints).some(([k,v]) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(k) || !validScalar(v))) errors.push("TASK_CONSTRAINTS_INVALID");
  if (!Array.isArray(input.required_evidence) || input.required_evidence.length > 32 ||
      input.required_evidence.some(e => !exactKeys(e,["claim_type","subject","required","revision"]) ||
        !EVIDENCE_CLAIMS.includes(e.claim_type) || !validId(e.subject) ||
        typeof e.required !== "boolean" || !validRevision(e.revision))) errors.push("TASK_EVIDENCE_REQUIREMENTS_INVALID");
  if (!validTime(input.created_at)) errors.push("TASK_TIMESTAMP_INVALID");
  if (!Array.isArray(input.requested_authority) || input.requested_authority.length > 16 ||
      input.requested_authority.some(v => typeof v !== "string" || v.length > 128)) errors.push("TASK_REQUESTED_AUTHORITY_INVALID");
  if (!TASK_STATES.includes(input.status)) errors.push("TASK_STATUS_INVALID");
  return errors.length ? {ok:false, errors} : {ok:true, value:Object.freeze(structuredClone(input))};
}

export function validateEvidenceRecord(input) {
  const keys = ["schema_version","evidence_id","subject","claim_type","source","observed_at","verification_method","result","artifact_digest","metadata"];
  if (!exactKeys(input, keys)) return {ok:false, errors:["EVIDENCE_SHAPE_INVALID"]};
  const errors = [];
  if (input.schema_version !== KRATT_SCHEMA_VERSION) errors.push("EVIDENCE_SCHEMA_UNSUPPORTED");
  if (!validId(input.evidence_id) || !validId(input.subject) || !EVIDENCE_CLAIMS.includes(input.claim_type)) errors.push("EVIDENCE_ID_OR_CLAIM_INVALID");
  if (!exactKeys(input.source,["source_type","source_id","revision"]) ||
      !validId(input.source.source_type) || !validId(input.source.source_id) || !validRevision(input.source.revision)) errors.push("EVIDENCE_SOURCE_INVALID");
  if (!validTime(input.observed_at) || !validId(input.verification_method)) errors.push("EVIDENCE_TIME_OR_METHOD_INVALID");
  if (!EVIDENCE_RESULTS.includes(input.result)) errors.push("EVIDENCE_RESULT_INVALID");
  if (input.artifact_digest !== null && (typeof input.artifact_digest !== "string" || !DIGEST.test(input.artifact_digest))) errors.push("EVIDENCE_DIGEST_INVALID");
  if (!plainObject(input.metadata) || Object.keys(input.metadata).length > 32 ||
      Object.entries(input.metadata).some(([k,v]) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(k) || !validScalar(v))) errors.push("EVIDENCE_METADATA_INVALID");
  return errors.length ? {ok:false, errors} : {ok:true, value:Object.freeze(structuredClone(input))};
}

export function validateTrustedContext(input) {
  const keys = ["schema_version","authorities","allowed_targets","policies","evaluated_at"];
  if (!exactKeys(input, keys)) return {ok:false, errors:["TRUSTED_CONTEXT_SHAPE_INVALID"]};
  const errors = [];
  if (input.schema_version !== KRATT_SCHEMA_VERSION) errors.push("TRUSTED_CONTEXT_SCHEMA_UNSUPPORTED");
  if (!Array.isArray(input.authorities) || input.authorities.length > 32 || input.authorities.some(x => !validId(x))) errors.push("TRUSTED_AUTHORITIES_INVALID");
  if (!Array.isArray(input.allowed_targets) || input.allowed_targets.length > 64 ||
      input.allowed_targets.some(t => !exactKeys(t,["resource_type","resource_id"]) || !validId(t.resource_type) || typeof t.resource_id !== "string" || !t.resource_id)) errors.push("TRUSTED_TARGETS_INVALID");
  const policyOptional = ["side_effect_class","allowed_branches","allowed_paths","max_context_age_ms"];
  if (input.policies !== null && (!Array.isArray(input.policies) || input.policies.length > 64 ||
      input.policies.some(p => !exactKeys(p,["action","required_authority","target_types"],policyOptional) ||
        !validId(p.action) || !validId(p.required_authority) || !Array.isArray(p.target_types) ||
        p.target_types.some(x => !validId(x)) ||
        (p.side_effect_class !== undefined && !["READ_ONLY","WRITE","IRREVERSIBLE"].includes(p.side_effect_class)) ||
        (p.allowed_branches !== undefined && (!Array.isArray(p.allowed_branches) || p.allowed_branches.some(x => typeof x !== "string" || !x || x.length > 255))) ||
        (p.allowed_paths !== undefined && (!Array.isArray(p.allowed_paths) || p.allowed_paths.some(x => typeof x !== "string" || !x || x.length > 512))) ||
        (p.max_context_age_ms !== undefined && (!Number.isSafeInteger(p.max_context_age_ms) || p.max_context_age_ms < 1 || p.max_context_age_ms > 300000))))) errors.push("TRUSTED_POLICIES_INVALID");
  if (!validTime(input.evaluated_at)) errors.push("TRUSTED_CONTEXT_TIME_INVALID");
  return errors.length ? {ok:false, errors} : {ok:true, value:structuredClone(input)};
}
