// Replays the three real blocks of the 28 Oct drills against the folders those drills left behind: what would the
// director have been shown by Automata at that moment, and what would Automata have done with its block?
// Nothing here calls an agent. It reads the project folder and the saved reports, opens the page in the PC's browser
// and prints the evidence and the decision.
//
//   node scripts/replay-blocks.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectEnvironment } from "../server/environment.mjs";
import { verifyDelivery } from "../server/delivery.mjs";
import { checkProjectText } from "../server/textcheck.mjs";
import { loadScenarios } from "../server/scenarios.mjs";
import { buildAutomataEvidence, renderAutomataEvidence, summarizePage, summarizeScenarios } from "../server/evidence.mjs";
import { classifyBlock, reaskMessage } from "../server/humancheck.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNS = [["run 2", "real-idea-2026-10-28T20-05-04-943Z"], ["run 3", "real-idea-2026-10-28T20-21-27-419Z"], ["run 4", "real-idea-2026-10-28T20-36-44-240Z"]];
const env = await detectEnvironment();
const rows = [];
for (const [label, folder] of RUNS) {
  const base = path.join(root, "artifacts", folder);
  const report = JSON.parse(fs.readFileSync(path.join(base, "report.json"), "utf8"));
  const dir = report.project.directory;
  const runDir = path.join(base, "data", "runs", fs.readdirSync(path.join(base, "data", "runs"))[0]);
  const last = fs.readdirSync(runDir).filter((x) => x.startsWith("round-")).sort().at(-1);
  const review = JSON.parse(fs.readFileSync(path.join(runDir, last, "review.json"), "utf8"));
  const checks = fs.readdirSync(path.join(runDir, last)).filter((f) => /^check-\d+\.json$/.test(f)).map((f) => JSON.parse(fs.readFileSync(path.join(runDir, last, f), "utf8")));
  const has = (name) => fs.readdirSync(dir).some((f) => f.toLowerCase() === name.toLowerCase());
  const scenarios = loadScenarios(dir);
  const parts = { launcher: has("Abrir.cmd"), guide: has("COMO_USAR.md") };
  const entry = !parts.launcher && !parts.guide && has("index.html") ? "index.html" : null;
  const result = await verifyDelivery({ directory: dir, env, parts, entry, scenarios: scenarios.scenarios, scenarioIssues: scenarios.problems });
  const page = result.report ? summarizePage({ ...result.report, target: result.open?.target }) : null;
  const evidence = buildAutomataEvidence({ round: Number(last.slice(6)), checks, page, ui: page ? summarizeScenarios(scenarios, result.report?.scenarios ?? null, !!result.report) : null, encoding: checkProjectText(dir), delivery: { launcher: parts.launcher && result.ok, guide: parts.guide && result.ok }, webManaged: !!page });
  const block = classifyBlock(review, { evidence, web: true });
  rows.push({ label, round: last, blockedTask: review.task, files: { launcher: parts.launcher, guide: parts.guide }, block: { humanCheck: block.humanCheck, sensitive: block.sensitive, actionable: block.actionable, covered: block.covered, uiCovered: block.uiCovered }, whatDirectorWouldSee: renderAutomataEvidence(evidence), whatDirectorWouldBeToldFirst: block.actionable ? reaskMessage(block, evidence).split("\n")[0] : null });
}
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
const out = path.join(root, "artifacts", "replay-blocks-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json");
fs.writeFileSync(out, JSON.stringify(rows, null, 2));
for (const row of rows) console.log(`\n=== ${row.label} · ${row.round} · tarea ${row.blockedTask} · lanzador ${row.files.launcher} · guía ${row.files.guide}\nbloqueo: ${JSON.stringify(row.block)}\n${row.whatDirectorWouldSee}`);
console.log("\nGuardado en", out);
