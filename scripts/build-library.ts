// Merge data/guides (research) with data/probes (live checks) into the bundle
// the Worker serves. Fails the build if any guide breaks the schema, so a bad
// guide can never ship. Usage: npm run build
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { validateGuide } from "../src/validate.ts";
import type { Guide, StoredGuide, TestResult } from "../src/types.ts";

const RESEARCHED_AT = "2026-10-28";

const guides: StoredGuide[] = [];
const problems: string[] = [];
for (const file of (await readdir("data/guides")).filter((f) => f.endsWith(".json")).sort()) {
  const guide: Guide = JSON.parse(await readFile(`data/guides/${file}`, "utf8"));
  for (const e of validateGuide(guide)) problems.push(`${file}: ${e}`);
  let tested: TestResult[] = [];
  try {
    tested = JSON.parse(await readFile(`data/probes/${guide.slug}.json`, "utf8"));
  } catch {
    problems.push(`${file}: no probe results; run npm run probe`);
  }
  guides.push({
    ...guide,
    meta: {
      origin: "library",
      researched_by: "Claude research agents (Claude Code), reviewed against official docs",
      researched_at: RESEARCHED_AT,
      tested_at: tested.map((t) => t.at).sort().at(-1) ?? RESEARCHED_AT,
    },
    tested,
  });
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}

const catalog = JSON.parse(await readFile("data/catalog.json", "utf8"));
await mkdir("src/generated", { recursive: true });
await writeFile("src/generated/library.json", JSON.stringify({ guides, catalog: catalog.apps }));
console.log(`library: ${guides.length} guides, catalog: ${catalog.apps.length} apps`);
