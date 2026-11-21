import { randomUUID } from "node:crypto";
import { createObservedOperationRunner } from "../../kratt-core/src/observed-operation.mjs";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export function createObservedTelegramIngestion({
 ingestion,store,environment="staging",runtimeVersion="node"+process.versions.node,
 idFactory=randomUUID,
}={}){
 if(!ingestion||typeof ingestion.ingest!=="function")throw new TypeError("TELEGRAM_INGESTION_REQUIRED");
 if(!store||typeof store.append!=="function")throw new TypeError("OBSERVATORY_EVENT_STORE_REQUIRED");
 if(!["development","test","staging","production"].includes(environment))throw new TypeError("OBSERVATORY_ENVIRONMENT_INVALID");
 if(typeof runtimeVersion!=="string"||!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(runtimeVersion))
  throw new TypeError("OBSERVATORY_RUNTIME_VERSION_INVALID");
 if(typeof idFactory!=="function")throw new TypeError("TELEGRAM_OPERATION_ID_FACTORY_REQUIRED");
 const runner=createObservedOperationRunner({store});
 return Object.freeze({
  async ingest({update,receivedSecret}={}){
   const updateId=Number.isSafeInteger(update?.update_id)&&update.update_id>=0?String(update.update_id):"unknown";
   let operationId;
   try{operationId="telegram-delivery-"+idFactory();}catch{return{status:"ERROR",reason:"OBSERVABILITY_ID_UNAVAILABLE"};}
   if(!ID.test(operationId))return{status:"ERROR",reason:"OBSERVABILITY_ID_INVALID"};
   const observed=await runner.run({
    operation_id:operationId,
    correlation_id:"telegram-update-"+updateId,
    module_id:"telegram-ingestion",
    adapter_id:"telegram-webhook",
    capability:"telegram.competitive.ingest",
    capability_state:"bound",
    environment,
    runtime_version:runtimeVersion,
    input_ref:"telegram-update:"+updateId,
    evidence_refs:[],
    execute:()=>ingestion.ingest({update,receivedSecret}),
    outputRef:result=>"telegram-result:"+(typeof result?.status==="string"?result.status:"unknown"),
   });
   if(observed.status==="COMPLETED")return observed.result;
   return{status:"ERROR",reason:observed.status==="OUTCOME_UNRECORDED"
    ?"OBSERVABILITY_OUTCOME_UNRECORDED":"OBSERVABILITY_EXECUTION_BLOCKED"};
  },
 });
}
