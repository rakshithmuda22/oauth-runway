// The live research agent: given an app name or website, Claude searches and
// reads the provider's docs, probes its real OAuth endpoints, and submits a
// guide that must pass the same schema as the library. Runs in the Worker and
// in Node (scripts/generate.ts).

import Anthropic from "@anthropic-ai/sdk";
import { guideSchema, validateGuide } from "./validate.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import {
  authorizeProbeUrl,
  interpretAuthorize,
  interpretDiscovery,
  interpretPortal,
  interpretSource,
  observe,
  runProbes,
  type Fetch,
} from "./probe.ts";
import type { AgentEvent, Guide, StoredGuide, TestResult } from "./types.ts";

export const DEFAULT_MODEL = "claude-opus-5-5";
const MAX_TURNS = 16;
const MAX_PROBES = 6;
const MAX_SUBMIT_ATTEMPTS = 3;

export class NotApplicableError extends Error {
  readonly appName: string;
  readonly reason: string;
  readonly alternative: string;
  constructor(appName: string, reason: string, alternative: string) {
    super(`${appName}: ${reason}`);
    this.appName = appName;
    this.reason = reason;
    this.alternative = alternative;
  }
}

/** The guide schema as a strict tool schema (no top-level metadata keywords). */
function guideToolSchema() {
  const { $schema: _s, title: _t, description: _d, ...rest } = guideSchema as Record<string, unknown>;
  const copy = structuredClone(rest) as { properties: { verdict: { properties: { difficulty: Record<string, unknown> } } } };
  copy.properties.verdict.properties.difficulty.enum = [1, 2, 3, 4, 5];
  return copy as unknown as Anthropic.Beta.BetaTool.InputSchema;
}

export const TOOLS: Anthropic.Beta.BetaToolUnion[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 10 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 14, max_content_tokens: 24_000 },
  {
    name: "probe_endpoint",
    description:
      "Make a real HTTPS GET request and report what the endpoint did. purpose=authorize: pass the provider's authorize URL (without query); we add a dummy client_id and the Composio redirect URI and report whether it rejects the unregistered client or sends the user to sign in. purpose=discovery: an OIDC/OAuth metadata URL; we report PKCE methods and grant types. purpose=developer_portal or other: reachability and sign-in walls. Results are recorded as tested evidence in the guide.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url", "purpose"],
      properties: {
        url: { type: "string", description: "Absolute https URL" },
        purpose: { type: "string", enum: ["authorize", "discovery", "developer_portal", "other"] },
      },
    },
  },
  {
    name: "submit_guide",
    description: "Submit the finished guide. Call exactly once, after research and probing. It is validated; fix any errors you are sent back and resubmit.",
    strict: true,
    input_schema: guideToolSchema(),
  },
  {
    name: "not_applicable",
    description: "Use instead of submit_guide when the provider does not offer OAuth for third-party apps at all.",
    strict: true,
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["app_name", "reason", "alternative"],
      properties: {
        app_name: { type: "string" },
        reason: { type: "string", description: "What the provider offers instead and the source URL" },
        alternative: { type: "string", description: "How a developer can still integrate (API keys, partner program...)" },
      },
    },
  },
];

/** Allow only public https hosts, so a prompt can't point probes at internal addresses. */
export function isPublicHttpsUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.startsWith("[") || !h.includes(".")) return false;
  return true;
}

async function runProbeTool(input: { url: string; purpose: string }, fetchImpl: Fetch): Promise<TestResult> {
  const at = new Date().toISOString();
  if (!isPublicHttpsUrl(input.url)) {
    return { check: `Probe (${input.purpose})`, method: input.url, result: "Refused: only public https URLs can be probed.", status: "info", at };
  }
  if (input.purpose === "authorize") {
    const url = authorizeProbeUrl(input.url);
    if (!url) return { check: "Authorize endpoint responds to an unregistered client", method: input.url, result: "Not probed: per-customer URL.", status: "info", at };
    return { check: "Authorize endpoint responds to an unregistered client", method: `GET ${url}`, ...interpretAuthorize(await observe(url, fetchImpl)), at };
  }
  const obs = await observe(input.url, fetchImpl);
  if (input.purpose === "discovery") return { check: "OAuth / OIDC metadata document", method: `GET ${input.url}`, ...interpretDiscovery(obs), at };
  if (input.purpose === "developer_portal") return { check: "Developer portal reachable", method: `GET ${input.url}`, ...interpretPortal(obs), at };
  return { check: "Page reachable", method: `GET ${input.url}`, ...interpretSource(obs), at };
}

