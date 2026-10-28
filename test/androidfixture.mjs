// Test helper: a small web project, an Automata data folder and (when this PC has a JDK and the Android SDK) a real
// APK built from it. Everything lives in a temporary folder; nothing is installed anywhere and no device is touched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAndroid, resolveToolchain } from "../server/androidbuild.mjs";
import { removeFolder } from "./rmretry.mjs";

export const toolchain = await resolveToolchain();
export const SKIP = toolchain.ok ? false : `sin JDK 21/25 o sin Android SDK en esta PC (${toolchain.missing.join(" ")})`;

const write = (root, file, content) => {
  const full = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
};
// The web files of a delivered P4 project plus everything else such a project holds.
export function webProject(root, { title = "Calculadora de prueba" } = {}) {
  write(root, "index.html", `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title><link rel="stylesheet" href="style.css"></head><body><h1 id="t">${title}</h1><img src="img/logo.svg" alt=""><script src="app.js"></script></body></html>\n`);
  write(root, "style.css", "body { font-family: sans-serif; }\n");
  write(root, "app.js", "document.getElementById('t').textContent += ' ✓';\n");
  write(root, "img/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>\n');
  write(root, "README.md", "# no va al APK\n");
  write(root, "COMO_USAR.md", "# guía\n");
  write(root, "Abrir.cmd", '@echo off\r\nstart "" "%~dp0index.html"\r\n');
  write(root, "package.json", "{}\n");
  write(root, "ui-check.json", "{}\n");
  write(root, ".env", "TOKEN=nada\n");
  write(root, "node_modules/lib/x.js", "x\n");
  write(root, "test/a.test.js", "x\n");
}

export function makeWorkspace(prefix = "automata-android-") {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const data = path.join(base, "data");
  fs.mkdirSync(data);
  return {
    base, data,
    project(name = "proyecto", options) { const dir = path.join(base, name); fs.mkdirSync(dir, { recursive: true }); webProject(dir, options); return dir; },
    cleanup() { removeFolder(base); }
  };
}
export const build = (options) => buildAndroid({ toolchain, ...options });
