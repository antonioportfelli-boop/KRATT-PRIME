import test from "node:test"; import assert from "node:assert/strict"; import { validateTelegramAdapterManifest, authorizeTelegramUpdate } from "../src/telegram-adapter.mjs";
const manifest={adapterId:"telegram.main",state:"READ_ONLY",allowedChatIds:["12345"],scopes:["telegram.message.read"],webhookConfigured:false};
test("permits allowlisted read as a non-executing decision",()=>{const r=authorizeTelegramUpdate({manifest,chatId:"12345",operation:"read"});assert.equal(r.decision,"ALLOW");assert.equal(r.executionStarted,false);});
test("denies unknown chats",()=>{assert.equal(authorizeTelegramUpdate({manifest,chatId:"999",operation:"read"}).decision,"DENY");});
test("rejects unknown scopes",()=>{assert.equal(validateTelegramAdapterManifest({...manifest,scopes:["admin"]}).ok,false);});
test("does not enable writes",()=>{assert.equal(authorizeTelegramUpdate({manifest,chatId:"12345",operation:"send"}).decision,"BLOCKED");});
