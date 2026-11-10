const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const signals = [
  { id:"SIG-1284", source:"Reuters", category:"Technology", title:"European infrastructure investment enters a new funding cycle", age:"12 min ago", relevance:.92, claims:3, state:"corroborated", tags:["Infrastructure","2 sources corroborate"] },
  { id:"SIG-1283", source:"Telegram · Market Watch", category:"Channel", title:"Unconfirmed supplier capacity expansion reported by channel sources", age:"28 min ago", relevance:.64, claims:1, state:"unverified", tags:["Unverified","Needs source"] },
  { id:"SIG-1282", source:"GitHub", category:"Engineering", title:"Runtime adapter contract updated with request-scoped approval rules", age:"41 min ago", relevance:.88, claims:4, state:"corroborated", tags:["Engineering","Digest verified"] },
  { id:"SIG-1281", source:"Financial Times", category:"Markets", title:"Regional infrastructure funds review long-term capital allocations", age:"56 min ago", relevance:.83, claims:2, state:"corroborated", tags:["Markets","Independent source"] },
  { id:"SIG-1280", source:"Telegram · Baltic Brief", category:"Channel", title:"Port expansion timeline differs across two channel reports", age:"1 hr ago", relevance:.71, claims:2, state:"unverified", tags:["Conflicting","Review required"] },
  { id:"SIG-1279", source:"EU Commission", category:"Policy", title:"New policy note clarifies eligibility for cross-border projects", age:"2 hrs ago", relevance:.95, claims:5, state:"corroborated", tags:["Policy","Primary source"] },
  { id:"SIG-1278", source:"RSS / Atom", category:"Research", title:"Research institute publishes revised supply-chain outlook", age:"3 hrs ago", relevance:.78, claims:3, state:"corroborated", tags:["Research","Digest verified"] },
  { id:"SIG-1277", source:"Slack · Internal", category:"Workspace", title:"Analyst review flags a duplicate origin in the source cluster", age:"4 hrs ago", relevance:.58, claims:1, state:"unverified", tags:["Duplicate","Human review"] }
];

const journal = [
  { type:"ADAPTER_VERIFIED", ref:"RSS-PRIMARY", time:"09:42:18", tone:"green", payload:{ adapter:"rss-primary", state:"VERIFIED_READ_ONLY" } },
  { type:"CLAIM_EXTRACTED", ref:"CLM-0291", time:"09:41:52", tone:"violet", payload:{ claim:"CLM-0291", state:"UNREVIEWED" } },
  { type:"CONFLICT_DETECTED", ref:"CFL-0012", time:"09:40:03", tone:"amber", payload:{ conflict:"CFL-0012", state:"CONTESTED" } }
];

let eventSequence = 3;
let toastHandle;
let activeView = "overview";

