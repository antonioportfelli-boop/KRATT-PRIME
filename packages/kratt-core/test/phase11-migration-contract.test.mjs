import test from "node:test";
import assert from "node:assert/strict";
import {
  PHASE11_BASE_MIGRATIONS,
  PHASE11_OWN_MIGRATIONS,
  PHASE11_REQUIRED_BASE_TABLES,
  PHASE11_REQUIRED_TABLES,
  createPhase11MigrationPlan
} from "../src/phase11-migration-contract.mjs";

test("migration plan is staging-only", () => {
  assert.equal(createPhase11MigrationPlan({
    APP_ENV: "production",
    WAVE11_APPLY_STAGING_MIGRATIONS: "true",
    WAVE11_EXPECTED_DATABASE: "kratt_staging"
  }).reason, "WAVE11_MIGRATION_STAGING_ONLY");
});

test("legacy Wave 8/9/10 opt-ins cannot authorize Phase 11 migration", () => {
  for (const flag of [
    "WAVE8_APPLY_STAGING_MIGRATIONS",
    "WAVE9_APPLY_STAGING_MIGRATIONS",
    "WAVE10_APPLY_STAGING_MIGRATIONS"
  ]) {
    const env = {
      APP_ENV: "staging",
      WAVE11_EXPECTED_DATABASE: "kratt_staging",
      [flag]: "true"
    };
    assert.equal(
      createPhase11MigrationPlan(env).reason,
      "WAVE11_MIGRATION_EXPLICIT_OPT_IN_REQUIRED"
    );
  }
});

test("migration plan requires an explicit expected database name", () => {
  assert.equal(createPhase11MigrationPlan({
    APP_ENV: "staging",
    WAVE11_APPLY_STAGING_MIGRATIONS: "true"
  }).reason, "WAVE11_EXPECTED_DATABASE_REQUIRED");

  assert.equal(createPhase11MigrationPlan({
    APP_ENV: "staging",
    WAVE11_APPLY_STAGING_MIGRATIONS: "true",
    WAVE11_EXPECTED_DATABASE: "database name with spaces"
  }).reason, "WAVE11_EXPECTED_DATABASE_REQUIRED");
});

test("Phase 11 migration order does not replay removed Wave 10 migration 0004", () => {
  const plan = createPhase11MigrationPlan({
    APP_ENV: "staging",
    WAVE11_APPLY_STAGING_MIGRATIONS: "true",
    WAVE11_EXPECTED_DATABASE: "kratt_staging"
  });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.baseMigrations, [
    "0002_competitive_intel_snapshots.sql",
    "0003_telegram_ingress_rate_limits.sql"
  ]);
  assert.deepEqual(plan.phaseMigrations, ["0005_semantic_memory.sql"]);
  assert.equal(
    [...PHASE11_BASE_MIGRATIONS, ...PHASE11_OWN_MIGRATIONS]
      .includes("0004_runtime_observatory.sql"),
    false
  );
});

test("Phase 11 migration requires Wave 10 observability tables before semantic DDL", () => {
  assert.ok(PHASE11_REQUIRED_BASE_TABLES.includes("kratt_runtime_operation_events"));
  assert.ok(PHASE11_REQUIRED_BASE_TABLES.includes("kratt_runtime_operations"));
  assert.ok(PHASE11_REQUIRED_BASE_TABLES.includes("kratt_runtime_observatory_head"));
  assert.ok(PHASE11_REQUIRED_TABLES.includes("kratt_semantic_memory_events"));
  assert.ok(PHASE11_REQUIRED_TABLES.includes("kratt_semantic_memory_head"));
});
