import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { chromium } from "playwright-core";
import { launchBrowserApp } from "./browser.mjs";
const output = path.resolve("artifacts", "window-" + Date.now());
fs.mkdirSync(output, { recursive: true });
const app = await launchBrowserApp({ port: 0, demo: true, dataRoot: path.join(output, "data"), profileRoot: fs.mkdtempSync(path.join(os.tmpdir(), "automata-window-")), headless: true, debug: true });
let browser;
try {
  const marker = path.join(app.profile, "DevToolsActivePort");
  const deadline = Date.now() + 15e3;
  while (!fs.existsSync(marker)) {
    if (Date.now() > deadline) throw new Error("Chrome no inició su ventana de aplicación.");
    await new Promise((r) => setTimeout(r, 100));
  }
  const port = Number(fs.readFileSync(marker, "utf8").split("\n")[0]);
  browser = await chromium.connectOverCDP("http://127.0.0.1:" + port);
  const page = browser.contexts()[0].pages()[0];
  await page.waitForFunction(() => document.querySelector("#projectName")?.textContent === "Hola, Automata");
  await page.click("#startButton");
  await page.waitForFunction(() => document.querySelector("#runState").textContent === "Completado", null, { timeout: 25e3 });
  if (app.coordinator.active.status !== "complete") throw new Error("El ciclo no se completó.");
  await page.screenshot({ path: path.join(output, "window.png") });
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ ok: true, host: "Chrome app window", output }, null, 2));
  console.log(JSON.stringify({ ok: true, output }));
} finally {
  if (browser && browser.isConnected()) {
    try {
      const cdp = await browser.newBrowserCDPSession();
      await cdp.send("Browser.close");
    } catch {
    }
  } else if (!browser) await app.stop();
  await app.finished;
}
