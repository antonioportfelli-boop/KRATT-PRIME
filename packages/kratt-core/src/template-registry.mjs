/**
 * KRATT PRIME — typed, non-executable template registry.
 * Templates produce schema-validated data only; no eval or shell expansion.
 */
export const TEMPLATE_SCHEMA_VERSION = "kratt-template/v1";
const ID = /^[a-z][a-z0-9._:-]{1,95}$/;
const plain = v => v !== null && typeof v === "object" && !Array.isArray(v) &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const bad = reason => Object.freeze({ok:false,reason});
const freeze = v => {
  if (Array.isArray(v)) return Object.freeze(v.map(freeze));
  if (plain(v)) {
    const out=Object.create(null);
    for (const [k,x] of Object.entries(v)) out[k]=freeze(x);
    return Object.freeze(out);
  }
  return v;
};
const BUILT_INS = [
  {id:"system-profile.v1",version:1,description:"Normalized OS, hardware and network snapshot",fields:[
    {name:"platform",type:"string",required:true},{name:"architecture",type:"string",required:true},
    {name:"osId",type:"string",required:false},{name:"kernel",type:"string",required:false},
    {name:"cpuCount",type:"number",required:false},{name:"memoryBytes",type:"number",required:false},
    {name:"packageManager",type:"string",required:false},{name:"networkManagerState",type:"string",required:true},
    {name:"interfaceCount",type:"number",required:true},{name:"ipv4RouteCount",type:"number",required:true},
    {name:"ipv6RouteCount",type:"number",required:true},{name:"observedAt",type:"string",required:true}
  ]},
  {id:"adapter-manifest.v1",version:1,description:"Connector trust and capability summary",fields:[
    {name:"adapterId",type:"string",required:true},{name:"provider",type:"string",required:true},
    {name:"state",type:"string",required:true},{name:"capabilityCount",type:"number",required:true},
    {name:"credentialRefPresent",type:"boolean",required:true},{name:"writeEnabled",type:"boolean",required:true}
  ]},
  {id:"workflow-task.v1",version:1,description:"Agent role, dependency and acceptance packet",fields:[
    {name:"taskId",type:"string",required:true},{name:"role",type:"string",required:true},
    {name:"objective",type:"string",required:true},{name:"sourceRevision",type:"string",required:true},
    {name:"dependencies",type:"string[]",required:true},{name:"acceptanceCriteria",type:"string[]",required:true},
    {name:"sideEffectClass",type:"string",required:true}
  ]},
  {id:"network-change-proposal.v1",version:1,description:"Review-only network configuration proposal",fields:[
    {name:"targetPath",type:"string",required:true},{name:"diffDigest",type:"string",required:true},
    {name:"riskClass",type:"string",required:true},{name:"rollbackRef",type:"string",required:true},
    {name:"requiresApproval",type:"boolean",required:true},{name:"applyStarted",type:"boolean",required:true}
  ]},
  {id:"integration-evidence-report.v1",version:1,description:"Provider state and evidence summary",fields:[
    {name:"provider",type:"string",required:true},{name:"lifecycleState",type:"string",required:true},
    {name:"verifiedAt",type:"string",required:false},{name:"evidenceRefs",type:"string[]",required:true},
    {name:"writeEnabled",type:"boolean",required:true}
  ]},
  {id:"release-gate.v1",version:1,description:"Release readiness and explicit approval evidence",fields:[
    {name:"sourceRevision",type:"string",required:true},{name:"testsPassed",type:"boolean",required:true},
    {name:"auditPassed",type:"boolean",required:true},{name:"approvalRef",type:"string",required:false},
    {name:"deployStarted",type:"boolean",required:true}
  ]}
];
const validType=(type,value)=>{
  if(type==="string") return typeof value==="string" && value.length<=4096;
  if(type==="number") return typeof value==="number" && Number.isFinite(value) && value>=0;
  if(type==="boolean") return typeof value==="boolean";
  if(type==="string[]") return Array.isArray(value) && value.length<=128 &&
    value.every(v=>typeof v==="string" && v.length<=512);
  return false;
};
function validateDefinition(d) {
  if(!plain(d) || Object.keys(d).some(k=>!["id","version","description","fields"].includes(k)) ||
     typeof d.id!=="string" || !ID.test(d.id) || !Number.isInteger(d.version) || d.version<1 ||
     typeof d.description!=="string" || d.description.length>240 ||
     !Array.isArray(d.fields) || d.fields.length<1 || d.fields.length>64) return bad("TEMPLATE_DEFINITION_INVALID");
  const names=new Set();
  for(const field of d.fields) {
    if(!plain(field) || Object.keys(field).some(k=>!["name","type","required"].includes(k)) ||
       typeof field.name!=="string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(field.name) ||
       !["string","number","boolean","string[]"].includes(field.type) || typeof field.required!=="boolean" ||
       names.has(field.name)) return bad("TEMPLATE_FIELD_INVALID");
    names.add(field.name);
  }
  return Object.freeze({ok:true,definition:freeze(structuredClone(d))});
}

export class TemplateRegistry {
  #templates = new Map();
  constructor({includeBuiltIns=true}={}) {
    if(includeBuiltIns) for(const template of BUILT_INS) this.register(template);
  }
  register(input) {
    const checked=validateDefinition(input);
    if(!checked.ok) return checked;
    if(this.#templates.has(checked.definition.id)) return bad("TEMPLATE_ALREADY_REGISTERED");
    this.#templates.set(checked.definition.id,checked.definition);
    return Object.freeze({ok:true,templateId:checked.definition.id,version:checked.definition.version});
  }
  describe(id) { return this.#templates.get(id) ?? null; }
  list() {
    return Object.freeze([...this.#templates.values()].map(t=>Object.freeze({
      id:t.id,version:t.version,description:t.description,fieldCount:t.fields.length
    })));
  }
  render(id,values) {
    const template=this.#templates.get(id);
    if(!template) return bad("TEMPLATE_NOT_FOUND");
    if(!plain(values)) return bad("TEMPLATE_VALUES_INVALID");
    const allowed=new Set(template.fields.map(f=>f.name));
    if(Object.keys(values).some(k=>!allowed.has(k))) return bad("TEMPLATE_UNKNOWN_VALUE");
    const output=Object.create(null);
    for(const field of template.fields) {
      const value=values[field.name];
      if(value===undefined) {
        if(field.required) return bad("TEMPLATE_REQUIRED_VALUE_MISSING:"+field.name);
        continue;
      }
      if(!validType(field.type,value)) return bad("TEMPLATE_VALUE_TYPE_INVALID:"+field.name);
      output[field.name]=structuredClone(value);
    }
    return Object.freeze({ok:true,result:freeze({
      schemaVersion:TEMPLATE_SCHEMA_VERSION,templateId:template.id,
      templateVersion:template.version,values:output
    })});
  }
}
export const BUILT_IN_TEMPLATE_IDS=Object.freeze(BUILT_INS.map(t=>t.id));
