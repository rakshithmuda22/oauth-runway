// Live checks run by code against a provider's real endpoints. These are the
// "tested" evidence in every guide: the model never writes them, so a guide
// can't claim a test that didn't happen. Uses only fetch, so the same module
// runs in the Worker (live guides) and in Node (scripts/probe-library.ts).

import type { Guide, TestResult } from "./types.ts";

export const PROBE_CLIENT_ID = "oauth-runway-probe";
export const PROBE_REDIRECT_URI = "https://backend.composio.dev/api/v3/toolkits/auth/callback";
const USER_AGENT = "OAuthRunway-Probe/0.1 (+https://github.com/rakshithmuda22/oauth-runway)";
const MAX_HOPS = 4;

export type Fetch = typeof fetch;

export interface Observation {
  url: string;
  status: number; // 0 = network error
  finalUrl: string;
  chain: { url: string; status: number }[];
  contentType: string;
  title: string;
  text: string;
  error?: string;
  /** Set when we stopped instead of following a redirect to the OAuth redirect_uri. */
  stoppedAtRedirectUri?: boolean;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** GET a URL, following redirects by hand so the chain is recorded. */
export async function observe(url: string, fetchImpl: Fetch = fetch, timeoutMs = 10_000): Promise<Observation> {
  const chain: Observation["chain"] = [];
  const redirectHost = new URL(PROBE_REDIRECT_URI).host;
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const res = await fetchImpl(current, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.8" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      chain.push({ url: current, status: res.status });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        const next = new URL(location, current).toString();
        await res.body?.cancel();
        if (new URL(next).host === redirectHost) {
          // The provider bounced back to the redirect_uri (usually with ?error=).
          // Record it but never call the real callback.
          return { url, status: res.status, finalUrl: next, chain, contentType: "", title: "", text: "", stoppedAtRedirectUri: true };
        }
        current = next;
        continue;
      }
      const contentType = res.headers.get("content-type") ?? "";
      const body = (await res.text()).slice(0, 200_000);
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim() ?? "";
      const text = contentType.includes("json") ? body.slice(0, 50_000) : htmlToText(body).slice(0, 4000);
      return { url, status: res.status, finalUrl: current, chain, contentType, title, text };
    }
    return { url, status: chain.at(-1)?.status ?? 0, finalUrl: current, chain, contentType: "", title: "", text: "", error: "too many redirects" };
  } catch (err) {
    return { url, status: 0, finalUrl: current, chain, contentType: "", title: "", text: "", error: err instanceof Error ? err.message : String(err) };
  }
}

const snippet = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const looksLikeLogin = (u: string) => /log-?in|sign-?in|signin|account|sso|session/i.test(new URL(u).pathname + new URL(u).host);
const LOGIN_WORDS = /\b(log ?in|sign ?in)\b/i;
const CLIENT_ERROR =
  /invalid[_ ]client|unauthori[sz]ed[_ ]client|unknown client|invalid[_ ]request|client[_ ]?id[^.]{0,40}(?:invalid|not found|does not exist|doesn.t exist|not recogni[sz]ed)|(?:app|application|integration)[^.]{0,40}(?:not found|does not exist|doesn.t exist|could not be found)|redirect[_ ]uri[^.]{0,40}(?:mismatch|invalid|not match|not registered)/i;

/** Text around the first match, so the quoted evidence shows the actual error. */
function around(text: string, re: RegExp, n = 160): string {
  const m = re.exec(text);
  if (!m) return snippet(text, n);
  const start = Math.max(0, m.index - 40);
  return (start > 0 ? "…" : "") + snippet(text.slice(start), n);
}

/**
 * Pick a probe-able URL out of the authorize_url field. Researchers sometimes
 * add prose ("(or https://MyDomain...)"); we take the first URL and fill the
 * tenant placeholder Microsoft documents. Per-customer hosts can't be probed.
 */
