import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { guideSchema, validateGuide } from "../src/validate.ts";
import type { Guide, TestResult } from "../src/types.ts";

const files = readdirSync("data/guides").filter((f) => f.endsWith(".json"));
const load = (f: string): Guide => JSON.parse(readFileSync(`data/guides/${f}`, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const ajvValidate = ajv.compile(guideSchema);

describe("library guides", () => {
  it("has a varied set of apps", () => {
    const tiers = new Set(files.map((f) => load(f).verdict.tier));
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(tiers.size).toBe(4);
  });

  for (const f of files) {
    describe(f, () => {
      const g = load(f);
      it("passes the JSON Schema (Ajv) and the runtime validator", () => {
        expect(ajvValidate(g), JSON.stringify(ajvValidate.errors)).toBe(true);
        expect(validateGuide(g)).toEqual([]);
      });
      it("is named after its slug and cites official sources", () => {
        expect(f).toBe(`${g.slug}.json`);
        expect(g.sources.some((s) => s.kind.startsWith("official"))).toBe(true);
      });
      it("tells the developer how to connect it to Composio", () => {
        expect(JSON.stringify(g.phases)).toContain("backend.composio.dev");
      });
      it("splits work between agent and human", () => {
        const owners = new Set(g.phases.flatMap((p) => p.steps.map((s) => s.owner)));
        expect(owners.has("you")).toBe(true);
        expect(owners.has("agent") || owners.has("agent+you")).toBe(true);
        expect(g.agent_handoff.agent_can.length).toBeGreaterThan(0);
        expect(g.agent_handoff.you_must.length).toBeGreaterThan(0);
      });
      it("has live probe results with no broken checks", () => {
        const probes: TestResult[] = JSON.parse(readFileSync(`data/probes/${g.slug}.json`, "utf8"));
        expect(probes.length).toBeGreaterThan(0);
        expect(probes.filter((p) => p.status === "fail")).toEqual([]);
      });
    });
  }
});

describe("runtime validator agrees with Ajv on broken guides", () => {
  const base = load(files[0]);
  const cases: [string, (g: any) => void][] = [
    ["missing verdict", (g) => delete g.verdict],
    ["bad tier", (g) => (g.verdict.tier = "easy")],
    ["extra key", (g) => (g.surprise = true)],
    ["string difficulty", (g) => (g.verdict.difficulty = "3")],
    ["bad owner", (g) => (g.phases[0].steps[0].owner = "robot")],
    ["sources not array", (g) => (g.sources = "s1")],
  ];
  for (const [name, mutate] of cases) {
    it(name, () => {
      const g = structuredClone(base);
      mutate(g);
      expect(ajvValidate(g)).toBe(false);
      expect(validateGuide(g).length).toBeGreaterThan(0);
    });
  }
  it("catches what a schema can't: dangling citations and out-of-range difficulty", () => {
    const g = structuredClone(base);
    g.phases[0].steps[0].sources = ["s999"];
    g.verdict.difficulty = 9;
    expect(ajvValidate(g)).toBe(true);
    const errors = validateGuide(g);
    expect(errors.join("\n")).toContain("s999");
  });
});
