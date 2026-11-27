# 3XTRINITY security alignment — 2026–2027

**Review date:** 2026-11-27  
**Scope:** KRATT PRIME, 3XT Fabric, STEEL adapters, FRAME.9 and associated local-first runtime  
**Status:** engineering alignment plan, not a certification or government authorization

## 1. Reference frameworks and their status

| Source | Current status as reviewed | How the ecosystem should use it |
|---|---|---|
| NIST CSF 2.0 (2024) | Final | Governance and enterprise risk outcomes: Govern, Identify, Protect, Detect, Respond, Recover |
| NIST SP 800-207 | Final (2020) | Resource-centric Zero Trust, per-session access and dynamic policy |
| NIST SP 800-207A | Final (2023) | Cloud-native application/service identities and identity-tier policy enforcement |
| CISA Zero Trust Maturity Model v2.0 | Published guidance (2023) | Five pillars: Identity, Devices, Networks, Applications & Workloads, Data; cross-cutting Visibility & Analytics, Automation & Orchestration, Governance |
| NIST SP 800-53 Rev. 5 | Final | Tailored control catalogue and assessment evidence, not a one-size-fits-all checklist |
| NIST SP 800-218 SSDF 1.1 | Final | Secure development lifecycle practices |
| NIST SP 800-218 Rev. 1 / SSDF 1.2 | Initial public draft dated 2025-12-17; comment period closed 2026-01-30 | Track as draft input; do not claim conformance to a final 1.2 publication |
| SLSA specification v1.2 | Approved/current specification | Adopt both Build and Source tracks; verify builder identity, source revision, resolved dependencies, artifact subject and signed provenance |
| OWASP API Security Top 10:2023 | Published project guidance | Specifically address object/function authorization, resource consumption, SSRF, inventory and unsafe API consumption |
| OpenTelemetry messaging conventions | Messaging conventions are still marked Development in the consulted spec | Adopt with version pinning and semantic-convention migration controls |

## 2. Architectural mapping

### Identity and authorization
- Preserve request-bound approvals and bind them to subject, agent, adapter, operation, resource target, scopes, expiry and canonical request digest.
- Re-evaluate authorization at the effect boundary; a grant is short-lived and cannot be replayed.
- Effective authority is the intersection of principal, agent and integration policy. Explicit deny takes precedence.
- Bind service and workload identity to independently verifiable platform identity; names and network location are not proof of identity.
- Tenant identity must be part of every durable key, query predicate, audit partition and object-level authorization decision before multi-tenant deployment.

### Adapter and workload isolation
- Keep untrusted adapter code out of the KRATT control-plane process.
- Require process/container isolation with read-only artifact mount, ephemeral writable scratch, memory/CPU/time limits, restricted egress and no ambient credentials.
- Use short-lived, audience-bound credentials or opaque credential references. Never pass raw secrets inside event payloads, invocation objects or logs.
- Re-check registration revision, artifact digest, grant expiry, cancellation state and fencing token at the effect boundary.

### Supply-chain integrity
- Pin source repository, immutable commit, file path and artifact digest.
- Require signed SLSA v1.2 build provenance and verify it against an explicit trusted-builder policy. Add Source Track controls for source provenance, protected review/change management and verified source history; provenance alone is not proof that the artifact is safe.
- Generate SBOMs, scan dependencies and containers, sign release artifacts, and retain attestations with the release evidence.
- Prefer isolated reusable CI workflows and least-privilege job permissions; separate source build authority from release/promotion authority.

### Data, audit and recovery
- Keep the 3XT event envelope closed-schema, versioned, size/depth bounded, signed and replay-resistant.
- Store nonce consumption, intent, outbox reservation and audit record atomically.
- Use append-only, tamper-evident audit with independent checkpoints and tested backup/restore.
- Establish explicit retention, data classification, encryption, key rotation, deletion and residency policies before public-sector or regulated workloads.
- Fail closed when identity, trusted time, policy, key status, audit persistence or lease fencing cannot be established.

### Detection and response
- Correlate event, request, task, invocation, worker lease and trace identifiers.
- Record policy denials, stale approval, replay attempts, adapter provenance changes, isolation verification failures, rate-limit pressure and dead-letter transitions.
- Build incident playbooks for compromised signing keys, poisoned adapters, provider compromise, worker takeover, journal tampering and data exposure.
- Test restore, containment and key revocation as operational exercises, not only unit tests.

## 3. Performance model — speed without loss of control

The governing idea is useful, correctly authorised information delivered per unit time:

effective throughput = accepted, verified, policy-compliant results / elapsed time

