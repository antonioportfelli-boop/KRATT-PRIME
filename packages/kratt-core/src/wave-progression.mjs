const DELIVERY_STATES = new Set([
  "baseline-present",
  "draft-open",
  "parallel-drafts-open",
  "candidate-in-wave10-base",
]);

const EVIDENCE_KINDS = new Set([
  "contract-tests",
  "typecheck-build",
  "architecture-review",
  "security-review",
  "negative-auth-tests",
  "key-custody-review",
  "fabric-contract-tests",
  "dispatch-audit-tests",
  "transaction-tests",
  "lease-recovery-tests",
  "operator-runbook",
  "request-bound-approval-tests",
  "steel-protocol-contract-tests",
  "audit-chain-tests",
  "evidence-provenance-tests",
  "pricing-normalization-tests",
  "report-digest-tests",
  "webhook-security-tests",
  "snapshot-chain-tests",
  "replay-tests",
  "staging-config-tests",
  "preflight-tests",
  "data-consent-review",
  "multi-replica-rate-limit-tests",
  "readiness-tests",
  "migration-gate-review",
  "observatory-integrity-tests",
  "read-api-auth-tests",
  "projection-tamper-tests",
  "ui-read-contract-tests",
  "operator-staging-attestation",
  "visual-alignment",
]);

const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

