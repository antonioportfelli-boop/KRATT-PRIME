/**
 * KRATT PRIME — typed adapter registry v1.
 * Registry and policy planning only. No provider calls or credential resolution.
 */
export const ADAPTER_SCHEMA_VERSION = "kratt-adapter/v1";
export const ADAPTER_STATES = Object.freeze([
  "DISCOVERED","CONNECTED_UNVERIFIED","VERIFIED_READ_ONLY",
  "WRITE_PENDING_APPROVAL","WRITE_ENABLED","DISABLED","ERROR"
]);
export const SIDE_EFFECTS = Object.freeze([
  "READ_ONLY","SENSITIVE_READ","LOCAL_WRITE","EXTERNAL_WRITE","PRIVILEGED","IRREVERSIBLE"
]);
export const SUPPORTED_PROVIDERS = Object.freeze([
  "github","slack","tinyfish","lovable","data","scispace",
  "base44","linear","canva","template-creator"
]);
const WRITES = new Set(["LOCAL_WRITE","EXTERNAL_WRITE","PRIVILEGED","IRREVERSIBLE"]);
const ID = /^[a-z][a-z0-9._:-]{1,95}$/;
const REF = /^cred:[A-Za-z0-9._:-]{1,128}$/;
const AUTH = /^authz:[A-Za-z0-9._:-]{1,128}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const exact = (v,required,optional=[]) => plain(v) &&
  Reflect.ownKeys(v).every(k => typeof k === "string" && [...required,...optional].includes(k) &&
    Object.getOwnPropertyDescriptor(v,k)?.get === undefined &&
    Object.getOwnPropertyDescriptor(v,k)?.set === undefined) &&
  required.every(k => Object.hasOwn(v,k));
const time = v => typeof v === "string" && TIME.test(v) && Number.isFinite(Date.parse(v));
const bad = reason => Object.freeze({ok:false,reason});
const frozen = value => {
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  if (plain(value)) {
    const out = Object.create(null);
    for (const [k,v] of Object.entries(value)) out[k] = frozen(v);
    return Object.freeze(out);
  }
  return value;
};
const stringList = (v,max=64) => Array.isArray(v) && v.length <= max &&
  v.every(x => typeof x === "string" && ID.test(x)) && new Set(v).size === v.length;

