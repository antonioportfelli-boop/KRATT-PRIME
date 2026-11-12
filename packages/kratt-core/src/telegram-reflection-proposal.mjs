import { createHash } from "node:crypto";

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function canonical(value, active = new WeakSet(), path = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`REFLECTION_PROPOSAL_NON_FINITE_NUMBER:${path}`);
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (!value || typeof value !== "object" || active.has(value)) {
    throw new TypeError(`REFLECTION_PROPOSAL_NON_CANONICAL_VALUE:${path}`);
  }
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new TypeError(`REFLECTION_PROPOSAL_ARRAY_SHAPE_INVALID:${path}`);
      const items = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`REFLECTION_PROPOSAL_ARRAY_ITEM_INVALID:${path}[${index}]`);
        }
        items.push(canonical(descriptor.value, active, `${path}[${index}]`));
      }
      return `[${items.join(",")}]`;
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new TypeError(`REFLECTION_PROPOSAL_OBJECT_PROTOTYPE_INVALID:${path}`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== "string")) throw new TypeError(`REFLECTION_PROPOSAL_SYMBOL_KEY:${path}`);
    return `{${keys.sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError(`REFLECTION_PROPOSAL_ACCESSOR_OR_HIDDEN_FIELD:${path}.${String(key)}`);
      }
      return `${JSON.stringify(key)}:${canonical(descriptor.value, active, `${path}.${key}`)}`;
    }).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function freezeDeep(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function validTime(value) {
  return typeof value === "string" && ISO_UTC.test(value) && Number.isFinite(Date.parse(value));
}

/**
 * Build a non-mutating Reflection Matrix proposal from a durably persisted,
 * architect-signed APPROVE decision. RootDelta remains opaque and is produced
 * by the canonical integration supplied by the host; this module does not
 * define RootDelta semantics, persist proposals, or perform compare-and-swap.
 */
export function createTelegramReflectionProposalService({
  decisionStore,
  projectionService,
  buildRootDelta,
} = {}) {
  if (!decisionStore || typeof decisionStore.getDecision !== "function" ||
      typeof decisionStore.getReviewRequest !== "function" ||
      !projectionService || typeof projectionService.get !== "function" ||
      typeof buildRootDelta !== "function") {
    throw new TypeError("TELEGRAM_REFLECTION_PROPOSAL_ADAPTERS_REQUIRED");
  }

  return Object.freeze({
    async createProposal({ requestId } = {}) {
      if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 192) {
        return Object.freeze({ status: "DENY", reason: "REFLECTION_PROPOSAL_REQUEST_ID_INVALID" });
      }

      let storedRequest, decision;
      try {
        storedRequest = decisionStore.getReviewRequest(requestId);
        decision = decisionStore.getDecision(requestId);
      } catch {
        return Object.freeze({ status: "ERROR", reason: "REFLECTION_PROPOSAL_DECISION_READ_FAILED" });
      }
      if (!storedRequest || storedRequest.state !== "CONSUMED" || !storedRequest.request ||
          !decision || decision.requestId !== requestId) {
        return Object.freeze({ status: "BLOCKED", reason: "REFLECTION_PROPOSAL_REQUIRES_DURABLE_DECISION" });
      }
      const request = storedRequest.request;
      if (decision.schemaVersion !== "kratt-telegram-validation-decision/v1" ||
          decision.decision !== "APPROVE" || typeof decision.decisionId !== "string" ||
          !validTime(decision.verifiedAt) || decision.claimId !== request.claimId ||
          decision.targetDigest !== request.targetDigest ||
          decision.evidenceSnapshotDigest !== request.evidenceSnapshotDigest ||
          decision.rootDigest !== request.rootDigest ||
          decision.policyVersion !== request.policyVersion) {
        return Object.freeze({ status: "DENY", reason: "REFLECTION_PROPOSAL_DECISION_BINDING_INVALID" });
      }

      let projection;
      try {
        projection = await projectionService.get(decision.claimId);
      } catch {
        return Object.freeze({ status: "ERROR", reason: "REFLECTION_PROPOSAL_PROJECTION_UNAVAILABLE" });
      }
      if (!projection || projection.readOnly !== true || projection.truthVerdict !== "NOT_ASSERTED" ||
          projection.claimId !== decision.claimId || projection.claimDigest !== decision.targetDigest ||
          projection.evidenceSnapshotDigest !== decision.evidenceSnapshotDigest ||
          projection.rootDigest !== decision.rootDigest ||
          !Number.isSafeInteger(projection.rootVersion) || projection.rootVersion < 0) {
        return Object.freeze({ status: "BLOCKED", reason: "REFLECTION_PROPOSAL_STALE_OR_UNVERIFIED_PROJECTION" });
      }

      let rootDelta;
      try {
        rootDelta = await buildRootDelta(Object.freeze({
          decision,
          projection,
          expectedRoot: Object.freeze({
            rootVersion: projection.rootVersion,
            rootDigest: projection.rootDigest,
          }),
        }));
      } catch {
        return Object.freeze({ status: "ERROR", reason: "REFLECTION_PROPOSAL_DELTA_BUILDER_FAILED" });
      }

      let deltaCanonical;
      try {
        deltaCanonical = canonical(rootDelta);
      } catch {
        return Object.freeze({ status: "DENY", reason: "REFLECTION_PROPOSAL_DELTA_NOT_CANONICAL" });
      }
      if (!rootDelta || Array.isArray(rootDelta) || typeof rootDelta !== "object" ||
          Object.getPrototypeOf(rootDelta) !== Object.prototype || deltaCanonical.length > 131072) {
        return Object.freeze({ status: "DENY", reason: "REFLECTION_PROPOSAL_DELTA_SHAPE_OR_SIZE_INVALID" });
      }

      const payload = {
        schemaVersion: "kratt-telegram-reflection-proposal/v1",
        status: "PROPOSAL_ONLY",
        applyStatus: "NOT_APPLIED",
        decisionId: decision.decisionId,
        requestId,
        claimId: decision.claimId,
        targetDigest: decision.targetDigest,
        evidenceSnapshotDigest: decision.evidenceSnapshotDigest,
        policyVersion: decision.policyVersion,
        expectedRootVersion: projection.rootVersion,
        expectedRootDigest: projection.rootDigest,
        rootDeltaDigest: sha256(deltaCanonical),
        rootDelta,
        createdFromVerifiedDecisionAt: decision.verifiedAt,
      };
      const proposalDigest = sha256(canonical(payload));
      return Object.freeze({
        status: "OK",
        reason: "REFLECTION_PROPOSAL_CREATED_NOT_APPLIED",
        proposal: freezeDeep({ ...payload, proposalId: `reflection-proposal:${proposalDigest.slice(7)}`, proposalDigest }),
      });
    },
  });
}
