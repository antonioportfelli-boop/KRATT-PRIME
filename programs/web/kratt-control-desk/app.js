import {
  WAVE_REGISTRY,
  evaluateWaveGate,
} from "../../../packages/kratt-core/src/wave-progression.mjs";

const byId = (id) => document.getElementById(id);
const waveGrid = byId("wave-grid");
const operationList = byId("operation-list");
const apiPill = byId("api-status");
const apiLabel = byId("api-status-label");
const runtimeMessage = byId("runtime-message");
const refreshButton = byId("refresh-runtime");
let selectedWave = WAVE_REGISTRY[0]?.id ?? null;

function node(tag, className, value) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (value !== undefined) item.textContent = String(value);
  return item;
}

function statusLabel(status) {
  return ({
    "baseline-present": "BASELINE PRESENT",
    "draft-open": "DRAFT OPEN",
    "parallel-drafts-open": "PARALLEL DRAFTS",
    "candidate-in-wave10-base": "CANDIDATE IN W10",
  })[status] ?? "UNCLASSIFIED";
}

function renderWaveCards() {
  waveGrid.replaceChildren();
  for (const wave of WAVE_REGISTRY) {
    const card = node("button", "wave-card");
    card.type = "button";
    card.setAttribute("aria-pressed", String(wave.id === selectedWave));
    card.setAttribute("aria-label", wave.id + ": " + wave.title + ", complexity " + wave.complexity + " of 10");
    const top = node("div", "wave-card-top");
    top.append(node("span", "wave-number", wave.id.replace("WAVE-", "WAVE ")));
    top.append(node("span", "wave-state", statusLabel(wave.deliveryState)));
    const title = node("h3", "", wave.title);
    const bottom = node("div", "wave-card-bottom");
    bottom.append(node("span", "", wave.layer.replaceAll("-", " ")));
    bottom.append(node("span", "", "LEVEL " + wave.complexity + "/10"));
    const track = node("div", "complexity-track");
    const fill = node("span");
    fill.style.width = (wave.complexity * 10) + "%";
    track.append(fill);
    card.append(top, title, bottom, track);
    card.addEventListener("click", () => {
      selectedWave = wave.id;
      renderWaveCards();
      renderWaveDetails();
    });
    waveGrid.append(card);
  }
  byId("wave-count").textContent = String(WAVE_REGISTRY.length);
}

function renderWaveDetails() {
  const wave = WAVE_REGISTRY.find((item) => item.id === selectedWave);
  if (!wave) return;
  byId("detail-kicker").textContent = wave.id + " / " + wave.layer.toUpperCase().replaceAll("-", " ");
  byId("detail-complexity").textContent = "LEVEL " + wave.complexity + " / 10";
  byId("detail-title").textContent = wave.title;
  byId("detail-summary").textContent = wave.summary;

  const capabilities = byId("detail-capabilities");
  capabilities.replaceChildren();
  for (const item of wave.capabilities) capabilities.append(node("span", "tag", item));

  const dependencies = byId("detail-dependencies");
  dependencies.replaceChildren();
  if (wave.dependsOn.length === 0) dependencies.append(node("span", "tag", "No prerequisite wave"));
  for (const item of wave.dependsOn) dependencies.append(node("span", "tag", item));

  const evidence = byId("detail-evidence");
  evidence.replaceChildren();
  for (const item of wave.requiredEvidence) evidence.append(node("li", "", item));

  const branches = byId("detail-branches");
  branches.replaceChildren();
  for (const branch of wave.branchRefs) {
    const item = node("li");
    item.append(node("code", "", branch));
    branches.append(item);
  }
  for (const pr of wave.pullRequests) {
    const item = node("li");
    item.append(node("span", "", "PR #" + pr.number + " · " + pr.state + " · " + pr.relation));
    branches.append(item);
  }
  byId("detail-lineage-note").textContent = wave.lineageNote;

  const gate = evaluateWaveGate(wave.id, { completedWaveIds: [], evidence: [] });
  byId("detail-lineage-note").setAttribute("title",
    "Local gate preview: " + gate.missingDependencies.length + " dependencies and " +
    gate.missingEvidence.length + " evidence items still require verified records.");
}

function setApiState(state, label, message, detail) {
  apiPill.dataset.state = state;
  apiLabel.textContent = label;
  runtimeMessage.dataset.state = state;
  runtimeMessage.replaceChildren();
  runtimeMessage.append(node("span", "state-indicator"));
  const copy = node("div");
  copy.append(node("strong", "", message));
  copy.append(node("p", "", detail));
  runtimeMessage.append(copy);
}

function dataArray(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

function renderOperations(items) {
  operationList.replaceChildren();
  if (!items.length) {
    operationList.append(node("p", "empty-state", "The protected API returned no operation rows."));
    return;
  }
  for (const operation of items.slice(0, 20)) {
    const row = node("div", "operation-row");
    const main = node("div", "operation-main");
    const title = node("strong", "", operation?.module_id || "Unknown module");
    const meta = node("span", "operation-meta",
      [operation?.operation_id, operation?.last_occurred_at || operation?.updated_at || ""].filter(Boolean).join(" · "));
    main.append(title, meta);
    const status = node("span", "operation-status", operation?.status || "unknown");
    status.dataset.status = String(operation?.status || "unknown");
    row.append(main, status);
    operationList.append(row);
  }
}

function classifyApiError(error) {
  if (error?.status === 403) {
    return {
      state: "denied",
      label: "API DENIED",
      title: "Read access denied",
      detail: "The server-side Observatory authorizer refused this request. No bypass was attempted.",
    };
  }
  if (error?.status === 404) {
    return {
      state: "unbound",
      label: "API UNBOUND",
      title: "Observatory route not mounted",
      detail: "This origin does not expose the protected Observatory read API.",
    };
  }
  return {
    state: "degraded",
    label: "API DEGRADED",
    title: "Runtime read unavailable",
    detail: "The protected API did not return a usable response. Runtime activity is not inferred.",
  };
}

async function getJson(path) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(path, {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error("OBSERVATORY_HTTP_" + response.status);
      error.status = response.status;
      throw error;
    }
    const payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("OBSERVATORY_RESPONSE_INVALID");
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function refreshRuntime() {
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  try {
    const [integrity, modules, operations] = await Promise.all([
      getJson("/observatory/integrity"),
      getJson("/observatory/modules"),
      getJson("/observatory/operations?limit=20"),
    ]);
    if (integrity.status !== "OK" || integrity.data?.ok !== true) {
      throw Object.assign(new Error("OBSERVATORY_INTEGRITY_NOT_VERIFIED"), { status: 503 });
    }
    const operationRows = dataArray(operations);
    const moduleRows = dataArray(modules);
    byId("operation-count").textContent = String(operationRows.length);
    byId("module-count").textContent = String(moduleRows.length);
    setApiState(
      "verified",
      "API VERIFIED",
      "Protected read succeeded",
      "Integrity is verified for " + String(integrity.data.count ?? "unknown") +
      " event records. " + operationRows.length + " recent operations loaded.",
    );
    renderOperations(operationRows);
  } catch (error) {
    const state = classifyApiError(error);
    byId("operation-count").textContent = "—";
    byId("module-count").textContent = "—";
    renderOperations([]);
    setApiState(state.state, state.label, state.title, state.detail);
  } finally {
    refreshButton.disabled = false;
    refreshButton.removeAttribute("aria-busy");
  }
}

refreshButton.addEventListener("click", refreshRuntime);
renderWaveCards();
renderWaveDetails();
