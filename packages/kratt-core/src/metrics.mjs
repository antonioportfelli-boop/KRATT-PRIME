/**
 * KRATT PRIME — evidence and operations metrics.
 * Counts observed evidence states only; deliberately no invented confidence score.
 */
const STATES=["OBSERVED","INFERRED","CONFIGURED","EXECUTED","VERIFIED","BLOCKED"];
export function aggregateEvidenceMetrics(events) {
  if(!Array.isArray(events)||events.length>100000) return {ok:false,reason:"METRIC_INPUT_INVALID"};
  const counts=Object.fromEntries(STATES.map(state=>[state,0]));
  const byType=Object.create(null);
  let digestCount=0;
  for(const event of events) {
    if(!event||!STATES.includes(event.decision)||typeof event.eventType!=="string")
      return {ok:false,reason:"METRIC_EVENT_INVALID"};
    counts[event.decision]++;
    byType[event.eventType]=(byType[event.eventType]??0)+1;
    if(typeof event.artifactDigest==="string") digestCount++;
  }
  return Object.freeze({
    ok:true,schemaVersion:"kratt-evidence-metrics/v1",totalEvents:events.length,
    decisionCounts:Object.freeze(counts),eventTypeCounts:Object.freeze({...byType}),
    artifactDigestCoverage:events.length?digestCount/events.length:null,
    caveat:"Digest coverage describes recorded hashes only; it is not a confidence or correctness score."
  });
}
