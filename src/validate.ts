// A small JSON Schema checker for the subset guide.schema.json uses (type,
// properties, required, additionalProperties: false, items, enum). Workers
// forbid runtime code generation, so Ajv cannot run there; the tests check
// this validator against Ajv so the two never disagree on the library.

import schema from "../schema/guide.schema.json" with { type: "json" };
import type { Guide } from "./types.ts";

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: Schema;
  enum?: unknown[];
};

function check(value: unknown, s: Schema, path: string, errors: string[]): void {
  if (s.enum && !s.enum.includes(value)) {
    errors.push(`${path}: must be one of ${s.enum.join(", ")} (got ${JSON.stringify(value)})`);
    return;
  }
  switch (s.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      const obj = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (!(key in obj)) errors.push(`${path}.${key}: missing`);
      }
      for (const [key, v] of Object.entries(obj)) {
        const sub = s.properties?.[key];
        if (sub) check(v, sub, `${path}.${key}`, errors);
        else if (s.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      if (s.items) value.forEach((v, i) => check(v, s.items!, `${path}[${i}]`, errors));
      return;
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      return;
    case "integer":
      if (!Number.isInteger(value)) errors.push(`${path}: expected integer`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return;
  }
}

/** Schema errors plus the cross-field rules a schema cannot express. */
export function validateGuide(value: unknown): string[] {
  const errors: string[] = [];
  check(value, schema as Schema, "$", errors);
  if (errors.length) return errors;

  const g = value as Guide;
  if (g.verdict.difficulty < 1 || g.verdict.difficulty > 5) errors.push("$.verdict.difficulty: must be 1-5");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(g.slug)) errors.push("$.slug: must be lowercase-kebab");
  if (!g.phases.length) errors.push("$.phases: at least one phase required");

  const ids = new Set(g.sources.map((s) => s.id));
  if (ids.size !== g.sources.length) errors.push("$.sources: duplicate ids");
  for (const s of g.sources) {
    if (!/^https?:\/\//.test(s.url)) errors.push(`$.sources[${s.id}]: url must be http(s)`);
  }
  const cited: [string, string[]][] = [
    ["oauth", g.oauth.sources],
    ...g.phases.flatMap((p, i) => p.steps.map((st, j): [string, string[]] => [`phases[${i}].steps[${j}]`, st.sources])),
    ...g.requirements.map((r, i): [string, string[]] => [`requirements[${i}]`, r.sources]),
    ...g.scopes.map((r, i): [string, string[]] => [`scopes[${i}]`, r.sources]),
    ...g.limits.map((r, i): [string, string[]] => [`limits[${i}]`, r.sources]),
    ...g.blockers.map((r, i): [string, string[]] => [`blockers[${i}]`, r.sources]),
  ];
  for (const [where, refs] of cited) {
    for (const ref of refs) if (!ids.has(ref)) errors.push(`$.${where}: cites unknown source ${ref}`);
  }
  return errors;
}

export { schema as guideSchema };
