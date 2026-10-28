// Run the live agent from the command line and save the result as a library
// guide. Usage: npm run generate -- "Zoom"   (needs ANTHROPIC_API_KEY in .dev.vars)
import Anthropic from "@anthropic-ai/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { generateGuide, NotApplicableError } from "../src/agent.ts";
import { validateGuide } from "../src/validate.ts";

const query = process.argv.slice(2).join(" ").trim();
if (!query) {
  console.error('usage: npm run generate -- "<app name or website>"');
  process.exit(1);
}
const started = Date.now();
try {
  const { guide, usage } = await generateGuide({
    query,
    client: new Anthropic(),
    emit: (e) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s] ${e.type}: ${"message" in e ? e.message : "query" in e ? e.query : "url" in e ? e.url + ("result" in e ? ` -> ${e.result}` : "") : "text" in e ? e.text.slice(0, 200) : ""}`),
  });
  const { meta, tested, ...core } = guide;
  const errors = validateGuide(core);
  if (errors.length) throw new Error(errors.join("\n"));
  await mkdir("data/live", { recursive: true });
  await writeFile(`data/live/${guide.slug}.json`, JSON.stringify(guide, null, 2) + "\n");
  console.log(`\nSaved data/live/${guide.slug}.json in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  console.log(`tier=${guide.verdict.tier} difficulty=${guide.verdict.difficulty} sources=${guide.sources.length} tested=${tested.length} (${meta.researched_by})`);
  console.log("usage", usage);
} catch (err) {
  if (err instanceof NotApplicableError) console.log(`Not applicable: ${err.message}\nAlternative: ${err.alternative}`);
  else throw err;
}
