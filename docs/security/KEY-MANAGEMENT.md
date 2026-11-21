# Key Management and Approval Trust
Status: Operational design required before production writes

## Key separation
Signing private keys remain in deployment-controlled KMS/HSM or approved secret manager. Runtime receives only minimum required key material. Approval verification uses trusted public-key registry with key ID, approver identity, allowed authorities, validity interval and revocation status. Test keys are ephemeral and never reused in production.

## Lifecycle
1. Generate keys in approved secure environment.
2. Record key ID, algorithm, owner, purpose and validity metadata.
3. Distribute public verification material through authenticated configuration.
4. Rotate before expiry and support overlap during migration.
5. Revoke compromised/departed approver keys and propagate revocation promptly.
6. Audit lifecycle events without logging private material.
7. Test restore and emergency rotation procedures.

## Approval verification
Use Ed25519 over canonical, versioned UTF-8 payload. Canonicalization must be deterministic and reject unknown/duplicate fields. Sign exact task digest, actor, provider, operation, target, nonce, time window, approver, authority and key ID.

## Nonce and storage
Nonce consumption must be atomic, durable and shared by all instances that can authorize the same approval. SQLite is limited to a single-host profile with tested durability; multi-host deployments require shared transactional storage or asynchronous authorization redesign.

## Production gate
No production private-key generation, provisioning, rotation or external write enablement is included in this documentation change. These require explicit operational approval.