/** Audited 3XTRINITY repository and integration-readiness snapshot.
 * Descriptive only: never authenticates, resolves credentials, deploys or writes externally.
 */
export const PORTFOLIO_SCHEMA = "3xtrinity.platform-portfolio.v1";
export const MATURITY = Object.freeze({ CORE: "CORE", ACTIVE: "ACTIVE_APPLICATION", PROTOTYPE: "PROTOTYPE", EXPERIMENTAL: "EXPERIMENTAL" });
export const READINESS = Object.freeze({ DOCUMENTED: "DOCUMENTED_ONLY", CONTRACT: "CONTRACT_IN_PROGRESS", DEMO: "DEMO_ONLY", READ_ONLY: "VERIFIED_READ_ONLY", WRITE: "WRITE_ENABLED", DISABLED: "DISABLED" });
export const OPERATION = Object.freeze({ READ: "READ", WRITE: "EXTERNAL_WRITE", DESTRUCTIVE: "DESTRUCTIVE_WRITE" });
const idPattern = /^[a-z][a-z0-9-]{1,63}$/;
const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const secretKey = /(^|[_-])(api.?key|access.?token|refresh.?token|password|private.?key|client.?secret|authorization)$/i;
const freeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const hasSecretKey = value => Array.isArray(value) ? value.some(hasSecretKey) :
  !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => secretKey.test(key) || hasSecretKey(child));

export const PLATFORM_PORTFOLIO = freeze({
  schemaVersion: PORTFOLIO_SCHEMA,
  observedAt: "2026-11-26T10:00:00+02:00",
  reviewScope: "Connected GitHub visibility; not a complete private-organization audit",
  systems: [
    { id: "kratt-prime", name: "KRATT PRIME", repository: "antonioportfelli-boop/KRATT-PRIME", defaultBranch: "main", developmentBranches: ["feature/wp01-approval-evidence-engine-2026-11-25", "feature/integration-capability-registry-v1-2026-11-25", "feature/phase11-wave10-reconciled-2026-11-23"], maturity: MATURITY.CORE, evidence: ["packages/kratt-core/src", "packages/kratt-runtime/src", "packages/kratt-orchestrator/src", "packages/kratt-core/test", "products/kratt-prime-console"], caveats: ["Root README, package name and src/App.tsx currently identify/render AURA; KRATT PRIME Console exists separately under products/kratt-prime-console.", "Integration registry expansion remains in an open draft PR."] },
    { id: "steel", name: "STEEL", repository: "3XTRINITY-CORPORATION-AND-SOFTWARE/STEEL-3XTRINITY-CORPORATION-OFFICIAL-APP-", defaultBranch: "main", developmentBranches: ["feat/kratt-dual-ai-wave444", "feature/3xt-fabric-v1-event-contract"], maturity: MATURITY.ACTIVE, evidence: ["src/components", "factory/dispatcher.ts", "factory/protocol", "factory/tests", "cerberus/core", ".github/workflows/ci.yml"], caveats: ["Latest observed full Vite CI success on main is 2026-11-11; rerun full CI before release.", "Dual-AI and Fabric v1 changes are feature-branch work, not confirmed in main."] },
    { id: "frame-9", name: "FRAME.9", repository: "antonioportfelli-boop/FRAME.9", defaultBranch: "main", developmentBranches: ["Forge.-9"], maturity: MATURITY.ACTIVE, evidence: ["src/components", "src/lib/signal", "src/routes/api", "scripts", ".github/workflows/ci.yml"], caveats: ["README identifies Forge.-9 as the development branch and main as stable base.", "A recent Dependabot run on Forge.-9 failed; full current CI needs a fresh run."] },
    { id: "aura", name: "AURA", repository: "3XTRINITY-CORPORATION-AND-SOFTWARE/AURA-3XTRINITY-CORPORATION-SOFTWARE-OFFICIAL-visualizer-programm", defaultBranch: "main", developmentBranches: [], maturity: MATURITY.PROTOTYPE, evidence: ["src/App.tsx", "src", "programs"], caveats: ["Visualizer spectrum is simulated; live microphone or STEEL audio integration is not established.", "OS and Android surfaces are described as planned."] },
  ],
  components: [
    { id: "goliath-kernel", ownerSystem: "kratt-prime", repository: "antonioportfelli-boop/KRATT-PRIME", path: "packages/goliath-kernel", maturity: MATURITY.EXPERIMENTAL, caveat: "Rust user-space analysis library and XDP/eBPF source specimen; not a production kernel agent or firewall." },
  ],
  integrations: [
    { id: "kratt-steel-fabric", source: "kratt-prime", target: "steel", contract: "3XT Fabric v1", evidenceBranch: "feature/3xt-fabric-v1-event-contract", readiness: READINESS.CONTRACT, externalWrites: "DENY", approvalRequired: true, caveat: "Fabric v1 code and tests exist on a STEEL feature branch; no live cross-repository runtime was verified." },
    { id: "kratt-frame9", source: "kratt-prime", target: "frame-9", contract: "KRATT topology / adapter contract", evidenceBranch: "feature/kratt-antikythera-topology-v0", readiness: READINESS.DOCUMENTED, externalWrites: "DENY", approvalRequired: true, caveat: "Related branches exist; no verified live adapter or end-to-end connection was confirmed." },
    { id: "steel-aura-visualizer", source: "steel", target: "aura", contract: "Visualizer synchronization", evidenceBranch: null, readiness: READINESS.DEMO, externalWrites: "DENY", approvalRequired: true, caveat: "AURA is designed to sync with STEEL; live event/audio synchronization was not verified." },
  ],
});

