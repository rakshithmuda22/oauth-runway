// Runs the live endpoint checks for every library guide and stores the results
// in data/probes/<slug>.json. Usage: npm run probe [-- slug ...]
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { runProbes } from "../src/probe.ts";
import type { Guide } from "../src/types.ts";

const only = new Set(process.argv.slice(2));
await mkdir("data/probes", { recursive: true });
for (const file of (await readdir("data/guides")).filter((f) => f.endsWith(".json")).sort()) {
  const guide: Guide = JSON.parse(await readFile(`data/guides/${file}`, "utf8"));
  if (only.size && !only.has(guide.slug)) continue;
  const results = await runProbes(guide);
  await writeFile(`data/probes/${guide.slug}.json`, JSON.stringify(results, null, 2) + "\n");
  const count = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`${guide.slug.padEnd(18)} pass ${count("pass")}  info ${count("info")}  fail ${count("fail")}`);
  for (const r of results.filter((r) => r.status !== "pass" || r.check.startsWith("Authorize") || r.check.startsWith("OAuth"))) {
    console.log(`   [${r.status}] ${r.check}: ${r.result}`);
  }
}
