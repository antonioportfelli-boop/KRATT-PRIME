const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
function authorized(value){return value===true||!!value&&typeof value==="object"&&value.ok===true;}
function deny(){return{statusCode:403,body:{status:"DENIED",reason:"OBSERVATORY_READ_NOT_AUTHORIZED"}};}
function unavailable(){return{statusCode:503,body:{status:"UNAVAILABLE",reason:"OBSERVATORY_READ_FAILED"}};}

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
  if(parts.length===2&&parts[1]==="operations"){resource="operations";action="list";}
  else if(parts.length===3&&parts[1]==="operations"){resource="operations";action="get";try{operationId=decodeURIComponent(parts[2]);}catch{return{statusCode:400,body:{status:"INVALID",reason:"OPERATION_ID_INVALID"}};}}
  else if(parts.length===4&&parts[1]==="operations"&&parts[3]==="events"){resource="operations";action="events";try{operationId=decodeURIComponent(parts[2]);}catch{return{statusCode:400,body:{status:"INVALID",reason:"OPERATION_ID_INVALID"}};}}
  else if(parts.length===2&&parts[1]==="modules"){resource="modules";action="summary";}
  else if(parts.length===2&&parts[1]==="integrity"){resource="integrity";action="verify";}
  else return{statusCode:404,body:{status:"NOT_FOUND"}};
  if(operationId!==null&&!ID.test(operationId))return{statusCode:400,body:{status:"INVALID",reason:"OPERATION_ID_INVALID"}};
  let granted=false;
  try{granted=authorized(await authorizeRead({principal,action:"read",resource,operation_id:operationId}));}catch{granted=false;}
  if(!granted)return deny();
  try{
   if(action==="list"){
    const limit=query?.limit===undefined?50:Number(query.limit);
    const options={limit};
    if(query?.module_id!==undefined)options.moduleId=query.module_id;
    if(query?.status!==undefined)options.status=query.status;
    return{statusCode:200,body:{status:"OK",data:await store.listOperations(options)}};
   }
   if(action==="get"){
    const item=await store.getOperation(operationId);
    return item?{statusCode:200,body:{status:"OK",data:item}}:
     {statusCode:404,body:{status:"NOT_FOUND"}};
   }
   if(action==="events"){
    const limit=query?.limit===undefined?100:Number(query.limit);
    const beforeSequence=query?.before_sequence===undefined?undefined:Number(query.before_sequence);
    const data=await store.listEvents(operationId,{limit,beforeSequence});
    return{statusCode:200,body:{status:"OK",data,next_before_sequence:data.length===limit?data[0].sequence:null}};
   }
   if(action==="summary")return{statusCode:200,body:{status:"OK",data:await store.summarizeModules()}};
   const integrity=await store.verifyChain();
   return{statusCode:integrity.ok?200:503,body:{status:integrity.ok?"OK":"DEGRADED",
    data:{ok:integrity.ok,count:integrity.count??null,operations:integrity.operations??null}}};
  }catch{return unavailable();}
 }
 return Object.freeze({handle});
}
