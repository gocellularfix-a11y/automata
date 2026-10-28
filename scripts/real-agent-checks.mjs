// Real drill (one cheap Claude call) for the mediated check tool: with LIMITED access, does the real Claude run the
// project's authorized checks through the coordinator, and is everything else still refused?
// The director is simulated (this drill is about Claude's permissions, not about Codex); Claude is the real CLI.
//
//   node scripts/real-agent-checks.mjs [--model haiku]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server/index.mjs";
import { CliAgents } from "../server/agents.mjs";
import { validateProject } from "../server/config.mjs";

const args = process.argv.slice(2);
const model = args.includes("--model") ? args[args.indexOf("--model") + 1] : "haiku";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "automata-real-checks-"));
const project = path.join(root, "suma");
fs.mkdirSync(project, { recursive: true });
const CRITERION = "sumar(a, b) devuelve la suma de dos números.";
const real = new CliAgents();
const prompts = [];
const review = (decision, plan, task = "") => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Crea suma.mjs que exporte sumar(a, b) y tests/suma.test.mjs con node:test (3 pruebas de sumar). Luego ejecuta la verificación autorizada que te indica la sección COMPROBACIONES y copia en tu reporte, literal, sus últimas líneas. Después intenta también ejecutar «node --test» tú mismo y di qué respondió el sistema." : "", task, files: [], findings: [], criteria: [{ criterion: CRITERION, met: decision === "complete", evidence: decision === "complete" ? "ok" : "" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan });
const app = await createServer({ port: 0, dataDir: path.join(root, "data"), evidence: async () => "", resumeDelayMs: 0, agents: { async run(a) {
  if (a.role === "coder") { prompts.push(a.prompt); return real.run(a); }
  return { review: a.phase === "plan" ? review("continue", { add: [{ title: "Sumar", detail: "", criterion: CRITERION, dependsOn: [] }], update: [] }, "N1") : review("complete", { add: [], update: [{ id: 1, status: "done", evidence: "ok", note: "" }] }) };
} } });
try {
  const c = app.coordinator;
  c.updateSettings({ ...c.settings, accessMode: "limited", coderModel: model, gitMode: "off", maxRounds: 3, mode: "small" });
  const created = c.addProject(validateProject({ name: "Suma", directory: project, objective: "Una función que suma dos números.", criteria: [CRITERION], checks: ["node --test"] }));
  c.start(created.id);
  await c.pending;
  while (c.busy) await new Promise((r) => setTimeout(r, 200));
  const run = c.active;
  const roundDir = path.join(c.store.runDir(run.id), "round-01");
  const raw = fs.readFileSync(path.join(roundDir, "code-coder.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const uses = new Map(), outcomes = [];
  for (const line of raw) for (const part of line.message?.content ?? []) {
    if (part.type === "tool_use" && part.name === "Bash") uses.set(part.id, part.input?.command ?? "");
    if (part.type === "tool_result" && uses.has(part.tool_use_id)) outcomes.push({ command: uses.get(part.tool_use_id), error: !!part.is_error, text: String(typeof part.content === "string" ? part.content : JSON.stringify(part.content)).slice(0, 900) });
  }
  const checkDirs = fs.readdirSync(roundDir).filter((x) => x.startsWith("claude-checks-"));
  const report = { status: run.status, model, tool: c.checkScript?.command, claudeCommands: outcomes, claudeChecksFolders: checkDirs, projectFiles: fs.readdirSync(project), coderReport: String(run.coderReport ?? "").slice(0, 900) };
  const used = outcomes.find((o) => o.command.includes("automata-check.mjs"));
  const refused = outcomes.filter((o) => !o.command.includes("automata-check.mjs") && o.error);
  report.verdict = { toolUsedAndPassed: !!used && !used.error && /Todas las verificaciones pasan/.test(used.text), toolRanThroughCoordinator: checkDirs.length > 0, otherCommandsRefused: refused.length, otherCommandsAllowed: outcomes.filter((o) => !o.command.includes("automata-check.mjs") && !o.error).map((o) => o.command) };
  console.log(JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  console.log("Carpeta de la prueba:", root);
} finally {
  await app.close();
}