export function validatePlatformPortfolio(input = PLATFORM_PORTFOLIO) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: ["PORTFOLIO_NOT_OBJECT"] };
  if (hasSecretKey(input)) errors.push("PORTFOLIO_SECRET_FIELD_FORBIDDEN");
  if (input.schemaVersion !== PORTFOLIO_SCHEMA) errors.push("PORTFOLIO_SCHEMA_UNSUPPORTED");
  if (typeof input.observedAt !== "string" || !Number.isFinite(Date.parse(input.observedAt))) errors.push("PORTFOLIO_OBSERVED_AT_INVALID");
  if (!Array.isArray(input.systems) || !input.systems.length || !Array.isArray(input.components) || !Array.isArray(input.integrations)) return { ok: false, errors: [...errors, "PORTFOLIO_COLLECTIONS_REQUIRED"] };
  const systems = new Map(); const repos = new Set();
  for (const system of input.systems) {
    if (!system || !idPattern.test(system.id || "")) { errors.push("SYSTEM_ID_INVALID"); continue; }
    if (systems.has(system.id)) errors.push("SYSTEM_ID_DUPLICATE:" + system.id);
    systems.set(system.id, system);
    if (!repoPattern.test(system.repository || "")) errors.push("SYSTEM_REPOSITORY_INVALID:" + system.id);
    else if (repos.has(system.repository)) errors.push("SYSTEM_REPOSITORY_DUPLICATE:" + system.repository);
    else repos.add(system.repository);
    if (!system.defaultBranch || typeof system.defaultBranch !== "string") errors.push("SYSTEM_DEFAULT_BRANCH_INVALID:" + system.id);
    if (!Object.values(MATURITY).includes(system.maturity)) errors.push("SYSTEM_MATURITY_INVALID:" + system.id);
    if (!Array.isArray(system.evidence) || !system.evidence.length) errors.push("SYSTEM_EVIDENCE_REQUIRED:" + system.id);
  }
  const componentIds = new Set();
  for (const component of input.components) {
    if (!component || !idPattern.test(component.id || "")) { errors.push("COMPONENT_ID_INVALID"); continue; }
    if (componentIds.has(component.id)) errors.push("COMPONENT_ID_DUPLICATE:" + component.id);
    componentIds.add(component.id);
    const owner = systems.get(component.ownerSystem);
    if (!owner) errors.push("COMPONENT_OWNER_UNKNOWN:" + component.id);
    if (!owner || owner.repository !== component.repository) errors.push("COMPONENT_REPOSITORY_OWNER_MISMATCH:" + component.id);
    if (typeof component.path !== "string" || component.path.startsWith("/") || component.path.split("/").includes("..")) errors.push("COMPONENT_PATH_INVALID:" + component.id);
    if (!Object.values(MATURITY).includes(component.maturity)) errors.push("COMPONENT_MATURITY_INVALID:" + component.id);
  }
  const edgeIds = new Set();
  for (const edge of input.integrations) {
    if (!edge || !idPattern.test(edge.id || "")) { errors.push("INTEGRATION_ID_INVALID"); continue; }
    if (edgeIds.has(edge.id)) errors.push("INTEGRATION_ID_DUPLICATE:" + edge.id);
    edgeIds.add(edge.id);
    if (!systems.has(edge.source) || !systems.has(edge.target)) errors.push("INTEGRATION_ENDPOINT_UNKNOWN:" + edge.id);
    if (edge.source === edge.target) errors.push("INTEGRATION_SELF_EDGE:" + edge.id);
    if (!Object.values(READINESS).includes(edge.readiness)) errors.push("INTEGRATION_READINESS_INVALID:" + edge.id);
    if (!["DENY", "APPROVAL_GATED"].includes(edge.externalWrites)) errors.push("INTEGRATION_WRITE_POLICY_INVALID:" + edge.id);
    if (edge.externalWrites === "APPROVAL_GATED" && edge.approvalRequired !== true) errors.push("INTEGRATION_APPROVAL_REQUIRED:" + edge.id);
    if (edge.readiness !== READINESS.WRITE && edge.externalWrites !== "DENY") errors.push("INTEGRATION_UNVERIFIED_WRITE_POLICY:" + edge.id);
  }
  return { ok: errors.length === 0, errors };
}

