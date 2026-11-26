import { validateFabricEvent, FABRIC_EVENT_SCHEMA } from "./fabric-event.mjs";

export const STEEL_FABRIC_PROTOCOL = "3XT-FABRIC/1";
export const STEEL_FABRIC_ADAPTER_FIELDS = Object.freeze([
  "destination_node", "source_revision", "issued_at", "expires_at", "scope",
  "payload_reference", "evidence_references", "key_id", "content_digest", "signature",
]);

/**
 * Assess a validated KRATT envelope against the STEEL wire contract.
 * This is deliberately not a converter: absent trust metadata must never be guessed,
 * and this function has no signing, network or persistence capability.
 */
export function assessKrattToSteelFabricCompatibility(input) {
  const validated = validateFabricEvent(input);
  if (!validated.ok) {
    return Object.freeze({
      ok: false, wireCompatible: false, code: "KRATT_EVENT_INVALID",
      errors: Object.freeze([...validated.errors]),
    });
  }
  return Object.freeze({
    ok: true,
    wireCompatible: false,
    code: "TRUSTED_ADAPTER_REQUIRED",
    sourceProtocol: FABRIC_EVENT_SCHEMA,
    targetProtocol: STEEL_FABRIC_PROTOCOL,
    missingTargetFields: STEEL_FABRIC_ADAPTER_FIELDS,
    semanticDecisionsRequired: Object.freeze([
      "occurred_at cannot be silently relabelled as issued_at",
      "causation_id cannot be silently relabelled as parent_event_id",
      "source.agent_id and source.component must be preserved or mapped by an explicit contract",
      "scope must be derived from trusted server-side policy, not copied from an untrusted payload",
      "source_revision, key_id, content_digest and signature require trusted provenance and cryptographic handling",
    ]),
    dispatchAllowed: false,
  });
}