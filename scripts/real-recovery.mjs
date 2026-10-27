// Real recovery drill with Claude and Codex: start a run on an isolated project, kill Automata's
// server hard while Claude is in the middle of a round (as if the PC died), start it again with the
// same data folder and watch it finish without anyone pressing Continuar.
//
//   node scripts/real-recovery.mjs [--port 4791] [--project <folder>]
//
// Uses the user's plans (no API keys), limited access, and its own data folder under artifacts/.
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const port = Number(arg("--port", 4791));
const projectDir = path.resolve(arg("--project", path.join(process.env.USERPROFILE ?? "", "Automata Projects", "paso1-recuperacion")));
const output = path.join(root, "artifacts", "real-recovery-" + new Date().toISOString().replace(/[:.]/g, "-"));
const data = path.join(output, "data");
fs.mkdirSync(data, { recursive: true });
const origin = `http://127.0.0.1:${port}`;
const report = { at: new Date().toISOString(), projectDir, data, timeline: [], interventions: 0, phases: {} };
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
  // Like a crash or a forced shutdown: the server and the agent it spawned die at once, nothing is saved.
  try { execFileSync("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
}
const runOf = (state) => state.runs.find((r) => r.projectId === report.projectId);
const sha = execFileSync(process.execPath, ["-e", "const h=require('crypto').createHash('sha256').update(require('fs').readFileSync('acceptance/cuenta.test.mjs','utf8').split(String.fromCharCode(13)).join('')).digest('hex');process.stdout.write(h)"], { cwd: projectDir }).toString();
const project = {
  name: "P1 · recuperación real",
  directory: projectDir,
  objective: "Crear un módulo y una CLI de Node.js, sin dependencias, que calculen la cuenta de un restaurante: subtotal, impuesto, propina, total y lo que paga cada persona, redondeado al centavo. La prueba de aceptación acceptance/cuenta.test.mjs define el comportamiento exacto: léela primero.",
  criteria: [
    "calcularCuenta({ items, impuesto, propina, personas }) exportada desde src/cuenta.mjs devuelve { subtotal, impuesto, propina, total, porPersona } redondeados al centavo (mitad hacia arriba) y sin errores de punto flotante, para entradas dentro de los límites: de 1 a 1000 artículos, cada monto de 0 a 1 000 000.",
    "calcularCuenta lanza RangeError ante entradas fuera de esos límites o inválidas: lista vacía o de más de 1000 artículos, montos negativos, mayores que 1 000 000, no finitos o no numéricos, porcentajes fuera de 0 a 100, y personas que no sean un entero mayor o igual a 1.",
    "node src/cli.mjs --items 10.50,4.25 --impuesto 8.75 --propina 15 --personas 2 imprime el resultado en JSON y termina con código 0; con datos inválidos termina con código 1 y explica el error en stderr.",
    "README.md explica en español cómo usar la CLI, con al menos un ejemplo que incluya node src/cli.mjs.",
    "El proyecto no tiene dependencias externas ni node_modules, y acceptance/cuenta.test.mjs queda sin modificar."
  ],
  checks: [
    "node --test \"acceptance/*.test.mjs\"",
    `node -e "const h=require('crypto').createHash('sha256').update(require('fs').readFileSync('acceptance/cuenta.test.mjs','utf8').split(String.fromCharCode(13)).join('')).digest('hex');if(h!=='${sha}'){console.error('acceptance/cuenta.test.mjs fue modificado');process.exit(1)}console.log('acceptance intacto')"`
  ],
  constraints: "Trabaja solo dentro de esta carpeta. No modifiques ni borres acceptance/cuenta.test.mjs. No instales paquetes ni uses la red. Claude no puede ejecutar comandos en acceso limitado; Automata ejecuta las verificaciones. Puedes agregar tus propias pruebas en test/.",
  source: "local"
};
try {
  server = startServer("1");
  await waitForServer();
  const settings = await api("state").then((s) => s.settings);
  await api("settings", { method: "PUT", body: JSON.stringify({ ...settings, accessMode: "limited", coderModel: "sonnet", coderEffort: "medium", auditorModel: "gpt-6-luna", auditorEffort: "default", maxRounds: 6, autoResume: true, planOnly: true, gitMode: "ask-push" }) });
  const created = await api("projects", { method: "POST", body: JSON.stringify(project) });
  report.projectId = created.id;
  log("proyecto registrado", { id: created.id });
  await api("start", { method: "POST", body: JSON.stringify({ projectId: created.id }) });
  report.interventions = 1;
  log("trabajo iniciado (única intervención humana: Iniciar)");
  // Phase 1: wait until Claude is in the middle of round 1, then kill everything.
  let killedAt = null, before = null;
  const deadline = Date.now() + 10 * 6e4;
  while (Date.now() < deadline) {
    const state = await api("state");
    const run = runOf(state);
    const coderTools = state.events.filter((e) => e.runId === run?.id && e.role === "coder" && e.kind === "tool").length;
    if (run && run.status === "running" && run.stage === "code" && run.round === 1 && coderTools >= 2) {
      before = { status: run.status, stage: run.stage, round: run.round, coderTools, events: state.events.filter((e) => e.runId === run.id).length };
      killedAt = new Date().toISOString();
      killHard(server);
      log(`servidor y Claude eliminados a la fuerza en la ronda 1 con ${coderTools} acciones de Claude registradas`, before);
      break;
    }
    if (run && !["running", "pausing"].includes(run.status)) {
      log(`el trabajo cambió a ${run.status} antes de la interrupción planeada`, { stage: run.stage, round: run.round });
      break;
    }
    await sleep(400);
  }
  report.phases.interruption = { killedAt, before };
  if (!killedAt) throw new Error("No se pudo interrumpir el trabajo en la ronda 1.");
  await sleep(1500);
  // Phase 2: start again with the same data; nobody touches the controls.
  server = startServer("2");
  await waitForServer();
  const afterRestart = runOf(await api("state"));
  log(`al reabrir: estado ${afterRestart.status}, etapa ${afterRestart.stage}, ronda ${afterRestart.round}`);
  report.phases.restart = { status: afterRestart.status, stage: afterRestart.stage, round: afterRestart.round, recovery: afterRestart.recovery };
  const finalDeadline = Date.now() + 25 * 6e4;
  let last = "";
  let final = null;
  while (Date.now() < finalDeadline) {
    const state = await api("state");
    const run = runOf(state);
    const key = `${run.status}/${run.stage}/${run.round}`;
    if (key !== last) {
      last = key;
      log(`estado ${run.status} · etapa ${run.stage} · ronda ${run.round}${run.waiting ? ` · espera: ${run.waiting.kind} ${run.waiting.role} hasta ${run.waiting.resumeAt}` : ""}`);
    }
    if (["complete", "blocked", "error", "limit", "stopped", "paused"].includes(run.status)) {
      final = { run: { status: run.status, stage: run.stage, round: run.round, error: run.error ?? null, recovery: run.recovery, tokens: run.tokens, gitQueue: run.gitQueue, review: run.review }, events: state.events.filter((e) => e.runId === run.id && ["start", "wait", "warning", "error", "complete", "phase", "success", "check"].includes(e.kind)).map((e) => ({ at: e.at, kind: e.kind, role: e.role, text: String(e.text).slice(0, 300) })) };
      break;
    }
    await sleep(1000);
  }
  report.phases.final = final;
  if (!final) throw new Error("El trabajo no terminó en 25 minutos tras reanudar.");
  log(`resultado final: ${final.run.status} en la ronda ${final.run.round}`);
  // Independent verification of the project.
  const tests = execFileSync(process.execPath, ["--test", "acceptance/*.test.mjs"], { cwd: projectDir, encoding: "utf8", windowsHide: true }).toString();
  const gitLog = execFileSync("git", ["log", "--oneline"], { cwd: projectDir, encoding: "utf8" }).toString().trim().split("\n");
  const gitStatus = execFileSync("git", ["status", "--short"], { cwd: projectDir, encoding: "utf8" }).toString().trim();
  report.verification = { tests: tests.split("\n").filter((l) => /^ℹ (tests|pass|fail)/.test(l)), gitLog, gitStatus, files: fs.readdirSync(projectDir).filter((f) => f !== ".git") };
  log("verificación independiente", report.verification);
  report.ok = final.run.status === "complete" && report.interventions === 1;
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
