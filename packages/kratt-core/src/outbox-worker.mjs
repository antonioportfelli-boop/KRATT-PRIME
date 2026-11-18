/** At-least-once worker. Provider adapters MUST honor stable idempotency keys. */
export function createOutboxWorker({store,adapters,workerId,actorId,maxAttempts=8}={}){
 if(!store||typeof store.claimOutbox!=="function"||typeof store.finishOutbox!=="function"||typeof store.retryOutbox!=="function")throw new TypeError("OUTBOX_STORE_REQUIRED");
 if(!adapters||Object.getPrototypeOf(adapters)!==Object.prototype)throw new TypeError("OUTBOX_ADAPTER_REGISTRY_REQUIRED");
 if(typeof workerId!=="string"||!workerId||typeof actorId!=="string"||!actorId)throw new TypeError("OUTBOX_WORKER_IDENTITY_REQUIRED");
 async function runOnce({limit=10,leaseSeconds=60}={}){
  const claimed=await store.claimOutbox({workerId,limit,leaseSeconds}),results=[];
  for(const item of claimed){
   const adapter=Object.hasOwn(adapters,item.provider)?adapters[item.provider]:null;
   if(!adapter||typeof adapter.dispatch!=="function"){
    const retry=await store.retryOutbox({outboxId:item.outbox_id,leaseToken:item.lease_token,errorCode:"PROVIDER_ADAPTER_UNAVAILABLE",maxAttempts});
    results.push({outbox_id:item.outbox_id,status:"RETRY_SCHEDULED",retry});continue;
   }
   try{
    const result=await adapter.dispatch({payload:item.payload,idempotencyKey:item.idempotency_key});
    const valid=result&&typeof result==="object"&&["accepted","completed"].includes(result.status);
    const finished=await store.finishOutbox({outboxId:item.outbox_id,leaseToken:item.lease_token,actorId,
     taskId:item.payload?.task?.task_id??item.payload?.task_id,
     outcome:valid?{status:"COMPLETED",audit_result:{status:result.status}}:{status:"FAILED",audit_result:{status:"invalid_result"}}});
    results.push({outbox_id:item.outbox_id,status:finished.ok?"RECORDED":"LEASE_LOST"});
   }catch{
    const retry=await store.retryOutbox({outboxId:item.outbox_id,leaseToken:item.lease_token,errorCode:"PROVIDER_DISPATCH_FAILED",maxAttempts});
    results.push({outbox_id:item.outbox_id,status:"RETRY_SCHEDULED",retry});
   }
  }
  return{claimed:claimed.length,results};
 }
 return Object.freeze({runOnce});
}
