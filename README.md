# OAuth Runway

**How long until your users can connect an app?**

Before an AI agent's users can connect Gmail, Slack or Xero, the developer often has to register an OAuth app with that provider and get it reviewed. OAuth Runway tells them how hard that is, how long it takes including approval waits, what can block them, and which steps an agent can do for them. Every claim is cited, every endpoint is tested live, and anything unconfirmed is labelled.

- **Live demo:** https://oauth-runway.vitalmaa.workers.dev
- **Library:** 13 researched guides chosen to cover every kind of path, from "same day, no review" (GitHub) to "not realistically reachable for a new product" (Spotify).
- **Live generation:** type any app name or website. An agent researches it in about 2–4 minutes and returns a guide with its own shareable link.
- **Formats:** each guide is a web page, a Markdown file (`/api/guides/<slug>.md`) for tickets and docs, and JSON (`/api/guides/<slug>.json`) for agents.

## The problem, in one picture

```
Provider OAuth app          Your integration (Composio auth config)       Your users' connections
(client ID + secret,   -->  (which OAuth app, which scopes,          -->  (one per end user: tokens
 redirect URI, review)       redirect URI)                                 Composio stores and refreshes)
```

Composio already runs *managed* OAuth apps for 124 toolkits, so many developers never see the left-hand box. They hit it when (a) the toolkit has no managed app (258 toolkits, including Shopify, Xero, X, Spotify and DocuSign), or (b) they want their own name on the consent screen, custom scopes or their own rate-limit quota. Registering is quick; the slow and uncertain part is review: Google's restricted scopes need a paid security assessment, Slack throttles unlisted apps, HubSpot caps unlisted apps at 25 installs, and Spotify has effectively closed the door to new products. Developers find these out late, often at scale. Each guide answers four questions up front:

| Question | Where it is in a guide |
|---|---|
| How hard is it? | Tier (self-serve, review to go wide, approval-gated, partner/paid) and difficulty 1–5 |
| How long, and how much work? | First connection, hands-on effort, approval wait, time to production, cost |
| What could block me? | Requirements, scopes and what they trigger, limits until approved, "If you get stuck" (exact symptom, then the fix) |
| What can an agent do for me? | Every step tagged **Agent**, **Agent + you**, **You** or **Provider**, plus a summary split |

## The library

| App | Tier | Difficulty | Time to production | Composio |
|---|---|---|---|---|
| GitHub | Self-serve | 2 | Same day, no review | Managed |
| Notion | Self-serve | 2 | Same day (Marketplace listing optional, +5–10 business days) | Managed |
| Microsoft 365 | Review to go wide | 3 | Same day; publisher verification up to ~2 weeks; tenant admin consent for Mail.Read | Managed |
| HubSpot | Review to go wide | 3 | Same day for 25 installs; ~3–10 weeks to a listing that lifts the cap | Managed |
| QuickBooks | Approval-gated | 3 | ~1–3 weeks (production keys need Intuit approval) | Managed |
| Slack | Review to go wide | 4 | Same day unlisted, but history reads throttled to 1 req/min; months to Marketplace | Managed |
| Salesforce | Review to go wide | 4 | Same day for one org; managed package for many; +4–6 weeks for AgentExchange | Managed |
| Shopify | Approval-gated | 4 | Same day for one store; ~4–10 weeks for any merchant (App Store review) | Bring your own |
| Xero | Partner / paid | 4 | Same day up to 50 orgs on a paid plan; certification beyond | Bring your own |
| DocuSign | Partner / paid | 4 | ~1–6 weeks (Partner Program + Go-Live) | Bring your own |
| X (Twitter) | Partner / paid | 2 | Same day, but pay-per-use credits required | Bring your own |
| Google Workspace | Review to go wide | 5 | Same day (basic scopes), ~1–2 weeks (sensitive), ~3–8 weeks plus annual CASA (restricted, e.g. reading Gmail) | Managed |
| Spotify | Partner / paid | 5 | Not reachable for a new product (250k MAU + business required since 2025) | Bring your own |

A further 87 apps from a 100-app target list (`data/catalog.json`) appear on the home page with a **Research** button that runs the live agent.

## What was tested, what is sourced, what is uncertain

Each guide keeps three kinds of evidence apart, and the code enforces the split:

