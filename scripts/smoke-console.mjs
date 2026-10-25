import fs from "node:fs";
import path from "node:path";
import { findAgent, runProcess } from "../server/agents.mjs";

const [mode, output, host] = process.argv.slice(2);
if (!output || !["native", "wrapper"].includes(mode)) throw Error("Use native|wrapper and an output path.");
const native = findAgent("auditor");
if (!native?.command.endsWith("codex.exe")) throw Error("Install the Windows Codex CLI first.");
const root = path.resolve(import.meta.dirname, "..");
const app = path.join(root, "dist", "Automata-Windows", "Automata.exe");
const wrapper = path.join(process.env.APPDATA, "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
if (mode === "native" && host !== "gui-host") {
  // Use the packaged GUI executable as the parent, just like the desktop app.
  const result = await runProcess(app, [import.meta.filename, mode, output, "gui-host"], { cwd: root, timeoutMs: 30000 });
  if (result.code !== 0) throw Error("GUI host probe failed: " + result.stderr);
} else {
  const results = [];
  for (let i = 0; i < 12; i++) {
    const result = await runProcess(mode === "wrapper" ? app : native.command, mode === "wrapper" ? [wrapper, "--version"] : ["--version"], { cwd: root, env: mode === "native" ? native.env : {}, timeoutMs: 15000 });
    if (result.code !== 0) throw Error("CLI version probe failed.");
    results.push(result.stdout.trim());
  }
  fs.writeFileSync(output, JSON.stringify({ ok: true, mode, guiParent: true, nativeExecutable: native.command, probes: results.length, version: results[0] }, null, 2));
}