const records = [
  {
    id: "WAVE-01",
    order: 1,
    complexity: 1,
    title: "Core contracts and agent foundation",
    layer: "foundation",
    summary: "Typed task, evidence and context contracts; bounded agent registry; append-only memory reference; deterministic Saga transitions.",
    capabilities: ["typed-contracts", "agent-scopes", "memory-provenance", "saga-state-machine"],
    dependsOn: [],
    deliveryState: "baseline-present",
    branchRefs: ["main", "integration/source-reconciliation-2026-10"],
    pullRequests: [{ number: 1, state: "closed", relation: "historical-core-candidate" }],
    requiredEvidence: ["contract-tests", "architecture-review", "visual-alignment"],
    lineageNote: "Core contract files exist on the inspected main tree. PR #1 is historical and is not treated as proof that every later wave was merged.",
  },
  {
    id: "WAVE-02",
    order: 2,
    complexity: 2,
    title: "Authorization and trust hardening",
    layer: "trust",
    summary: "Trusted context freshness, evidence verification, exact resource/path scope, request-bound approvals, cancellation and fail-closed decisions.",
    capabilities: ["trusted-context", "approval-binding", "evidence-verification", "scope-enforcement", "kill-switch"],
    dependsOn: ["WAVE-01"],
    deliveryState: "draft-open",
    branchRefs: ["feature/kratt-prime-v2.1-execution", "feature/wp01-authorization-hardening"],
    pullRequests: [
      { number: 3, state: "open", relation: "authorization-candidate" },
      { number: 2, state: "closed", relation: "earlier-authorization-candidate" },
    ],
    requiredEvidence: ["negative-auth-tests", "key-custody-review", "security-review", "visual-alignment"],
    lineageNote: "Authorization work remains a review gate. A policy decision is not a cryptographic proof unless the trusted server-side verifier and key lifecycle are actually supplied.",
  },
  {
    id: "WAVE-03",
    order: 3,
    complexity: 3,
    title: "3XT Fabric events and authorized dispatch",
    layer: "integration-gateway",
    summary: "Versioned Fabric event envelopes, integration lifecycle registry, request-bound operation approval and a durable local dispatch/audit boundary.",
    capabilities: ["fabric-event-contract", "integration-registry", "read-write-separation", "authorized-dispatch", "sqlite-audit"],
    dependsOn: ["WAVE-01", "WAVE-02"],
    deliveryState: "parallel-drafts-open",
    branchRefs: ["feature/agentops-trust-control-plane-v1", "feature/authorized-dispatch-audit-v1"],
    pullRequests: [
      { number: 27, state: "open", relation: "fabric-gateway-candidate" },
      { number: 28, state: "open", relation: "authorized-dispatch-candidate" },
    ],
    requiredEvidence: ["fabric-contract-tests", "dispatch-audit-tests", "security-review", "visual-alignment"],
    lineageNote: "PRs #27 and #28 are sibling candidates against main. Their logical dependency is not Git ancestry; reconcile contracts before stacking or combining them.",
  },
  {
    id: "WAVE-04",
    order: 4,
    complexity: 4,
    title: "Transactional outbox and recovery",
    layer: "durability",
    summary: "PostgreSQL transaction boundary for approval nonce, cancellation, idempotency, intent, outbox and audit; fenced worker leases and bounded retries.",
    capabilities: ["postgres-outbox", "idempotency", "lease-fencing", "retry-policy", "dead-letter"],
    dependsOn: ["WAVE-03"],
    deliveryState: "draft-open",
    branchRefs: ["feature/postgres-outbox-runtime-v1-ci"],
    pullRequests: [
      { number: 30, state: "open", relation: "current-wave4-draft" },
      { number: 29, state: "closed", relation: "superseded-wave4-draft" },
    ],
    requiredEvidence: ["transaction-tests", "lease-recovery-tests", "audit-chain-tests", "operator-runbook"],
    lineageNote: "The current Wave 4 draft is based on main in GitHub metadata even though its description calls the work cumulative. Logical dependencies must be verified against the actual tree.",
  },
  {
    id: "WAVE-05",
    order: 5,
    complexity: 5,
    title: "Asynchronous trusted runtime and STEEL adapter",
    layer: "async-runtime",
    summary: "Server-owned asynchronous authorization, transactionally consumed approval claims, shared outbox, MÕTLEMINE evidence checks and STEEL Factory Protocol v1 mapping.",
    capabilities: ["async-trusted-runtime", "transactional-approval", "steel-protocol-v1", "evidence-assessment"],
    dependsOn: ["WAVE-02", "WAVE-04"],
    deliveryState: "draft-open",
    branchRefs: ["feature/wave5-async-trusted-motlemine-steel-v1"],
    pullRequests: [{ number: 31, state: "open", relation: "wave5-draft" }],
    requiredEvidence: ["request-bound-approval-tests", "steel-protocol-contract-tests", "audit-chain-tests", "security-review"],
    lineageNote: "The adapter must follow STEEL's actual Factory Protocol contract. It must not duplicate or invent a second protocol schema.",
  },
  {
    id: "WAVE-06",
    order: 6,
    complexity: 6,
    title: "Competitive Intelligence and TCO evidence",
    layer: "evidence-intelligence",
    summary: "Normalized competitor signals, time-aligned pricing comparisons, explicit baselines, partial-coverage reporting and traceable report digests.",
    capabilities: ["signal-normalization", "pricing-comparison", "tco-estimation", "baseline-detection", "report-digest"],
    dependsOn: ["WAVE-05"],
    deliveryState: "draft-open",
    branchRefs: ["feature/wave6-competitive-intel-telegram-pricing-v1"],
    pullRequests: [{ number: 32, state: "open", relation: "wave6-draft" }],
    requiredEvidence: ["evidence-provenance-tests", "pricing-normalization-tests", "report-digest-tests", "visual-alignment"],
    lineageNote: "A missing historical baseline is an unknown, not zero change. Cross-competitor and cross-unit comparisons must remain explicitly scoped.",
  },
  {
    id: "WAVE-07",
    order: 7,
    complexity: 7,
    title: "Telegram ingestion and immutable snapshots",
    layer: "ingestion",
    summary: "Authenticated webhook ingress, channel allowlist, inbox leases, replay control, source provenance and hash-chained PostgreSQL snapshots.",
    capabilities: ["webhook-authentication", "durable-inbox", "replay-protection", "immutable-snapshots", "provenance"],
    dependsOn: ["WAVE-06"],
    deliveryState: "draft-open",
    branchRefs: ["feature/wave7-telegram-inbox-snapshots-v1"],
    pullRequests: [{ number: 33, state: "open", relation: "wave7-draft" }],
    requiredEvidence: ["webhook-security-tests", "snapshot-chain-tests", "replay-tests", "security-review"],
    lineageNote: "Telegram content is untrusted source data. It must never become executable instructions or override server-owned provenance.",
  },
  {
    id: "WAVE-08",
    order: 8,
    complexity: 8,
    title: "Staging composition and live connector gates",
    layer: "staging-composition",
    summary: "Staging-only server composition, strict parser, database preflight, rate limiting, explicit consent and operator-controlled webhook configuration.",
    capabilities: ["staging-server", "connector-preflight", "consent-gate", "postgres-readiness", "operator-webhook-setup"],
    dependsOn: ["WAVE-07"],
    deliveryState: "parallel-drafts-open",
    branchRefs: ["feature/wave8-staging-runtime-composition-v1", "feature/wave8-live-staging-connectors-v1"],
    pullRequests: [
      { number: 34, state: "open", relation: "staging-runtime-candidate" },
      { number: 35, state: "open", relation: "live-connectors-candidate" },
    ],
    requiredEvidence: ["staging-config-tests", "preflight-tests", "data-consent-review", "operator-runbook"],
    lineageNote: "Wave 8 has two separate drafts: server composition and live connector assembly. Combine only after checking migrations, config contracts and test fixtures for duplicate or incompatible definitions.",
  },
  {
    id: "WAVE-09",
    order: 9,
    complexity: 9,
    title: "Resilient staging operations",
    layer: "resilience",
    summary: "Replica-safe rate limiting, schema/readiness gates, ordered staging migrations, safe health responses and bounded operational recovery.",
    capabilities: ["multi-replica-limiter", "schema-preflight", "safe-readiness", "migration-order", "recovery-runbook"],
    dependsOn: ["WAVE-08"],
    deliveryState: "candidate-in-wave10-base",
    branchRefs: ["feature/wave9-resilient-staging-operations-v1", "feature/phase10-runtime-observatory-v1"],
    pullRequests: [{ number: 36, state: "open", relation: "phase10-cumulative-candidate" }],
    requiredEvidence: ["multi-replica-rate-limit-tests", "readiness-tests", "migration-gate-review", "operator-staging-attestation"],
    lineageNote: "Wave 9 behavior is present in the inspected Phase 10 candidate tree. The Wave 9 branch is still a separate ref; real PostgreSQL, Telegram, DNS and TLS checks remain operator-owned.",
  },
  {
    id: "WAVE-10",
    order: 10,
    complexity: 10,
    title: "Runtime Observatory and integrity hardening",
    layer: "observability",
    summary: "Typed operation lifecycle events, fail-closed observed execution, append-only PostgreSQL history, projection verification and a protected read API.",
    capabilities: ["operation-lifecycle", "hash-chain", "projection-integrity", "protected-read-api", "operation-ui-contract"],
    dependsOn: ["WAVE-09"],
    deliveryState: "parallel-drafts-open",
    branchRefs: [
      "feature/phase10-runtime-observatory-v1",
      "feature/wave10-observatory-hardening-remediation-v1",
      "feature/wave10-observatory-hardening-v1",
      "feature/wave1-10-progression-alignment-2026-11-20",
      "feature/wave1-10-observatory-http-integration-2026-11-20",
    ],
    pullRequests: [
      { number: 36, state: "open", merged: false, draft: true, relation: "observatory-core-draft" },
      { number: 38, state: "open", merged: false, draft: false, relation: "observatory-hardening-open-not-merged" },
      { number: 39, state: "closed", merged: true, draft: false, relation: "merged-into-phase10-candidate" },
      { number: 40, state: "closed", merged: true, draft: false, relation: "merged-into-wave10-remediation-branch" },
    ],
    requiredEvidence: [
      "observatory-integrity-tests",
      "read-api-auth-tests",
      "projection-tamper-tests",
      "ui-read-contract-tests",
      "operator-staging-attestation",
    ],
    lineageNote: "As inspected 2026-11-20: PR #40 is merged into feature/wave10-observatory-hardening-remediation-v1 (head bdda0df); PR #39 is merged separately into feature/phase10-runtime-observatory-v1 (head de5e3f0); PR #38 remains open and unmerged. Those candidate lines are divergent and must be reconciled before a canonical Wave 10 promotion. WP-10 PR #37 remains adjacent work on a separate worker-lease base.",
  },
];

