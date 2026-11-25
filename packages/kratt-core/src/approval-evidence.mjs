/**
 * WP-01 approval evidence primitives.
 * Signature verification and durable replay/revocation are injected production dependencies.
 */
const SAFE_REF = /^[a-z][a-z0-9._:-]{1,127}$/;
const isRecord = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const deny = (code, reason) => Object.freeze({ allowed: false, code, reason });
const VERIFIED_APPROVALS = new WeakSet();
const deepFreeze = (v) => {
  if (Array.isArray(v)) return Object.freeze(v.map(deepFreeze));
  if (isRecord(v)) return Object.freeze(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepFreeze(x)])));
  return v;
};

export function normalizeApprovalEnvelope(input) {
  if (!isRecord(input)) throw new TypeError("approval envelope must be an object");
  const refs = ["approvalId", "requestId", "principalRef", "agentRef", "provider", "operationId", "evidenceRef"];
  for (const key of refs) if (typeof input[key] !== "string" || !SAFE_REF.test(input[key])) throw new TypeError("invalid " + key);
  if (typeof input.target !== "string" || input.target.length < 1 || input.target.length > 512) throw new TypeError("invalid target");
  if (typeof input.nonce !== "string" || input.nonce.length < 16 || input.nonce.length > 256) throw new TypeError("invalid nonce");
  if (!Array.isArray(input.scopes) || input.scopes.length === 0 || input.scopes.some(x => typeof x !== "string" || !SAFE_REF.test(x)) || new Set(input.scopes).size !== input.scopes.length) throw new TypeError("scopes must be unique safe references");
  if (typeof input.destructive !== "boolean") throw new TypeError("destructive must be boolean");
  const issued = Date.parse(input.issuedAt), expires = Date.parse(input.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) throw new TypeError("invalid approval time window");
  return deepFreeze({
    schemaVersion: 1, approvalId: input.approvalId, requestId: input.requestId,
    principalRef: input.principalRef, agentRef: input.agentRef, provider: input.provider,
    operationId: input.operationId, target: input.target, scopes: [...input.scopes].sort(),
    issuedAt: new Date(issued).toISOString(), expiresAt: new Date(expires).toISOString(),
    nonce: input.nonce, evidenceRef: input.evidenceRef, destructive: input.destructive,
  });
}

/** verifier.verify(normalizedEnvelope) must validate signature, issuer, key status and evidence provenance. */
export async function verifyApprovalForRequest({ envelope, verifier, request, principalRef, agentRef, requiredScopes = [], now = Date.now(), maxLifetimeMs = 900000 }) {
  let approval;
  try { approval = normalizeApprovalEnvelope(envelope); }
  catch (error) { return deny("APPROVAL_INVALID", error.message); }
  if (!verifier || typeof verifier.verify !== "function") return deny("VERIFIER_UNAVAILABLE", "trusted approval verifier is required");
  if (!isRecord(request) || !Array.isArray(requiredScopes) || requiredScopes.some(x => typeof x !== "string")) return deny("REQUEST_INVALID", "request context is invalid");
  const issued = Date.parse(approval.issuedAt), expires = Date.parse(approval.expiresAt);
  if (issued > now) return deny("APPROVAL_NOT_YET_VALID", "approval issue time is in the future");
  if (expires <= now) return deny("APPROVAL_EXPIRED", "approval has expired");
  if (expires - issued > maxLifetimeMs) return deny("APPROVAL_LIFETIME_EXCEEDED", "approval lifetime exceeds policy");
  const binding = [[approval.requestId, request.requestId], [approval.principalRef, principalRef], [approval.agentRef, agentRef], [approval.provider, request.provider], [approval.operationId, request.operationId], [approval.target, request.target]];
  if (binding.some(([a, b]) => typeof b !== "string" || a !== b)) return deny("APPROVAL_BINDING_MISMATCH", "approval is not bound to this exact request and actor");
  if (!requiredScopes.every(scope => approval.scopes.includes(scope))) return deny("APPROVAL_SCOPE_MISSING", "approval does not cover all required scopes");
  if (request.destructive === true && approval.destructive !== true) return deny("DESTRUCTIVE_APPROVAL_REQUIRED", "destructive operation needs explicit destructive approval");
  let authentic = false;
  try { authentic = await verifier.verify(approval); } catch { return deny("VERIFIER_ERROR", "trusted verifier failed closed"); }
  if (authentic !== true) return deny("APPROVAL_UNTRUSTED", "approval authenticity was not established");
  const verified = Object.freeze({
    allowed: true, code: "APPROVAL_VERIFIED", approvalId: approval.approvalId,
    requestId: approval.requestId, provider: approval.provider, operationId: approval.operationId,
    target: approval.target, scopes: approval.scopes, expiresAt: approval.expiresAt,
    destructive: approval.destructive, evidenceRef: approval.evidenceRef, nonce: approval.nonce,
  });
  VERIFIED_APPROVALS.add(verified);
  return verified;
}

/** Single-process prototype only; replace with a durable transactional store before production. */
export class InMemoryApprovalLedger {
  #used = new Set();
  #revoked = new Set();
  consume(verifiedApproval, { now = Date.now() } = {}) {
    if (!verifiedApproval || !VERIFIED_APPROVALS.has(verifiedApproval) || verifiedApproval.code !== "APPROVAL_VERIFIED") return deny("APPROVAL_NOT_VERIFIED", "only verifier-produced approvals may be consumed");
    if (Date.parse(verifiedApproval.expiresAt) <= now) return deny("APPROVAL_EXPIRED", "approval has expired");
    if (this.#revoked.has(verifiedApproval.approvalId)) return deny("APPROVAL_REVOKED", "approval has been revoked");
    const key = verifiedApproval.approvalId + ":" + verifiedApproval.nonce;
    if (this.#used.has(key)) return deny("APPROVAL_REPLAYED", "approval nonce has already been consumed");
    this.#used.add(key);
    return Object.freeze({ allowed: true, code: "APPROVAL_CONSUMED", approvalId: verifiedApproval.approvalId });
  }
  revoke(approvalId) {
    if (typeof approvalId !== "string" || !SAFE_REF.test(approvalId)) throw new TypeError("invalid approvalId");
    this.#revoked.add(approvalId);
    return Object.freeze({ revoked: true, approvalId });
  }
  isRevoked(approvalId) { return this.#revoked.has(approvalId); }
}