export function validateAdapterManifest(input) {
  const required = ["schemaVersion","adapterId","provider","version","state","capabilities",
    "allowedTargets","credentialRef","verifiedAt"];
  const optional = ["writeAuthorityRef","evidenceRefs"];
  if (!exact(input,required,optional)) return bad("ADAPTER_SHAPE_INVALID");
  if (input.schemaVersion !== ADAPTER_SCHEMA_VERSION) return bad("ADAPTER_SCHEMA_UNSUPPORTED");
  if (typeof input.adapterId !== "string" || !ID.test(input.adapterId)) return bad("ADAPTER_ID_INVALID");
  if (!SUPPORTED_PROVIDERS.includes(input.provider)) return bad("ADAPTER_PROVIDER_UNSUPPORTED");
  if (typeof input.version !== "string" || !/^\d+\.\d+\.\d+$/.test(input.version)) return bad("ADAPTER_VERSION_INVALID");
  if (!ADAPTER_STATES.includes(input.state)) return bad("ADAPTER_STATE_INVALID");
  if (input.credentialRef !== null && (typeof input.credentialRef !== "string" || !REF.test(input.credentialRef)))
    return bad("CREDENTIAL_REFERENCE_INVALID");
  if (input.verifiedAt !== null && !time(input.verifiedAt)) return bad("ADAPTER_VERIFICATION_TIME_INVALID");
  if (input.writeAuthorityRef !== undefined &&
      (typeof input.writeAuthorityRef !== "string" || !AUTH.test(input.writeAuthorityRef)))
    return bad("WRITE_AUTHORITY_REFERENCE_INVALID");
  if (input.evidenceRefs !== undefined &&
      (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 64 ||
       input.evidenceRefs.some(x => typeof x !== "string" || !/^evidence:[A-Za-z0-9._:-]{1,120}$/.test(x))))
    return bad("ADAPTER_EVIDENCE_REFS_INVALID");
  if (!Array.isArray(input.allowedTargets) || input.allowedTargets.length > 256)
    return bad("ADAPTER_TARGETS_INVALID");
  const targetSet = new Set();
  for (const target of input.allowedTargets) {
    if (!exact(target,["resourceType","resourceId"]) ||
        typeof target.resourceType !== "string" || !ID.test(target.resourceType) ||
        typeof target.resourceId !== "string" || target.resourceId.length < 1 ||
        target.resourceId.length > 256 || target.resourceId === "*")
      return bad("ADAPTER_TARGET_INVALID");
    const key = target.resourceType + "\u0000" + target.resourceId;
    if (targetSet.has(key)) return bad("ADAPTER_TARGET_DUPLICATE");
    targetSet.add(key);
  }
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 64)
    return bad("ADAPTER_CAPABILITIES_INVALID");
  const operations = new Set();
  for (const cap of input.capabilities) {
    if (!exact(cap,["operationId","sideEffect","requiredScopes","targetTypes","timeoutMs","idempotent","enabled"]))
      return bad("ADAPTER_CAPABILITY_SHAPE_INVALID");
    if (typeof cap.operationId !== "string" || !ID.test(cap.operationId) || operations.has(cap.operationId))
      return bad("ADAPTER_OPERATION_INVALID");
    operations.add(cap.operationId);
    if (!SIDE_EFFECTS.includes(cap.sideEffect)) return bad("ADAPTER_SIDE_EFFECT_INVALID");
    if (!stringList(cap.requiredScopes) || cap.requiredScopes.length === 0) return bad("ADAPTER_SCOPES_INVALID");
    if (!stringList(cap.targetTypes) || cap.targetTypes.length === 0) return bad("ADAPTER_TARGET_TYPES_INVALID");
    if (!Number.isInteger(cap.timeoutMs) || cap.timeoutMs < 100 || cap.timeoutMs > 30000)
      return bad("ADAPTER_TIMEOUT_INVALID");
    if (typeof cap.idempotent !== "boolean" || typeof cap.enabled !== "boolean")
      return bad("ADAPTER_CAPABILITY_FLAGS_INVALID");
    if (cap.enabled && WRITES.has(cap.sideEffect) && input.state !== "WRITE_ENABLED")
      return bad("WRITE_CAPABILITY_MUST_BE_DISABLED");
    if (cap.enabled && ["PRIVILEGED","IRREVERSIBLE"].includes(cap.sideEffect))
      return bad("HIGH_IMPACT_CAPABILITY_NOT_SUPPORTED");
  }
  if (input.state === "VERIFIED_READ_ONLY" &&
      (!time(input.verifiedAt) || input.capabilities.some(c => c.enabled && !["READ_ONLY","SENSITIVE_READ"].includes(c.sideEffect))))
    return bad("READ_ONLY_STATE_INCONSISTENT");
  if (input.state === "WRITE_ENABLED" &&
      (!input.writeAuthorityRef || !time(input.verifiedAt) ||
       !input.capabilities.some(c => c.enabled && ["LOCAL_WRITE","EXTERNAL_WRITE"].includes(c.sideEffect))))
    return bad("WRITE_ENABLEMENT_INCOMPLETE");
  return Object.freeze({ok:true,manifest:frozen(input)});
}

/**
 * approval must be produced by a server-owned verifier. Caller supplied fields
 * or model output alone can never create verificationState=VERIFIED.
 */
