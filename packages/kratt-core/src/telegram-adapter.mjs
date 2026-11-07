/** Telegram adapter contract only. No token handling, network calls, webhook or polling. */
const ID=/^[A-Za-z0-9._:-]{1,128}$/;
const SCOPES=new Set(["telegram.message.read","telegram.message.send","telegram.command.execute"]);
export function validateTelegramAdapterManifest(input) {
  if (!input || typeof input!=="object" || Array.isArray(input) ||
      Object.keys(input).some(k=>!["adapterId","state","allowedChatIds","scopes","webhookConfigured"].includes(k)) ||
      !ID.test(input.adapterId??"") || !["DISABLED","READ_ONLY","WRITE_PENDING_APPROVAL"].includes(input.state) ||
      !Array.isArray(input.allowedChatIds) || input.allowedChatIds.length>256 ||
      !input.allowedChatIds.every(x=>typeof x==="string" && /^-?[0-9]{1,20}$/.test(x)) ||
      new Set(input.allowedChatIds).size!==input.allowedChatIds.length ||
      !Array.isArray(input.scopes) || !input.scopes.every(x=>SCOPES.has(x)) ||
      typeof input.webhookConfigured!=="boolean") return Object.freeze({ok:false,reason:"TELEGRAM_MANIFEST_INVALID"});
  if (input.state==="WRITE_PENDING_APPROVAL" && !input.scopes.includes("telegram.message.send"))
    return Object.freeze({ok:false,reason:"TELEGRAM_WRITE_SCOPE_MISSING"});
  return Object.freeze({ok:true,manifest:Object.freeze({...input,allowedChatIds:Object.freeze([...input.allowedChatIds]),scopes:Object.freeze([...input.scopes])})});
}
export function authorizeTelegramUpdate({manifest,chatId,operation}) {
  const checked=validateTelegramAdapterManifest(manifest);
  if(!checked.ok) return Object.freeze({decision:"BLOCKED",reason:checked.reason,executionStarted:false});
  if(typeof chatId!=="string" || !checked.manifest.allowedChatIds.includes(chatId))
    return Object.freeze({decision:"DENY",reason:"TELEGRAM_CHAT_NOT_ALLOWLISTED",executionStarted:false});
  if(operation==="read" && checked.manifest.state==="READ_ONLY" && checked.manifest.scopes.includes("telegram.message.read"))
    return Object.freeze({decision:"ALLOW",reason:"READ_SCOPE_MATCHED",executionStarted:false});
  return Object.freeze({decision:"BLOCKED",reason:"TELEGRAM_OPERATION_NOT_ENABLED",executionStarted:false});
}
