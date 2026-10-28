// Cloudflare Worker: serves the library, the guide pages, and the live
// generation endpoint. Static files (public/) are served by Workers Assets;
// this script only handles /api/*, /guide/* and /g/*.

import Anthropic from "@anthropic-ai/sdk";
import library from "./generated/library.json" with { type: "json" };
import { DEFAULT_MODEL, generateGuide, NotApplicableError } from "./agent.ts";
import { toMarkdown } from "./markdown.ts";
import type { AgentEvent, StoredGuide } from "./types.ts";

export interface Env {
  ASSETS: Fetcher;
  GUIDES: KVNamespace;
  ANTHROPIC_API_KEY?: string;
  MODEL?: string;
  DAILY_LIMIT_PER_IP?: string;
  DAILY_LIMIT_TOTAL?: string;
}

interface CatalogApp {
  slug: string;
  name: string;
  category: string;
  website: string;
  composio_toolkit: string;
  managed_oauth: string;
}

interface RecentEntry {
  id: string;
  name: string;
  tier: string;
  difficulty: number;
  at: string;
}

const GUIDES = library.guides as unknown as StoredGuide[];
const BY_SLUG = new Map(GUIDES.map((g) => [g.slug, g]));
const CATALOG = library.catalog as CatalogApp[];
const CACHE_DAYS = 30;
const MAX_QUERY = 120;

// Names people type for apps the library covers under another name.
const ALIASES: Record<string, string> = {
  gmail: "google-workspace", google: "google-workspace", "google drive": "google-workspace", "google calendar": "google-workspace",
  "google sheets": "google-workspace", "g suite": "google-workspace", outlook: "microsoft-365", "office 365": "microsoft-365",
  "microsoft graph": "microsoft-365", "microsoft outlook": "microsoft-365", "entra id": "microsoft-365", twitter: "x-twitter",
  x: "x-twitter", intuit: "quickbooks", "quickbooks online": "quickbooks", "github app": "github", "docusign esignature": "docusign",
};

