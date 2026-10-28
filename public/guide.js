import { BRAND, OWNERS, TIERS, esc, linkify, managedBadge, pips, tierBadge, toast } from "/common.js";

document.getElementById("topbar").insertAdjacentHTML("afterbegin", BRAND);
const root = document.getElementById("guide");

const [, kind, id] = location.pathname.match(/^\/(guide|g)\/([a-z0-9-]+)/) ?? [];
const api = kind === "guide" ? `/api/guides/${id}` : `/api/g/${id}`;
const storeKey = `oauth-runway:done:${kind}:${id}`;

function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(storeKey) ?? "[]")); } catch { return new Set(); }
}
function saveDone(set) {
  try { localStorage.setItem(storeKey, JSON.stringify([...set])); } catch { /* private mode: progress just isn't remembered */ }
}

const cites = (ids) => (ids ?? []).map((s) => `<a class="cite" href="#src-${esc(s)}">[${esc(s)}]</a>`).join("");
const owner = (o) => `<span class="owner ${esc(o)}">${esc(OWNERS[o] ?? o)}</span>`;

function render(g) {
  const v = g.verdict;
  document.title = `${g.app.name}: OAuth app setup and approval · OAuth Runway`;
  const done = loadDone();
  const allSteps = g.phases.flatMap((p) => p.steps);
  let n = 0;
  const counts = Object.fromEntries(Object.keys(OWNERS).map((k) => [k, allSteps.filter((s) => s.owner === k).length]));
  const passed = g.tested.filter((t) => t.status === "pass").length;
  const live = g.meta.origin === "live";

  root.innerHTML = `
  <section class="g-head">
    <div class="crumbs"><a href="/#library">Library</a> / ${esc(g.app.category)}${live ? " / researched live" : ""}</div>
    <h1>${esc(g.app.name)}</h1>
    <p class="lede">${esc(v.headline)}</p>
    <div class="meta-row">${tierBadge(v.tier)}<span>Difficulty ${pips(v.difficulty, true)} ${v.difficulty}/5</span>${managedBadge(g.composio.managed_oauth)}<span>Confidence: <b>${esc(v.confidence)}</b></span><span>${passed}/${g.tested.length} live checks passed</span></div>
    <div class="actions">
      <button class="btn ghost" id="copy-link">Copy link</button>
      <button class="btn ghost" id="copy-md">Copy as Markdown</button>
      <a class="btn ghost" href="${api}.md" download="${esc(g.slug)}-oauth-guide.md">Download .md</a>
      <a class="btn ghost" href="${api}.json" target="_blank" rel="noopener">JSON (for agents)</a>
      <button class="btn ghost" onclick="print()">Print / PDF</button>
    </div>
  </section>

  <div class="facts">
    <div class="fact"><div class="k">First connection</div><div class="v">${esc(v.time_to_first_connection)}</div></div>
    <div class="fact"><div class="k">Hands-on effort</div><div class="v">${esc(v.hands_on_effort)}</div></div>
    <div class="fact"><div class="k">Approval wait</div><div class="v">${esc(v.approval_wait)}</div></div>
    <div class="fact"><div class="k">Time to production</div><div class="v">${esc(v.time_to_production)}</div></div>
    <div class="fact"><div class="k">Cost</div><div class="v">${esc(v.cost)}</div></div>
  </div>

  <p>${esc(v.summary)}</p>
  <div class="callout"><b>Composio:</b> ${linkify(g.composio.note)}${g.composio.toolkit_slug ? ` Toolkit <code>${esc(g.composio.toolkit_slug)}</code>.` : ""}</div>
  <p class="small muted">${esc(TIERS[v.tier]?.blurb ?? "")}</p>

  <h2>Your runway</h2>
  <div class="runway">${g.phases.map((p) => `<div class="seg${p.is_wait ? " wait" : ""}"><b>${esc(p.name)}</b>${esc(p.duration)}${p.is_wait ? " · waiting" : ""}</div>`).join("")}</div>

  <h2>Steps <span class="small muted" id="progress-count"></span></h2>
  <div class="legend-owners">${Object.entries(counts).filter(([, c]) => c).map(([k, c]) => `${owner(k)} ${c}`).join(" ")}</div>
  ${g.phases.map((p) => `
    <div class="phase">
      <div class="phase-h"><h3>${esc(p.name)}</h3><span class="dur">${esc(p.duration)}${p.is_wait ? " · waiting on the provider" : ""}</span></div>
      <p class="goal">${esc(p.goal)}</p>
      <ol class="steps">${p.steps.map((s) => {
        const key = String(n++);
        return `<li class="step${done.has(key) ? " done" : ""}">
          <input type="checkbox" data-step="${key}" ${done.has(key) ? "checked" : ""} aria-label="Mark step done">
          <div>
            <div class="t">${esc(s.title)}</div>
            <p class="d">${linkify(s.detail)}</p>
            ${s.agent_help ? `<div class="agent"><b>Agent:</b> ${linkify(s.agent_help)}</div>` : ""}
            <div class="foot">${owner(s.owner)}${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">Open ↗</a>` : ""}${cites(s.sources)}</div>
          </div>
        </li>`;
      }).join("")}</ol>
    </div>`).join("")}

  <h2>What an agent can do, and where you take over</h2>
  <div class="split">
    <div><h3>${owner("agent")} Agent can</h3><ul>${g.agent_handoff.agent_can.map((x) => `<li>${linkify(x)}</li>`).join("")}</ul></div>
    <div><h3>${owner("you")} You must</h3><ul>${g.agent_handoff.you_must.map((x) => `<li>${linkify(x)}</li>`).join("")}</ul></div>
  </div>

  ${g.requirements.length ? `<h2>Requirements</h2>
  <div class="table-wrap"><table><thead><tr><th>Requirement</th><th>Needed for</th><th>Detail</th></tr></thead><tbody>
  ${g.requirements.map((r) => `<tr><td><b>${esc(r.item)}</b></td><td>${esc(r.needed_for)}</td><td>${linkify(r.detail)} ${cites(r.sources)}</td></tr>`).join("")}
  </tbody></table></div>` : ""}

  ${g.scopes.length ? `<h2>Scopes an agent typically needs</h2>
  <div class="table-wrap"><table><thead><tr><th>Scope</th><th>Purpose</th><th>Level</th><th>What it triggers</th></tr></thead><tbody>
  ${g.scopes.map((s) => `<tr><td><code>${esc(s.scope)}</code></td><td>${esc(s.purpose)}</td><td><span class="sens ${esc(s.sensitivity)}">${esc(s.sensitivity)}</span></td><td>${linkify(s.review_impact)} ${cites(s.sources)}</td></tr>`).join("")}
  </tbody></table></div>` : ""}

  ${g.limits.length ? `<h2>Limits until you're approved</h2>
  <div class="table-wrap"><table><thead><tr><th>Limit</th><th>Applies when</th><th>How to lift it</th></tr></thead><tbody>
  ${g.limits.map((l) => `<tr><td><b>${esc(l.limit)}</b></td><td>${esc(l.applies_when)}</td><td>${linkify(l.how_to_lift)} ${cites(l.sources)}</td></tr>`).join("")}
  </tbody></table></div>` : ""}

  ${g.blockers.length ? `<h2>If you get stuck</h2>
  <div class="blockers">${g.blockers.map((b) => `<div class="blocker"><b>${esc(b.blocker)}</b><div class="sym">${esc(b.symptom)}</div><div><b>Fix:</b> ${linkify(b.fix)} ${cites(b.sources)}</div></div>`).join("")}</div>` : ""}

  <h2>OAuth details</h2>
  <dl class="kv">
    <dt>Authorize URL</dt><dd><code>${esc(g.oauth.authorize_url)}</code></dd>
    <dt>Token URL</dt><dd><code>${esc(g.oauth.token_url)}</code></dd>
    ${g.oauth.discovery_url ? `<dt>Metadata</dt><dd>${linkify(g.oauth.discovery_url)}</dd>` : ""}
    <dt>PKCE</dt><dd>${linkify(g.oauth.pkce)}</dd>
    <dt>Refresh tokens</dt><dd>${linkify(g.oauth.refresh_tokens)}</dd>
    <dt>Redirect URIs</dt><dd>${linkify(g.oauth.redirect_uri_rules)} ${cites(g.oauth.sources)}</dd>
    <dt>Developer portal</dt><dd>${linkify(g.app.developer_portal_url)}</dd>
    <dt>OAuth docs</dt><dd>${linkify(g.app.docs_url)}</dd>
  </dl>

  <h2>Evidence</h2>
  <h3>Tested <span class="small muted">· run by code against the live endpoints, ${esc(g.meta.tested_at.slice(0, 10))}</span></h3>
  <div class="evidence">${g.tested.map((t) => `<div class="ev"><span class="dot ${esc(t.status)}" title="${esc(t.status)}"></span><div><b>${esc(t.check)}</b>: ${esc(t.result)}<div class="m">${esc(t.method)}</div></div></div>`).join("") || `<p class="muted">No live checks recorded.</p>`}</div>

  <h3 style="margin-top:24px">Sources</h3>
  <ol class="sources">${g.sources.map((s) => `<li id="src-${esc(s.id)}"><span class="mono">[${esc(s.id)}]</span> <a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><span class="kind">${esc(s.kind)}</span><div class="small muted">${esc(s.supports)}</div></li>`).join("")}</ol>

  ${g.uncertain.length ? `<h3 style="margin-top:24px">Uncertain</h3><div class="callout warn"><ul class="uncertain">${g.uncertain.map((u) => `<li>${linkify(u)}</li>`).join("")}</ul></div>` : ""}

  <p class="small muted" style="margin-top:28px">${live ? `Researched live by ${esc(g.meta.researched_by)} on ${esc(g.meta.researched_at.slice(0, 10))} for the request "${esc(g.meta.query ?? "")}".` : `Researched by ${esc(g.meta.researched_by)} on ${esc(g.meta.researched_at)}.`}</p>`;

  const total = allSteps.length;
  const counter = document.getElementById("progress-count");
  const update = () => (counter.textContent = `· ${done.size} of ${total} done`);
  update();
  root.addEventListener("change", (e) => {
    const box = e.target.closest("input[data-step]");
    if (!box) return;
    box.checked ? done.add(box.dataset.step) : done.delete(box.dataset.step);
    box.closest(".step").classList.toggle("done", box.checked);
    saveDone(done);
    update();
  });
  document.getElementById("copy-link").onclick = async () => {
    await navigator.clipboard.writeText(location.origin + location.pathname);
    toast("Link copied");
  };
  document.getElementById("copy-md").onclick = async () => {
    const md = await (await fetch(`${api}.md`)).text();
    await navigator.clipboard.writeText(md);
    toast("Markdown copied");
  };
}

if (!id) {
  root.innerHTML = `<p class="empty">No guide here. <a href="/">Back to the library</a>.</p>`;
} else {
  fetch(api)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(render)
    .catch(() => (root.innerHTML = `<p class="empty">That guide doesn't exist (or has expired). <a href="/">Search the library or research it live</a>.</p>`));
}