export function concreteAuthorizeUrl(authorizeUrl: string): string | null {
  const first = /https:\/\/[^\s,;)]+/.exec(authorizeUrl)?.[0];
  if (!first) return null;
  const filled = first.replace(/\{tenant\}|\{tenant[-_]id\}|<tenant>/gi, "common");
  if (/[{}<>[\]]|mydomain|your[-_]?(?:shop|store|domain|instance)/i.test(filled)) return null;
  return filled;
}

export function authorizeProbeUrl(authorizeUrl: string): string | null {
  const base = concreteAuthorizeUrl(authorizeUrl);
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("client_id", PROBE_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", PROBE_REDIRECT_URI);
  u.searchParams.set("state", "oauth-runway-probe");
  return u.toString();
}

/** Turn an authorize-endpoint observation into a plain-language result. */
export function interpretAuthorize(obs: Observation): Pick<TestResult, "result" | "status"> {
  if (obs.status === 0) return { status: "fail", result: `Unreachable: ${obs.error ?? "network error"}` };
  if (obs.stoppedAtRedirectUri) {
    const err = new URL(obs.finalUrl).searchParams.get("error");
    return { status: "pass", result: `Endpoint is live. It redirected back to the redirect URI${err ? ` with error=${err}` : ""} for an unregistered client.` };
  }
  const hops = obs.chain.length - 1;
  const via = hops > 0 ? ` after ${hops} redirect${hops > 1 ? "s" : ""}` : "";
  if (obs.status === 404 || obs.status === 410) return { status: "fail", result: `HTTP ${obs.status}${via}: the documented authorize URL was not found.` };
  if (obs.status >= 500) return { status: "fail", result: `HTTP ${obs.status}${via}: server error.` };
  const page = `${obs.title} ${obs.text}`.trim();
  if (CLIENT_ERROR.test(page)) {
    return { status: "pass", result: `Endpoint is live and rejects an unregistered client_id (HTTP ${obs.status}${via}): "${around(page, CLIENT_ERROR)}"` };
  }
  if (obs.status === 403 && /cloudflare|captcha|access denied|request blocked/i.test(page)) {
    return { status: "info", result: `HTTP 403${via}: blocked by bot protection, so the client check could not be observed.` };
  }
  if ((hops > 0 && looksLikeLogin(obs.finalUrl)) || (obs.status < 400 && LOGIN_WORDS.test(obs.title + " " + obs.text.slice(0, 300)))) {
    return { status: "pass", result: `Endpoint is live. It asks the user to sign in first (${new URL(obs.finalUrl).host}); the client is only validated after login, so a bad client ID or redirect URI shows up as an error after sign-in.` };
  }
  if (obs.status >= 400) return { status: "pass", result: `Endpoint is live and refused the probe with HTTP ${obs.status}${via}: "${snippet(page)}"` };
  if (page.length < 200 || /enable javascript|javascript must be enabled|javascript is required/i.test(page)) {
    return { status: "info", result: `Endpoint is live (HTTP ${obs.status}${via}) but renders in the browser with JavaScript, so its client check can't be seen without a real browser session.` };
  }
  return { status: "info", result: `HTTP ${obs.status}${via}; page title "${snippet(obs.title || "(none)")}". No explicit client error was shown.` };
}

/** Summarise an OIDC / OAuth authorization-server metadata document. */
export function interpretDiscovery(obs: Observation): Pick<TestResult, "result" | "status"> {
  if (obs.status !== 200) return { status: obs.status === 0 ? "fail" : "info", result: obs.status === 0 ? `Unreachable: ${obs.error}` : `HTTP ${obs.status}: no metadata document here.` };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(obs.text);
  } catch {
    return { status: "info", result: "Responded, but not with JSON metadata." };
  }
  const list = (k: string) => (Array.isArray(doc[k]) ? (doc[k] as string[]).join(", ") : "not advertised");
  return {
    status: "pass",
    result: `Metadata published. PKCE methods: ${list("code_challenge_methods_supported")}. Grant types: ${list("grant_types_supported")}. Token auth: ${list("token_endpoint_auth_methods_supported")}.`,
  };
}