export function normalizeQuery(q: string): string {
  return q
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, (m) => (m.length > 1 ? "" : ""))
    .replace(/[^a-z0-9.+ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Find a library guide for a free-text query (name, slug, alias or domain). */
export function findInLibrary(query: string): StoredGuide | undefined {
  const q = normalizeQuery(query);
  if (!q) return undefined;
  if (BY_SLUG.has(q)) return BY_SLUG.get(q);
  if (ALIASES[q]) return BY_SLUG.get(ALIASES[q]);
  for (const g of GUIDES) {
    const host = new URL(g.app.website).hostname.replace(/^www\./, "");
    if (g.app.name.toLowerCase() === q || host === q || host.split(".")[0] === q || g.slug.replace(/-/g, " ") === q) return g;
  }
  return undefined;
}

const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

const markdown = (g: StoredGuide, url: string) =>
  new Response(toMarkdown(g, url), { headers: { "content-type": "text/markdown; charset=utf-8" } });

function summary(g: StoredGuide) {
  return {
    slug: g.slug,
    name: g.app.name,
    category: g.app.category,
    tier: g.verdict.tier,
    difficulty: g.verdict.difficulty,
    headline: g.verdict.headline,
    time_to_production: g.verdict.time_to_production,
    managed_oauth: g.composio.managed_oauth,
    confidence: g.verdict.confidence,
  };
}

async function readRecent(env: Env): Promise<RecentEntry[]> {
  return ((await env.GUIDES.get("recent", "json")) as RecentEntry[] | null) ?? [];
}

/** Count one generation against the per-IP and global daily budgets. */
async function takeBudget(env: Env, ip: string): Promise<string | null> {
  const day = new Date().toISOString().slice(0, 10);
  const perIp = Number(env.DAILY_LIMIT_PER_IP ?? 3);
  const total = Number(env.DAILY_LIMIT_TOTAL ?? 40);
  const ipKey = `rl:${ip}:${day}`;
  const allKey = `rl:all:${day}`;
  const [ipUsed, allUsed] = await Promise.all([env.GUIDES.get(ipKey), env.GUIDES.get(allKey)]);
  if (Number(allUsed ?? 0) >= total) return "The demo has hit today's limit for live research. Library guides are still available; try again tomorrow.";
  if (Number(ipUsed ?? 0) >= perIp) return `You've generated ${perIp} guides today, which is the demo limit. Library guides are still available.`;
  await Promise.all([
    env.GUIDES.put(ipKey, String(Number(ipUsed ?? 0) + 1), { expirationTtl: 172_800 }),
    env.GUIDES.put(allKey, String(Number(allUsed ?? 0) + 1), { expirationTtl: 172_800 }),
  ]);
  return null;
}

function newId(slug: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `${slug}-${[...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6)}`;
}

/** POST /api/generate: stream research progress as server-sent events. */
async function handleGenerate(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let query = "";
  try {
    query = String(((await request.json()) as { query?: unknown }).query ?? "").trim();
  } catch {
    return json({ error: "Send JSON: {\"query\": \"app name or website\"}" }, 400);
  }
  if (!query || query.length > MAX_QUERY) return json({ error: `Enter an app name or website (up to ${MAX_QUERY} characters).` }, 400);

  const origin = new URL(request.url).origin;
  const hit = findInLibrary(query);
  if (hit) return json({ redirect: `/guide/${hit.slug}`, source: "library" });
  const norm = normalizeQuery(query);
  const cachedId = await env.GUIDES.get(`query:${norm}`);
  if (cachedId) return json({ redirect: `/g/${cachedId}`, source: "cache" });

  if (!env.ANTHROPIC_API_KEY) return json({ error: "Live research is not configured on this deployment (no API key)." }, 503);
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const refused = await takeBudget(env, ip);
  if (refused) return json({ error: refused }, 429);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let open = true;
  const send = (e: AgentEvent) => {
    if (open) writer.write(enc.encode(`data: ${JSON.stringify(e)}\n\n`)).catch(() => (open = false));
  };
  const heartbeat = setInterval(() => open && writer.write(enc.encode(": ping\n\n")).catch(() => (open = false)), 15_000);

  const run = (async () => {
    try {
      const model = env.MODEL || DEFAULT_MODEL;
      const { guide, usage } = await generateGuide({
        query,
        client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
        model,
        emit: send,
        maxSourceChecks: 10,
      });
      const id = newId(guide.slug);
      guide.meta.id = id;
      await env.GUIDES.put(`guide:${id}`, JSON.stringify(guide));
      await env.GUIDES.put(`query:${norm}`, id, { expirationTtl: CACHE_DAYS * 86_400 });
      const recent = [{ id, name: guide.app.name, tier: guide.verdict.tier, difficulty: guide.verdict.difficulty, at: guide.meta.researched_at }, ...(await readRecent(env)).filter((r) => r.name !== guide.app.name)].slice(0, 24);
      await env.GUIDES.put("recent", JSON.stringify(recent));
      console.log(JSON.stringify({ event: "generated", id, query, usage }));
      send({ type: "done", id, url: `${origin}/g/${id}` });
    } catch (err) {
      if (err instanceof NotApplicableError) {
        send({ type: "error", message: `${err.appName} doesn't offer OAuth to third-party apps. ${err.reason} Alternative: ${err.alternative}` });
      } else {
        console.error(JSON.stringify({ event: "generate_failed", query, error: err instanceof Error ? err.message : String(err) }));
        const message = err instanceof Anthropic.RateLimitError ? "The research model is busy. Try again in a minute." : err instanceof Anthropic.APIError ? `The research model returned an error (${err.status}).` : err instanceof Error ? err.message : "Research failed.";
        send({ type: "error", message });
      }
    } finally {
      clearInterval(heartbeat);
      open = false;
      await writer.close().catch(() => {});
    }
  })();
  ctx.waitUntil(run);

  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/generate" && request.method === "POST") return handleGenerate(request, env, ctx);
    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "Method not allowed" }, 405);

    if (path === "/api/guides") {
      return json({ guides: GUIDES.map(summary), catalog: CATALOG, recent: await readRecent(env) }, 200, { "cache-control": "public, max-age=60" });
    }

    let m = /^\/api\/guides\/([a-z0-9-]+)(\.md|\.json)?$/.exec(path);
    if (m) {
      const g = BY_SLUG.get(m[1]);
      if (!g) return json({ error: "No library guide with that name" }, 404);
      return m[2] === ".md" ? markdown(g, `${url.origin}/guide/${g.slug}`) : json(g);
    }

    m = /^\/api\/g\/([a-z0-9-]+)(\.md|\.json)?$/.exec(path);
    if (m) {
      const g = (await env.GUIDES.get(`guide:${m[1]}`, "json")) as StoredGuide | null;
      if (!g) return json({ error: "Guide not found" }, 404);
      return m[2] === ".md" ? markdown(g, `${url.origin}/g/${m[1]}`) : json(g);
    }

    if (/^\/(guide|g)\/[a-z0-9-]+\/?$/.test(path)) {
      // Assets serves guide.html at the extensionless path ("/guide.html" would 307 to it).
      return env.ASSETS.fetch(new Request(new URL("/guide", url.origin), request));
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
