import { deflateSync } from "node:zlib";

const MAX_HTML_BYTES = 32_768;
const MAX_COMPRESSED_BYTES = 4_096;
const MAX_CHAT_DATA_BYTES = 1_024;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

function safeDigest(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value : "not verified";
}

function evidenceRows(items, label) {
  if (!Array.isArray(items) || items.length === 0) return `<p class="muted">No ${label.toLowerCase()} evidence attached.</p>`;
  return items.slice(0, 4).map(item => {
    const title = escapeHtml(item.publisher ?? item.sourceId ?? item.evidenceId ?? "Source");
    const excerpt = escapeHtml(item.excerpt ?? item.summary ?? item.relation ?? "No excerpt supplied.");
    const digest = escapeHtml(safeDigest(item.digest ?? item.evidenceDigest));
    return `<article class="evidence"><strong>${title}</strong><p>${excerpt}</p><small>${digest}</small></article>`;
  }).join("");
}

function buildHtml(projection) {
  const claim = escapeHtml(projection.claimText ?? projection.proposition ?? projection.claimId);
  const status = escapeHtml(projection.claimStatus ?? "UNREVIEWED");
  const sources = evidenceRows(projection.sourceRefs, "Source");
  const supporting = evidenceRows((projection.evidenceLinks ?? []).filter(item => item.relation === "SUPPORTS"), "Supporting");
  const contradicting = evidenceRows((projection.evidenceLinks ?? []).filter(item => item.relation === "CONTRADICTS"), "Contradicting");
  const contradictions = Array.isArray(projection.contradictions) ? projection.contradictions.slice(0, 3).map(item =>
    `<li>${escapeHtml(item.summary ?? item.description ?? item.candidateId ?? "Contradiction candidate")}</li>`
  ).join("") : "";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{color-scheme:light dark;font:14px system-ui,sans-serif}body{margin:0;padding:12px;color:var(--tg-theme-text-color,#222);background:transparent}h3{font-size:16px;margin:0 0 8px}.muted,small{color:var(--tg-theme-hint-color,#777)}.status{display:inline-block;padding:3px 8px;border-radius:10px;background:var(--tg-theme-secondary-bg-color,#eee);font-size:11px;margin-bottom:8px}.section{margin-top:12px}.section h4{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--tg-theme-hint-color,#777);margin:0 0 6px}.evidence{padding:8px;margin:5px 0;border-radius:8px;background:var(--tg-theme-secondary-bg-color,#eee)}.evidence p{margin:4px 0;font-size:13px}.evidence small{font-size:10px;overflow-wrap:anywhere}.actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}button{border:0;border-radius:8px;padding:9px 11px;background:var(--tg-theme-button-color,#2481cc);color:var(--tg-theme-button-text-color,#fff);font:600 12px system-ui;min-height:36px}button.secondary{background:var(--tg-theme-secondary-bg-color,#ddd);color:var(--tg-theme-text-color,#222)}button:disabled{opacity:.45}.result{min-height:18px;margin-top:8px;color:var(--tg-theme-hint-color,#777);font-size:12px}ul{padding-left:18px;margin:4px 0}
</style></head><body>
<h3>KRATT · Claim Review</h3><span class="status">${status}</span>
<p>${claim}</p>
<section class="section"><h4>Source lineage</h4>${sources}</section>
<section class="section"><h4>Supporting evidence</h4>${supporting}</section>
<section class="section"><h4>Contradicting evidence</h4>${contradicting}</section>
${contradictions ? `<section class="section"><h4>Contradiction candidates</h4><ul>${contradictions}</ul></section>` : ""}
<section class="section"><small>Claim digest: ${escapeHtml(safeDigest(projection.claimDigest))}</small><br><small>Evidence snapshot: ${escapeHtml(safeDigest(projection.evidenceSnapshotDigest))}</small><br><small>Root snapshot: ${escapeHtml(safeDigest(projection.rootDigest))}</small></section>
<div class="actions">
<button data-action="intent:APPROVE">Approve intent</button>
<button class="secondary" data-action="intent:REJECT:SOURCE_CONTRADICTED">Reject · contradicted</button>
<button class="secondary" data-action="intent:CONTEST:INSUFFICIENT_CONTEXT">Contest · context</button>
<button class="secondary" data-action="intent:ABSTAIN:NEED_MORE_EVIDENCE">Abstain</button>
</div>
<div id="result" class="result" role="status">Decision intent requires a separate signed confirmation.</div>
<script>
(function(){
 const W=window.TelegramWidget;
 const result=document.getElementById("result");
 const buttons=Array.from(document.querySelectorAll("button[data-action]"));
 function setBusy(busy){buttons.forEach(button=>{button.disabled=busy;});}
 buttons.forEach(button=>button.addEventListener("click",function(){
   if(!W||typeof W.request!=="function"){result.textContent="Widget requests are unavailable.";return;}
   setBusy(true);result.textContent="Submitting decision intent…";
   W.request(button.getAttribute("data-action")).then(function(answer){
     result.textContent=answer&&answer.result?answer.result:"Intent received. Awaiting signed confirmation.";
   }).catch(function(error){
     result.textContent="Request not accepted: "+String(error&&error.code||"FAILED");
   }).finally(function(){setBusy(false);});
 }));
 function refreshFromState(){
   if(!W||!W.chatData)return;
   try{const state=JSON.parse(W.chatData);if(state&&state.status==="SIGNED"){result.textContent="Signed decision recorded.";setBusy(true);}
   else if(state&&state.status==="PENDING_SIGNATURE"){result.textContent="Intent recorded. Complete the separate signature step.";}}
   catch(_error){}
 }
 if(W&&typeof W.onEvent==="function")W.onEvent("chatDataChanged",refreshFromState);
 refreshFromState();
})();
</script></body></html>`;
}

/**
 * Build a self-contained Telegram HTML widget. The HTML is fixed after send;
 * only bot-written chat_data may change. Widget actions submit intents only.
 */
export function renderClaimReviewWidget({ projection, request } = {}) {
  if (!projection || typeof projection !== "object" ||
      typeof projection.claimId !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(projection.claimDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(projection.evidenceSnapshotDigest ?? "") ||
      !/^sha256:[0-9a-f]{64}$/.test(projection.rootDigest ?? "") ||
      !request || typeof request.requestId !== "string" ||
      request.claimId !== projection.claimId ||
      request.targetDigest !== projection.claimDigest ||
      request.evidenceSnapshotDigest !== projection.evidenceSnapshotDigest ||
      request.rootDigest !== projection.rootDigest ||
      request.chatType !== "private") {
    throw new TypeError("TELEGRAM_REVIEW_WIDGET_PROJECTION_INVALID");
  }
  const html = buildHtml(projection);
  const htmlBytes = utf8Bytes(html);
  const compressedBytes = deflateSync(Buffer.from(html, "utf8"), { level: 9 }).length;
  const chatData = JSON.stringify({
    schemaVersion: "kratt-telegram-widget-state/v1",
    requestId: request.requestId,
    status: "PENDING_SIGNATURE",
  });
  if (html.includes("\u0000") || htmlBytes < 1 || htmlBytes > MAX_HTML_BYTES ||
      compressedBytes > MAX_COMPRESSED_BYTES || utf8Bytes(chatData) > MAX_CHAT_DATA_BYTES) {
    throw new RangeError("TELEGRAM_REVIEW_WIDGET_SIZE_LIMIT");
  }
  return Object.freeze({
    html,
    htmlBytes,
    compressedBytes,
    chatData,
    allowQueries: true,
    isShared: false,
    width: 360,
  });
}