function freezeRecord(record) {
  return Object.freeze({
    ...record,
    capabilities: Object.freeze([...record.capabilities]),
    dependsOn: Object.freeze([...record.dependsOn]),
    branchRefs: Object.freeze([...record.branchRefs]),
    pullRequests: Object.freeze(record.pullRequests.map((item) => Object.freeze({ ...item }))),
    requiredEvidence: Object.freeze([...record.requiredEvidence]),
  });
}

export const WAVE_REGISTRY = Object.freeze(records.map(freezeRecord));
export const WAVE_IDS = Object.freeze(WAVE_REGISTRY.map((wave) => wave.id));

export const WAVE_SOURCE_SNAPSHOT = Object.freeze({
  observedOn: "2026-11-20",
  main: Object.freeze({ ref: "main", sha: "ef3422809bbc54381a9ca3a15904727074ca0b16" }),
  alignmentMergedInto: Object.freeze({
    branch: "feature/wave10-observatory-hardening-remediation-v1",
    sha: "bdda0df167d529ddbb583afbbfde39482ab91f5d",
    pullRequest: 40,
  }),
  parallelPhase10Candidate: Object.freeze({
    branch: "feature/phase10-runtime-observatory-v1",
    sha: "de5e3f084464f8051f34544b5314bb22bc2a235a",
    pullRequest: 39,
  }),
  reconciliationRequired: true,
});

