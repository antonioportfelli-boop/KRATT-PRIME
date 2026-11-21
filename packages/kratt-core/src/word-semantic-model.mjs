import { createHash } from "node:crypto";

export const WORD_SEMANTIC_MODEL_VERSION = "1.0.0";
export const SEMANTIC_LAYERS = Object.freeze(["FORM","SENSE","PRINCIPLE","INTENT","SPEECH_ACT","EFFECT","POWER","AUTHORITY"]);
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DIGEST=/^[a-f0-9]{64}$/i;
const plain=v=>v!==null&&typeof v==="object"&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));
const bounded=(v,n)=>typeof v==="string"&&v.trim().length>0&&v.length<=n;
const fail=reason=>Object.freeze({ok:false,reason});
const exact=(v,keys)=>plain(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const refs=v=>Array.isArray(v)&&v.length<=64&&v.every(x=>ID.test(x))&&new Set(v).size===v.length;
const FORM=["token_id","surface","language","normalization","span"];
const KEYS={
 senses:["sense_id","definition","language","domain","concept_ref","confidence","evidence_refs"],
 principles:["principle_id","statement","norm_type","jurisdiction","valid_from","valid_until","source_refs"],
 intents:["intent_id","actor_ref","goal","audience_refs","context_ref","confidence"],
 speech_acts:["act_id","act_type","speaker_ref","addressee_refs","propositional_content","felicity_conditions"],
 effects:["effect_id","effect_type","target_refs","direction","magnitude","measurement_refs","causal_status"],
 powers:["power_id","power_type","holder_ref","target_refs","mechanism","scope","evidence_refs"],
 authorities:["authority_id","authority_type","issuer_ref","subject_ref","action_scope","resource_scope","jurisdiction","valid_from","valid_until","evidence_refs","status"]
};

export function validateWordSemanticRecord(x){
 if(!plain(x)||x.schema_version!=="kratt-word-semantics/v1"||!ID.test(x.record_id??"")||!plain(x.source)||!bounded(x.source.source_ref,1000)||!DIGEST.test(x.source.source_digest??"")||!bounded(x.context_id,192)||!Number.isFinite(Date.parse(x.created_at??""))||!exact(x.form,FORM)||!ID.test(x.form.token_id??"")||!bounded(x.form.surface,256)||!bounded(x.form.language,24)||!bounded(x.form.normalization,64)||!plain(x.form.span)||!Number.isInteger(x.form.span.start)||!Number.isInteger(x.form.span.end)||x.form.span.start<0||x.form.span.end<=x.form.span.start)return fail("WORD_FORM_INVALID");
 for(const [layer,keys] of Object.entries(KEYS)){
  const rows=x[layer];if(!Array.isArray(rows)||rows.length>64)return fail(layer.toUpperCase()+"_INVALID");
  for(const row of rows){if(!exact(row,keys)||!ID.test(row[keys[0]]??""))return fail(layer.toUpperCase()+"_SHAPE_INVALID");}
 }
 for(const s of x.senses)if(!bounded(s.definition,2000)||!bounded(s.language,24)||!bounded(s.domain,128)||!(s.concept_ref===null||ID.test(s.concept_ref))||!Number.isFinite(s.confidence)||s.confidence<0||s.confidence>1||!refs(s.evidence_refs))return fail("SENSE_FIELDS_INVALID");
 for(const p of x.principles)if(!bounded(p.statement,3000)||!["LEGAL","POLICY","ETHICAL","DOMAIN","OPERATIONAL","CUSTOM"].includes(p.norm_type)||!(p.jurisdiction===null||bounded(p.jurisdiction,128))||!refs(p.source_refs)||!(p.valid_from===null||Number.isFinite(Date.parse(p.valid_from)))||!(p.valid_until===null||Number.isFinite(Date.parse(p.valid_until))))return fail("PRINCIPLE_FIELDS_INVALID");
 for(const i of x.intents)if(!bounded(i.actor_ref,192)||!bounded(i.goal,1000)||!refs(i.audience_refs)||!bounded(i.context_ref,192)||!Number.isFinite(i.confidence)||i.confidence<0||i.confidence>1)return fail("INTENT_FIELDS_INVALID");
 for(const a of x.speech_acts)if(!["ASSERT","REQUEST","DIRECTIVE","PROMISE","WARNING","DECLARATION","QUESTION","EXPRESSIVE","OTHER"].includes(a.act_type)||!bounded(a.speaker_ref,192)||!refs(a.addressee_refs)||!bounded(a.propositional_content,2000)||!plain(a.felicity_conditions))return fail("SPEECH_ACT_FIELDS_INVALID");
 for(const e of x.effects)if(!["BEHAVIORAL","INFORMATIONAL","ECONOMIC","LEGAL","SOCIAL","TECHNICAL","SAFETY","OTHER"].includes(e.effect_type)||!refs(e.target_refs)||!["POSITIVE","NEGATIVE","MIXED","UNKNOWN"].includes(e.direction)||!(e.magnitude===null||(Number.isFinite(e.magnitude)&&e.magnitude>=0))||!refs(e.measurement_refs)||!["ASSERTED","OBSERVED","CAUSALLY_SUPPORTED","CAUSALLY_ESTABLISHED","UNKNOWN"].includes(e.causal_status))return fail("EFFECT_FIELDS_INVALID");
 for(const p of x.powers)if(!["COERCIVE","INSTITUTIONAL","ECONOMIC","EXPERT","AGENDA_SETTING","INFORMATIONAL","NETWORK","OTHER"].includes(p.power_type)||!bounded(p.holder_ref,192)||!refs(p.target_refs)||!bounded(p.mechanism,1000)||!bounded(p.scope,1000)||!refs(p.evidence_refs))return fail("POWER_FIELDS_INVALID");
 for(const a of x.authorities)if(!["LEGAL","CONTRACTUAL","ORGANIZATIONAL","DELEGATED","TECHNICAL","NONE","UNKNOWN"].includes(a.authority_type)||!bounded(a.issuer_ref,192)||!bounded(a.subject_ref,192)||!bounded(a.action_scope,1000)||!bounded(a.resource_scope,1000)||!(a.jurisdiction===null||bounded(a.jurisdiction,128))||!(a.valid_from===null||Number.isFinite(Date.parse(a.valid_from)))||!(a.valid_until===null||Number.isFinite(Date.parse(a.valid_until)))||!refs(a.evidence_refs)||!["CANDIDATE","VERIFIED","REVOKED","EXPIRED","UNKNOWN"].includes(a.status))return fail("AUTHORITY_FIELDS_INVALID");
 return Object.freeze({ok:true,value:Object.freeze(x)});
}

export function evaluateWordSemantics(x,{now=new Date().toISOString(),requiredLayers=["SENSE"]}={}){
 const checked=validateWordSemanticRecord(x);if(!checked.ok)return checked;
 if(!Number.isFinite(Date.parse(now))||!Array.isArray(requiredLayers)||requiredLayers.some(l=>!SEMANTIC_LAYERS.includes(l)))return fail("EVALUATION_CONTEXT_INVALID");
 const time=Date.parse(now);
 const active=x.authorities.filter(a=>a.status==="VERIFIED"&&(a.valid_from===null||Date.parse(a.valid_from)<=time)&&(a.valid_until===null||Date.parse(a.valid_until)>time));
 const count={SENSE:x.senses.length,PRINCIPLE:x.principles.length,INTENT:x.intents.length,SPEECH_ACT:x.speech_acts.length,EFFECT:x.effects.length,POWER:x.powers.length,AUTHORITY:active.length};
 const missing=requiredLayers.filter(l=>l!=="FORM"&&count[l]===0);
 const ambiguous=x.senses.filter(s=>s.confidence>=0.8).length>1;
 const revoked=x.authorities.some(a=>a.status==="REVOKED"&&a.authority_type!=="NONE");
 const effects=x.effects.filter(e=>!["CAUSALLY_SUPPORTED","CAUSALLY_ESTABLISHED"].includes(e.causal_status)).map(e=>e.effect_id);
 const status=revoked?"AUTHORITY_CONFLICT":(missing.length||ambiguous?"SEMANTIC_REVIEW_REQUIRED":"READY_FOR_SEMANTIC_REVIEW");
 return Object.freeze({ok:true,status,token_id:x.form.token_id,surface:x.form.surface,evaluated_at:now,required_layers:Object.freeze([...requiredLayers]),missing_layers:Object.freeze(missing),ambiguous_sense_ids:Object.freeze(ambiguous?x.senses.filter(s=>s.confidence>=0.8).map(s=>s.sense_id):[]),effects_without_causal_establishment:Object.freeze(effects),authorization_granted:false,policy_authority:false,note:"Form, sense, principle, intent, speech act, effect, power and authority are separate typed objects. Reflection or identical surface form does not collapse these distinctions."});
}

export function createWordSemanticRecord({recordId,sourceRef,sourceDigest,contextId,form,createdAt,senses=[],principles=[],intents=[],speechActs=[],effects=[],powers=[],authorities=[]}={}){
 return validateWordSemanticRecord({schema_version:"kratt-word-semantics/v1",record_id:recordId,source:{source_ref:sourceRef,source_digest:sourceDigest},context_id:contextId,created_at:createdAt,form,senses,principles,intents,speech_acts:speechActs,effects,powers,authorities});
}