Optimise each layer independently:
1. Admission: bounded queue, request-size caps, tenant/provider quotas and back-pressure.
2. Routing: local cache only for immutable or versioned metadata; never cache mutable authorization indefinitely.
3. Execution: bounded concurrency, per-provider rate limits, short deadlines and cancellation propagation.
4. Storage: indexed idempotency keys, append-only audit partitions and batched reads; do not trade away atomic reservation.
5. Network: regional placement and connection reuse where lawful; no bypass of TLS, identity or egress policy.
6. Recovery: retry only idempotent/deduplicated work with jittered backoff; dead-letter ambiguous effects for reconciliation.

### Required SLO candidates (to be measured, not claimed)
- Authorization decision latency: p50/p95/p99 measured separately for local policy evaluation and cryptographic verification.
- Intake-to-first-evidence latency: p50/p95/p99 by source type.
- Queue age and oldest-message age: alert on sustained growth.
- Delivery success, duplicate suppression, retry and dead-letter rates.
- Worker concurrency, active lease count, lease expiry, provider rate-limit response and database lock/wait time.
- Recovery point objective and recovery time objective proven by restore exercises.

No numeric latency target should be declared until the hardware, provider mix, data class, load profile and failure model are defined. Establish baselines, then set service-specific targets and error budgets.

## 4. Priority work after Wave 12

| Priority | Work item | Exit evidence |
|---|---|---|
| P0 | Tenant-bound identity and storage partitioning | Cross-tenant adversarial tests; DB row-level policy or equivalent isolation |
| P0 | Production-grade effect-boundary fence | Revocation/cancellation/key-rotation race tests against shared storage |
| P0 | Verified process/container supervisor | Platform attestation, syscall/network/filesystem controls and isolation break-out tests |
| P1 | Signed provenance + SBOM release chain | Verified SLSA provenance and signed artifact verification in CI |
| P1 | Durable audit retention and external checkpoints | Restore, tamper, retention and access-review evidence |
| P1 | Per-provider rate limits and timeout contracts | Contract tests with 429/timeout/duplicate/slow-provider scenarios |
| P2 | OpenTelemetry traces and service dashboards | Redacted metrics, trace correlation and queue saturation alerts |
| P2 | Disaster recovery and incident drills | Timed restore and containment evidence |
| P2 | Control mapping for target public-sector jurisdiction | Named system owner, data classification, legal review and independent assessment |

## 5. Explicit limitations

The current codebase is not NIST-certified, FIPS-validated, CISA-certified, accredited for classified information, or approved for national critical infrastructure. NIST and CISA frameworks are reference models; the applicable jurisdiction, system categorisation, legal basis, threat model, procurement rules, cryptographic requirements and independent assessment determine the actual authorization path.

## 6. Primary source register

The following are the authoritative publication pages used for this alignment. Version and publication status must be re-checked when a control baseline is approved.

- NIST Cybersecurity Framework 2.0: https://doi.org/10.6028/NIST.CSWP.29
- NIST SP 800-207, Zero Trust Architecture: https://doi.org/10.6028/NIST.SP.800-207
- NIST SP 800-207A, Zero Trust Architecture Model for Access Control in Cloud-Native Applications in Multi-Cloud Environments: https://doi.org/10.6028/NIST.SP.800-207A
- CISA Zero Trust Maturity Model v2.0: https://www.cisa.gov/sites/default/files/2023-04/zero_trust_maturity_model_v2_508.pdf
- NIST SP 800-53 Rev. 5: https://csrc.nist.gov/pubs/sp/800/53/r5/final
- NIST SP 800-218 / SSDF 1.1: https://csrc.nist.gov/pubs/sp/800/218/final
- NIST SP 800-218 Rev. 1 / SSDF 1.2 Initial Public Draft: https://csrc.nist.gov/pubs/sp/800/218/r1/ipd
- SLSA specification v1.2 (approved): https://slsa.dev/spec/v1.2/\n- SLSA v1.2 Build Provenance: https://slsa.dev/spec/v1.2/build-provenance\n- SLSA v1.2 Source Track: https://slsa.dev/spec/v1.2/source
- GitHub artifact attestations: https://docs.github.com/en/actions/concepts/security/artifact-attestations
- OWASP API Security Project / API Security Top 10: https://owasp.org/projects/api-security-project
- OpenTelemetry messaging metrics semantic conventions: https://opentelemetry.io/docs/specs/semconv/messaging/messaging-metrics/

OpenTelemetry messaging conventions and NIST SSDF 1.2 were treated as draft/development material in the reviewed snapshot. Do not use their identifiers as proof of a final standard or certification.