- **Tested** results come from code, never from the model. `src/probe.ts` sends a dummy `client_id` and Composio's redirect URI to the provider's real authorize endpoint and records what happens: an explicit `invalid_client` (Salesforce, Xero), a redirect to sign-in (Google, Microsoft, GitHub, Intuit, Spotify, X), or a page that only renders with JavaScript, which is reported as not observable rather than as a pass. It also reads OIDC metadata for PKCE support, opens the developer portal, and re-checks every cited link. It never follows a redirect into the callback. Across the library's 13 guides, 200 of 205 checks pass and none fail. The other 5 are informational: 4 authorize pages that only render with JavaScript, and Shopify's per-store URL, which can't be probed without a store.
- **Sourced** claims cite a source id. The validator rejects a guide that cites a source it doesn't list. Sources are typed (`official-docs`, `official-policy`, `official-blog`, `composio`, `community`), so a vendor blog can't pass as policy.
- **Uncertain** is a required list: estimates with no published SLA, sources that conflict (for example, Slack's two pages disagree on whether the 2025 rate limits apply to existing installs), and anything that couldn't be confirmed.

### How the library was made, and checked

1. Four research agents (Claude Code subagents) split the 13 apps. They read official docs (in a browser where pages needed JavaScript) and wrote guides against the JSON Schema.
2. Two separate fact-check agents re-opened every cited source and checked each number, date and price. They fixed six guides: X re-tiered as paid-only after its February 2026 move to pay-per-use; Slack's PKCE support, added 30 March 2026, recorded; a GitHub rate-limit claim corrected; unsupported claims about Composio's managed HubSpot app removed; Google's CASA cost reworded; a Salesforce menu path fixed.
3. The probes ran against every guide, and the build fails if any guide breaks the schema or has no probe results.

## Live generation

`POST /api/generate` runs `src/agent.ts` on Claude Opus 5.5 with:

- `web_search` and `web_fetch` (server tools), so it reads the provider's own docs;
- `probe_endpoint`, a client tool that runs the same probes, so the agent tries the real endpoints rather than only reading about them;
- `submit_guide`, a strict tool whose input schema *is* the guide schema. Submissions are validated (schema, citations, ranges), and errors go back to the model to fix;
- `not_applicable`, for apps that offer no third-party OAuth at all.

After submission the Worker re-runs every probe itself and stores the guide in KV under a permanent link (`/g/<id>`). Progress streams to the browser over server-sent events ("Searching…", "Reading…", "Tested…"). Library apps and aliases ("gmail", "outlook", "twitter", a bare domain) resolve instantly without a model call; repeat queries are cached for 30 days; and the public demo is rate-limited (3 live guides per IP per day, 40 in total) to cap spend.

## Run it

```bash
npm install
npm test              # builds the library bundle, then 120 tests
npm run dev           # http://localhost:8787 (put ANTHROPIC_API_KEY=... in .dev.vars for live research)
```

| Command | What it does |
|---|---|
| `npm run probe [-- slug]` | Re-run live endpoint checks for the library and write `data/probes/` |
| `npm run build` | Validate every guide and bundle guides, probes and the catalog for the Worker |
| `npm run generate -- "Zoom"` | Run the live agent from the CLI and save to `data/live/` (a reviewed result can be promoted into `data/guides/`) |
| `npm run deploy` | Build and deploy to Cloudflare Workers (`wrangler secret put ANTHROPIC_API_KEY` once) |

```
schema/guide.schema.json   the contract: library, agent tool and validator all use it
data/guides/*.json         researched guides          data/probes/*.json  live check results
data/catalog.json          the 100-app target list    data/composio-managed-auth.json  snapshot of Composio's directory
src/agent.ts  live agent   src/probe.ts  endpoint checks   src/validate.ts  schema + citation checks
src/worker.ts routes, cache, rate limits, SSE              src/markdown.ts  Markdown export
public/       the site (no framework, no build step)       test/  Vitest suites
```

## What I'd do next

- **Get to 100:** batch-run the agent over the catalog at night, auto-publish guides that come back high-confidence with no failed probes, and send the rest to a human review queue. The catalog is ordered by my estimate of demand from agent builders; that order should be replaced with Composio's real usage data.
- **Keep guides fresh:** provider policy changed for at least 7 of these 13 apps between 2025 and 2026. Re-probe weekly on a Cron Trigger, re-research monthly, and flag guides whose sources changed or whose probes started failing.
- **Do more of the work:** where providers allow it, have the agent do the steps itself. A Slack app manifest and a GitHub App manifest flow can create the app from a single click by the developer, and a draft privacy policy and scope justifications cover most of Google's verification form.
- **Measure:** time from a developer's first lookup to their first connected account, the share of guides with an "Agent" step completed for the developer, and which blockers developers actually hit (an "I'm stuck here" button on each step).

## Caveats

Guides reflect provider documentation on the date shown on each one. Review times that providers don't publish are estimates and are labelled as such. Composio's managed-auth status is a snapshot of its directory taken on 2026-10-28. The probes use an unauthenticated session, so they can show that an endpoint is live and how it treats an unknown client, but not the whole consent flow.

Built by Sai Rakshith Muda as a take-home for Composio (APM, Integrations).
