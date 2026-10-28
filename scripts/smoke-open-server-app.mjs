// Real check, from the DESKTOP window, of a delivered web app that needs a local server:
//   «Abrir aplicación» starts the server -> it answers -> the real default browser opens it -> «Detener» stops it,
//   and closing Automata with the app still running leaves nothing behind.
// The delivered run is copied from a real drill (state of «Tu aplicación está lista») and pointed at a tiny Node server
// of its own, under a title and folder name that can be recognised among the user's windows. No port is fixed: the
// server asks the system for one and Automata reads it from the launcher.
//
//   node scripts/smoke-open-server-app.mjs [--source artifacts/real-idea-2026-10-28T21-57-21-051Z]
//
// It leaves the browser tabs it opened (the user's browser is not this script's to close).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const source = path.resolve(root, arg("--source", "artifacts/real-idea-2026-10-28T21-57-21-051Z"));
const stamp = Date.now().toString(36);
const title = `AUTOMATA-SERVIDOR-${stamp}`;
const output = path.join(root, "artifacts", "open-server-app-" + new Date().toISOString().replace(/[:.]/g, "-"));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "automata-open-srv-"));
const appFolder = path.join(base, `app-servidor-${stamp}`);
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(appFolder, { recursive: true });

// A port that is free right now; the launcher and the delivered state name it, like a real app's launcher does.
const port = await new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });
fs.writeFileSync(path.join(appFolder, "server.mjs"), `import http from "node:http";\nhttp.createServer((q, r) => { r.setHeader("content-type", "text/html; charset=utf-8"); r.end("<!doctype html><meta charset=utf-8><title>${title}</title><body><h1>${title}</h1></body>"); }).listen(${port}, "127.0.0.1", () => console.log("http://localhost:${port}"));\n`);
fs.writeFileSync(path.join(appFolder, "package.json"), JSON.stringify({ scripts: { start: "node server.mjs" } }));
fs.writeFileSync(path.join(appFolder, "Abrir.cmd"), `@echo off\r\nstart /min "" node "%~dp0server.mjs"\r\ntimeout /t 2 >nul\r\nstart "" http://localhost:${port}\r\n`);
fs.writeFileSync(path.join(appFolder, "COMO_USAR.md"), "# Cómo usar\n\n## Instalar\nNo hay nada que instalar.\n\n## Abrir\nDoble clic en Abrir.cmd.\n");

// The run of the real drill, now delivered as a server app.
const report = JSON.parse(fs.readFileSync(path.join(source, "report.json"), "utf8"));
const oldDir = path.resolve(report.project.directory);
const userData = path.join(base, "user-data"), workspace = path.join(userData, "workspace");
fs.cpSync(path.join(source, "data"), workspace, { recursive: true, filter: (file) => !/access-token$|coordinator\.lock$/.test(file) });
const escaped = (p) => JSON.stringify(p).slice(1, -1);
for (const file of ["projects.json", "runs.json", "events.json", "proposals.json"]) {
  const target = path.join(workspace, file);
  if (fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(target, "utf8").split(escaped(oldDir)).join(escaped(appFolder)));
}
const runsFile = path.join(workspace, "runs.json");
const runs = JSON.parse(fs.readFileSync(runsFile, "utf8"));
for (const run of Array.isArray(runs) ? runs : runs.runs) if (run.delivery?.status === "ready") {
  run.delivery.mode = "server";
  run.delivery.open = { type: "url", target: `http://localhost:${port}`, command: "node server.mjs" };
}
fs.writeFileSync(runsFile, JSON.stringify(runs));

// ---- What is on the system (read-only) ----
const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
const processesWith = (text) => ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${text}') -and $_.CommandLine -notlike '*Get-CimInstance*' -and $_.ProcessId -ne ${process.pid} } | ForEach-Object { [string]$_.ProcessId + '|' + $_.Name }`).split(/\r?\n/).filter(Boolean);
// The server is found by the port it listens on (its command line is just «node server.mjs»), with the shell that started it.
const listener = () => { const out = ps(`$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); [string]$c.OwningProcess + ',' + [string]$p.ParentProcessId }; exit 0`); return out ? out.split(",").map(Number) : []; };
const alive = (pids) => pids.length ? ps(`@(${pids.join(",")} | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | ForEach-Object { [string]$_.Id + '|' + $_.ProcessName }) -join [Environment]::NewLine`).split(/\r?\n/).filter(Boolean) : [];
const browserWindows = () => ps(`Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }`).split(/\r?\n/).filter(Boolean);
const answers = () => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }).then(async (r) => (await r.text()).includes(title), () => false);
const until = async (read, ms, want = true) => { const limit = Date.now() + ms; let v = await read(); while ((Array.isArray(v) ? v.length > 0 : !!v) !== want && Date.now() < limit) { await new Promise((r) => setTimeout(r, 400)); v = await read(); } return v; };

