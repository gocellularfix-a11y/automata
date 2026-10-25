import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.mjs";
import { AuthManager } from "../server/auth.mjs";
import { GitHubProjects } from "../server/github.mjs";
import { runProcess } from "../server/agents.mjs";

const output = path.resolve("artifacts", "github-" + Date.now());
const origin = path.join(output, "fixture-origin.git"), destination = path.join(output, "clock"), local = path.join(output, "local");
fs.mkdirSync(destination, { recursive: true });
fs.mkdirSync(local);
await runProcess("git", ["init", "--bare", origin], { cwd: output });
const auth = new AuthManager({
  find: role => ({ command: role, args: [] }),
  run: async role => ({ code: 0, stdout: role === "coder" ? '{"loggedIn":true,"authMethod":"claude.ai"}' : "", stderr: role === "auditor" ? "Logged in using ChatGPT" : role === "github" ? "Logged in to github.com account test-user" : "" })
});
let clones = 0;
const github = new GitHubProjects({ auth, find: () => ({ command: "simulated-gh", args: [] }), run: async (command, args, options) => {
  if (command !== "simulated-gh") return runProcess(command, args, options);
  if (args[0] !== "repo" || args[1] !== "clone" || args[2] !== "https://github.com/example/clock") throw Error("Unexpected clone invocation.");
  clones++;
  return runProcess("git", ["clone", origin, args[3]], options);
} });
const app = await createServer({ port: 0, dataDir: path.join(output, "data"), auth, github });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1480, height: 1020 }, reducedMotion: "reduce" });
const checks = [], errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, ok) => { checks.push({ name, ok: !!ok }); if (!ok) throw Error(name); };
async function fillProject(directory, name) {
  await page.fill("#projectForm [name=name]", name);
  await page.fill("#projectForm [name=directory]", directory);
  await page.fill("#projectForm [name=objective]", "Crear un reloj digital con comprobaciones.");
  await page.fill("#projectForm [name=criteria]", "Muestra la hora actual.");
}
try {
  await page.goto(app.origin + "/#token=" + app.token);
  await page.waitForSelector("#accountsDialog[open]");
  await page.click("#accountsDialog [data-close]");
  await page.click("#newProjectTop");
  check("Local es la opción inicial y GitHub es opcional", await page.locator("#projectForm [value=local]").isChecked() && !await page.locator("#githubProjectFields").isVisible());
  await page.check("#projectForm [value=github]");
  await page.fill("#projectForm [name=repository]", "example/clock");
  await fillProject(destination, "Reloj desde GitHub");
  check("GitHub muestra repositorio y acción de importación", await page.locator("#projectForm [name=repository]").isVisible() && await page.locator("#projectSubmitLabel").textContent() === "Clonar y crear proyecto");
  await page.screenshot({ path: path.join(output, "01-github-project.png") });
  await page.click("#projectForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Reloj desde GitHub");
  check("clonación local de prueba completa desde la interfaz", clones === 1 && fs.existsSync(path.join(destination, ".git")) && app.coordinator.projects[0].source === "github");
  await page.click("#newProjectTop");
  await page.check("#projectForm [value=github]");
  await page.fill("#projectForm [name=repository]", "example/clock");
  await fillProject(destination, "Otra copia");
  await page.click("#projectForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectError").textContent.includes("carpeta vacía"));
  check("clonar nunca sobrescribe una carpeta ocupada", clones === 1 && app.coordinator.projects.length === 1);
  await runProcess("git", ["remote", "set-url", "origin", "https://github.com/example/clock.git"], { cwd: destination });
  await page.selectOption("#projectForm [name=repositoryAction]", "existing");
  await page.click("#projectForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Otra copia");
  check("abrir una copia existente no vuelve a clonar", clones === 1 && app.coordinator.projects.length === 2);
  await page.click("#newProjectTop");
  await page.check("#projectForm [value=github]");
  await page.fill("#projectForm [name=repository]", "example/other");
  await page.selectOption("#projectForm [name=repositoryAction]", "existing");
  await fillProject(destination, "No debe crearse");
  await page.click("#projectForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectError").textContent.includes("no coincide"));
  check("repo incorrecto no cambia origin ni agrega proyecto", app.coordinator.projects.length === 2);
  await page.check("#projectForm [value=local]");
  await fillProject(local, "Reloj local sin Git");
  await page.click("#projectForm button[type=submit]");
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Reloj local sin Git");
  check("volver a Local ignora el repo y no inicializa Git", app.coordinator.projects[2].source === "local" && app.coordinator.projects[2].repository === null && !fs.existsSync(path.join(local, ".git")));
  check("importar proyectos no inicia llamadas a modelos", app.coordinator.runs.length === 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#newProjectTop");
  await page.check("#projectForm [value=github]");
  check("selector Local/GitHub sin desbordamiento móvil", await page.evaluate(() => document.querySelector("#projectDialog").scrollWidth <= document.querySelector("#projectDialog").clientWidth && document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(output, "02-mobile-github.png") });
  check("sin errores de JavaScript", errors.length === 0);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ok: true, simulatedGitHub: true, actualLocalGitClone: true, checks, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks: checks.length, simulatedGitHub: true, output }, null, 2));
} finally { await browser.close(); await app.close(); }
