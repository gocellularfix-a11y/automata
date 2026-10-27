// Real P2 drill with Claude and Codex: a project with 8 criteria and dependent tasks, sessions renewed
// every 2 rounds, a forced kill mid-round (the plan must come back whole), a chained conversation
// with the director, a casual message, and an independent verification at the end.
//
//   node scripts/real-plan.mjs [--port 4792] [--project <folder>] [--refresh 2] [--kill-round 3]
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const port = Number(arg("--port", 4792));
const refresh = Number(arg("--refresh", 2));
const killRound = Number(arg("--kill-round", 3));
const projectDir = path.resolve(arg("--project", path.join(process.env.USERPROFILE ?? "", "Automata Projects", "p2-agenda")));
const output = path.join(root, "artifacts", "real-plan-" + new Date().toISOString().replace(/[:.]/g, "-"));
const data = path.join(output, "data");
fs.mkdirSync(data, { recursive: true });
const origin = `http://127.0.0.1:${port}`;
const report = { at: new Date().toISOString(), projectDir, data, refresh, killRound, timeline: [], interventions: 0, phases: {} };
const log = (text, extra = {}) => {
  const entry = { at: new Date().toISOString(), text, ...extra };
  report.timeline.push(entry);
  console.log(`${entry.at.slice(11, 19)} ${text}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server = null, token = null;
function startServer(label) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [path.join(root, "server", "index.mjs"), "--port", String(port), "--data", data], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const logFile = path.join(output, `server-${label}.log`);
  child.stdout.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
  child.stderr.on("data", (chunk) => fs.appendFileSync(logFile, chunk));
  child.on("exit", (code) => log(`servidor ${label} terminó (código ${code})`));
  return child;
}
async function api(route, options = {}) {
  const response = await fetch(origin + "/api/" + route, { ...options, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json", ...options.headers ?? {} } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: ${body.error}`);
  return body;
}
async function waitForServer() {
  const deadline = Date.now() + 30e3;
  while (Date.now() < deadline) {
    try {
      token = fs.readFileSync(path.join(data, "access-token"), "utf8").trim();
      await api("state");
      return;
    } catch { await sleep(300); }
  }
  throw new Error("El servidor no respondió en 30 s.");
}
function killHard(child) {
  try { execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
}
const runOf = (state) => state.runs.find((r) => r.projectId === report.projectId);
const planOf = () => api("plan", { method: "POST", body: JSON.stringify({ projectId: report.projectId, action: "list" }) });
const sha = execFileSync(process.execPath, ["-e", "const h=require('crypto').createHash('sha256').update(require('fs').readFileSync('acceptance/agenda.test.mjs','utf8').split(String.fromCharCode(13)).join('')).digest('hex');process.stdout.write(h)"], { cwd: projectDir }).toString();
const project = {
  name: "P2 · agenda",
  directory: projectDir,
  objective: "Crear una agenda de contactos en Node.js sin dependencias: un módulo src/agenda.mjs, una CLI src/cli.mjs con persistencia en JSON y un README. La prueba de aceptación acceptance/agenda.test.mjs define el comportamiento exacto: léela primero.",
  criteria: [
    "crearAgenda() exportada desde src/agenda.mjs devuelve una agenda vacía con la lista contactos.",
    "agregar(agenda, contacto) valida nombre no vacío, teléfono de 10 dígitos (acepta separadores y los quita) y correo opcional válido; asigna ids enteros crecientes y lanza RangeError ante datos inválidos.",
    "No se permiten dos contactos con el mismo teléfono normalizado (RangeError).",
    "buscar(agenda, texto) ignora mayúsculas y acentos y busca en nombre, teléfono y correo; sin texto devuelve todos.",
    "eliminar(agenda, id) quita el contacto y lo devuelve; un id inexistente lanza RangeError.",
    "guardar(agenda, archivo) escribe JSON legible y cargar(archivo) lo lee; un archivo inexistente carga una agenda vacía.",
    "node src/cli.mjs --archivo <ruta> agregar|listar imprime JSON y termina con código 0; con datos inválidos termina con código 1 y explica el error en stderr.",
    "La CLI también admite buscar <texto> y eliminar --id <n>, y README.md explica en español su uso con ejemplos."
  ],
  checks: [
    "node --test \"acceptance/*.test.mjs\"",
    `node -e "const h=require('crypto').createHash('sha256').update(require('fs').readFileSync('acceptance/agenda.test.mjs','utf8').split(String.fromCharCode(13)).join('')).digest('hex');if(h!=='${sha}'){console.error('acceptance/agenda.test.mjs fue modificado');process.exit(1)}console.log('acceptance intacto')"`
  ],
  constraints: "Trabaja solo dentro de esta carpeta. No modifiques ni borres acceptance/agenda.test.mjs. No instales paquetes ni uses la red. Claude no puede ejecutar comandos en acceso limitado; Automata ejecuta las verificaciones. Puedes agregar tus propias pruebas en test/.",
  source: "local"
};
const usageOf = (run) => run.usage;
try {
  server = startServer("1");
  await waitForServer();
  const settings = await api("state").then((s) => s.settings);
  await api("settings", { method: "PUT", body: JSON.stringify({ ...settings, accessMode: "limited", coderModel: "sonnet", coderEffort: "medium", auditorModel: "gpt-6-luna", auditorEffort: "default", maxRounds: 14, autoResume: true, planOnly: true, gitMode: "ask-push", coderRefreshRounds: refresh, auditorRefreshRounds: refresh }) });
  const created = await api("projects", { method: "POST", body: JSON.stringify(project) });
  report.projectId = created.id;
  log("proyecto registrado", { id: created.id });
  await api("start", { method: "POST", body: JSON.stringify({ projectId: created.id }) });
  report.interventions = 1;
  log("trabajo iniciado (única intervención humana: Iniciar)");
  // Phase 1: let the plan form and a few rounds run; kill while Claude works in round killRound.
  let killedAt = null, planBefore = null, last = "";
  const deadline = Date.now() + 20 * 6e4;
  while (Date.now() < deadline) {
    const state = await api("state");
    const run = runOf(state);
    const key = `${run?.status}/${run?.stage}/${run?.round}`;
    if (key !== last) { last = key; log(`estado ${key}${run?.taskId ? ` · tarea T${run.taskId}` : ""}`); }
    const tools = state.events.filter((e) => e.runId === run?.id && e.role === "coder" && e.kind === "tool" && e.at > (run.updatedAt ?? "")).length;
    if (run && run.status === "running" && run.stage === "code" && run.round === killRound && tools >= 2) {
      planBefore = await planOf();
      killedAt = new Date().toISOString();
      killHard(server);
      log(`servidor y Claude eliminados a la fuerza en la ronda ${killRound} (tarea T${run.taskId}, ${planBefore.tasks.length} tareas en el plan)`, { plan: planBefore.tasks.map((t) => `T${t.id}:${t.status}`) });
      break;
    }
    if (run && !["running", "pausing"].includes(run.status)) {
      log(`el trabajo cambió a ${run.status} antes de la interrupción planeada`, { stage: run.stage, round: run.round, error: run.error });
      break;
    }
    await sleep(500);
  }
  report.phases.interruption = { killedAt, plan: planBefore?.tasks.map((t) => ({ id: t.id, status: t.status, criterion: !!t.criterion, dependsOn: t.dependsOn })) ?? null };
  if (!killedAt) throw new Error(`No se pudo interrumpir el trabajo en la ronda ${killRound}.`);
  await sleep(1500);
  // Phase 2: restart; nobody touches the controls. The plan must be identical and the run must continue.
  server = startServer("2");
  await waitForServer();
  const planAfter = await planOf();
  const same = JSON.stringify(planBefore.tasks.map((t) => [t.id, t.status, t.dependsOn])) === JSON.stringify(planAfter.tasks.map((t) => [t.id, t.status, t.dependsOn]));
  log(`al reabrir: el plan tiene ${planAfter.tasks.length} tareas, ${same ? "idéntico" : "DISTINTO"} al de antes del corte`);
  report.phases.restart = { planIdentical: same, run: (({ status, stage, round, taskId }) => ({ status, stage, round, taskId }))(runOf(await api("state"))) };
  const finalDeadline = Date.now() + 35 * 6e4;
  let final = null;
  last = "";
  while (Date.now() < finalDeadline) {
    const state = await api("state");
    const run = runOf(state);
    const key = `${run.status}/${run.stage}/${run.round}`;
    if (key !== last) { last = key; log(`estado ${key}${run.taskId ? ` · tarea T${run.taskId}` : ""}${run.waiting ? ` · espera ${run.waiting.kind}` : ""}`); }
    if (["complete", "blocked", "error", "limit", "stopped", "paused"].includes(run.status)) {
      final = { run: { status: run.status, stage: run.stage, round: run.round, error: run.error ?? null, recovery: run.recovery, sessionLog: run.sessionLog, usage: usageOf(run), gitQueue: run.gitQueue, review: run.review }, events: state.events.filter((e) => e.runId === run.id && ["start", "wait", "warning", "error", "complete", "phase", "session", "plan"].includes(e.kind)).map((e) => ({ at: e.at, kind: e.kind, role: e.role, text: String(e.text).slice(0, 240) })) };
      break;
    }
    await sleep(1000);
  }
  report.phases.final = final;
  if (!final) throw new Error("El trabajo no terminó en 35 minutos tras reanudar.");
  log(`resultado final: ${final.run.status} en la ronda ${final.run.round}`);
  report.phases.plan = (await planOf()).tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, criterion: t.criterion ? t.criterion.slice(0, 40) : "", dependsOn: t.dependsOn, source: t.source, evidence: t.evidence.slice(0, 120) }));
  // Per-call usage from the saved run (not in the snapshot).
  const saved = JSON.parse(fs.readFileSync(path.join(data, "runs.json"), "utf8")).find((r) => r.projectId === report.projectId);
  report.phases.usageLog = saved.usageLog;
  // Phase 3: conversation memory with the director: two chained questions, then a casual message.
  const ask = async (text, kind = "question", target = "auditor") => {
    const message = await api("chat", { method: "POST", body: JSON.stringify({ projectId: report.projectId, target, kind, text }) });
    const until = Date.now() + 6 * 6e4;
    while (Date.now() < until) {
      const state = await api("state");
      const m = state.messages.find((x) => x.id === message.id);
      if (["answered", "error", "interrupted", "delivered"].includes(m.status)) return m;
      await sleep(1000);
    }
    throw new Error("La consulta no terminó.");
  };
  const q1 = await ask("¿Cuál fue la tarea del plan que más rondas necesitó y por qué?");
  log("consulta 1 respondida", { answer: q1.answers?.[0]?.text?.slice(0, 300) });
  const q2 = await ask("¿Y qué archivos tocó esa tarea? No repitas la explicación anterior.");
  log("consulta 2 respondida", { resumed: q2.answers?.[0]?.resumed, answer: q2.answers?.[0]?.text?.slice(0, 300) });
  const casual = await ask("¡Buen trabajo, jóvenes!", "task");
  log("mensaje casual", { casual: casual.casual, answer: casual.answers?.[0]?.text?.slice(0, 120) });
  report.phases.chat = { q1: { text: q1.text, answer: q1.answers?.[0]?.text, resumed: q1.answers?.[0]?.resumed }, q2: { text: q2.text, answer: q2.answers?.[0]?.text, resumed: q2.answers?.[0]?.resumed }, casual: { casual: casual.casual, agentsCalled: !!casual.answers?.some((a) => a.role !== "system") }, exchanges: JSON.parse(fs.readFileSync(path.join(data, "messages.json"), "utf8")).length };
  // Independent verification.
  const tests = execFileSync(process.execPath, ["--test", "acceptance/*.test.mjs"], { cwd: projectDir, encoding: "utf8", windowsHide: true }).toString();
  const gitLog = execFileSync("git", ["log", "--oneline"], { cwd: projectDir, encoding: "utf8" }).toString().trim().split("\n");
  const gitStatus = execFileSync("git", ["status", "--short"], { cwd: projectDir, encoding: "utf8" }).toString().trim();
  report.verification = { tests: tests.split("\n").filter((l) => /^ℹ (tests|pass|fail)/.test(l)), gitLog, gitStatus, files: fs.readdirSync(projectDir).filter((f) => f !== ".git") };
  log("verificación independiente", report.verification);
  report.ok = final.run.status === "complete" && report.interventions === 1 && same;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  log("ERROR " + error.message);
} finally {
  if (server) killHard(server);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, error: report.error, interventions: report.interventions, output }, null, 2));
}
process.exit(report.ok ? 0 : 1);
