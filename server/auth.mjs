import { spawn } from "node:child_process";
import { findAgent, runProcess, killTree } from "./agents.mjs";

const roles = ["coder", "auditor"];
const names = { coder: "Claude Code", auditor: "ChatGPT / Codex" };
const stripAnsi = value => String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const hosts = {
  coder: ["claude.ai", "console.anthropic.com", "platform.claude.com"],
  auditor: ["auth.openai.com", "chatgpt.com", "platform.openai.com"]
};

export function authUrl(role, value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && hosts[role]?.includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

export function interpretStatus(role, result) {
  const text = stripAnsi(result.stdout + "\n" + result.stderr);
  if (role === "coder") {
    let data;
    try { data = JSON.parse(result.stdout); } catch {
      return { connected: false, status: "error", message: "No se pudo leer el estado de Claude. Comprueba que Claude Code esté actualizado." };
    }
    const connected = result.code === 0 && data.loggedIn === true;
    const method = typeof data.authMethod === "string" ? data.authMethod : "unknown";
    return { connected, status: connected ? "connected" : "disconnected", method,
      message: connected ? (method === "claude.ai" ? "Sesión de Claude activa en esta PC." : "Credenciales de Claude disponibles en esta PC.") : "Inicia sesión con tu cuenta de Claude." };
  }
  const connected = result.code === 0 && /logged in/i.test(text) && !/not logged in/i.test(text);
  const disconnected = /not logged in|no credentials|not authenticated/i.test(text);
  const method = connected ? /api key/i.test(text) ? "api_key" : /access token/i.test(text) ? "access_token" : /chatgpt/i.test(text) ? "chatgpt" : "other" : "none";
  const diagnostic = /could not find home directory/i.test(text) ? "Codex no pudo localizar tu perfil de usuario. Abre Automata.exe desde tu escritorio de Windows y vuelve a comprobar." : "No se pudo verificar Codex. Revisa su instalación y vuelve a comprobar.";
  return { connected, status: connected ? "connected" : disconnected ? "disconnected" : "error", method,
    message: connected ? (method === "chatgpt" ? "Sesión de ChatGPT activa en Codex." : "Credenciales de Codex disponibles en esta PC.") : disconnected ? "Inicia sesión con ChatGPT para conectar al director." : diagnostic };
}

// OAuth URLs and device codes live only in memory; never write CLI login output to disk.
export class AuthManager {
  constructor({ demo = false, find = findAgent, run = runProcess, spawnLogin = spawn, stop = killTree, timeoutMs = 10 * 60 * 1000 } = {}) {
    Object.assign(this, { demo, find, run, spawnLogin, stop, timeoutMs });
    this.providers = Object.fromEntries(roles.map(role => [role, { installed: false, connected: false, status: "unknown", message: "Pendiente de comprobar." }]));
    this.jobs = new Map();
    this.probes = new Map();
    this.checkedAt = {};
    this.controllers = new Set();
    this.closed = false;
  }
  validate(role) {
    if (!roles.includes(role)) throw new Error("Proveedor no válido.");
    if (this.closed) throw new Error("Automata se está cerrando.");
  }
  snapshot({ local = false } = {}) {
    return { demo: this.demo, canLogin: local && !this.demo, providers: Object.fromEntries(roles.map(role => {
      const provider = { ...this.providers[role] };
      if (this.demo) return [role, { installed: false, connected: false, status: "demo", message: "La demostración funciona sin iniciar sesión." }];
      const job = this.jobs.get(role);
      if (job) Object.assign(provider, { connected: false, status: "pending", message: "Completa el acceso en el navegador y regresa a Automata." }, local ? { flow: { url: job.url, deviceCode: job.deviceCode, acceptsCode: job.acceptsCode, method: job.method } } : {});
      return [role, provider];
    })) };
  }
  async probe(role, force = false) {
    this.validate(role);
    if (this.demo || this.jobs.has(role) || !force && Date.now() - (this.checkedAt[role] ?? 0) < 15000) return;
    if (this.probes.has(role)) return this.probes.get(role);
    const controller = new AbortController();
    this.controllers.add(controller);
    const pending = (async () => {
      const cli = this.find(role);
      if (!cli) {
        this.providers[role] = { installed: false, connected: false, status: "missing", message: `Instala ${names[role]} en esta PC y vuelve a comprobar.` };
        return;
      }
      try {
        const args = role === "coder" ? ["auth", "status", "--json"] : ["login", "status"];
        const result = await this.run(cli.command, [...cli.args, ...args], { timeoutMs: 20000, signal: controller.signal });
        if (!this.closed && !this.jobs.has(role)) this.providers[role] = { installed: true, ...interpretStatus(role, result) };
      } catch {
        if (!this.closed && !this.jobs.has(role)) this.providers[role] = { installed: true, connected: false, status: "error", message: `No se pudo comprobar ${names[role]}. Revisa su instalación y vuelve a intentar.` };
      }
    })().finally(() => {
      this.checkedAt[role] = Date.now();
      this.controllers.delete(controller);
      this.probes.delete(role);
    });
    this.probes.set(role, pending);
    return pending;
  }
  async status({ force = false, local = false } = {}) {
    await Promise.all(roles.map(role => this.probe(role, force)));
    return this.snapshot({ local });
  }
  async requireConnected(required = roles) {
    if (this.demo) return;
    await Promise.all(required.map(role => this.probe(role, true)));
    const missing = required.filter(role => this.jobs.has(role) || !this.providers[role].connected);
    if (missing.length) throw new Error(`Conecta ${missing.map(role => names[role]).join(" y ")} en Cuentas antes de continuar.`);
  }
  async start(role, method = "browser") {
    this.validate(role);
    if (this.demo) throw new Error("Abre Automata sin --demo para conectar tus cuentas.");
    if (!["browser", "device"].includes(method) || method === "device" && role !== "auditor") throw new Error("Método de acceso no válido.");
    if (this.jobs.has(role)) return this.snapshot({ local: true });
    // Finish an earlier status query before starting a login for the same provider.
    await this.probes.get(role);
    if (this.jobs.has(role)) return this.snapshot({ local: true });
    const cli = this.find(role);
    if (!cli) throw new Error(`Instala ${names[role]} en esta PC antes de conectar.`);
    const args = role === "coder" ? ["auth", "login", "--claudeai"] : ["login", ...method === "device" ? ["--device-auth"] : []];
    const child = this.spawnLogin(cli.command, [...cli.args, ...args], {
      shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NO_COLOR: "1" }
    });
    const job = { child, method, url: null, deviceCode: null, acceptsCode: false, buffer: "", timer: null };
    this.jobs.set(role, job);
    this.providers[role] = { installed: true, connected: false, status: "pending", message: "Esperando autorización." };
    const consume = chunk => {
      job.buffer = (job.buffer + stripAnsi(chunk)).slice(-32000);
      for (const match of job.buffer.matchAll(/https:\/\/[^\s<>"']+/g)) {
        const valid = authUrl(role, match[0].replace(/[),.;]+$/, ""));
        if (valid) job.url = valid;
      }
      if (role === "auditor" && method === "device") {
        const match = job.buffer.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/);
        if (match) job.deviceCode = match[0];
      }
      if (role === "coder" && /paste.{0,80}code|enter.{0,40}(?:authorization|authentication) code/i.test(job.buffer)) job.acceptsCode = true;
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.stdin.on("error", () => {});
    const complete = async code => {
      if (this.jobs.get(role) !== job) return;
      clearTimeout(job.timer);
      this.jobs.delete(role);
      job.buffer = "";
      this.checkedAt[role] = 0;
      if (this.closed) return;
      await this.probe(role, true);
      if (code !== 0 && !this.providers[role].connected && !this.jobs.has(role)) this.providers[role] = { installed: true, connected: false, status: "error", message: "El acceso no se completó. Vuelve a conectar o consulta las instrucciones." };
    };
    child.once("error", () => void complete(-1));
    child.once("close", code => void complete(code));
    job.timer = setTimeout(() => void this.cancel(role, true), this.timeoutMs);
    job.timer.unref?.();
    return this.snapshot({ local: true });
  }
  submitCode(role, code) {
    this.validate(role);
    const job = this.jobs.get(role);
    if (role !== "coder" || !job?.acceptsCode || !job.child.stdin.writable) throw new Error("No hay un código pendiente para este proveedor.");
    if (typeof code !== "string" || !/^[A-Za-z0-9._~#/+%=-]{8,4096}$/.test(code.trim())) throw new Error("Pega solamente el código de autorización que muestra Claude.");
    job.child.stdin.write(code.trim() + "\n");
    job.acceptsCode = false;
    return this.snapshot({ local: true });
  }
  async cancel(role, expired = false) {
    this.validate(role);
    const job = this.jobs.get(role);
    if (job) {
      this.jobs.delete(role);
      clearTimeout(job.timer);
      job.buffer = "";
      await this.stop(job.child);
      this.checkedAt[role] = 0;
      this.providers[role] = { installed: true, connected: false, status: "disconnected", message: expired ? "El acceso venció. Inicia una nueva conexión." : "Acceso cancelado. Puedes volver a conectar." };
    }
    return this.snapshot({ local: true });
  }
  async close() {
    this.closed = true;
    for (const controller of this.controllers) controller.abort();
    await Promise.all([...this.jobs.values()].map(job => {
      clearTimeout(job.timer);
      job.buffer = "";
      return this.stop(job.child);
    }));
    this.jobs.clear();
  }
}
