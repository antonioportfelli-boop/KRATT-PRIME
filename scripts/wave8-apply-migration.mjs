import { readFile } from "node:fs/promises";
import { createPostgresPoolFromConfig } from "../packages/kratt-orchestrator/src/wave8-live-connectors.mjs";

if(process.env.APP_ENV!=="staging")throw new Error("WAVE8_MIGRATION_STAGING_ONLY");
const migrationOptIn=process.env.WAVE9_APPLY_STAGING_MIGRATIONS==="true"||process.env.WAVE8_APPLY_STAGING_MIGRATIONS==="true";
if(!migrationOptIn)throw new Error("WAVE9_MIGRATION_EXPLICIT_OPT_IN_REQUIRED");

let pool;
try{
 const migrationUrl=process.env.DATABASE_MIGRATION_URL?.trim();
 if(!migrationUrl)throw new Error("DATABASE_MIGRATION_URL_REQUIRED");
 let databaseUrl;
 try{databaseUrl=new URL(migrationUrl);}catch{throw new Error("DATABASE_MIGRATION_URL_INVALID");}
 if(!["postgres:","postgresql:"].includes(databaseUrl.protocol)||!databaseUrl.hostname||!databaseUrl.username||!databaseUrl.password||
  ["sslmode","sslcert","sslkey","sslrootcert"].some(k=>databaseUrl.searchParams.has(k)))
  throw new Error("DATABASE_MIGRATION_URL_INVALID");
 pool=await createPostgresPoolFromConfig({databaseUrl,databaseCaCertPath:process.env.DATABASE_MIGRATION_CA_CERT_PATH?.trim()||null});
 const before=await pool.query("SELECT current_database() AS database, current_user AS role");
 const expected=(process.env.WAVE9_EXPECTED_DATABASE??process.env.WAVE8_EXPECTED_DATABASE)?.trim();
 if(!expected||before.rows[0].database!==expected)throw new Error("WAVE9_DATABASE_NAME_CONFIRMATION_MISMATCH");
 const migrations=["0002_competitive_intel_snapshots.sql","0003_telegram_ingress_rate_limits.sql"];
 for(const migration of migrations){
  const sql=await readFile(new URL("../packages/kratt-core/migrations/"+migration,import.meta.url),"utf8");
  await pool.query(sql);
 }
 const verify=await pool.query(
  "SELECT to_regclass('public.kratt_telegram_competitive_inbox') AS inbox,"+
  "to_regclass('public.kratt_competitor_snapshots') AS snapshots,"+
  "to_regclass('public.kratt_competitor_snapshot_events') AS events,"+
  "to_regclass('public.kratt_competitor_snapshot_head') AS head,"+
  "to_regclass('public.kratt_telegram_ingress_rate_limits') AS rate_limits");
 const missing=["inbox","snapshots","events","head","rate_limits"].filter(k=>!verify.rows?.[0]?.[k]);
 if(missing.length)throw new Error("WAVE9_MIGRATION_POSTCHECK_FAILED:"+missing.join(","));
 process.stdout.write(JSON.stringify({status:"MIGRATED",database:before.rows[0].database,role:before.rows[0].role,migrations})+"\n");
}catch(error){
 process.stderr.write(JSON.stringify({status:"FAILED",reason:String(error?.message??"MIGRATION_FAILED").split(":")[0]})+"\n");
 process.exitCode=1;
}finally{if(pool)try{await pool.end();}catch{}}
