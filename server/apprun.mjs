import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { killTree, redact } from "./agents.mjs";
const MAX_OUTPUT = 2e4;
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}[^\s"'<>)\]]*/i;
// Runs the project's app once the user approves the director's proposal. Only one app at a time;
// it keeps running until the user stops it or Automata closes.
export class AppRunner extends EventEmitter {
  constructor({ spawnApp } = {}) {
    super();
    this.spawnApp = spawnApp ?? defaultSpawn;
    this.state = null;
    this.child = null;
  }
  get running() {
    return this.state?.status === "running";
  }
  view() {
    return this.state ? { ...this.state } : null;
  }
  start({ directory, command, url = "", projectId = null, runId = null }) {
    if (this.running) throw new Error("Ya hay una app corriendo. Detenla antes de abrir otra.");
    const state = { id: randomUUID(), projectId, runId, directory, command, url, status: "running", output: "", startedAt: new Date().toISOString() };
    let child;
    try {
      child = this.spawnApp(command, directory);
    } catch (error) {
      throw new Error(`No se pudo iniciar la app: ${error.message}`);
    }
    this.state = state;
    this.child = child;
    const append = (chunk) => {
      const text = redact(String(chunk));
      state.output = (state.output + text).slice(-MAX_OUTPUT);
      if (!state.url) {
        const found = URL_IN_OUTPUT.exec(text);
        if (found) state.url = found[0].replace(/^(https?:\/\/)0\.0\.0\.0/i, "$1localhost");
      }
      this.emit("change", this.view());
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      if (this.state !== state) return;
      state.status = "failed";
      state.error = error.message;
      state.endedAt = new Date().toISOString();
      this.child = null;
      this.emit("change", this.view());
    });
    child.on("close", (code) => {
      if (this.state !== state || state.status !== "running") return;
      state.status = "exited";
      state.code = code ?? -1;
      state.endedAt = new Date().toISOString();
      this.child = null;
      this.emit("change", this.view());
    });
    this.emit("change", this.view());
    return this.view();
  }
  async stop() {
    const child = this.child, state = this.state;
    if (!child || !state || state.status !== "running") return this.view();
    state.status = "stopped";
    state.endedAt = new Date().toISOString();
    this.child = null;
    await killTree(child);
    this.emit("change", this.view());
    return this.view();
  }
  dismiss() {
    if (this.running) throw new Error("Detén la app antes de cerrar su panel.");
    this.state = null;
    this.emit("change", null);
  }
}
function defaultSpawn(command, cwd) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.platform === "win32") {
    // -EncodedCommand keeps quotes and special characters exactly as the director wrote them.
    // Windows PowerShell reports 1 for any failing native command; pass its own exit code through.
    const encoded = Buffer.from(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`, "utf16le").toString("base64");
    return spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  }
  return spawn("/bin/sh", ["-c", command], { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
}
