// Asks Chrome itself whether Automata's interface can be installed as an app (Windows and Android install it from
// Chrome or Edge; iOS adds it to the Home Screen from Safari with the same manifest and icons). Throwaway coordinator
// (demo, own data folder, 127.0.0.1) and a throwaway browser profile. Installs nothing.
//   node scripts/pwa-check.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "../server/index.mjs";
import { detectEnvironment } from "../server/environment.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const env = await detectEnvironment();
const executable = env.tools.browser.found ? env.tools.browser.path : null;
if (!executable) { console.error("No hay Chrome ni Edge para comprobarlo."); process.exit(2); }
const data = fs.mkdtempSync(path.join(os.tmpdir(), "automata-pwa-data-")), profile = fs.mkdtempSync(path.join(os.tmpdir(), "automata-pwa-profile-"));
const app = await createServer({ port: 0, demo: true, dataDir: data });
const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const report = { origin: app.origin, ok: false };
try {
  let port, browserPath;
  for (let i = 0; i < 100 && !port; i++) {
    try { const [a, b] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split(/\r?\n/); if (Number(a) > 0 && b) { port = Number(a); browserPath = b; } } catch { /* not yet */ }
    if (!port) await wait(100);
  }
  if (!port) throw new Error("Chrome no arrancó a tiempo.");
  const ws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error("sin canal de depuración")); });
  let next = 0;
  const pending = new Map(), events = [];
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result ?? {}); } else events.push(m); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...sessionId ? { sessionId } : {} })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: app.origin + "/" }, sessionId);
  for (let i = 0; i < 100 && !events.some((m) => m.method === "Page.loadEventFired"); i++) await wait(100);
  await wait(1200);
  const manifest = await send("Page.getAppManifest", {}, sessionId);
  const installability = await send("Page.getInstallabilityErrors", {}, sessionId);
  Object.assign(report, { manifestUrl: manifest.url, manifestErrors: manifest.errors?.map((e) => e.message) ?? [], installabilityErrors: installability.installabilityErrors?.map((e) => e.errorId) ?? [] });
  const parsed = JSON.parse(manifest.data || "{}");
  report.name = parsed.name; report.display = parsed.display; report.icons = parsed.icons?.length;
  report.ok = !!manifest.url && !report.manifestErrors.length && !report.installabilityErrors.length;
  ws.close();
} catch (error) {
  report.error = error.message;
} finally {
  child.kill();
  await app.close();
  await wait(500);
  for (const dir of [data, profile]) try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(JSON.stringify(report, null, 2));
console.log(report.ok ? "Chrome da la interfaz por instalable como app." : "Chrome NO la da por instalable.");
process.exit(report.ok ? 0 : 1);
