import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { TOOLS, generateGuide, isPublicHttpsUrl, NotApplicableError } from "../src/agent.ts";
import type { AgentEvent, Guide } from "../src/types.ts";

type Block = Record<string, unknown>;
const message = (content: Block[], stop_reason: string) => ({
  content,
  stop_reason,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, server_tool_use: { web_search_requests: 1 } },
});

/** A stand-in for the SDK client that replays scripted responses and records requests. */
function fakeClient(script: ReturnType<typeof message>[]) {
  const requests: any[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: any) {
          requests.push(structuredClone(params));
          const next = script.shift();
          if (!next) throw new Error("script exhausted");
          const handlers: ((b: Block) => void)[] = [];
          return {
            on(event: string, cb: (b: Block) => void) {
              if (event === "contentBlock") handlers.push(cb);
              return this;
            },
            async finalMessage() {
              for (const b of next.content) handlers.forEach((h) => h(b));
              return next;
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const notion: Guide = JSON.parse(readFileSync("data/guides/notion.json", "utf8"));
const okFetch = (async (input: RequestInfo | URL) =>
  String(input).includes("authorize") ? new Response("invalid_client", { status: 400 }) : new Response("<title>ok</title>")) as typeof fetch;

describe("generateGuide", () => {
  it("researches, probes, fixes a validation error, and returns a tested guide", async () => {
    const broken = { ...structuredClone(notion), verdict: { ...notion.verdict, tier: "easy" } };
    const { client, requests } = fakeClient([
      message([
        { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "notion oauth public integration" } },
        { type: "web_search_tool_result", tool_use_id: "s1", content: [] },
        { type: "server_tool_use", id: "s2", name: "web_fetch", input: { url: "https://developers.notion.com/docs/authorization" } },
        { type: "tool_use", id: "t1", name: "probe_endpoint", input: { url: "https://api.notion.com/v1/oauth/authorize", purpose: "authorize" } },
      ], "tool_use"),
      message([{ type: "tool_use", id: "t2", name: "submit_guide", input: broken }], "tool_use"),
      message([{ type: "tool_use", id: "t3", name: "submit_guide", input: notion }], "tool_use"),
    ]);
    const events: AgentEvent[] = [];
    const { guide, usage } = await generateGuide({ query: "Notion", client, fetchImpl: okFetch, emit: (e) => events.push(e), now: () => new Date("2026-10-28T12:00:00Z") });

    expect(guide.slug).toBe("notion");
    expect(guide.meta).toMatchObject({ origin: "live", query: "Notion", researched_by: "claude-opus-5-5" });
    expect(guide.tested.some((t) => t.check.startsWith("Authorize") && t.status === "pass")).toBe(true);
    expect(usage.input_tokens).toBe(300);

    // The validation error went back to the model as an error tool_result.
    const second = requests[2].messages.at(-1).content[0];
    expect(second).toMatchObject({ type: "tool_result", tool_use_id: "t2", is_error: true });
    expect(second.content).toContain("verdict.tier");

    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["search", "fetch", "probe", "status"]));
    expect(requests[0]).toMatchObject({ model: "claude-opus-5-5", fallbacks: "default", thinking: { type: "adaptive" } });
    expect(requests[0].tool_choice).toBeUndefined(); // forced tool_choice 400s on Opus 5.5
  });

  it("resumes after pause_turn without adding a user message", async () => {
    const { client, requests } = fakeClient([
      message([{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }], "pause_turn"),
      message([{ type: "tool_use", id: "t1", name: "submit_guide", input: notion }], "tool_use"),
    ]);
    await generateGuide({ query: "Notion", client, fetchImpl: okFetch });
    expect(requests[1].messages.at(-1).role).toBe("assistant");
  });

  it("stops with NotApplicableError when the app has no third-party OAuth", async () => {
    const { client } = fakeClient([
      message([{ type: "tool_use", id: "t1", name: "not_applicable", input: { app_name: "Acme", reason: "API keys only", alternative: "Use a personal API key" } }], "tool_use"),
    ]);
    await expect(generateGuide({ query: "Acme", client, fetchImpl: okFetch })).rejects.toBeInstanceOf(NotApplicableError);
  });

  it("refuses to probe private or non-https URLs", async () => {
    const { client, requests } = fakeClient([
      message([{ type: "tool_use", id: "t1", name: "probe_endpoint", input: { url: "http://169.254.169.254/latest", purpose: "other" } }], "tool_use"),
      message([{ type: "tool_use", id: "t2", name: "submit_guide", input: notion }], "tool_use"),
    ]);
    let fetched = false;
    await generateGuide({ query: "x", client, fetchImpl: (async (u: RequestInfo | URL) => { if (String(u).includes("169.254")) fetched = true; return new Response("ok"); }) as typeof fetch });
    expect(fetched).toBe(false);
    expect(requests[1].messages.at(-1).content[0].content).toContain("Refused");
  });

  it("gives up after repeated invalid submissions", async () => {
    const bad = { slug: "x" };
    const { client } = fakeClient([1, 2, 3].map((i) => message([{ type: "tool_use", id: `t${i}`, name: "submit_guide", input: bad }], "tool_use")));
    await expect(generateGuide({ query: "x", client, fetchImpl: okFetch })).rejects.toThrow(/failed validation/);
  });
});

describe("tool definitions", () => {
  it("uses strict schemas with no forced tool choice", () => {
    const custom = TOOLS.filter((t): t is Anthropic.Beta.BetaTool => "input_schema" in t);
    expect(custom.map((t) => t.name)).toEqual(["probe_endpoint", "submit_guide", "not_applicable"]);
    for (const t of custom) {
      expect(t.strict).toBe(true);
      expect((t.input_schema as any).additionalProperties).toBe(false);
      expect(JSON.stringify(t.input_schema)).not.toContain("$schema");
    }
  });
  it("isPublicHttpsUrl", () => {
    expect(isPublicHttpsUrl("https://slack.com/oauth/v2/authorize")).toBe(true);
    for (const bad of ["http://slack.com", "https://localhost/x", "https://10.0.0.1/", "https://[::1]/", "https://intranet/", "https://a.internal/", "https://u:p@x.com/", "not a url"]) {
      expect(isPublicHttpsUrl(bad), bad).toBe(false);
    }
  });
});
