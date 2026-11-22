const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function authorized(value){return value===true||!!value&&typeof value==="object"&&value.ok===true;}
function deny(){return{statusCode:403,body:{status:"DENIED",reason:"OBSERVATORY_READ_NOT_AUTHORIZED"}};}
function unavailable(){return{statusCode:503,body:{status:"UNAVAILABLE",reason:"OBSERVATORY_READ_FAILED"}};}
const STATUSES=new Set(["queued","running","succeeded","failed","cancelled","timed_out","not_run"]);
function listOptions(query){
 if(!query||typeof query!=="object"||Array.isArray(query))return{ok:false};
 const allowed=new Set(["limit","module_id","status"]);
 if(Object.keys(query).some(key=>!allowed.has(key)))return{ok:false};
 let limit=50;
 if(query.limit!==undefined){
  if(typeof query.limit==="number")limit=query.limit;
  else if(typeof query.limit==="string"&&/^(?:[1-9][0-9]*)$/.test(query.limit))limit=Number(query.limit);
  else return{ok:false};
 }
 if(!Number.isInteger(limit)||limit<1||limit>200)return{ok:false};
 if(query.module_id!==undefined&&(typeof query.module_id!=="string"||!ID.test(query.module_id)))return{ok:false};
 if(query.status!==undefined&&(typeof query.status!=="string"||!STATUSES.has(query.status)))return{ok:false};
 const options={limit};
 if(query.module_id!==undefined)options.moduleId=query.module_id;
 if(query.status!==undefined)options.status=query.status;
 return{ok:true,options};
}

function eventOptions(query){
 if(!query||typeof query!=="object"||Array.isArray(query))return{ok:false};
 const allowed=new Set(["limit","before_sequence"]);
 if(Object.keys(query).some(key=>!allowed.has(key)))return{ok:false};
 let limit=100;
 if(query.limit!==undefined){
  if(typeof query.limit==="number")limit=query.limit;
  else if(typeof query.limit==="string"&&/^(?:[1-9][0-9]*)$/.test(query.limit))limit=Number(query.limit);
  else return{ok:false};
 }
 if(!Number.isSafeInteger(limit)||limit<1||limit>500)return{ok:false};
 let beforeSequence;
 if(query.before_sequence!==undefined){
  if(typeof query.before_sequence==="number")beforeSequence=query.before_sequence;
  else if(typeof query.before_sequence==="string"&&/^(?:[1-9][0-9]*)$/.test(query.before_sequence))beforeSequence=Number(query.before_sequence);
  else return{ok:false};
  if(!Number.isSafeInteger(beforeSequence)||beforeSequence<1)return{ok:false};
 }
 return{ok:true,options:{limit,beforeSequence}};
}

export function createRuntimeObservatoryApi({store,authorizeRead}={}){
 if(!store||!["listOperations","getOperation","listEvents","summarizeModules","verifyChain"].every(name=>typeof store[name]==="function"))
  throw new TypeError("OBSERVATORY_READ_STORE_REQUIRED");
 if(typeof authorizeRead!=="function")throw new TypeError("OBSERVATORY_READ_AUTHORIZER_REQUIRED");

 async function handle({method="GET",path="/observatory/operations",principal,query={}}={}){
  if(method!=="GET")return{statusCode:405,body:{status:"DENIED",reason:"GET_REQUIRED"}};
  if(typeof path!=="string"||path.length>1024)return{statusCode:400,body:{status:"INVALID",reason:"PATH_INVALID"}};
  const parts=path.split("?")[0].split("/").filter(Boolean);
  if(parts[0]!=="observatory")return{statusCode:404,body:{status:"NOT_FOUND"}};
  let resource,operationId=null,action;
  let validatedList=null;
  if(parts.length===2&&parts[1]==="operations"){resource="operations";action="list";}
  else if(parts.length===3&&parts[1]==="operations"){resource="operations";action="get";try{operationId=decodeURIComponent(parts[2]);}catch{return{statusCode:400,body:{status:"INVALID",reason:"OPERATION_ID_INVALID"}};}}
  else if(parts.length===4&&parts[1]==="operations"&&parts[3]==="events"){resource="operations";action="events";try{operationId=decodeURIComponent(parts[2]);}catch{return{statusCode:400,body:{status:"INVALID",reason:"OPERATION_ID_INVALID"}};}}
  else if(parts.length===2&&parts[1]==="modules"){resource="modules";action="summary";}
  else if(parts.length===2&&parts[1]==="integrity"){resource="integrity";action="verify";}
  else return{statusCode:404,body:{status:"NOT_FOUND"}};
  if(operationId!==null&&!ID.test(operationId))return{statusCode:400,body:{status:"INVALID",reason:"OPERATION_ID_INVALID"}};
  if(action==="list"){validatedList=listOptions(query);if(!validatedList.ok)return{statusCode:400,body:{status:"INVALID",reason:"QUERY_INVALID"}};}
  let granted=false;
  try{granted=authorized(await authorizeRead({principal,action:"read",resource,operation_id:operationId}));}catch{granted=false;}
  if(!granted)return deny();
  try{
   if(action==="list")return{statusCode:200,body:{status:"OK",data:await store.listOperations(validatedList.options)}};
   if(action==="get"){
    const item=await store.getOperation(operationId);
    return item?{statusCode:200,body:{status:"OK",data:item}}:
     {statusCode:404,body:{status:"NOT_FOUND"}};
   }
   if(action==="events"){
    const checked=eventOptions(query);
    if(!checked.ok)return{statusCode:400,body:{status:"INVALID",reason:"QUERY_INVALID"}};
    const {limit,beforeSequence}=checked.options;
    const events=await store.listEvents(operationId,{limit,beforeSequence});
    const data=events.map(item=>({
     sequence:item.sequence,event_id:item.event_id,event:item.event
    }));
    return{statusCode:200,body:{status:"OK",data,
     next_before_sequence:data.length===limit?(data[0]?.sequence??null):null}};
   }
   if(action==="summary")return{statusCode:200,body:{status:"OK",data:await store.summarizeModules()}};
   const integrity=await store.verifyChain();
   return{statusCode:integrity.ok?200:503,body:{status:integrity.ok?"OK":"DEGRADED",
    data:{ok:integrity.ok,count:integrity.count??null,operations:integrity.operations??null}}};
  }catch{return unavailable();}
 }
 return Object.freeze({handle});
}
