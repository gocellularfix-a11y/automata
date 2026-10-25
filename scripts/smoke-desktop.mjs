import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron, chromium } from "playwright-core";
const require = createRequire(import.meta.url), root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts", "desktop-" + Date.now());
fs.mkdirSync(output, { recursive: true });
const chrome = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const iconPage = await browser.newPage({ viewport: { width: 256, height: 256 } });
const svg = fs.readFileSync(path.join(root, "public/icon.svg"), "utf8");
await iconPage.setContent(`<style>html,body{margin:0;width:256px;height:256px;background:transparent}svg{display:block;width:256px;height:256px}</style>${svg}`);
await iconPage.screenshot({ path: path.join(root, "public/icon.png"), omitBackground: true });
await browser.close();
const env = { ...process.env, AUTOMATA_USER_DATA: path.join(output, "user-data"), AUTOMATA_SMOKE: "1" };
if (process.argv.includes("--headed")) env.AUTOMATA_SHOW = "1";
delete env.ELECTRON_RUN_AS_NODE;
const args = process.env.AUTOMATA_PACKAGED ? ["--demo", "--port", "0", "--disable-gpu"] : [root, "--demo", "--port", "0", "--disable-gpu"];
if (process.argv.includes("--compatibility")) args.push("--compatibility");
const app = await _electron.launch({ executablePath: process.env.AUTOMATA_PACKAGED ?? require("electron"), args, env, timeout: 3e4 });
const errors = [];
let page;
try {
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForFunction(() => document.querySelector("#projectName").textContent === "Hola, Automata");
  const native = await page.evaluate(() => ({ bridge: !!window.automata, node: typeof window.require }));
  if (!native.bridge || native.node !== "undefined") throw new Error("El aislamiento del renderer no es correcto.");
  if (process.argv.includes("--headed")) await page.screenshot({ path: path.join(output, "windows.png"), timeout: 10000 });
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 25e3 });
  if (errors.length) throw new Error(errors.join("\n"));
  const result = { ok: true, native, errors, packaged: !!process.env.AUTOMATA_PACKAGED, output };
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  if (page) {
    await page.screenshot({ path: path.join(output, "failed.png") }).catch(() => {
    });
    const diagnostic = await page.evaluate(async () => ({ bridge: !!window.automata, status: document.querySelector("#connection")?.textContent, toast: document.querySelector("#toast")?.textContent, probe: await window.automata?.request("state").then((s) => ({ projects: s.projects.length })).catch((e2) => ({ error: e2.message })) })).catch(() => null);
    fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ok: false, error: e.message, errors, diagnostic }, null, 2));
    console.error(diagnostic);
  }
  throw e;
} finally {
  await app.close();
}