function timeNow() {
  return new Intl.DateTimeFormat("en-GB", { hour:"2-digit", minute:"2-digit", second:"2-digit", timeZone:"UTC" }).format(new Date()) + " UTC";
}
function updateClock() {
  const clock = $("#clock");
  if (clock) clock.textContent = timeNow();
}
function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastHandle);
  toastHandle = setTimeout(() => el.classList.remove("show"), 3200);
}
function sourceClass(source) {
  if (/telegram/i.test(source)) return "source-telegram";
  if (/github/i.test(source)) return "source-github";
  return "source-news";
}
function sourceMark(source) {
  if (/telegram/i.test(source)) return "➤";
  if (/github/i.test(source)) return "⌘";
  if (/rss/i.test(source)) return "◉";
  if (/slack/i.test(source)) return "#";
  return source.trim().charAt(0).toUpperCase();
}
function signalMarkup(item) {
  const stateLabel = item.state === "corroborated" ? "2 sources corroborate" : "Needs review";
  const stateClass = item.state === "corroborated" ? "tag-green" : "tag-amber";
  const categoryClass = /engineering/i.test(item.category) ? "tag-violet" : "tag-cyan";
  return `<article class="signal-row" data-signal-id="${item.id}">
    <div class="source-logo ${sourceClass(item.source)}">${sourceMark(item.source)}</div>
    <div class="signal-body">
      <div class="signal-meta"><b>${escapeHtml(item.source)} · ${escapeHtml(item.category)}</b><span>${escapeHtml(item.age)}</span></div>
      <h3>${escapeHtml(item.title)}</h3>
      <div class="signal-tags"><span class="tag ${categoryClass}">${escapeHtml(item.category)}</span><span class="tag">${item.claims} claim${item.claims===1?"":"s"}</span><span class="tag ${stateClass}">${stateLabel}</span></div>
    </div>
    <div class="signal-score ${item.state==="unverified"?"score-muted":""}"><b>${item.relevance.toFixed(2)}</b><small>relevance</small></div>
  </article>`;
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char]);
}
function renderSignals() {
  const list = $("#all-signals");
  if (!list) return;
  const query = ($("#signal-search")?.value ?? "").trim().toLowerCase();
  const filter = $("#signal-filter")?.value ?? "all";
  const filtered = signals.filter(item => {
    const matchesQuery = !query || [item.id,item.source,item.title,item.category].join(" ").toLowerCase().includes(query);
    const matchesFilter = filter === "all" || item.state === filter;
    return matchesQuery && matchesFilter;
  });
  list.innerHTML = filtered.length ? filtered.map(signalMarkup).join("") : '<div class="empty-state">No signals match this filter.</div>';
  $("#signal-total").textContent = `${filtered.length} of ${signals.length} records`;
  $("#signal-count-nav").textContent = String(signals.length);
}
function renderJournal() {
  const rows = journal.map(event => `<div class="event-item"><i class="event-dot" style="background:var(--${event.tone==="green"?"green":event.tone==="amber"?"amber":"violet"})"></i><code>${escapeHtml(event.type)}</code><span>${escapeHtml(event.ref)}</span><time>${escapeHtml(event.time)}</time></div>`).join("");
  const target = $("#orchestration-events");
  const full = $("#full-journal");
  if (target) target.innerHTML = rows;
  if (full) full.innerHTML = rows;
}
function showView(view) {
  const allowed = ["overview","signals","evidence","orchestration","connectors","governance","audit"];
  if (!allowed.includes(view)) return;
  activeView = view;
  $$(".page-view").forEach(el => el.classList.toggle("active", el.id === `view-${view}`));
  $$(".nav-item").forEach(el => el.classList.toggle("active", el.dataset.view === view));
  $("#crumb-view").textContent = view === "audit" ? "Event journal" : view.charAt(0).toUpperCase() + view.slice(1);
  if (view === "signals") renderSignals();
  if (view === "audit" || view === "orchestration") renderJournal();
  window.scrollTo({ top:0, behavior:"smooth" });
}
$$(".nav-item").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
$$("[data-go]").forEach(button => button.addEventListener("click", () => showView(button.dataset.go)));
$$("[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
$("#signal-search")?.addEventListener("input", renderSignals);
$("#signal-filter")?.addEventListener("change", renderSignals);
$("#dismiss-notice")?.addEventListener("click", () => $(".notice-bar")?.remove());

const dialog = $("#intake-dialog");
function openIntake() {
  if (typeof dialog?.showModal === "function") dialog.showModal();
  else toast("This browser does not support the intake dialog.");
}
$("#new-intake")?.addEventListener("click", openIntake);
$("#new-intake-signals")?.addEventListener("click", openIntake);

async function hashText(text) {
  if (!globalThis.crypto?.subtle) return null;
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return "sha256:" + [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2,"0")).join("");
}
async function appendEvent(type, ref, payload, tone = "cyan") {
  const previous = journal.at(-1)?.hash ?? null;
  const event = {
    sequence: ++eventSequence,
    type,
    ref,
    time: timeNow().replace(" UTC",""),
    tone,
    payload,
    previousHash: previous
  };
  event.hash = await hashText(JSON.stringify(event));
  journal.push(event);
  renderJournal();
  return event;
}
$("#intake-form")?.addEventListener("submit", async event => {
  event.preventDefault();
  const label = $("#intake-label").value.trim();
  const sourceType = $("#intake-source").value;
  if (!label) return;
  const item = {
    id:"SIG-" + String(1284 + (signals.length - 7)).padStart(4,"0"),
    source:sourceType,
    category:"New intake",
    title:label,
    age:"just now",
    relevance:.50,
    claims:0,
    state:"unverified",
    tags:["New","Unreviewed"]
  };
  signals.unshift(item);
  $("#metric-signals").textContent = (1284 + signals.length - 8).toLocaleString("en-US");
  renderSignals();
  await appendEvent("INTAKE_REQUESTED", item.id, { label, sourceType, mode:"LOCAL_PREVIEW" }, "violet");
  dialog.close();
  $("#intake-label").value = "";
  toast("Local intake preview added. No external source was contacted.");
  if (activeView === "signals") renderSignals();
});

$("#verify-demo-journal")?.addEventListener("click", async () => {
  const result = $("#journal-result");
  result.classList.remove("ok");
  if (!globalThis.crypto?.subtle) {
    result.textContent = "Web Crypto is unavailable in this context; no integrity claim made.";
    return;
  }
  let valid = true;
  let previous = null;
  for (const event of journal) {
    const { hash, ...body } = event;
    if (event.previousHash !== previous || await hashText(JSON.stringify(body)) !== hash) {
      valid = false;
      break;
    }
    previous = hash;
  }
  result.textContent = valid ? `LOCAL SAMPLE CHAIN VERIFIED · ${journal.length} events · ${previous?.slice(0,24)}…` : "INTEGRITY FAILURE · sample event chain differs.";
  result.classList.toggle("ok", valid);
  toast(valid ? "Sample event chain verified locally." : "Sample event chain integrity failure.");
});

$("#run-demo-intake")?.addEventListener("click", event => {
  // The form submit handler owns the local-only preview action.
});

updateClock();
setInterval(updateClock, 1000);
renderSignals();
renderJournal();
