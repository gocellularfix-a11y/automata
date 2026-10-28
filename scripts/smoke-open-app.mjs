// Real check of «Abrir aplicación» and «Abrir carpeta» from the DESKTOP interface (the Electron window), with the
// real system: the real default browser opens the delivered page and the real Explorer opens the folder.
// It starts from a delivered app (the finished run of a real drill, copied) with a title and folder name of its own, so
// what appears on the screen can be recognised among the user's windows. Nothing of the original project is touched.
//
//   node scripts/smoke-open-app.mjs [--source artifacts/real-idea-2026-10-28T20-44-16-580Z]  [--keep]
//
// It leaves a browser tab open (it is the user's browser; closing someone's tab is not this script's business) and
// closes only the Explorer window it opened.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { _electron } from "playwright-core";

const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
const source = path.resolve(root, arg("--source", "artifacts/real-idea-2026-10-28T20-44-16-580Z"));
const stamp = Date.now().toString(36);
const output = path.join(root, "artifacts", "open-app-" + new Date().toISOString().replace(/[:.]/g, "-"));
const base = fs.mkdtempSync(path.join(os.tmpdir(), "automata-open-"));
const appFolder = path.join(base, `app-abrir-${stamp}`);
const title = `AUTOMATA-ABRIR-${stamp}`;
fs.mkdirSync(output, { recursive: true });

// 1. The delivered app, copied under a recognisable name and title.
const data = JSON.parse(fs.readFileSync(path.join(source, "report.json"), "utf8"));
const oldDir = data.project?.directory ? path.resolve(data.project.directory) : "";
if (!oldDir || !fs.existsSync(path.join(oldDir, "index.html"))) throw new Error("No encuentro la carpeta de la app entregada en report.json (" + oldDir + ").");
fs.cpSync(oldDir, appFolder, { recursive: true });
const indexFile = path.join(appFolder, "index.html");
fs.writeFileSync(indexFile, fs.readFileSync(indexFile, "utf8").replace(/<title>[^<]*<\/title>/i, `<title>${title}</title>`));

// 2. Automata's data of that run, pointing at the copy.
const userData = path.join(base, "user-data"), workspace = path.join(userData, "workspace");
fs.cpSync(path.join(source, "data"), workspace, { recursive: true, filter: (file) => !/access-token$|coordinator\.lock$/.test(file) });
const escaped = (p) => JSON.stringify(p).slice(1, -1);
for (const file of ["projects.json", "runs.json", "events.json", "proposals.json"]) {
  const target = path.join(workspace, file);
  if (fs.existsSync(target)) fs.writeFileSync(target, fs.readFileSync(target, "utf8").split(escaped(oldDir)).join(escaped(appFolder)));
}

// 3. What is on the screen, read from the system (read-only).
const ps = (script) => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true }).trim();
const windowsWithTitle = () => ps(`Get-Process | Where-Object { $_.MainWindowTitle -like '*${title}*' } | ForEach-Object { $_.ProcessName + '|' + $_.MainWindowTitle }`).split(/\r?\n/).filter(Boolean);
const folderWindows = () => ps(`$s = New-Object -ComObject Shell.Application; @($s.Windows() | Where-Object { $_.LocationURL -like '*${path.basename(appFolder)}*' } | ForEach-Object { $_.LocationURL }) -join [Environment]::NewLine`).split(/\r?\n/).filter(Boolean);
const closeFolderWindows = () => ps(`$s = New-Object -ComObject Shell.Application; @($s.Windows()) | Where-Object { $_.LocationURL -like '*${path.basename(appFolder)}*' } | ForEach-Object { $_.Quit() }`);
const until = async (read, ms) => { const limit = Date.now() + ms; let value = read(); while (!value.length && Date.now() < limit) { await new Promise((r) => setTimeout(r, 500)); value = read(); } return value; };

const headed = args.includes("--headed");
// A hidden window cannot be photographed; with --headed it is shown on the screen for the length of the check.
const shot = async (page, name) => { if (headed) await page.screenshot({ path: path.join(output, name), timeout: 10000 }).catch(() => {}); };
const env = { ...process.env, AUTOMATA_USER_DATA: userData, AUTOMATA_SMOKE: "1", ...headed ? { AUTOMATA_SHOW: "1" } : {} };
delete env.ELECTRON_RUN_AS_NODE;
const report = { at: new Date().toISOString(), appFolder, title, source: path.relative(root, source), desktop: {}, system: {} };
const app = await _electron.launch({ executablePath: require("electron"), args: [root, "--port", "0", "--disable-gpu"], env, timeout: 30000 });
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector('[data-delivery="open"]', { timeout: 30000 });
  // A fresh profile asks to connect the accounts first; that dialog is not what is being tested.
  await page.evaluate(() => document.querySelector("#accountsDialog")?.close());
  report.desktop.rowText = (await page.locator(".delivery-row .app-text").first().innerText()).replace(/\s+/g, " ");
  await shot(page, "1-fila-entrega.png");

  // «Abrir aplicación»
  await page.click('[data-delivery="open"]');
  await page.waitForFunction(() => /Abriendo|Ruta|permitid|error/i.test(document.querySelector("#toast")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
  report.desktop.openToast = (await page.locator("#toast").innerText().catch(() => "")).trim();
  await shot(page, "2-despues-de-abrir-aplicacion.png");
  report.system.browserWindows = await until(windowsWithTitle, 20000);

  // «Abrir carpeta»
  await page.waitForTimeout(1200);
  await page.click('[data-delivery="folder"]');
  await page.waitForFunction(() => /Abriendo la carpeta|Ruta|permitid|error/i.test(document.querySelector("#toast")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});
  report.desktop.folderToast = (await page.locator("#toast").innerText().catch(() => "")).trim();
  report.system.explorerWindows = await until(folderWindows, 15000);

  // «Guía y detalles» (also goes through the same door)
  await page.click('[data-delivery="details"]');
  await page.waitForSelector(".delivery-guide h5", { timeout: 10000 }).catch(() => {});
  report.desktop.guideLoaded = (await page.locator(".delivery-guide").first().innerText().catch(() => "")).includes("Instalar");
  await shot(page, "3-guia.png");
  report.desktop.pageErrors = errors;
} finally {
  await app.close().catch(() => {});
  try { closeFolderWindows(); } catch { /* the window may already be gone */ }
}
report.verdict = {
  openAppButtonWorks: report.system.browserWindows.length > 0 && /Abriendo la aplicación/.test(report.desktop.openToast),
  openFolderButtonWorks: report.system.explorerWindows.length > 0,
  guideLoads: report.desktop.guideLoaded === true
};
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!args.includes("--keep")) fs.rmSync(base, { recursive: true, force: true });
process.exitCode = Object.values(report.verdict).every(Boolean) ? 0 : 1;
