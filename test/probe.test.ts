import { describe, expect, it } from "vitest";
import {
  PROBE_REDIRECT_URI,
  authorizeProbeUrl,
  concreteAuthorizeUrl,
  interpretAuthorize,
  interpretDiscovery,
  observe,
  runProbes,
  type Observation,
} from "../src/probe.ts";
import { readFileSync } from "node:fs";

const obs = (o: Partial<Observation>): Observation => ({
  url: "https://p.example/authorize",
  status: 200,
  finalUrl: "https://p.example/authorize",
  chain: [{ url: "https://p.example/authorize", status: 200 }],
  contentType: "text/html",
  title: "",
  text: "",
  ...o,
});

describe("concreteAuthorizeUrl", () => {
  it("takes the first URL out of researcher prose", () => {
    expect(concreteAuthorizeUrl("https://login.salesforce.com/services/oauth2/authorize (or https://MyDomain.my.salesforce.com/...)")).toBe(
      "https://login.salesforce.com/services/oauth2/authorize",
    );
  });
  it("fills Microsoft's tenant placeholder", () => {
    expect(concreteAuthorizeUrl("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize")).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
  });
  it("refuses per-customer hosts", () => {
    expect(concreteAuthorizeUrl("https://{shop}.myshopify.com/admin/oauth/authorize")).toBeNull();
    expect(concreteAuthorizeUrl("https://your-store.example.com/oauth")).toBeNull();
    expect(concreteAuthorizeUrl("")).toBeNull();
  });
  it("adds a dummy client and the Composio redirect URI", () => {
    const u = new URL(authorizeProbeUrl("https://slack.com/oauth/v2/authorize")!);
    expect(u.searchParams.get("client_id")).toBe("oauth-runway-probe");
    expect(u.searchParams.get("redirect_uri")).toBe(PROBE_REDIRECT_URI);
  });
});

// Fixtures below are trimmed from real responses observed on 2026-10-28.
describe("interpretAuthorize", () => {
  it("Salesforce: explicit invalid client error", () => {
    const r = interpretAuthorize(obs({ status: 400, text: "error=invalid_client_id&error_description=client%20identifier%20invalid" }));
    expect(r.status).toBe("pass");
    expect(r.result).toContain("rejects an unregistered client_id");
  });
  it("Xero: error page that names unauthorized_client", () => {
    const r = interpretAuthorize(obs({ title: "Xero | Error", text: "Sorry, something went wrong. Error: unauthorized_client Unknown client or client not enabled" }));
    expect(r.result).toContain("unauthorized_client");
  });
  it("GitHub: redirect to sign-in is a pass, not a client error", () => {
    const r = interpretAuthorize(obs({
      finalUrl: "https://github.com/login?client_id=oauth-runway-probe",
      chain: [{ url: "https://github.com/login/oauth/authorize", status: 302 }, { url: "https://github.com/login", status: 200 }],
      title: "Sign in to GitHub · GitHub",
      text: "Sign in to GitHub. Error: please enable cookies",
    }));
    expect(r.status).toBe("pass");
    expect(r.result).toContain("sign in first");
  });
  it("Notion/Slack: page that needs JavaScript is reported as not observable", () => {
    const r = interpretAuthorize(obs({ title: "Notion", text: "Notion JavaScript must be enabled in order to use Notion." }));
    expect(r.status).toBe("info");
    expect(r.result).toContain("JavaScript");
  });
  it("bounce back to the redirect URI with an error", () => {
    const r = interpretAuthorize(obs({ status: 302, stoppedAtRedirectUri: true, finalUrl: `${PROBE_REDIRECT_URI}?error=invalid_client` }));
    expect(r).toEqual({ status: "pass", result: expect.stringContaining("error=invalid_client") });
  });
  it("404 and network failures fail", () => {
    expect(interpretAuthorize(obs({ status: 404 })).status).toBe("fail");
    expect(interpretAuthorize(obs({ status: 0, error: "ENOTFOUND" })).status).toBe("fail");
  });
});

describe("interpretDiscovery", () => {
  it("reports PKCE methods from metadata", () => {
    const r = interpretDiscovery(obs({ contentType: "application/json", text: JSON.stringify({ issuer: "x", code_challenge_methods_supported: ["S256"] }) }));
    expect(r.status).toBe("pass");
    expect(r.result).toContain("PKCE methods: S256");
  });
  it("non-JSON is info", () => {
    expect(interpretDiscovery(obs({ text: "<html>" })).status).toBe("info");
  });
});

describe("observe", () => {
  it("records the redirect chain and never calls the real callback", async () => {
    const calls: string[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://p.example/authorize")) return new Response(null, { status: 302, headers: { location: "/login" } });
      if (url === "https://p.example/login") return new Response(null, { status: 302, headers: { location: `${PROBE_REDIRECT_URI}?error=access_denied` } });
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const o = await observe("https://p.example/authorize", fake);
    expect(o.stoppedAtRedirectUri).toBe(true);
    expect(o.chain.map((c) => c.status)).toEqual([302, 302]);
    expect(calls.some((c) => c.startsWith(PROBE_REDIRECT_URI))).toBe(false);
  });
  it("turns network errors into status 0", async () => {
    const o = await observe("https://p.example/x", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    expect(o.status).toBe(0);
    expect(o.error).toContain("fetch failed");
  });
});

describe("runProbes", () => {
  it("checks authorize, discovery, portal and every source", async () => {
    const guide = JSON.parse(readFileSync("data/guides/salesforce.json", "utf8"));
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("openid-configuration")) return Response.json({ code_challenge_methods_supported: ["S256"] });
      if (url.includes("/authorize")) return new Response("error=invalid_client_id", { status: 400 });
      return new Response("<title>Docs</title>", { status: 200, headers: { "content-type": "text/html" } });
    }) as typeof fetch;
    const results = await runProbes(guide, { fetchImpl: fake, now: () => new Date("2026-10-28T00:00:00Z") });
    expect(results[0].check).toContain("Authorize");
    expect(results.filter((r) => r.check.startsWith("Source")).length).toBe(guide.sources.length);
    expect(results.every((r) => r.status === "pass")).toBe(true);
  });
  it("respects maxSources", async () => {
    const guide = JSON.parse(readFileSync("data/guides/slack.json", "utf8"));
    const fake = (async () => new Response("ok")) as typeof fetch;
    const results = await runProbes(guide, { fetchImpl: fake, maxSources: 2 });
    expect(results.filter((r) => r.check.startsWith("Source")).length).toBe(2);
  });
});
