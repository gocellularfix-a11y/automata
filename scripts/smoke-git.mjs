// The Git buttons in a real Chrome, with simulated agents and a real repository: saving the pending changes before
// finishing (Guardar), retrying a commit that failed (Reintentar), leaving them unsaved on purpose (Dejar sin guardar),
// and approving or rejecting a merge the director asked for. Also at phone width.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "smoke-git-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(output, { recursive: true });
Object.assign(process.env, { GIT_AUTHOR_NAME: "Smoke", GIT_AUTHOR_EMAIL: "smoke@example.com", GIT_COMMITTER_NAME: "Smoke", GIT_COMMITTER_EMAIL: "smoke@example.com" });
const projects = fs.mkdtempSync(path.join(os.tmpdir(), "automata-smoke-git-"));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const CRITERIA = ["Funciona la aplicación."];
const noGit = { commit: false, message: "", push: false, branch: "", merge_into: "" };
const review = (decision, gitDecision = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task: "", files: [], findings: [], criteria: CRITERIA.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "Probado." : "Pendiente." })), git: { ...noGit, ...gitDecision }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: null });
// One script of director decisions per project folder; the last one repeats.
const scripts = new Map();
const app = await createServer({ port: 0, dataDir: path.join(output, "data"), checks: async () => [], evidence: async () => "", agents: { async run(a) {
  if (a.role === "coder") {
    fs.appendFileSync(path.join(a.project.directory, "app.txt"), `trabajo ${Date.now()}\n`);
    return { text: "Implementado" };
  }
  const queue = scripts.get(path.basename(a.project.directory));
  const next = queue.length > 1 ? queue.shift() : queue[0];
  return { review: review(next.decision, next.git) };
} } });
const chrome = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ executablePath: chrome, channel: chrome ? undefined : "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1020 }, reducedMotion: "reduce" });
const errors = [], external = [], report = { at: new Date().toISOString(), checks: [], screenshots: [] };
page.on("pageerror", (e) => errors.push(e.message));
page.on("request", (r) => { if (new URL(r.url()).origin !== app.origin) external.push(r.url()); });
const check = (name, ok, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) throw new Error(name + ": " + JSON.stringify(detail));
};
const shot = async (name) => {
  const file = path.join(output, name + ".png");
  await page.screenshot({ path: file });
  report.screenshots.push(file);
};
// A real repository with one commit, a project in it, and the director's script.
function project(name, decisions) {
  const folder = path.join(projects, name);
  fs.mkdirSync(folder);
  git(folder, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(folder, "README.md"), "# app\n");
  git(folder, "add", "-A");
  git(folder, "commit", "-q", "-m", "chore: inicio");
  scripts.set(name, decisions);
  const p = app.coordinator.addProject({ name, directory: folder, objective: "Una aplicación que funciona y se prueba.", criteria: CRITERIA, checks: [] });
  return { p, folder };
}
async function open(p) {
  await page.evaluate((id) => localStorage.setItem("automata.project", id), p.id);
  await page.reload();
  await page.waitForFunction((id) => document.querySelector("#projectName")?.textContent.length > 0, p.id);
  await closeAccounts();
}
// Without logged-in accounts the page opens the accounts dialog by itself; close it like a person would.
async function closeAccounts() {
  await page.waitForFunction(() => document.querySelector("#accountsDialog")?.open, null, { timeout: 4000 }).catch(() => {});
  if (await page.locator("#accountsDialog").evaluate((d) => d.open)) await page.click("#accountsDialog [data-close]");
}
const bar = () => page.locator("#gitItems .git-item[data-git]");
const buttons = async () => (await page.locator("#gitItems .git-item[data-git] button").allTextContents()).map((s) => s.trim());
const state = () => app.coordinator.active ?? app.coordinator.runs?.at(-1);
const waitStatus = (status) => page.waitForFunction((s) => document.querySelector("#runState")?.textContent === s, status, { timeout: 20000 });
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForFunction(() => document.querySelector("#projectName"));
  await closeAccounts();

  // 1. Unsaved changes at the end: the run waits and the person chooses Guardar.
  const a = project("guardar", [{ decision: "continue" }, { decision: "complete" }]);
  await open(a.p);
  app.coordinator.start(a.p.id);
  await bar().first().waitFor({ state: "visible", timeout: 20000 });
  check("con cambios sin guardar al terminar aparece el aviso de Git", await page.locator("#gitBar").isVisible());
  check("los botones son Guardar y Dejar sin guardar", JSON.stringify(await buttons()) === JSON.stringify(["Guardar", "Dejar sin guardar"]), await buttons());
  check("el texto explica qué se guardará", /Guardar los cambios pendientes antes de terminar/.test(await bar().first().innerText()));
  check("hasta decidir, el trabajo no está completo", app.coordinator.active?.status === "blocked", app.coordinator.active?.status);
  await shot("01-guardar");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  check("en el teléfono no hay desbordamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("en el teléfono los botones de Git se ven dentro de la pantalla", await page.evaluate(() => [...document.querySelectorAll("#gitItems .git-item[data-git] button")].every((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= 0 && r.right <= innerWidth + 1; })));
  await shot("02-guardar-movil");
  await page.setViewportSize({ width: 1480, height: 1020 });
  await bar().first().locator("[data-decision=approve]").click();
  await waitStatus("Completado");
  check("Guardar crea el commit y el trabajo termina con la carpeta limpia", git(a.folder, "status", "--porcelain") === "" && /^docs|^chore|^feat|^fix/m.test(git(a.folder, "log", "--format=%s")) && git(a.folder, "rev-list", "--count", "HEAD") === "2", git(a.folder, "log", "--format=%s"));
  check("el aviso desaparece al terminar", await page.locator("#gitBar").isHidden());
  check("nada se publicó", git(a.folder, "remote") === "");

  // 2. A commit that fails (the repository's own pre-commit hook): the error is visible and Reintentar works once it is fixed.
  const b = project("reintentar", [{ decision: "continue" }, { decision: "complete" }]);
  const hook = path.join(b.folder, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\necho 'las pruebas locales no pasan' >&2\nexit 1\n", { mode: 0o755 });
  await open(b.p);
  app.coordinator.start(b.p.id);
  await bar().first().waitFor({ state: "visible", timeout: 20000 });
  await bar().first().locator("[data-decision=approve]").click();
  await page.waitForFunction(() => /No se pudo guardar/.test(document.querySelector("#gitItems")?.innerText ?? ""), null, { timeout: 15000 });
  check("si el commit falla, se ve el motivo en pantalla", /las pruebas locales no pasan/.test(await bar().first().innerText()), await bar().first().innerText());
  check("los botones pasan a Reintentar y Dejar sin guardar", JSON.stringify(await buttons()) === JSON.stringify(["Reintentar", "Dejar sin guardar"]), await buttons());
  check("tras el fallo el trabajo sigue sin completarse", app.coordinator.active?.status === "blocked", app.coordinator.active?.status);
  await shot("03-reintentar");
  fs.rmSync(hook);
  await bar().first().locator("[data-decision=approve]").click();
  await waitStatus("Completado");
  check("Reintentar guarda cuando el problema se arregló", git(b.folder, "status", "--porcelain") === "" && git(b.folder, "rev-list", "--count", "HEAD") === "2");

  // 3. Leaving the changes unsaved is an explicit decision, noted in the activity.
  const c = project("dejar", [{ decision: "continue" }, { decision: "complete" }]);
  await open(c.p);
  app.coordinator.start(c.p.id);
  await bar().first().waitFor({ state: "visible", timeout: 20000 });
  await bar().first().locator("[data-decision=reject]").click();
  await waitStatus("Completado");
  check("Dejar sin guardar termina sin commit y los cambios siguen ahí", git(c.folder, "rev-list", "--count", "HEAD") === "1" && git(c.folder, "status", "--porcelain").includes("app.txt"));
  check("la decisión queda anotada en la actividad", app.coordinator.events.some((e) => /Decidiste dejar los cambios sin guardar/.test(e.text)));

  // 4. A merge the director asks for from a work branch waits for approval; Rechazar leaves main untouched.
  const d = project("fusion", [{ decision: "continue", git: { branch: "feature/calculo" } }, { decision: "complete", git: { commit: true, message: "feat: calculo", merge_into: "main" } }]);
  await open(d.p);
  app.coordinator.start(d.p.id);
  await bar().first().waitFor({ state: "visible", timeout: 20000 });
  check("el merge pide aprobación con Aprobar y Rechazar", JSON.stringify(await buttons()) === JSON.stringify(["Aprobar", "Rechazar"]) && /Merge de la rama actual en «main»/.test(await bar().first().innerText()), await bar().first().innerText());
  await shot("04-merge");
  await bar().first().locator("[data-decision=reject]").click();
  await page.waitForFunction(() => document.querySelectorAll("#gitItems .git-item[data-git]").length === 0, null, { timeout: 15000 });
  check("Rechazar no fusiona nada: main conserva su historia", git(d.folder, "log", "main", "--format=%s") === "chore: inicio", git(d.folder, "log", "main", "--format=%s"));

  // 5. Main into main is never requested.
  const e = project("principal", [{ decision: "continue" }, { decision: "complete", git: { commit: true, message: "feat: listo", merge_into: "main" } }]);
  await open(e.p);
  app.coordinator.start(e.p.id);
  await waitStatus("Completado");
  check("pedir fusionar main en main se omite sin aprobación pendiente", (await bar().count()) === 0 && !app.coordinator.active.gitQueue.some((g) => g.kind === "merge"));
  check("sin errores de la página", errors.length === 0, errors);
  check("sin peticiones externas", external.length === 0, external);
  await shot("05-final");
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error.message ?? error);
  await shot("error").catch(() => {});
} finally {
  report.errors = errors;
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();
  await app.close?.();
  fs.rmSync(projects, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: report.ok, error: report.error, checks: report.checks.length, passed: report.checks.filter((c) => c.ok).length, output }, null, 2));
  process.exit(report.ok ? 0 : 1);
}