export function getWaveById(id) {
  return WAVE_REGISTRY.find((wave) => wave.id === id) ?? null;
}

export function validateWaveRegistry(registry = WAVE_REGISTRY) {
  const errors = [];
  if (!Array.isArray(registry) || registry.length !== 10) {
    return { ok: false, errors: ["WAVE_REGISTRY_MUST_CONTAIN_TEN_WAVES"] };
  }

  const positions = new Map();
  registry.forEach((wave, index) => {
    if (!wave || typeof wave !== "object") {
      errors.push("WAVE_RECORD_INVALID:" + index);
      return;
    }
    if (positions.has(wave.id)) errors.push("WAVE_ID_DUPLICATE:" + wave.id);
    positions.set(wave.id, index);
    if (wave.id !== "WAVE-" + String(index + 1).padStart(2, "0")) {
      errors.push("WAVE_ORDER_INVALID:" + String(wave.id));
    }
    if (wave.order !== index + 1 || wave.complexity !== index + 1) {
      errors.push("WAVE_COMPLEXITY_ORDER_INVALID:" + String(wave.id));
    }
    if (typeof wave.title !== "string" || !wave.title.trim()) {
      errors.push("WAVE_TITLE_REQUIRED:" + String(wave.id));
    }
    if (!DELIVERY_STATES.has(wave.deliveryState)) {
      errors.push("WAVE_DELIVERY_STATE_INVALID:" + String(wave.id));
    }
    if (!Array.isArray(wave.dependsOn) || !Array.isArray(wave.requiredEvidence) ||
        !Array.isArray(wave.branchRefs) || !Array.isArray(wave.pullRequests)) {
      errors.push("WAVE_COLLECTION_INVALID:" + String(wave.id));
      return;
    }
    if (new Set(wave.requiredEvidence).size !== wave.requiredEvidence.length) {
      errors.push("WAVE_EVIDENCE_DUPLICATE:" + wave.id);
    }
    for (const evidence of wave.requiredEvidence) {
      if (!EVIDENCE_KINDS.has(evidence)) errors.push("WAVE_EVIDENCE_KIND_INVALID:" + wave.id + ":" + evidence);
    }
    for (const branch of wave.branchRefs) {
      if (typeof branch !== "string" || !REF.test(branch) || branch.includes("..")) {
        errors.push("WAVE_BRANCH_REF_INVALID:" + wave.id);
      }
    }
    const prNumbers = new Set();
    for (const pr of wave.pullRequests) {
      if (!Number.isSafeInteger(pr.number) || pr.number < 1 ||
          !["open", "closed"].includes(pr.state) ||
          pr.merged !== undefined && typeof pr.merged !== "boolean" ||
          pr.draft !== undefined && typeof pr.draft !== "boolean" ||
          typeof pr.relation !== "string" || !pr.relation.trim()) {
        errors.push("WAVE_PULL_REQUEST_REF_INVALID:" + wave.id);
      }
      if (prNumbers.has(pr.number)) errors.push("WAVE_PULL_REQUEST_DUPLICATE:" + wave.id + ":" + pr.number);
      prNumbers.add(pr.number);
      if (pr.merged === true && pr.state !== "closed") {
        errors.push("WAVE_PULL_REQUEST_MERGED_STATE_INVALID:" + wave.id + ":" + pr.number);
      }
    }
  });

  registry.forEach((wave, index) => {
    for (const dependency of wave?.dependsOn ?? []) {
      const dependencyPosition = positions.get(dependency);
      if (dependencyPosition === undefined) {
        errors.push("WAVE_DEPENDENCY_UNKNOWN:" + wave.id + ":" + dependency);
      } else if (dependencyPosition >= index) {
        errors.push("WAVE_DEPENDENCY_NOT_EARLIER:" + wave.id + ":" + dependency);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

function readDenseStringArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes("length") ||
        keys.some((key) => typeof key !== "string" ||
          key !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(key))) return null;
    const result = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable ||
          typeof descriptor.value !== "string") return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function snapshotEvidenceRecord(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 3 || keys.some((key) =>
      typeof key !== "string" || !["kind", "ref", "verified"].includes(key))) return null;
    const values = Object.create(null);
    for (const key of ["kind", "ref", "verified"]) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
      values[key] = descriptor.value;
    }
    if (typeof values.kind !== "string" || !EVIDENCE_KINDS.has(values.kind) ||
        typeof values.ref !== "string" || !REF.test(values.ref) || values.ref.includes("..") ||
        typeof values.verified !== "boolean") return null;
    return Object.freeze(values);
  } catch {
    return null;
  }
}

