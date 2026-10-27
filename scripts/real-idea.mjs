// Real P3 drill: a person types one sentence in the «Nueva idea» dialog, reads the director's
// proposal, approves once, and Claude and Codex build it to the end. Driven through Chrome on a
// second Automata instance with its own data folder; projects go to the normal projects folder.
//
//   node scripts/real-idea.mjs [--port 4793] [--idea "…"] [--rounds 20]
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const port = Number(arg("--port", 4793));
const idea = arg("--idea", "Quiero una aplicación para administrar el inventario de mi tienda");
const maxRounds = Number(arg("--rounds", 20));
const projectsRoot = path.join(process.env.USERPROFILE ?? "", "Automata Projects");
const output = path.join(root, "artifacts", "real-idea-" + new Date().toISOString().replace(/[:.]/g, "-"));
const data = path.join(output, "data");
fs.mkdirSync(data, { recursive: true });
const origin = `http://127.0.0.1:${port}`;
const report = { at: new Date().toISOString(), idea, data, timeline: [], interventions: [], screenshots: [] };
const log = (text, extra = {}) => {
  const entry = { at: new Date().toISOString(), text, ...extra };
  report.timeline.push(entry);
  console.log(`${entry.at.slice(11, 19)} ${text}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Other projects must stay untouched: their Git state before and after.
const others = fs.readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(projectsRoot, e.name));
const gitState = (dir) => { try { return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }) + execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }); } catch { return "sin git"; } };
const before = Object.fromEntries([...others, root].map((dir) => [dir, gitState(dir)]));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const server = spawn(process.execPath, [path.join(root, "server", "index.mjs"), "--port", String(port), "--data", data], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
server.stdout.on("data", (chunk) => fs.appendFileSync(path.join(output, "server.log"), chunk));
server.stderr.on("data", (chunk) => fs.appendFileSync(path.join(output, "server.log"), chunk));
let token;
const api = async (route, options = {}) => {
  const response = await fetch(origin + "/api/" + route, { ...options, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
  const body = await response.json();
  if (!response.ok) throw new Error(`${route}: ${body.error}`);
  return body;
};
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => p && fs.existsSync(p));
let browser;
try {
  for (let i = 0; i < 60 && !token; i++) { try { token = fs.readFileSync(path.join(data, "access-token"), "utf8").trim(); await api("state"); } catch { token = null; await sleep(500); } }
  const settings = (await api("state")).settings;
  await api("settings", { method: "PUT", body: JSON.stringify({ ...settings, accessMode: "limited", coderModel: "sonnet", coderEffort: "medium", auditorModel: "gpt-6-luna", auditorEffort: "default", maxRounds, planOnly: true, gitMode: "ask-push", projectsRoot }) });
  browser = await chromium.launch({ executablePath: chrome, headless: true });
  const page = await browser.newPage({ viewport: { width: 1480, height: 1020 } });
  const shot = async (name) => { const file = path.join(output, name + ".png"); await page.screenshot({ path: file }); report.screenshots.push(file); };
  await page.goto(origin + "/#token=" + token);
  await page.waitForFunction(() => document.querySelector("#accountsDialog")?.open, null, { timeout: 60e3 });
  await page.waitForFunction(() => !["coder", "auditor"].some((role) => document.querySelector("#" + role + "AccountState").textContent === "Comprobando"), null, { timeout: 60e3 });
  report.accounts = await page.evaluate(() => ({ coder: document.querySelector("#coderAccountState").textContent, auditor: document.querySelector("#auditorAccountState").textContent }));
  await page.click("#accountsDialog [data-close]");
  log("cuentas", report.accounts);
  // 1. The idea, in plain words.
  await page.click("#newIdeaTop");
  await page.fill("#ideaText", idea);
  report.interventions.push({ at: new Date().toISOString(), what: "Escribir la idea y pulsar Proponer" });
  await page.click("#ideaForm button[type=submit]");
  log("idea enviada: " + idea);
  await page.waitForFunction(() => !document.querySelector("#ideaCard").hidden || document.querySelector("#ideaError").textContent.trim(), null, { timeout: 10 * 6e4 });
  const error = (await page.locator("#ideaError").textContent()).trim();
  if (error) throw new Error("La propuesta falló: " + error);
  const state = await api("state");
  const proposal = state.proposals.at(-1);
  report.proposal = proposal;
  log(`propuesta lista: «${proposal.draft.name}», ${proposal.draft.criteria.length} criterios, ${proposal.draft.plan.length} tareas, plataforma ${proposal.draft.platform}`, { usage: proposal.usage });
  await page.locator("#ideaCard").screenshot({ path: path.join(output, "01-propuesta.png") });
  report.proposalText = await page.locator("#ideaCard").innerText();
  // 2. One approval.
  report.interventions.push({ at: new Date().toISOString(), what: "Crear y empezar" });
  await page.click("#ideaAccept");
  await page.waitForFunction(() => !document.querySelector("#ideaDialog").open || document.querySelector("#ideaError").textContent.trim(), null, { timeout: 2 * 6e4 });
  const acceptError = (await page.locator("#ideaError").textContent()).trim();
  if (acceptError) throw new Error("No se pudo crear: " + acceptError);
  const project = (await api("state")).projects.at(-1);
  report.project = { id: project.id, name: project.name, directory: project.directory, criteria: project.criteria, checks: project.checks };
  log(`proyecto creado en ${project.directory}`);
  await shot("02-empieza");
  // 3. Watch until it ends; the person does nothing else.
  let last = "", final = null, shots = 0;
  const deadline = Date.now() + 90 * 6e4;
  while (Date.now() < deadline) {
    const s = await api("state");
    const run = s.runs.find((r) => r.projectId === project.id);
    const plan = s.plans[project.id];
    const key = `${run?.status}/${run?.stage}/${run?.round}/${plan?.done}`;
    if (key !== last) {
      last = key;
      log(`estado ${run?.status} · ${run?.stage} · ronda ${run?.round} · plan ${plan?.done}/${plan?.active}${plan?.current ? ` · «${plan.current.title}»` : ""}${run?.waiting ? ` · espera ${run.waiting.kind}` : ""}`, { status: await page.locator("#bottomStatus").textContent() });
      if (run?.stage === "code" && shots < 2) { shots++; await shot(`03-construyendo-${shots}`); }
    }
    if (run && ["complete", "blocked", "error", "limit", "stopped", "paused"].includes(run.status)) { final = { run, plan }; break; }
    await sleep(2000);
  }
  if (!final) throw new Error("No terminó en 90 minutos.");
  await shot("04-final");
  log(`final: ${final.run.status} en la ronda ${final.run.round}, plan ${final.plan.done}/${final.plan.active}`, { error: final.run.error });
  report.final = { status: final.run.status, round: final.run.round, error: final.run.error ?? null, usage: final.run.usage, sessionLog: final.run.sessionLog, recovery: final.run.recovery?.log, gitQueue: final.run.gitQueue, review: final.run.review, plan: final.plan };
  const saved = JSON.parse(fs.readFileSync(path.join(data, "runs.json"), "utf8")).find((r) => r.projectId === project.id);
  report.usageLog = saved.usageLog;
  report.planTasks = (await api("plan", { method: "POST", body: JSON.stringify({ projectId: project.id, action: "list" }) })).tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, dependsOn: t.dependsOn, source: t.source, criterion: !!t.criterion }));
  // 4. Independent verification: the project's own checks, run by me, and the state of everything else.
  report.verification = { checks: [] };
  for (const command of project.checks) {
    let out, code = 0;
    try { out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { cwd: project.directory, encoding: "utf8", windowsHide: true, timeout: 5 * 6e4 }); } catch (e) { out = String(e.stdout ?? "") + String(e.stderr ?? ""); code = e.status ?? 1; }
    report.verification.checks.push({ command, code, tail: out.split("\n").filter((l) => /^ℹ (tests|pass|fail)|^# (tests|pass|fail)|passed|failed/i.test(l)).slice(-6) });
  }
  report.verification.gitLog = execFileSync("git", ["log", "--oneline"], { cwd: project.directory, encoding: "utf8" }).trim().split("\n");
  report.verification.gitStatus = execFileSync("git", ["status", "--short"], { cwd: project.directory, encoding: "utf8" }).trim();
  report.verification.files = execFileSync("git", ["ls-files"], { cwd: project.directory, encoding: "utf8" }).trim().split("\n");
  report.verification.othersUntouched = Object.entries(before).every(([dir, value]) => gitState(dir) === value);
  report.verification.changed = Object.entries(before).filter(([dir, value]) => gitState(dir) !== value).map(([dir]) => dir);
  log("verificación independiente", report.verification);
  report.ok = final.run.status === "complete" && report.verification.checks.every((c) => c.code === 0) && report.verification.othersUntouched;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  log("ERROR " + error.message);
} finally {
  await browser?.close();
  try { execFileSync("taskkill.exe", ["/pid", String(server.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" }); } catch {}
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: report.ok, error: report.error, interventions: report.interventions.length, output }, null, 2));
}
process.exit(report.ok ? 0 : 1);
