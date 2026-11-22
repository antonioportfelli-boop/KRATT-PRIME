import { readFile } from "node:fs/promises";
import { createPostgresPoolFromConfig } from "../packages/kratt-orchestrator/src/wave8-live-connectors.mjs";
import { createPhase11MigrationPlan } from "../packages/kratt-core/src/phase11-migration-contract.mjs";

const plan = createPhase11MigrationPlan(process.env);
if (!plan.ok) throw new Error(plan.reason);

let pool;
try {
  const migrationUrl = process.env.DATABASE_MIGRATION_URL?.trim();
  if (!migrationUrl) throw new Error("DATABASE_MIGRATION_URL_REQUIRED");

  let databaseUrl;
  try {
    databaseUrl = new URL(migrationUrl);
  } catch {
    throw new Error("DATABASE_MIGRATION_URL_INVALID");
  }
  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
      !databaseUrl.hostname || !databaseUrl.username || !databaseUrl.password ||
      ["sslmode", "sslcert", "sslkey", "sslrootcert"].some(key => databaseUrl.searchParams.has(key))) {
    throw new Error("DATABASE_MIGRATION_URL_INVALID");
  }

  pool = await createPostgresPoolFromConfig({
    databaseUrl,
    databaseCaCertPath: process.env.DATABASE_MIGRATION_CA_CERT_PATH?.trim() || null
  });

  const before = await pool.query("SELECT current_database() AS database, current_user AS role");
  if (before.rows?.[0]?.database !== plan.expectedDatabase) {
    throw new Error("WAVE11_DATABASE_NAME_CONFIRMATION_MISMATCH");
  }

  const migrations = [...plan.baseMigrations, ...plan.phaseMigrations];
  for (const migration of plan.baseMigrations) {
    const sql = await readFile(
      new URL("../packages/kratt-core/migrations/" + migration, import.meta.url),
      "utf8"
    );
    await pool.query(sql);
  }

  const baseColumns = plan.requiredBaseTables.map((table, index) =>
    "to_regclass('public." + table + "') AS t" + index
  );
  const baseVerification = await pool.query("SELECT " + baseColumns.join(","));
  const missingBase = plan.requiredBaseTables.filter((table, index) =>
    !baseVerification.rows?.[0]?.["t" + index]
  );
  if (missingBase.length) {
    throw new Error("WAVE11_BASE_SCHEMA_REQUIRED:" + missingBase.join(","));
  }

  for (const migration of plan.phaseMigrations) {
    const sql = await readFile(
      new URL("../packages/kratt-core/migrations/" + migration, import.meta.url),
      "utf8"
    );
    await pool.query(sql);
  }

  const requiredColumns = plan.requiredTables.map((table, index) =>
    "to_regclass('public." + table + "') AS t" + index
  );
  const verification = await pool.query("SELECT " + requiredColumns.join(","));
  const missing = plan.requiredTables.filter((table, index) =>
    !verification.rows?.[0]?.["t" + index]
  );
  if (missing.length) {
    throw new Error("WAVE11_MIGRATION_POSTCHECK_FAILED:" + missing.join(","));
  }

  process.stdout.write(JSON.stringify({
    status: "MIGRATED",
    database: before.rows[0].database,
    role: before.rows[0].role,
    migrations
  }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({
    status: "FAILED",
    reason: String(error?.message ?? "MIGRATION_FAILED").split(":")[0]
  }) + "\n");
  process.exitCode = 1;
} finally {
  if (pool) {
    try { await pool.end(); } catch {}
  }
}
