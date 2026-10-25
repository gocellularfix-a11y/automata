import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { MODES, REVIEW_SCHEMA } from "./config.mjs";
export function findCodexNative(packageRoot, { platform = process.platform, arch = process.arch } = {}) {
  if (platform !== "win32" || !["x64", "arm64"].includes(arch)) return null;
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const roots = [path.join(packageRoot, "vendor")];
  try {
    const resolve = createRequire(path.join(packageRoot, "package.json"));
    roots.unshift(path.join(path.dirname(resolve.resolve(`@openai/codex-win32-${arch}/package.json`)), "vendor"));
  } catch {}
  for (const root of roots) for (const folder of ["bin", "codex"]) {
    const binary = path.join(root, target, folder, "codex.exe");
    if (fs.existsSync(binary)) return { command: binary, args: [], env: { CODEX_MANAGED_PACKAGE_ROOT: fs.realpathSync(packageRoot), CODEX_MANAGED_BY_NPM: "1" } };
  }
  return null;
}
export function findAgent(role) {
  const env = role === "coder" ? process.env.AUTOMATA_CLAUDE : process.env.AUTOMATA_CODEX;
  if (env && fs.existsSync(env)) return /\.[cm]?js$/.test(env) ? { command: process.execPath, args: [env] } : { command: env, args: [] };
  const npm = process.env.APPDATA ? path.join(process.env.APPDATA, "npm", "node_modules") : null;
  if (role === "auditor" && npm) {
    const native = findCodexNative(path.join(npm, "@openai", "codex"));
    if (native) return native;
  }
  const candidates = role === "coder" ? [npm && path.join(npm, "@anthropic-ai", "claude-code", "bin", "claude.exe"), path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude")] : [npm && path.join(npm, "@openai", "codex", "bin", "codex.js")];
  for (const file of candidates.filter(Boolean)) if (fs.existsSync(file)) return file.endsWith(".js") ? { command: process.execPath, args: [file] } : { command: file, args: [] };
  if (process.platform !== "win32") return { command: role === "coder" ? "claude" : "codex", args: [] };
  return null;
}
export const redact = (text) => String(text).replace(/\bsk-[a-zA-Z0-9_-]{12,}/g, "[credencial omitida]").replace(/\bgh[pousr]_[a-zA-Z0-9]{15,}/g, "[credencial omitida]");
export async function killTree(child) {
  if (!child?.pid || child.exitCode != null) return;
  if (process.platform === "win32") await promisify(execFile)("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true }).catch(() => child.kill());
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}
export function runProcess(command, args, { cwd, input = "", signal, timeoutMs = 18e5, onLine = () => {
}, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("Ejecución detenida."), { name: "AbortError" }));
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env } });
    let stdout = "", stderr = "", pending = "", failure = null, settled = false;
    const abort = () => {
      failure = Object.assign(new Error("Ejecución detenida."), { name: "AbortError" });
      void killTree(child);
    };
    const timer = setTimeout(() => {
      failure = new Error("La ejecución alcanzó el límite de tiempo.");
      void killTree(child);
    }, timeoutMs);
    timer.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    child.on("error", (e) => finish(new Error(`No se pudo iniciar ${path.basename(command)}: ${e.message}`)));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-8 * 1024 * 1024);
      pending += chunk;
      if (pending.length > 2 * 1024 * 1024) {
        failure = new Error("El agente emitió un evento demasiado grande.");
        void killTree(child);
        pending = "";
        return;
      }
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const l of lines) {
        try {
          onLine(l, "stdout");
        } catch (e) {
          failure = e;
          void killTree(child);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-24e3);
      try {
        onLine(chunk, "stderr");
      } catch (e) {
        failure = e;
        void killTree(child);
      }
    });
    child.on("close", (code, exitSignal) => {
      if (pending) {
        try {
          onLine(pending, "stdout");
        } catch (e) {
          failure = e;
        }
      }
      finish(failure, { code: code ?? -1, signal: exitSignal, stdout, stderr: redact(stderr) });
    });
    child.stdin.on("error", () => {
    });
    child.stdin.end(input);
  });
}
export function decodeEvent(role, raw) {
  let e;
  try {
    e = JSON.parse(raw);
  } catch {
    return null;
  }
  if (role === "coder") {
    if (e.type === "result") return { kind: "result", text: e.result ?? "", error: !!e.is_error, sessionId: e.session_id, usage: e.usage, cost: e.total_cost_usd };
    if (e.type === "assistant") {
      const blocks = e.message?.content ?? [];
      const text = blocks.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      const tools = blocks.filter((c) => c.type === "tool_use").map((c) => `${c.name}${c.input?.file_path ? " · " + c.input.file_path : ""}`);
      return { kind: tools.length ? "tool" : "message", text: [text, ...tools].filter(Boolean).join("\n") };
    }
    if (e.type === "system" && e.subtype === "init") return { kind: "session", text: "Sesión de Claude iniciada", sessionId: e.session_id, model: e.model };
    if (e.type === "system" && e.subtype === "permission_denied") return { kind: "warning", text: "Claude encontró una herramienta sin permiso. El reporte debe indicar el bloqueo." };
  } else {
    if (e.type === "thread.started") return { kind: "session", text: "Sesión de Codex iniciada", sessionId: e.thread_id };
    if (e.type === "turn.completed") return { kind: "usage", usage: e.usage };
    if (e.type === "error" || e.type === "turn.failed") return { kind: "warning", text: e.message ?? e.error?.message ?? "El auditor reportó un error." };
    if (e.type === "item.completed" && e.item?.type === "agent_message") return { kind: "message", text: e.item.text };
    if (e.type === "item.started" && e.item?.type === "command_execution") return { kind: "tool", text: "Inspeccionando el repositorio", detail: e.item.command };
  }
  return null;
}
export class CliAgents {
  async run({ role, prompt, project, settings, phase, directory, signal, emit }) {
    const executable = findAgent(role);
    if (!executable) throw new Error(`${role === "coder" ? "Claude Code" : "Codex CLI"} no está instalado. Instálalo o configura AUTOMATA_CLAUDE / AUTOMATA_CODEX.`);
    fs.writeFileSync(path.join(directory, `${phase}-prompt.txt`), prompt, { mode: 384 });
    let result = null, lastMessage = "", sessionId = null, usage = null;
    const outputFile = path.join(directory, `${phase}-response.json`);
    let args;
    if (role === "auditor") {
      const schema = phase === "chat" ? null : path.join(directory, "review-schema.json");
      if (schema) fs.writeFileSync(schema, JSON.stringify(REVIEW_SCHEMA));
      // The user selects a local project folder; Git is optional. Keep the auditor read-only.
      args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--model", settings.auditorModel, "--json", "--output-last-message", outputFile, "--cd", project.directory];
      if (schema) args.push("--output-schema", schema);
      if (settings.auditorEffort !== "default") args.push("-c", `model_reasoning_effort="${settings.auditorEffort}"`);
      args.push("-");
    } else {
      args = ["-p", "--model", settings.coderModel, "--output-format", "stream-json", "--verbose", "--max-turns", String(MODES[settings.mode].turns), "--permission-mode", phase === "chat" ? "plan" : "acceptEdits", "--allowedTools", phase === "chat" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write,Bash(git status *),Bash(git diff *),Bash(git log *)"];
      if (settings.coderEffort !== "default") args.push("--effort", settings.coderEffort);
    }
    const rawFile = path.join(directory, `${phase}-${role}.jsonl`);
    const executed = await runProcess(executable.command, [...executable.args, ...args], {
      cwd: project.directory,
      input: prompt,
      signal,
      env: executable.env,
      timeoutMs: settings.timeoutMinutes * 6e4,
      onLine: (line, stream) => {
        if (stream === "stderr") {
          fs.appendFileSync(rawFile, JSON.stringify({ stderr: redact(line) }) + "\n");
          return;
        }
        fs.appendFileSync(rawFile, redact(line) + "\n");
        const e = decodeEvent(role, line);
        if (!e) return;
        if (e.kind === "result") result = e;
        if (e.sessionId) sessionId = e.sessionId;
        if (e.usage) usage = e.usage;
        if (e.kind === "message") lastMessage = e.text;
        if (e.text && e.kind !== "result") emit({ role, ...e, text: redact(e.text) });
      }
    });
    if (executed.code !== 0 || result?.error) throw new Error(redact(result?.text || executed.stderr || `El agente terminó con código ${executed.code}.`).slice(-8e3));
    if (role === "coder") {
      if (!result?.text?.trim()) throw new Error("Claude terminó sin reporte final.");
      fs.writeFileSync(outputFile, JSON.stringify(result));
      return { text: redact(result.text), sessionId, usage, cost: result.cost ?? null };
    }
    const text = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : lastMessage;
    if (!text) throw new Error("Codex terminó sin respuesta.");
    if (phase === "chat") return { text: redact(text), sessionId, usage };
    let review;
    try {
      review = JSON.parse(text);
    } catch {
      throw new Error("Codex no entregó el JSON de auditoría esperado.");
    }
    return { text: review.summary, review, sessionId, usage };
  }
}
export async function gitEvidence(directory) {
  try {
    const repository = await runProcess("git", ["rev-parse", "--is-inside-work-tree"], { cwd: directory, timeoutMs: 2e4 });
    if (repository.code !== 0 || repository.stdout.trim() !== "true") return "Proyecto local sin evidencia de Git disponible. Inspecciona los archivos y las verificaciones directamente. No se requiere crear ni inicializar un repositorio.";
  } catch {
    return "Git no está disponible. Inspecciona los archivos y las verificaciones directamente; trabajar en una carpeta local es válido.";
  }
  const commands = [["status", "--short", "--", "."], ["diff", "--stat", "--", "."], ["diff", "--no-ext-diff", "--unified=3", "--", "."], ["diff", "--cached", "--no-ext-diff", "--stat", "--", "."]];
  const output = [];
  for (const args of commands) {
    try {
      const r = await runProcess("git", args, { cwd: directory, timeoutMs: 2e4 });
      output.push(`git ${args.join(" ")}
${r.code === 0 ? redact(r.stdout).slice(0, 6e4) : "Git no disponible para este proyecto."}`);
    } catch {
      output.push("No se pudo recoger evidencia de Git.");
    }
  }
  return output.join("\n\n");
}
export async function runChecks(project, directory, signal, emit) {
  const results = [];
  for (const [i, command] of project.checks.entries()) {
    emit({ role: "system", kind: "check", text: `Verificando · ${command}` });
    const filename = path.join(directory, `check-${i + 1}.${process.platform === "win32" ? "ps1" : "sh"}`);
    const source = process.platform === "win32" ? `$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0
${command}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
` : `set -e
${command}
`;
    fs.writeFileSync(filename, (process.platform === "win32" ? "\uFEFF" : "") + source);
    const r = await runProcess(process.platform === "win32" ? "powershell.exe" : "/bin/sh", process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", filename] : [filename], { cwd: project.directory, signal, timeoutMs: 3e5 });
    const result = { command, passed: r.code === 0, code: r.code, output: redact(r.stdout.slice(-3e4)), stderr: r.stderr };
    fs.writeFileSync(path.join(directory, `check-${i + 1}.json`), JSON.stringify(result, null, 2));
    results.push(result);
    emit({ role: "system", kind: result.passed ? "success" : "warning", text: `${result.passed ? "Aprobado" : "Falló"} · ${command}` });
  }
  return results;
}
export class DemoAgents {
  async run({ role, phase, project, emit, signal }) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("Demostración detenida"), { name: "AbortError" }));
      }, { once: true });
    });
    if (phase === "chat") return { text: "Estás en la demostración local. Puedes probar el flujo, los controles y el historial. Para consultar a un modelo real, abre Automata sin --demo y configura un proyecto." };
    if (role === "coder") {
      fs.writeFileSync(path.join(project.directory, "greet.mjs"), "export function greet(name) { return `Hola, ${name}. Bienvenido a Automata.`; }\n");
      fs.writeFileSync(path.join(project.directory, "greet.test.mjs"), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from './greet.mjs';\ntest('saludo de Automata',()=>assert.equal(greet('compa'),'Hola, compa. Bienvenido a Automata.'));\n");
      emit({ role: "coder", kind: "tool", text: "Demostración · creados greet.mjs y greet.test.mjs en el proyecto de ejemplo." });
      return { text: "Demostración: implementé un saludo con su prueba. Automata ejecutará node --test para verificarlo. No se llamó a ninguna AI." };
    }
    const complete = phase !== "plan";
    return { review: { decision: complete ? "complete" : "continue", summary: complete ? "Demostración completada: el saludo y su prueba están creados. Las verificaciones reales se ejecutaron por separado." : "Preparé una tarea pequeña para probar el ciclo completo sin consumir créditos.", nextPrompt: complete ? "" : "Crea greet.mjs con un saludo y greet.test.mjs con una prueba de node:test.", findings: [], criteria: project.criteria.map((criterion) => ({ criterion, met: complete, evidence: complete ? "greet.mjs y greet.test.mjs del ejemplo; resultados de node --test." : "Pendiente de ejecución." })) } };
  }
}
