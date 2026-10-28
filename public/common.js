// Shared by the library and guide pages.
export const TIERS = {
  "self-serve": { label: "Self-serve", blurb: "Any user can connect as soon as you register. No provider review." },
  "self-serve-with-review": { label: "Self-serve, review to go wide", blurb: "Works today for you and test users. Review, verification or a listing unlocks everyone or sensitive scopes." },
  "approval-gated": { label: "Approval-gated", blurb: "The provider must approve the app before real users can connect." },
  "partner-only": { label: "Partner or paid tier", blurb: "Needs a partner program, a contract, a minimum company size or a paid API plan." },
};
export const OWNERS = {
  agent: "Agent",
  "agent+you": "Agent + you",
  you: "You",
  provider: "Provider",
};

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Escape, then turn bare URLs into links. */
export function linkify(s) {
  return esc(s).replace(/https?:\/\/[^\s<)"]+[^\s<)".,;:]/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
}

export function tierBadge(tier) {
  return `<span class="tier ${esc(tier)}">${esc(TIERS[tier]?.label ?? tier)}</span>`;
}

export function pips(n, big = false) {
  return `<span class="pips${big ? " big" : ""}" role="img" aria-label="Difficulty ${n} of 5">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`;
}

export function managedBadge(m) {
  const label = { available: "Composio-managed OAuth", "bring-your-own": "Bring your own OAuth app", "not-listed": "Not in Composio yet" }[m] ?? m;
  return `<span class="badge">${esc(label)}</span>`;
}

export function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 1800);
}

export const BRAND = `<a class="brand" href="/"><svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8" fill="#3b5bdb"/><path d="M9 25 15 7h2l6 18" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M16 11v2.5M16 16v2.5M16 21v2.5" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>OAuth Runway</a>`;
