import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DEFAULT_SETTINGS, validateProject, validateSettings, validateReview } from "./config.mjs";
import { CliAgents, DemoAgents, gitEvidence, runChecks } from "./agents.mjs";
import { directorPrompt, coderPrompt, chatPrompt } from "./prompts.mjs";
const LIVE = /* @__PURE__ */ new Set(["running", "pausing"]);
export class Coordinator extends EventEmitter {
  constructor(store, { demo = false, agents, checks = runChecks, evidence = gitEvidence } = {}) {
    super();
    this.store = store;
    this.demo = demo;
    this.agents = agents ?? (demo ? new DemoAgents() : new CliAgents());
    this.checks = checks;
    this.evidence = evidence;
    this.projects = store.read("projects.json", []);
    this.settings = validateSettings(store.read("settings.json", DEFAULT_SETTINGS));
    this.runs = store.read("runs.json", []);
    for (const run of this.runs) if (run.settings) {
      run.settings.accessMode ??= this.settings.accessMode;
      run.settings.language ??= this.settings.language;
    }
    this.events = store.read("events.json", []);
    this.messages = store.read("messages.json", []);
    for (const message of this.messages) if (message.status === "processing") {
      message.status = "interrupted";
      message.error = "La consulta se interrumpió al cerrar Automata. Puedes enviarla de nuevo.";
      delete message.activeRole;
    }
    this.busy = false;
    this.controller = null;
    this.chatController = null;
    this.chatQueue = this.messages.filter((m) => m.status === "queued").map((message) => ({ message, project: this.projects.find((p) => p.id === message.projectId) })).filter((m) => m.project);
    this.active = this.runs.find((r) => LIVE.has(r.status) || ["paused", "interrupted", "error", "blocked", "limit", "stopped"].includes(r.status)) ?? null;
    for (const run of this.runs) if (LIVE.has(run.status)) {
      run.status = "interrupted";
      if (run.stage === "code") {
        run.stage = "checks";
        run.coderReport = "La ejecución anterior se interrumpió. Inspecciona el trabajo parcial antes de dar la siguiente instrucción.";
      }
    }
    this.persist();
  }
  persist() {
    for (const [name, data] of Object.entries({ projects: this.projects, settings: this.settings, runs: this.runs, events: this.events.slice(-700), messages: this.messages.slice(-200) })) this.store.write(`${name}.json`, data);
  }
  snapshot() {
    return { projects: this.projects, settings: this.settings, runs: this.runs.map(({ baseline, coderReport, nextPrompt, ...r }) => r), activeId: this.active?.id ?? null, events: this.events.slice(-250), messages: this.messages.slice(-100), demo: this.demo, busy: this.busy };
  }
  notify() {
    this.emit("state", this.snapshot());
  }
  event(event) {
    const item = { id: randomUUID(), at: (/* @__PURE__ */ new Date()).toISOString(), runId: this.active?.id ?? null, projectId: this.active?.projectId ?? null, ...event };
    if (item.text) item.text = item.text.slice(0, 18e3);
    this.events.push(item);
    this.events = this.events.slice(-700);
    this.store.write("events.json", this.events);
    this.emit("event", item);
    return item;
  }
  addProject(input) {
    if (this.demo) throw new Error("En demostración usa el proyecto de ejemplo. Reinicia sin --demo para agregar tus proyectos.");
    const p = { ...validateProject(input), id: randomUUID(), createdAt: (/* @__PURE__ */ new Date()).toISOString() };
    this.projects.push(p);
    this.persist();
    this.notify();
    return p;
  }
  seedDemo() {
    if (!this.demo) return;
    const dir = path.join(this.store.directory, "demo-project");
    fs.mkdirSync(dir, { recursive: true });
    if (!this.projects.some((p) => p.id === "demo")) this.projects.push({ id: "demo", name: "Hola, Automata", directory: dir, objective: "Crear un saludo sencillo y verificarlo con una prueba automatizada.", criteria: ["El saludo incluye el nombre y la prueba pasa."], checks: ["node --test"], constraints: "Solo modificar el proyecto de demostración. No llamar a servicios de AI.", createdAt: (/* @__PURE__ */ new Date()).toISOString() });
    this.persist();
  }
  updateSettings(input) {
    const previousAccess = this.settings.accessMode;
    this.settings = validateSettings(input);
    if (this.active?.settings) this.active.settings.language = this.settings.language;
    if (previousAccess !== this.settings.accessMode && this.active?.settings && this.active.status !== "complete") {
      this.active.settings.accessMode = this.settings.accessMode;
      this.event({ role: "system", kind: "phase", text: `Permisos para la siguiente operación: acceso ${this.settings.accessMode === "full" ? "completo" : "limitado"}.` });
    }
    this.persist();
    this.notify();
    return this.settings;
  }
  start(projectId) {
    if (this.busy || this.active && ["paused", "interrupted", ...LIVE].includes(this.active.status)) throw new Error("Continúa o detén el trabajo actual antes de iniciar otro.");
    const p = this.projects.find((p2) => p2.id === projectId);
    if (!p) throw new Error("Selecciona un proyecto.");
    validateProject(p);
    const run = { id: randomUUID(), projectId: p.id, project: { ...p }, settings: { ...this.settings }, status: "running", stage: "plan", round: 0, createdAt: (/* @__PURE__ */ new Date()).toISOString(), updatedAt: (/* @__PURE__ */ new Date()).toISOString(), baseline: "", coderReport: "", nextPrompt: "", review: null, checks: [], tokens: 0, costUsd: 0 };
    this.runs.unshift(run);
    this.active = run;
    this.event({ role: "system", kind: "start", text: `${this.demo ? "Demostración · " : ""}Iniciando ${p.name}. El director preparará la primera tarea.` });
    this.persist();
    this.notify();
    this.launch();
    return run;
  }
  launch() {
    if (this.busy) throw new Error("Hay una ejecución activa.");
    this.busy = true;
    this.controller = new AbortController();
    this.active.status = "running";
    this.notify();
    this.pending = this.loop().catch((e) => {
      const r = this.active;
      if (e.name === "AbortError") {
        r.status = "stopped";
        if (r.stage === "code") {
          r.stage = "checks";
          r.coderReport = "Ejecución detenida por el usuario. Revisa el trabajo parcial.";
        }
      } else {
        r.status = "error";
        r.error = e.message;
        this.event({ role: "system", kind: "error", text: e.message });
      }
    }).finally(async () => {
      this.busy = false;
      this.controller = null;
      this.active.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.persist();
      this.notify();
      if (this.chatQueue.length) this.chatPending = this.drainChats();
    });
  }
  async boundary() {
    if (this.controller.signal.aborted) throw Object.assign(new Error("Detenido"), { name: "AbortError" });
    if (this.active.status === "pausing") {
      this.active.status = "paused";
      this.event({ role: "system", kind: "pause", text: "Trabajo pausado en un punto seguro. Puedes continuar desde aquí." });
      return false;
    }
    await this.drainChats(true);
    return !this.controller.signal.aborted;
  }
  async invoke(role, prompt, phase, dir) {
    const r = this.active;
    let watcher, projectChanged = false;
    if (role === "auditor" && phase === "review" && r.settings.accessMode !== "limited") {
      const storeRoot = path.resolve(this.store.directory).toLowerCase();
      const projectRoot = path.resolve(r.project.directory).toLowerCase();
      const nestedStore = storeRoot.startsWith(projectRoot + path.sep);
      try {
        watcher = fs.watch(r.project.directory, { recursive: true }, (_event, filename) => {
          const relative = String(filename ?? "");
          const target = path.resolve(r.project.directory, relative).toLowerCase();
          if (nestedStore && (target === storeRoot || target.startsWith(storeRoot + path.sep)) || /^(?:\.git|node_modules|\.automata)(?:[\\/]|$)/.test(relative)) return;
          projectChanged = true;
        });
        watcher.on("error", () => { projectChanged = true; });
      } catch {
        throw new Error("No se pudieron vigilar los cambios durante la auditoría con acceso completo.");
      }
    }
    let result;
    try {
      result = await this.agents.run({ role, prompt, phase, directory: dir, project: r.project, settings: { ...r.settings }, signal: this.controller.signal, emit: (e) => {
      if (e.model) {
        r.actualModels ??= {};
        r.actualModels[role] = e.model;
      }
      this.event(e);
      } });
      if (watcher) await new Promise(resolve => setTimeout(resolve, 50));
    } finally { watcher?.close(); }
    if (projectChanged) result = { ...result, projectChanged: true };
    if (result.usage) {
      const u = result.usage;
      r.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    if (Number.isFinite(result.cost)) r.costUsd += result.cost;
    if (result.sessionId) r[`${role}SessionId`] = result.sessionId;
    return result;
  }
  async loop() {
    const r = this.active, p = r.project, s = r.settings, root = this.store.runDir(r.id);
    if (!r.baseline) r.baseline = await this.evidence(p.directory);
    while (await this.boundary()) {
      const dir = path.join(root, `round-${String(r.round).padStart(2, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      if (r.stage === "plan" || r.stage === "review") {
        const phase = r.stage;
        this.event({ role: "auditor", kind: "phase", text: phase === "plan" ? "Voy a inspeccionar el proyecto y preparar una tarea verificable." : "Estoy contrastando el reporte con el código y las verificaciones." });
        const evidence = await this.evidence(p.directory);
        const prompt = directorPrompt(p, s, { phase, report: r.coderReport, evidence: `CAMBIOS PREVIOS:
${r.baseline}

ESTADO ACTUAL:
${evidence}

VERIFICACIONES:
${JSON.stringify(r.checks)}
${p.checks.length ? "" : "Sin verificaciones automáticas configuradas; exige evidencia explícita."}`, history: r.review?.summary });
        const result = await this.invoke("auditor", prompt, phase, dir);
        const review = validateReview(result.review, p, phase);
        if (result.projectChanged) {
          r.checks = [];
          r.checksRound = null;
          if (review.decision === "complete") {
            review.decision = "continue";
            review.nextPrompt = "El director modificó archivos durante la revisión. Inspecciona esos cambios, comprueba que cumplen el objetivo y deja una entrega revisable. Automata volverá a ejecutar las verificaciones antes de aprobar.";
            review.summary += " Se detectaron cambios durante la auditoría; falta una nueva ronda de verificación.";
          }
          this.event({ role: "system", kind: "warning", text: "El director cambió archivos. Se repetirán las verificaciones antes de aprobar." });
        }
        if (review.decision === "complete" && r.checks.some((c) => !c.passed)) throw new Error("El auditor intentó aprobar con verificaciones fallidas. Revisa la evidencia antes de continuar.");
        if (review.decision === "complete" && p.checks.length && (r.checksRound !== r.round || r.checks.length !== p.checks.length)) throw new Error("Faltan verificaciones de la ronda actual.");
        fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(review, null, 2));
        r.review = review;
        this.event({ role: "auditor", kind: "review", text: review.summary, review });
        if (review.decision === "complete") {
          r.status = "complete";
          r.stage = "complete";
          r.finishedAt = (/* @__PURE__ */ new Date()).toISOString();
          this.event({ role: "system", kind: "complete", text: "Objetivo completado con evidencia para todos los criterios." });
          break;
        }
        if (review.decision === "blocked") {
          r.status = "blocked";
          this.event({ role: "system", kind: "warning", text: "Se necesita tu intervención: " + review.summary });
          break;
        }
        r.nextPrompt = review.nextPrompt;
        r.stage = "code";
      } else if (r.stage === "code") {
        if (r.round >= s.maxRounds) {
          r.status = "limit";
          this.event({ role: "system", kind: "warning", text: `Se alcanzó el límite de ${s.maxRounds} rondas. El objetivo sigue pendiente.` });
          break;
        }
        r.round++;
        r.checks = [];
        r.checksRound = null;
        const work = path.join(root, `round-${String(r.round).padStart(2, "0")}`);
        fs.mkdirSync(work, { recursive: true });
        this.event({ role: "coder", kind: "phase", text: `Ronda ${r.round} · ${r.nextPrompt}` });
        const result = await this.invoke("coder", coderPrompt(p, s, r.nextPrompt, r.baseline), "code", work);
        r.coderReport = result.text;
        fs.writeFileSync(path.join(work, "coder-report.md"), r.coderReport);
        this.event({ role: "coder", kind: "report", text: r.coderReport });
        r.stage = "checks";
      } else if (r.stage === "checks") {
        r.checks = await this.checks(p, dir, this.controller.signal, (e) => this.event(e));
        r.checksRound = r.round;
        r.stage = "review";
      } else break;
      r.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.persist();
      this.notify();
    }
  }
  control(action) {
    if (action === "stop" && this.chatController) {
      this.chatController.abort();
      return { status: "stopping" };
    }
    const r = this.active;
    if (!r) throw new Error("No hay un trabajo activo.");
    if (action === "pause") {
      if (!LIVE.has(r.status)) throw new Error("No hay una ejecución que pausar.");
      r.status = "pausing";
      this.event({ role: "system", kind: "pause", text: "Pausa solicitada. Terminará la operación actual antes de detener el ciclo." });
    } else if (action === "stop") {
      this.controller?.abort();
      r.status = "stopped";
      this.event({ role: "system", kind: "stop", text: "Trabajo detenido. Los archivos existentes se conservan." });
    } else if (action === "resume") {
      if (this.busy) throw new Error("Espera a que termine la operación actual.");
      if (!["paused", "interrupted", "error", "blocked", "limit", "stopped"].includes(r.status)) throw new Error("Este trabajo no se puede continuar.");
      if (r.status === "limit") {
        if (this.settings.maxRounds <= r.round) throw new Error("Aumenta el límite de rondas antes de continuar.");
        r.settings.maxRounds = this.settings.maxRounds;
      }
      if (r.status === "error" && r.stage === "code") {
        r.stage = "checks";
        r.coderReport = "El codificador terminó con error. Revisa los archivos parciales y el registro de errores antes de reintentar.";
      }
      delete r.error;
      this.launch();
    } else throw new Error("Acción desconocida.");
    this.persist();
    this.notify();
    return r;
  }
  async sendChat({ projectId, target, text, kind = "question" }) {
    const p = this.projects.find((p2) => p2.id === projectId);
    if (!p) throw new Error("Selecciona un proyecto para conversar.");
    text = String(text ?? "").trim();
    if (!text || text.length > 12e3) throw new Error("Escribe un mensaje de hasta 12 000 caracteres.");
    if (!["coder", "auditor", "both"].includes(target) || !["task", "question", "instruction"].includes(kind)) throw new Error("Destino o tipo de mensaje no válido.");
    const message = { id: randomUUID(), projectId, target, text, kind, status: "queued", at: (/* @__PURE__ */ new Date()).toISOString() };
    this.messages.push(message);
    this.chatQueue.push({ message, project: p });
    this.persist();
    this.notify();
    if (!this.busy) this.chatPending = this.drainChats();
    return message;
  }
  async drainChats(withinRun = false) {
    if (!withinRun && this.busy) return;
    if (!withinRun) {
      this.busy = true;
      this.chatController = new AbortController();
      this.notify();
    }
    try {
      while (this.chatQueue.length) {
        const { message, project } = this.chatQueue.shift();
        message.status = "processing";
        message.startedAt = new Date().toISOString();
        this.persist();
        this.notify();
        if (message.kind === "instruction") {
          const run = this.active;
          if (!run || run.projectId !== project.id || ["complete", "stopped"].includes(run.status)) {
            message.status = "error";
            message.error = "Inicia o continúa un trabajo de este proyecto antes de enviar instrucciones.";
          } else {
            run.coderReport += `

INSTRUCCIÓN NUEVA DEL USUARIO (dirige la siguiente tarea sin cambiar los criterios):
${message.text}`;
            if (run.stage !== "checks") run.stage = "review";
            message.status = "delivered";
            message.answer = "Instrucción entregada al director. Se revisará antes de la siguiente tarea.";
          }
        } else {
          const roles = message.target === "both" ? ["coder", "auditor"] : [message.target];
          message.answers = [];
          for (const role of roles) {
            message.activeRole = role;
            this.persist();
            this.notify();
            try {
              const dir = path.join(this.store.directory, "chats", message.id, role);
              fs.mkdirSync(dir, { recursive: true });
              message.settings = { ...this.settings };
              const result = await this.agents.run({ role, phase: message.kind === "task" ? "task" : "chat", prompt: chatPrompt(project, role, message.text, this.runs.find((r) => r.projectId === project.id)?.review?.summary, message.settings, { kind: message.kind, previousAnswers: message.answers }), project, settings: message.settings, directory: dir, signal: withinRun ? this.controller.signal : this.chatController.signal, emit: (e) => this.event({ ...e, projectId: project.id }) });
              message.answers.push({ role, text: result.text });
            } catch (e) {
              message.answers.push({ role, text: e.message, error: true });
            }
            delete message.activeRole;
            this.persist();
            this.notify();
          }
          message.status = message.answers.some((a) => a.error) ? "error" : "answered";
          if (withinRun && message.kind === "task" && this.active?.projectId === project.id) {
            this.active.coderReport += `\n\nTAREA DIRECTA DEL USUARIO:\n${message.text}\nRESULTADO:\n${message.answers.map(answer => `${answer.role}: ${answer.text}`).join("\n")}`;
            if (this.active.stage === "review") {
              this.active.stage = "checks";
              this.active.checks = [];
              this.active.checksRound = null;
            }
          }
        }
        message.finishedAt = new Date().toISOString();
        this.persist();
        this.notify();
      }
    } finally {
      if (!withinRun) {
        this.busy = false;
        this.chatController = null;
        this.notify();
      }
    }
  }
  async close() {
    this.controller?.abort();
    this.chatController?.abort();
    await this.pending?.catch(() => {
    });
    await this.chatPending?.catch(() => {
    });
    this.persist();
  }
}