export function evaluateAdapterOperation(input = {}) {
  const manifestResult = validateAdapterManifest(input.manifest);
  if (!manifestResult.ok) return Object.freeze({decision:"BLOCKED",reason:manifestResult.reason,executionStarted:false});
  const manifest = manifestResult.manifest;
  const operationId = input.operationId;
  const target = input.target;
  if (typeof operationId !== "string" || !ID.test(operationId))
    return Object.freeze({decision:"DENY",reason:"OPERATION_ID_INVALID",executionStarted:false});
  const capability = manifest.capabilities.find(c => c.operationId === operationId && c.enabled);
  if (!capability) return Object.freeze({decision:"DENY",reason:"OPERATION_NOT_ENABLED",executionStarted:false});
  if (!exact(target,["resourceType","resourceId"]) ||
      !manifest.allowedTargets.some(t => t.resourceType === target.resourceType && t.resourceId === target.resourceId) ||
      !capability.targetTypes.includes(target.resourceType))
    return Object.freeze({decision:"DENY",reason:"TARGET_OUT_OF_SCOPE",executionStarted:false});
  const principal = input.principalScopes, agent = input.agentScopes, task = input.taskScopes;
  if (!stringList(principal) || !stringList(agent) || !stringList(task) || !time(input.now))
    return Object.freeze({decision:"BLOCKED",reason:"TRUSTED_CONTEXT_INVALID",executionStarted:false});
  const effective = new Set(principal.filter(scope => agent.includes(scope) && task.includes(scope)));
  if (capability.requiredScopes.some(scope => !effective.has(scope)))
    return Object.freeze({decision:"DENY",reason:"EFFECTIVE_SCOPE_INSUFFICIENT",executionStarted:false});
  if (["READ_ONLY","SENSITIVE_READ"].includes(capability.sideEffect)) {
    if (manifest.state !== "VERIFIED_READ_ONLY" && manifest.state !== "WRITE_ENABLED")
      return Object.freeze({decision:"BLOCKED",reason:"ADAPTER_NOT_VERIFIED",executionStarted:false});
    return Object.freeze({decision:"ALLOW",reason:"READ_SCOPE_VERIFIED",provider:manifest.provider,
      operationId,target:frozen(target),sideEffect:capability.sideEffect,timeoutMs:capability.timeoutMs,
      idempotent:capability.idempotent,executionStarted:false});
  }
  if (!["LOCAL_WRITE","EXTERNAL_WRITE"].includes(capability.sideEffect) || manifest.state !== "WRITE_ENABLED")
    return Object.freeze({decision:"BLOCKED",reason:"WRITE_NOT_ENABLED",executionStarted:false});
  const approval = input.approval;
  const validApproval = exact(approval,["verificationState","approvalId","provider","operationId","target","issuedAt","expiresAt","revoked"]) &&
    approval.verificationState === "VERIFIED" && typeof approval.approvalId === "string" &&
    approval.provider === manifest.provider && approval.operationId === operationId &&
    approval.revoked === false && exact(approval.target,["resourceType","resourceId"]) &&
    approval.target.resourceType === target.resourceType && approval.target.resourceId === target.resourceId &&
    time(approval.issuedAt) && time(approval.expiresAt) &&
    Date.parse(approval.issuedAt) <= Date.parse(input.now) && Date.parse(approval.expiresAt) > Date.parse(input.now);
  if (!validApproval) return Object.freeze({decision:"BLOCKED",reason:"EXACT_VERIFIED_APPROVAL_REQUIRED",executionStarted:false});
  return Object.freeze({decision:"ALLOW",reason:"EXACT_APPROVAL_VERIFIED",provider:manifest.provider,
    operationId,target:frozen(target),sideEffect:capability.sideEffect,timeoutMs:capability.timeoutMs,
    idempotent:capability.idempotent,approvalId:approval.approvalId,executionStarted:false});
}

export class AdapterRegistry {
  #items = new Map();
  register(input) {
    const checked = validateAdapterManifest(input);
    if (!checked.ok) return checked;
    if (this.#items.has(checked.manifest.adapterId)) return bad("ADAPTER_ALREADY_REGISTERED");
    this.#items.set(checked.manifest.adapterId,checked.manifest);
    return Object.freeze({ok:true,adapterId:checked.manifest.adapterId});
  }
  get(id) { return this.#items.get(id) ?? null; }
  list() {
    return Object.freeze([...this.#items.values()].map(m => Object.freeze({
      adapterId:m.adapterId,provider:m.provider,version:m.version,state:m.state,
      enabledOperations:Object.freeze(m.capabilities.filter(c=>c.enabled).map(c=>c.operationId)),
      writeEnabled:m.state === "WRITE_ENABLED"
    })));
  }
}
