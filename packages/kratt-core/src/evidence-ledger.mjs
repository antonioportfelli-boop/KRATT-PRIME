/**
 * KRATT PRIME — append-only hash-chained evidence ledger v1.
 * Reference adapter for tests and local simulation only; not durable or signed.
 */
import { createHash } from "node:crypto";

export const EVIDENCE_LEDGER_SCHEMA = "kratt-evidence/v1";
const GENESIS = "0".repeat(64);
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const DECISIONS = new Set(["OBSERVED","INFERRED","CONFIGURED","EXECUTED","VERIFIED","BLOCKED"]);
const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|cookie|email|phone|private.?key)/i;
const SENSITIVE_VALUE = /(gh[pousr]_[A-Za-z0-9]{12,}|xai-[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{12,}|Bearer\s+\S+|[\w.+-]+@[\w-]+\.[\w.-]+)/i;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

function canonicalize(value,depth=0) {
  if(depth>12) throw new TypeError("CANONICAL_DEPTH_EXCEEDED");
  if(value===null || typeof value==="string" || typeof value==="boolean") {
    if(typeof value==="string" && SENSITIVE_VALUE.test(value)) throw new TypeError("SENSITIVE_VALUE");
    return value;
  }
  if(typeof value==="number") {
    if(!Number.isFinite(value)) throw new TypeError("NON_FINITE_NUMBER");
    return value;
  }
  if(Array.isArray(value)) {
    if(value.length>256) throw new TypeError("ARRAY_TOO_LARGE");
    return value.map(item=>canonicalize(item,depth+1));
  }
  if(!plain(value)) throw new TypeError("NON_JSON_VALUE");
  const keys=Object.keys(value).sort();
  if(keys.length>64) throw new TypeError("OBJECT_TOO_LARGE");
  const out=Object.create(null);
  for(const key of keys) {
    if(SENSITIVE_KEY.test(key)) throw new TypeError("SENSITIVE_KEY");
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set)
      throw new TypeError("ACCESSOR_PROPERTY_REJECTED");
    out[key]=canonicalize(descriptor.value,depth+1);
  }
  return out;
}

export function canonicalEvidenceJson(value) {
  return JSON.stringify(canonicalize(value));
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function hashEntry(entry) {
  return digest(canonicalEvidenceJson({
    sequence:entry.sequence,previousHash:entry.previousHash,event:entry.event
  }));
}

export function validateEvidenceEvent(input) {
  const required=["schemaVersion","eventId","eventType","actorId","occurredAt",
    "subject","decision","sourceRef","artifactDigest","metadata"];
  if(!plain(input) || Object.keys(input).some(k=>!required.includes(k)) ||
     required.some(k=>!Object.hasOwn(input,k))) return {ok:false,reason:"EVIDENCE_EVENT_SHAPE_INVALID"};
  if(input.schemaVersion!==EVIDENCE_LEDGER_SCHEMA) return {ok:false,reason:"EVIDENCE_SCHEMA_UNSUPPORTED"};
  if(typeof input.eventId!=="string" || !ID.test(input.eventId) ||
     typeof input.actorId!=="string" || !ID.test(input.actorId) ||
     typeof input.subject!=="string" || !ID.test(input.subject) ||
     typeof input.eventType!=="string" || !/^[a-z][a-z0-9_.:-]{1,95}$/.test(input.eventType))
    return {ok:false,reason:"EVIDENCE_IDENTIFIERS_INVALID"};
  if(typeof input.occurredAt!=="string" || !TIME.test(input.occurredAt) ||
     !Number.isFinite(Date.parse(input.occurredAt))) return {ok:false,reason:"EVIDENCE_TIME_INVALID"};
  if(!DECISIONS.has(input.decision)) return {ok:false,reason:"EVIDENCE_DECISION_INVALID"};
  if(input.sourceRef!==null && (!plain(input.sourceRef) ||
     Object.keys(input.sourceRef).some(k=>!["provider","resource","revision"].includes(k)) ||
     typeof input.sourceRef.provider!=="string" || !ID.test(input.sourceRef.provider) ||
     typeof input.sourceRef.resource!=="string" || input.sourceRef.resource.length>256 ||
     (input.sourceRef.revision!==null && (typeof input.sourceRef.revision!=="string" || input.sourceRef.revision.length>128))))
    return {ok:false,reason:"EVIDENCE_SOURCE_INVALID"};
  if(input.artifactDigest!==null &&
     (typeof input.artifactDigest!=="string" || !/^sha256:[0-9a-f]{64}$/.test(input.artifactDigest)))
    return {ok:false,reason:"EVIDENCE_DIGEST_INVALID"};
  if(!plain(input.metadata)) return {ok:false,reason:"EVIDENCE_METADATA_INVALID"};
  try {
    const normalized=canonicalEvidenceJson(input);
    if(normalized.length>16384) return {ok:false,reason:"EVIDENCE_EVENT_TOO_LARGE"};
    return {ok:true,value:JSON.parse(normalized)};
  } catch(error) {
    return {ok:false,reason:["SENSITIVE_KEY","SENSITIVE_VALUE"].includes(error?.message)
      ? "SENSITIVE_EVIDENCE_REJECTED" : "EVIDENCE_CANONICALIZATION_FAILED"};
  }
}

export function verifyEvidenceChain(entries) {
  if(!Array.isArray(entries)) return {ok:false,reason:"LEDGER_NOT_ARRAY",sequence:0};
  let previous=GENESIS;
  for(let index=0;index<entries.length;index++) {
    const entry=entries[index];
    if(!plain(entry) || entry.sequence!==index+1 || entry.previousHash!==previous ||
       typeof entry.entryHash!=="string" || !HASH.test(entry.entryHash))
      return {ok:false,reason:"LEDGER_LINK_INVALID",sequence:index+1};
    const event=validateEvidenceEvent(entry.event);
    if(!event.ok) return {ok:false,reason:"LEDGER_EVENT_INVALID",sequence:index+1};
    const expected=hashEntry({sequence:entry.sequence,previousHash:entry.previousHash,event:event.value});
    if(expected!==entry.entryHash) return {ok:false,reason:"LEDGER_HASH_MISMATCH",sequence:index+1};
    previous=entry.entryHash;
  }
  return {ok:true,count:entries.length,headHash:previous};
}

export class EvidenceLedger {
  #entries=[];
  #ids=new Set();
  append(input) {
    const checked=validateEvidenceEvent(input);
    if(!checked.ok) return checked;
    if(this.#ids.has(checked.value.eventId)) return {ok:false,reason:"DUPLICATE_EVIDENCE_EVENT"};
    const entry={
      sequence:this.#entries.length+1,
      previousHash:this.#entries.at(-1)?.entryHash ?? GENESIS,
      event:checked.value
    };
    entry.entryHash=hashEntry(entry);
    this.#entries.push(Object.freeze(structuredClone(entry)));
    this.#ids.add(checked.value.eventId);
    return Object.freeze({ok:true,entry:structuredClone(entry)});
  }
  list({afterSequence=0,limit=100}={}) {
    if(!Number.isInteger(afterSequence)||afterSequence<0||
       !Number.isInteger(limit)||limit<1||limit>1000)
      return {ok:false,reason:"LEDGER_QUERY_INVALID"};
    return Object.freeze({
      ok:true,
      entries:Object.freeze(this.#entries.filter(e=>e.sequence>afterSequence).slice(0,limit).map(e=>structuredClone(e))),
      headSequence:this.#entries.length
    });
  }
  verify() { return verifyEvidenceChain(this.#entries); }
  get size() { return this.#entries.length; }
}
