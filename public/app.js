import { BRAND, TIERS, esc, managedBadge, pips, tierBadge } from "/common.js";

document.getElementById("topbar").insertAdjacentHTML("afterbegin", BRAND);

const grid = document.getElementById("grid");
const filterInput = document.getElementById("filter");
let guides = [];
let tierFilter = "";

function card(g, href) {
  return `<a class="card" href="${href}">
    <div class="row"><span class="name">${esc(g.name)}</span><span class="cat">${esc(g.category ?? "")}</span></div>
    <div class="row">${tierBadge(g.tier)}${pips(g.difficulty)}</div>
    ${g.headline ? `<div class="line">${esc(g.headline)}</div>` : ""}
    ${g.time_to_production ? `<div class="when"><b>To production:</b> ${esc(g.time_to_production)}</div>` : ""}
    ${g.managed_oauth ? `<div>${managedBadge(g.managed_oauth)}</div>` : ""}
  </a>`;
}

function renderGrid() {
  const q = filterInput.value.trim().toLowerCase();
  const shown = guides
    .filter((g) => !tierFilter || g.tier === tierFilter)
    .filter((g) => !q || `${g.name} ${g.category} ${g.headline}`.toLowerCase().includes(q))
    .sort((a, b) => a.difficulty - b.difficulty || a.name.localeCompare(b.name));
  grid.innerHTML = shown.length ? shown.map((g) => card(g, `/guide/${g.slug}`)).join("") : `<p class="muted">No guides match.</p>`;
}

document.getElementById("filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  tierFilter = chip.dataset.tier;
  for (const c of document.querySelectorAll(".chip")) c.setAttribute("aria-pressed", String(c === chip));
  renderGrid();
});
filterInput.addEventListener("input", renderGrid);

document.getElementById("legend").innerHTML = Object.entries(TIERS)
  .map(([k, v]) => `<div>${tierBadge(k)}<span class="muted">${esc(v.blurb)}</span></div>`)
  .join("");

async function loadLibrary() {
  const res = await fetch("/api/guides");
  const data = await res.json();
  guides = data.guides;
  renderGrid();

  if (data.recent?.length) {
    document.getElementById("recent-wrap").classList.remove("hidden");
    document.getElementById("recent").innerHTML = data.recent.map((r) => card(r, `/g/${r.id}`)).join("");
  }

  const have = new Set(guides.map((g) => g.slug));
  const rest = data.catalog.filter((a) => !have.has(a.slug));
  document.getElementById("next-intro").textContent =
    `${have.size} of ${data.catalog.length} target apps have a researched guide. For the other ${rest.length}, the agent researches the app when you ask. The list is ordered by estimated demand; about half are apps where Composio has no managed OAuth app, so the developer must bring their own.`;
  document.getElementById("catalog").innerHTML = rest
    .map((a) => `<div><span>${esc(a.name)}${a.managed_oauth === "bring-your-own" ? ' <span class="muted small" title="Composio has no managed app: bring your own">•</span>' : ""}</span><button type="button" data-try="${esc(a.name)}">Research</button></div>`)
    .join("");
}

// ---- live generation ----
const form = document.getElementById("gen-form");
const input = document.getElementById("q");
const go = document.getElementById("go");
const progress = document.getElementById("progress");
const pStatus = document.getElementById("p-status");
const pTime = document.getElementById("p-time");
const pLog = document.getElementById("p-log");
let timer = null;

const ICON = { search: "🔎", fetch: "📄", probe: "🧪", note: "💭", status: "•", error: "⚠️" };

function log(kind, html) {
  pLog.insertAdjacentHTML("beforeend", `<li class="k-${kind}"><span>${ICON[kind] ?? "•"}</span><span>${html}</span></li>`);
  pLog.scrollTop = pLog.scrollHeight;
}

function setBusy(busy, label) {
  go.disabled = busy;
  input.disabled = busy;
  if (label) pStatus.innerHTML = busy ? `<span class="spinner"></span>${esc(label)}` : esc(label);
  if (busy && !timer) {
    const start = Date.now();
    timer = setInterval(() => {
      const s = Math.floor((Date.now() - start) / 1000);
      pTime.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  }
  if (!busy) {
    clearInterval(timer);
    timer = null;
  }
}

function handleEvent(e) {
  switch (e.type) {
    case "status": pStatus.innerHTML = `<span class="spinner"></span>${esc(e.message)}`; log("status", esc(e.message)); break;
    case "search": log("search", `Searching <b>${esc(e.query)}</b>`); break;
    case "fetch": log("fetch", `Reading <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.url)}</a>`); break;
    case "probe": log("probe", `Tested <span class="mono">${esc(e.url)}</span>: ${esc(e.result)}`); break;
    case "note": log("note", esc(e.text.length > 400 ? e.text.slice(0, 400) + "…" : e.text)); break;
    case "error": log("error", esc(e.message)); setBusy(false, "Stopped"); break;
    case "done": setBusy(false, "Done. Opening the guide…"); location.href = `/g/${e.id}`; break;
  }
}

async function generate(query) {
  progress.classList.remove("hidden");
  pLog.innerHTML = "";
  pTime.textContent = "0:00";
  setBusy(true, `Looking up "${query}"`);
  let res;
  try {
    res = await fetch("/api/generate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
  } catch {
    handleEvent({ type: "error", message: "Network error. Check your connection and try again." });
    return;
  }
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = await res.json();
    if (body.redirect) {
      setBusy(false, body.source === "library" ? "Found in the library. Opening…" : "Already researched. Opening…");
      location.href = body.redirect;
    } else handleEvent({ type: "error", message: body.error ?? `Request failed (${res.status})` });
    return;
  }
  setBusy(true, "Researching. Keep this tab open.");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let finished = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const evt = JSON.parse(line.slice(6));
      if (evt.type === "done" || evt.type === "error") finished = true;
      handleEvent(evt);
    }
  }
  if (!finished) handleEvent({ type: "error", message: "The connection closed before the guide was finished. Try again." });
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (q) generate(q);
});
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-try]");
  if (!btn || go.disabled) return;
  input.value = btn.dataset.try;
  window.scrollTo({ top: 0, behavior: "smooth" });
  generate(btn.dataset.try);
});

loadLibrary().catch(() => (grid.innerHTML = `<p class="muted">Couldn't load the library.</p>`));
