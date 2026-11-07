# CI Status and Recovery
Date: 2026-11-06  
Status: BLOCKED — no successful runner evidence established

## Observed state
The current workstream records GitHub Actions runs blocked before job execution by an account-level billing restriction. Earlier annotations explicitly state the job was not started because the account is locked due to a billing issue. Recent run IDs include 41930671396, 41930671350 and Telegram run 41931113074.

A blocked job is not a test failure and is not a passing test. No runtime test, typecheck or build result may be claimed from a job that never started.

## Recovery sequence
1. Repository owner resolves billing restriction through GitHub billing/account settings.
2. Confirm Actions are enabled and required workflows are present.
3. Re-run checks on exact candidate commit SHA.
4. Capture workflow URL, run ID, commit SHA, runner image, Node version and logs.
5. Classify each check as PASS, FAIL, BLOCKED or NOT RUN.
6. Fix failures from actual logs; do not infer errors from unavailable logs.
7. Repeat on final PR head and retain evidence.

## Required checks
Dependency install with lockfile (npm ci); KRATT Core tests (npm test); TypeScript typecheck (npm run typecheck); production build (npm run build); secret scanning and dependency/security review; integration and concurrency tests for durable adapters.

## Acceptance
CI recovery is complete only when required jobs actually execute on candidate SHA and produce inspectable successful results.