import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "../server/index.mjs";
import { killTree } from "../server/agents.mjs";
export async function launchBrowserApp({ demo = false, lan = false, port = 4780, dataRoot = process.env.AUTOMATA_USER_DATA ?? path.join(process.env.APPDATA ?? os.homedir(), "Automata"), profileRoot = dataRoot, headless = false, debug = false } = {}) {
  const chrome = [process.env.CHROME_PATH, ...[process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], "C:/Program Files", "C:/Program Files (x86)"].filter(Boolean).map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe"))].find((p) => p && fs.existsSync(p));
  if (!chrome) throw new Error("No se encontró Chrome. Usa la aplicación Electron o define CHROME_PATH.");
  const dataDir = path.join(dataRoot, demo ? "demo" : "workspace");
  let service;
  try {
    service = await createServer({ port, lan, demo, dataDir });
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    service = await createServer({ port: 0, lan, demo, dataDir });
  }
  const profile = path.join(profileRoot, demo ? "demo-browser" : "browser");
  fs.mkdirSync(profile, { recursive: true });
  const args = [`--app=${service.origin}/#token=${service.token}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--password-store=basic", "--disable-background-networking", "--window-size=1540,1040", ...headless ? ["--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] : [], ...debug ? ["--remote-debugging-port=0"] : []];
  const child = spawn(chrome, args, { windowsHide: headless, stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.on("data", (data) => fs.appendFileSync(path.join(dataRoot, "browser.log"), data));
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await service.close();
    }
  };
  const finished = new Promise((resolve, reject) => {
    child.once("error", (e) => {
      void close().then(() => reject(e));
    });
    child.once("exit", () => {
      void close().then(resolve, reject);
    });
  });
  return { ...service, child, profile, finished, async stop() {
    await killTree(child);
    await close();
  } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), at = args.indexOf("--port");
  const app = await launchBrowserApp({ demo: args.includes("--demo"), lan: args.includes("--lan"), port: at >= 0 ? Number(args[at + 1]) : 4780 });
  console.log("Automata abierto en una ventana de aplicación. Cierra la ventana para terminar.");
  for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => void app.stop());
  await app.finished;
}
