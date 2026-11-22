export const PHASE11_BASE_MIGRATIONS = Object.freeze([
  "0002_competitive_intel_snapshots.sql",
  "0003_telegram_ingress_rate_limits.sql"
]);

export const PHASE11_OWN_MIGRATIONS = Object.freeze([
  "0005_semantic_memory.sql"
]);

// Wave 10 owns the observatory schema. Its historical 0004 migration is not
// replayed by Phase 11; the tables must already exist before semantic memory
// is allowed to migrate.
export const PHASE11_REQUIRED_BASE_TABLES = Object.freeze([
  "kratt_telegram_competitive_inbox",
  "kratt_competitor_snapshots",
  "kratt_competitor_snapshot_events",
  "kratt_competitor_snapshot_head",
  "kratt_telegram_ingress_rate_limits",
  "kratt_runtime_operation_events",
  "kratt_runtime_operations",
  "kratt_runtime_observatory_head"
]);

export const PHASE11_REQUIRED_TABLES = Object.freeze([
  ...PHASE11_REQUIRED_BASE_TABLES,
  "kratt_semantic_memory_events",
  "kratt_semantic_memory_head"
]);

const DATABASE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export function createPhase11MigrationPlan(env = {}) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    return Object.freeze({ ok: false, reason: "WAVE11_MIGRATION_ENV_INVALID" });
  }
  if (env.APP_ENV !== "staging") {
    return Object.freeze({ ok: false, reason: "WAVE11_MIGRATION_STAGING_ONLY" });
  }
  if (env.WAVE11_APPLY_STAGING_MIGRATIONS !== "true") {
    return Object.freeze({ ok: false, reason: "WAVE11_MIGRATION_EXPLICIT_OPT_IN_REQUIRED" });
  }
  const expectedDatabase = typeof env.WAVE11_EXPECTED_DATABASE === "string"
    ? env.WAVE11_EXPECTED_DATABASE.trim()
    : "";
  if (!DATABASE_NAME.test(expectedDatabase)) {
    return Object.freeze({ ok: false, reason: "WAVE11_EXPECTED_DATABASE_REQUIRED" });
  }

  return Object.freeze({
    ok: true,
    expectedDatabase,
    baseMigrations: PHASE11_BASE_MIGRATIONS,
    phaseMigrations: PHASE11_OWN_MIGRATIONS,
    requiredBaseTables: PHASE11_REQUIRED_BASE_TABLES,
    requiredTables: PHASE11_REQUIRED_TABLES
  });
}
