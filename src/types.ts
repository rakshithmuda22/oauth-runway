// Mirrors schema/guide.schema.json. The schema is the source of truth; these
// types exist so the worker, scripts and tests agree on field names.

export type Owner = "agent" | "you" | "agent+you" | "provider";
export type Tier = "self-serve" | "self-serve-with-review" | "approval-gated" | "partner-only";

export interface Step {
  title: string;
  detail: string;
  owner: Owner;
  agent_help: string;
  link: string;
  sources: string[];
}

export interface Phase {
  name: string;
  goal: string;
  duration: string;
  is_wait: boolean;
  steps: Step[];
}

export interface Source {
  id: string;
  title: string;
  url: string;
  kind: "official-docs" | "official-policy" | "official-blog" | "composio" | "community";
  supports: string;
}

export interface Guide {
  slug: string;
  app: { name: string; website: string; category: string; developer_portal_url: string; docs_url: string };
  composio: { toolkit_slug: string; managed_oauth: "available" | "bring-your-own" | "not-listed"; note: string };
  verdict: {
    tier: Tier;
    difficulty: number;
    headline: string;
    summary: string;
    time_to_first_connection: string;
    time_to_production: string;
    hands_on_effort: string;
    approval_wait: string;
    cost: string;
    confidence: "high" | "medium" | "low";
  };
  phases: Phase[];
  requirements: { item: string; needed_for: "development" | "production" | "public-listing"; detail: string; sources: string[] }[];
  scopes: { scope: string; purpose: string; sensitivity: "basic" | "sensitive" | "restricted" | "admin"; review_impact: string; sources: string[] }[];
  oauth: {
    authorize_url: string;
    token_url: string;
    discovery_url: string;
    pkce: string;
    refresh_tokens: string;
    redirect_uri_rules: string;
    sources: string[];
  };
  limits: { limit: string; applies_when: string; how_to_lift: string; sources: string[] }[];
  blockers: { blocker: string; symptom: string; fix: string; sources: string[] }[];
  agent_handoff: { agent_can: string[]; you_must: string[] };
  sources: Source[];
  uncertain: string[];
}

/** One observation made by code (never by the model) against a live endpoint. */
export interface TestResult {
  check: string;
  method: string;
  result: string;
  status: "pass" | "fail" | "info";
  at: string;
}

export interface GuideMeta {
  /** "library" guides were researched ahead of time; "live" ones were generated on request. */
  origin: "library" | "live";
  researched_by: string;
  researched_at: string;
  tested_at: string;
  /** Live guides only: the request that produced it. */
  query?: string;
  id?: string;
}

export interface StoredGuide extends Guide {
  meta: GuideMeta;
  tested: TestResult[];
}

/** Progress events streamed to the browser while a live guide is generated. */
export type AgentEvent =
  | { type: "status"; message: string }
  | { type: "search"; query: string }
  | { type: "fetch"; url: string }
  | { type: "probe"; url: string; result: string }
  | { type: "note"; text: string }
  | { type: "done"; id: string; url: string }
  | { type: "error"; message: string };