/** A readiness guard only; real writes still require WP-01 trusted verification and authorized dispatch. */
export function evaluatePlatformIntegration({ integrationId, operationClass, approvalVerified = false } = {}) {
  if (typeof integrationId !== "string" || !Object.values(OPERATION).includes(operationClass)) return Object.freeze({ allowed: false, code: "INVALID_INTEGRATION_REQUEST" });
  const edge = PLATFORM_PORTFOLIO.integrations.find(item => item.id === integrationId);
  if (!edge) return Object.freeze({ allowed: false, code: "INTEGRATION_NOT_FOUND" });
  if (edge.readiness === READINESS.DISABLED) return Object.freeze({ allowed: false, code: "INTEGRATION_DISABLED" });
  if (operationClass === OPERATION.READ) {
    if (![READINESS.READ_ONLY, READINESS.WRITE].includes(edge.readiness)) return Object.freeze({ allowed: false, code: "INTEGRATION_NOT_VERIFIED" });
    return Object.freeze({ allowed: true, code: "READ_ALLOWED", sideEffect: "NONE" });
  }
  if (edge.readiness !== READINESS.WRITE || edge.externalWrites !== "APPROVAL_GATED") return Object.freeze({ allowed: false, code: "EXTERNAL_WRITE_NOT_ENABLED" });
  if (approvalVerified !== true) return Object.freeze({ allowed: false, code: "APPROVAL_NOT_VERIFIED" });
  if (operationClass === OPERATION.DESTRUCTIVE && edge.destructiveApprovalRequired !== true) return Object.freeze({ allowed: false, code: "DESTRUCTIVE_APPROVAL_REQUIRED" });
  return Object.freeze({ allowed: true, code: "WRITE_ALLOWED", sideEffect: operationClass });
}