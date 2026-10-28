import { describe, expect, it } from "vitest";
import library from "../src/generated/library.json" with { type: "json" };
import { findInLibrary, normalizeQuery } from "../src/worker.ts";
import { toMarkdown } from "../src/markdown.ts";
import type { StoredGuide } from "../src/types.ts";

const guides = library.guides as unknown as StoredGuide[];

describe("finding a library guide from what people type", () => {
  const cases: [string, string | undefined][] = [
    ["Slack", "slack"],
    ["https://www.hubspot.com/", "hubspot"],
    ["xero.com", "xero"],
    ["Gmail", "google-workspace"],
    ["outlook", "microsoft-365"],
    ["Twitter", "x-twitter"],
    ["  QuickBooks Online ", "quickbooks"],
    ["Zoom", undefined],
    ["", undefined],
  ];
  for (const [q, slug] of cases) it(JSON.stringify(q), () => expect(findInLibrary(q)?.slug).toBe(slug));
  it("normalizes urls and punctuation", () => expect(normalizeQuery("HTTPS://www.Pipedrive.com/en")).toBe("pipedrive.com"));
});

describe("markdown export", () => {
  for (const g of guides) {
    it(g.slug, () => {
      const md = toMarkdown(g, `https://example.com/guide/${g.slug}`);
      expect(md).toContain(`# ${g.app.name}`);
      expect(md).toContain(g.verdict.headline);
      for (const s of g.sources) expect(md).toContain(s.url);
      for (const p of g.phases) expect(md).toContain(p.name);
      expect(md).toContain("### Tested");
    });
  }
});

describe("bundle", () => {
  it("ships every library guide with probe results and the 100-app catalog", () => {
    expect(guides.length).toBeGreaterThanOrEqual(13);
    expect(guides.every((g) => g.tested.length > 0 && g.meta.origin === "library")).toBe(true);
    expect(library.catalog.length).toBe(100);
    const slugs = new Set(library.catalog.map((a: { slug: string }) => a.slug));
    for (const g of guides) expect(slugs.has(g.slug), g.slug).toBe(true);
  });
});