export interface RunOptions {
  query: string;
  client: Anthropic;
  model?: string;
  emit?: (e: AgentEvent) => void;
  fetchImpl?: Fetch;
  now?: () => Date;
  /** Cap on source links re-checked after submission (Worker subrequest budget). */
  maxSourceChecks?: number;
}

export interface RunResult {
  guide: StoredGuide;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; web_search_requests: number };
}

export async function generateGuide(opts: RunOptions): Promise<RunResult> {
  const emit = opts.emit ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const model = opts.model ?? DEFAULT_MODEL;
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0 };

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: userMessage(opts.query, now().toISOString().slice(0, 10)) },
  ];
  const agentProbes: TestResult[] = [];
  let submitAttempts = 0;

  emit({ type: "status", message: `Researching "${opts.query}"` });

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = opts.client.beta.messages.stream({
      model,
      max_tokens: 64_000,
      betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
      fallbacks: "default",
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "server_tool_use" && block.name === "web_search") emit({ type: "search", query: String(block.input.query ?? "") });
      else if (block.type === "server_tool_use" && block.name === "web_fetch") emit({ type: "fetch", url: String(block.input.url ?? "") });
      else if (block.type === "thinking" && block.thinking.trim()) emit({ type: "note", text: block.thinking.trim() });
      else if (block.type === "text" && block.text.trim()) emit({ type: "note", text: block.text.trim() });
    });
    const message = await stream.finalMessage();

    usage.input_tokens += message.usage.input_tokens;
    usage.output_tokens += message.usage.output_tokens;
    usage.cache_read_input_tokens += message.usage.cache_read_input_tokens ?? 0;
    usage.web_search_requests += message.usage.server_tool_use?.web_search_requests ?? 0;

    if (message.stop_reason === "refusal") throw new Error("The model declined this request.");
    if (message.stop_reason === "max_tokens") throw new Error("The guide was too long to finish. Try again.");

    messages.push({ role: "assistant", content: message.content });
    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // Ended without submitting: ask once more, explicitly.
      messages.push({ role: "user", content: "Please call submit_guide now with the complete guide (or not_applicable)." });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let submitted: Guide | null = null;
    for (const use of toolUses) {
      if (use.name === "probe_endpoint") {
        const input = use.input as { url: string; purpose: string };
        if (agentProbes.length >= MAX_PROBES) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Probe limit reached; submit the guide." });
          continue;
        }
        const r = await runProbeTool(input, fetchImpl);
        agentProbes.push(r);
        emit({ type: "probe", url: input.url, result: r.result });
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(r) });
      } else if (use.name === "not_applicable") {
        const input = use.input as { app_name: string; reason: string; alternative: string };
        throw new NotApplicableError(input.app_name, input.reason, input.alternative);
      } else if (use.name === "submit_guide") {
        submitAttempts++;
        const errors = validateGuide(use.input);
        if (errors.length === 0) {
          submitted = use.input as Guide;
          results.push({ type: "tool_result", tool_use_id: use.id, content: "Accepted." });
        } else {
          if (submitAttempts >= MAX_SUBMIT_ATTEMPTS) throw new Error(`Guide failed validation: ${errors.slice(0, 5).join("; ")}`);
          emit({ type: "status", message: "Fixing validation errors in the draft guide" });
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Fix these and resubmit:\n${errors.slice(0, 30).join("\n")}` });
        }
      } else {
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` });
      }
    }

    if (submitted) {
      emit({ type: "status", message: "Re-checking endpoints and every cited source" });
      const checks = await runProbes(submitted, { fetchImpl, now, maxSources: opts.maxSourceChecks });
      // Keep the agent's own probes too, without repeating identical requests.
      const seen = new Set(checks.map((c) => c.method));
      const tested = [...checks, ...agentProbes.filter((p) => !seen.has(p.method))];
      const at = now().toISOString();
      return {
        guide: { ...submitted, meta: { origin: "live", researched_by: model, researched_at: at, tested_at: at, query: opts.query }, tested },
        usage,
      };
    }
    messages.push({ role: "user", content: results });
  }
  throw new Error("The agent ran out of turns before finishing the guide.");
}