/**
 * A wave gate requires an injected trusted evidence verifier. The verified field
 * is only part of the bounded evidence envelope; it is never trusted on its own.
 * Do not use this helper as the KRATT cryptographic authorization boundary.
 */
export function evaluateWaveGate(id, input = {}) {
  const wave = getWaveById(id);
  if (!wave) return { ok: false, eligible: false, reason: "WAVE_NOT_FOUND" };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" };
  }

  let completedInput;
  let evidenceInput;
  let verifyEvidence;
  try {
    const keys = Reflect.ownKeys(input);
    if (keys.some((key) =>
      typeof key !== "string" ||
      !["completedWaveIds", "evidence", "verifyEvidence"].includes(key))) {
      return { ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" };
    }
    const completedDescriptor = Object.getOwnPropertyDescriptor(input, "completedWaveIds");
    const evidenceDescriptor = Object.getOwnPropertyDescriptor(input, "evidence");
    const verifierDescriptor = Object.getOwnPropertyDescriptor(input, "verifyEvidence");
    if (completedDescriptor && !("value" in completedDescriptor) ||
        evidenceDescriptor && !("value" in evidenceDescriptor) ||
        verifierDescriptor && !("value" in verifierDescriptor)) {
      return { ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" };
    }
    completedInput = completedDescriptor ? completedDescriptor.value : [];
    evidenceInput = evidenceDescriptor ? evidenceDescriptor.value : [];
    verifyEvidence = verifierDescriptor ? verifierDescriptor.value : null;
  } catch {
    return { ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" };
  }

  const completedWaveIds = readDenseStringArray(completedInput, 10);
  if (!completedWaveIds || !Array.isArray(evidenceInput) || evidenceInput.length > 256 ||
      verifyEvidence !== null && typeof verifyEvidence !== "function") {
    return { ok: false, eligible: false, reason: "WAVE_GATE_INPUT_INVALID" };
  }

  const completed = new Set(completedWaveIds);
  const verifiedKinds = new Set();
  for (let index = 0; index < evidenceInput.length; index++) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(evidenceInput, String(index)); }
    catch { descriptor = null; }
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) continue;
    const evidence = snapshotEvidenceRecord(descriptor.value);
    if (!evidence || evidence.verified !== true || typeof verifyEvidence !== "function") continue;
    let verified = false;
    try { verified = verifyEvidence(evidence) === true; } catch { verified = false; }
    if (verified) verifiedKinds.add(evidence.kind);
  }

  const missingDependencies = wave.dependsOn.filter((dependency) => !completed.has(dependency));
  const missingEvidence = wave.requiredEvidence.filter((kind) => !verifiedKinds.has(kind));
  return Object.freeze({
    ok: true,
    waveId: wave.id,
    eligible: missingDependencies.length === 0 && missingEvidence.length === 0,
    missingDependencies: Object.freeze(missingDependencies),
    missingEvidence: Object.freeze(missingEvidence),
  });
}