export function interpretSource(obs: Observation): Pick<TestResult, "result" | "status"> {
  if (obs.status === 0) return { status: "fail", result: `Unreachable: ${obs.error}` };
  if (obs.status >= 200 && obs.status < 300) return { status: "pass", result: `HTTP ${obs.status}${obs.title ? `: "${snippet(obs.title, 90)}"` : ""}` };
  if ([401, 403, 429, 999].includes(obs.status)) return { status: "info", result: `HTTP ${obs.status}: the site blocks automated requests, so this link was not machine-checked.` };
  return { status: "fail", result: `HTTP ${obs.status}: link may be broken or moved.` };
}

export function interpretPortal(obs: Observation): Pick<TestResult, "result" | "status"> {
  if (obs.status === 0) return { status: "fail", result: `Unreachable: ${obs.error}` };
  if (obs.chain.length > 1 && looksLikeLogin(obs.finalUrl)) return { status: "pass", result: `Reachable. Redirects to sign-in (${new URL(obs.finalUrl).host}); you will need an account here.` };
  if (obs.status < 400) return { status: "pass", result: `Reachable (HTTP ${obs.status})${obs.title ? `: "${snippet(obs.title, 90)}"` : ""}.` };
  return interpretSource(obs);
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export interface ProbeOptions {
  fetchImpl?: Fetch;
  now?: () => Date;
  /** Cap on source links checked; the Worker keeps this low to stay under subrequest limits. */
  maxSources?: number;
}

/** Run every check a guide supports. Order: authorize, discovery, portal, sources. */
export async function runProbes(guide: Guide, opts: ProbeOptions = {}): Promise<TestResult[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const at = () => (opts.now ?? (() => new Date()))().toISOString();
  const jobs: (() => Promise<TestResult | null>)[] = [];

  const authUrl = authorizeProbeUrl(guide.oauth.authorize_url);
  if (authUrl) {
    jobs.push(async () => ({
      check: "Authorize endpoint responds to an unregistered client",
      method: `GET ${authUrl}`,
      ...interpretAuthorize(await observe(authUrl, fetchImpl)),
      at: at(),
    }));
  } else if (guide.oauth.authorize_url) {
    jobs.push(async () => ({
      check: "Authorize endpoint responds to an unregistered client",
      method: guide.oauth.authorize_url,
      result: "Not probed: the URL is per-customer (it contains a placeholder such as a store or instance name).",
      status: "info",
      at: at(),
    }));
  }

  const discovery = guide.oauth.discovery_url && /^https:\/\//.test(guide.oauth.discovery_url) ? guide.oauth.discovery_url : null;
  if (discovery) {
    jobs.push(async () => ({
      check: "OAuth / OIDC metadata document",
      method: `GET ${discovery}`,
      ...interpretDiscovery(await observe(discovery, fetchImpl)),
      at: at(),
    }));
  }

  if (/^https:\/\//.test(guide.app.developer_portal_url)) {
    jobs.push(async () => ({
      check: "Developer portal reachable",
      method: `GET ${guide.app.developer_portal_url}`,
      ...interpretPortal(await observe(guide.app.developer_portal_url, fetchImpl)),
      at: at(),
    }));
  }

  for (const s of guide.sources.slice(0, opts.maxSources ?? guide.sources.length)) {
    jobs.push(async () => ({
      check: `Source [${s.id}] still online`,
      method: `GET ${s.url}`,
      ...interpretSource(await observe(s.url, fetchImpl)),
      at: at(),
    }));
  }

  const results = await pool(jobs, 6, (job) => job());
  return results.filter((r): r is TestResult => r !== null);
}