const env = { ...process.env, AUTOMATA_USER_DATA: userData, AUTOMATA_SMOKE: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const result = { at: new Date().toISOString(), appFolder, port, title, source: path.relative(root, source), steps: {} };
const launch = () => _electron.launch({ executablePath: require("electron"), args: [root, "--port", "0", "--disable-gpu"], env, timeout: 30000 });
const ready = async (page) => { await page.waitForSelector('[data-delivery="open"]', { timeout: 30000 }); await page.evaluate(() => document.querySelector("#accountsDialog")?.close()); };
const toast = async (page, pattern) => { await page.waitForFunction((p) => new RegExp(p, "i").test(document.querySelector("#toast")?.textContent ?? ""), pattern, { timeout: 20000 }).catch(() => {}); return (await page.locator("#toast").innerText().catch(() => "")).trim(); };

result.steps.beforeAnything = { serverAnswers: await answers(), listeners: listener() };

// 1) Open, see it answer, see the browser, stop it from the interface.
let reopenedPids = [];
let app = await launch();
try {
  const page = await app.firstWindow();
  await ready(page);
  await page.click('[data-delivery="open"]');
  result.steps.open = { toast: await toast(page, "Abriendo la aplicación|Ruta|error"), serverAnswers: await until(answers, 25000) };
  result.steps.open.browserWindows = await until(browserWindows, 20000);
  result.steps.open.appRow = (await page.locator(".app-text").allInnerTexts().catch(() => [])).map((x) => x.replace(/\s+/g, " ")).join(" | ").slice(0, 300);
  result.steps.open.serverPids = listener();
  const startedPids = result.steps.open.serverPids;
  await page.waitForSelector('[data-app="stop"]', { timeout: 10000 }).catch(() => {});
  result.steps.open.stopButton = (await page.locator('[data-app="stop"]').count()) > 0;
  await page.click('[data-app="stop"]').catch(() => {});
  result.steps.stop = { serverStopped: await until(answers, 15000, false) === false, processesLeft: await until(() => alive(startedPids), 15000, false) };
  // 2) Open again and close Automata with the app still running: nothing may stay behind.
  await page.waitForSelector('[data-delivery="open"]', { timeout: 10000 });
  await page.click('[data-delivery="open"]');
  result.steps.reopen = { serverAnswers: await until(answers, 25000), serverPids: listener() };
  reopenedPids = result.steps.reopen.serverPids;
} finally {
  await app.close().catch(() => {});
}
result.steps.afterClosingAutomata = { serverStopped: (await until(answers, 20000, false)) === false, processesLeft: await until(() => alive(reopenedPids), 20000, false), automataLeft: processesWith(`automata-open-srv-`).filter((p) => !/powershell|conhost/i.test(p)) };
result.verdict = {
  startedAndAnswered: result.steps.open.serverAnswers === true && result.steps.open.serverPids.length === 2,
  openedInBrowser: result.steps.open.browserWindows.length > 0,
  detenerWorks: result.steps.open.stopButton === true && result.steps.stop.serverStopped === true && result.steps.stop.processesLeft.length === 0,
  closingAutomataStopsIt: result.steps.reopen.serverAnswers === true && result.steps.afterClosingAutomata.serverStopped === true,
  noResidualProcesses: result.steps.afterClosingAutomata.processesLeft.length === 0 && result.steps.afterClosingAutomata.automataLeft.length === 0
};
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!args.includes("--keep")) fs.rmSync(base, { recursive: true, force: true });
process.exitCode = Object.values(result.verdict).every(Boolean) ? 0 : 1;
