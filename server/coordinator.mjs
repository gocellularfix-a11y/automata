import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DEFAULT_SETTINGS, validateProject, validateSettings, validateReview, teamOf, agentLabel, combineReviews } from "./config.mjs";
import { CliAgents, DemoAgents, gitEvidence, runChecks } from "./agents.mjs";
import { GitOps, normalizeGit, hasGitActions } from "./git.mjs";
import { directorPrompt, coderPrompt, chatPrompt } from "./prompts.mjs";
import { observe, digest } from "./watch.mjs";
import { AppRunner } from "./apprun.mjs";
import { MemoryStore, parseRemember, changedFiles } from "./memory.mjs";
const LIVE = /* @__PURE__ */ new Set(["running", "pausing"]);
// When checks fail the executor fixes them straight away; the director only steps in after this many tries.
const MAX_AUTO_FIXES = 3;
const tail = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? "…" + value.slice(-max) : value;
};
const fixPrompt = (task, failing) => `Las verificaciones automáticas fallaron. Corrige el código para que pasen, sin cambiar los criterios ni debilitar o borrar las pruebas, y vuelve a ejecutarlas.

TAREA ORIGINAL:
${task}

VERIFICACIONES FALLIDAS:
${failing.map((check) => `$ ${check.command ?? "(sin comando)"} → código ${check.code ?? "?"}\n${tail(check.output, 2500)}${check.stderr ? "\n" + tail(check.stderr, 800) : ""}`).join("\n\n")}`;
const gitView = ({ kind, message, branch, into, push }) => ({ kind, message, branch, into, push });
export class Coordinator extends EventEmitter {
  constructor(store, { demo = false, agents, checks = runChecks, evidence = gitEvidence, git, app, memory } = {}) {
    super();
    this.store = store;
    this.demo = demo;
    // One SQLite file per project, next to the rest of Automata's data and outside the project folder.
    this.memory = memory ?? new MemoryStore(path.join(store.directory, "memory"));
    this.agents = agents ?? (demo ? new DemoAgents() : new CliAgents());
    this.checks = checks;
    this.evidence = evidence;
    this.git = git ?? new GitOps();
    this.gitBusy = false;
    this.app = app ?? new AppRunner();
    // App output can arrive many times per second; the UI only needs a refresh now and then.
    this.app.on("change", () => {
      const st = this.app.state;
      if (st && st.status !== "running" && !st.announced) {
        st.announced = true;
        const text = st.status === "failed" ? `La app no pudo iniciar: ${st.error}` : st.status === "stopped" ? "App detenida." : `La app se cerró (código ${st.code}).`;
        this.event({ role: "system", kind: st.status === "exited" && st.code === 0 || st.status === "stopped" ? "stop" : "warning", text, runId: st.runId, projectId: st.projectId });
      }
      if (this.appTimer) return;
      this.appTimer = setTimeout(() => {
        this.appTimer = null;
        this.notify();
      }, 600);
      this.appTimer.unref?.();
    });
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
    clearTimeout(this.eventsTimer);
    this.eventsTimer = null;
    for (const [name, data] of Object.entries({ projects: this.projects, settings: this.settings, runs: this.runs, events: this.events.slice(-700), messages: this.messages.slice(-200) })) this.store.write(`${name}.json`, data);
  }
  snapshot() {
    return { projects: this.projects, settings: this.settings, runs: this.runs.map(({ baseline, coderReport, nextPrompt, sessions, watch, ...r }) => ({ ...r, watched: watch?.length ?? 0 })), activeId: this.active?.id ?? null, events: this.events.slice(-250), messages: this.messages.slice(-100), demo: this.demo, busy: this.busy, app: this.app.view() };
  }
  notify() {
    this.emit("state", this.snapshot());
  }
  event(event) {
    const item = { id: randomUUID(), at: (/* @__PURE__ */ new Date()).toISOString(), runId: this.active?.id ?? null, projectId: this.active?.projectId ?? null, ...event };
    if (item.text) item.text = item.text.slice(0, 18e3);
    this.events.push(item);
    this.events = this.events.slice(-700);
    // Agents emit many small events; rewriting the whole file for each one stalls everything else.
    if (!this.eventsTimer) {
      this.eventsTimer = setTimeout(() => {
        this.eventsTimer = null;
        this.store.write("events.json", this.events.slice(-700));
      }, 250);
      this.eventsTimer.unref?.();
    }
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
    if (this.active?.settings) {
      this.active.settings.language = this.settings.language;
      // Plan or API key is a property of this PC, not of a run.
      this.active.settings.planOnly = this.settings.planOnly;
    }
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
    const run = { id: randomUUID(), projectId: p.id, project: { ...p }, settings: JSON.parse(JSON.stringify(this.settings)), status: "running", stage: "plan", round: 0, createdAt: (/* @__PURE__ */ new Date()).toISOString(), updatedAt: (/* @__PURE__ */ new Date()).toISOString(), baseline: "", coderReport: "", nextPrompt: "", review: null, checks: [], tokens: 0, costUsd: 0, sessions: {}, gitQueue: [] };
    // A new run of the project replaces any question still open from an earlier one.
    for (const old of this.runs) if (old.projectId === p.id) for (const offer of old.runOffers ?? []) if (offer.status === "pending") offer.status = "superseded";
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
  // Memory helps the agents but must never stop the work: a failure is shown once and the run goes on.
  remember(action, fn) {
    try {
      return fn();
    } catch (error) {
      if (!this.memoryWarned) {
        this.memoryWarned = true;
        this.event({ role: "system", kind: "warning", text: `No se pudo ${action} la memoria del proyecto: ${error.message}` });
      }
      return null;
    }
  }
  memoryBrief(projectId, options) {
    return this.remember("leer", () => this.memory.brief(projectId, options))?.text ?? "";
  }
  // Facts an agent listed under «PARA RECORDAR:» at the end of its report.
  rememberReport(projectId, text, meta) {
    const items = parseRemember(text);
    if (items.length) this.remember("guardar", () => this.memory.applyAgentMemory(projectId, { add: items }, meta));
  }
  recordCommands(projectId, log, meta) {
    if (log?.length) this.remember("guardar", () => this.memory.recordCommands(projectId, { ...meta, log }));
  }
  // Read, add, correct, retire and restore what a project remembers (the Memory panel and the API).
  memoryAction(input = {}) {
    const p = this.projects.find((project) => project.id === input.projectId);
    if (!p) throw new Error("Selecciona un proyecto.");
    const m = this.memory, id = Number(input.id);
    switch (input.action ?? "list") {
      case "list": return { facts: m.listFacts(p.id, { status: ["active", "retired", "all"].includes(input.status) ? input.status : "active", q: input.q }), errors: m.listErrors(p.id, { q: input.q }), stats: m.stats(p.id) };
      case "brief": return m.brief(p.id, { query: String(input.q ?? "") });
      case "add": return { fact: m.addFact(p.id, { kind: input.kind, text: input.text, source: "user" }) };
      case "update": return { fact: m.updateFact(p.id, id, { text: input.text, kind: input.kind, by: "user" }) };
      case "retire": return { fact: m.setFactStatus(p.id, id, "retired", { reason: input.reason || "Retirado por el usuario", by: "user" }) };
      case "restore": return { fact: m.setFactStatus(p.id, id, "active", { by: "user" }) };
      case "history": return { history: m.history(p.id, id) };
      case "errorStatus": return { error: m.setErrorStatus(p.id, id, input.status) };
      default: throw new Error("Acción de memoria no válida.");
    }
  }
  pauseIfRequested() {
    if (this.active.status !== "pausing") return false;
    this.active.status = "paused";
    this.event({ role: "system", kind: "pause", text: "Trabajo pausado en un punto seguro. Puedes continuar desde aquí." });
    return true;
  }
  async boundary() {
    if (this.controller.signal.aborted) throw Object.assign(new Error("Detenido"), { name: "AbortError" });
    if (this.pauseIfRequested()) return false;
    await this.drainChats(true);
    // A pause requested while queued chats were running must not start another operation.
    if (this.controller.signal.aborted) return false;
    return !this.pauseIfRequested();
  }
  // prompts is a string or { full, short }: the short form is used when the agent's session is resumed.
  async invoke(role, prompts, phase, dir, index = 0) {
    const r = this.active;
    const team = teamOf(r.settings, role), member = team[index] ?? team[0];
    const sessionKey = `${role}:${index}`;
    const resume = r.settings.reuseSessions !== false ? r.sessions?.[sessionKey] ?? null : null;
    const full = typeof prompts === "string" ? prompts : prompts.full;
    const short = typeof prompts === "string" ? prompts : prompts.short ?? prompts.full;
    const agent = { ...member, index, count: team.length, label: agentLabel(role, team, index), resume };
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
    // This call's own commands, so failed builds and tests (and their fixes) reach the project memory once.
    const commands = role === "coder" ? [] : null;
    try {
      result = await this.agents.run({ role, prompt: resume ? short : full, fallbackPrompt: full, phase, directory: dir, project: r.project, settings: { ...r.settings }, agent, signal: this.controller.signal, emit: (e) => {
      if (e.model) {
        r.actualModels ??= {};
        r.actualModels[role] = e.model;
      }
      if (role === "coder") {
        observe(r.watch ??= [], e);
        observe(commands, e);
      }
      this.event(team.length > 1 ? { ...e, agent: agent.label } : e);
      } });
      if (watcher) await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      watcher?.close();
      this.recordCommands(r.projectId, commands, { runId: r.id, round: r.round, directory: r.project.directory });
    }
    if (projectChanged) result = { ...result, projectChanged: true };
    if (result.usage) {
      const u = result.usage;
      r.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    if (Number.isFinite(result.cost)) r.costUsd += result.cost;
    if (result.sessionId) {
      (r.sessions ??= {})[sessionKey] = result.sessionId;
      r[`${role}SessionId`] = result.sessionId;
    }
    return result;
  }
  gitNeedsApproval(mode, kind) {
    return mode === "ask-all" || mode === "ask-push" && (kind === "push" || kind === "merge");
  }
  queueGit(r, action) {
    r.gitQueue ??= [];
    const same = (item) => item.status === "pending" && item.kind === action.kind && item.branch === action.branch && item.message === action.message && item.into === action.into;
    if (r.gitQueue.some(same)) return null;
    const item = { id: randomUUID(), ...action, status: "pending", at: (/* @__PURE__ */ new Date()).toISOString(), round: r.round };
    r.gitQueue.push(item);
    return item;
  }
  // The director decides; these run as the executor's hands and show up in its terminal.
  async runGit(r, item) {
    const dir = r.project.directory, tag = { runId: r.id, projectId: r.projectId }, signal = this.controller?.signal;
    const onStep = (step) => {
      const toolId = randomUUID();
      this.event({ role: "coder", kind: "tool", toolId, tool: { name: "Bash", command: step.command, git: true }, text: step.command, ...tag });
      this.event({ role: "coder", kind: "toolresult", toolId, text: step.output, error: step.code !== 0, ...tag });
    };
    let result;
    try {
      if (item.kind === "branch") result = await this.git.branch(dir, item.branch, { onStep, signal });
      else if (item.kind === "commit") result = await this.git.commit(dir, item.message, { onStep, signal });
      else if (item.kind === "push") result = await this.git.push(dir, { onStep, signal });
      else {
        result = await this.git.merge(dir, item.into, { onStep, signal });
        if (result.ok && !result.noop && item.push) {
          const pushed = await this.git.push(dir, { onStep, signal });
          result = pushed.ok ? { ...result, summary: `${result.summary} y push` } : { ...pushed, error: `El merge se hizo, pero el push falló: ${pushed.error}` };
        }
      }
    } catch (error) {
      item.status = "failed";
      item.error = error.name === "AbortError" ? "Interrumpido." : error.message;
      throw error;
    }
    item.status = result.ok ? "done" : "failed";
    item.summary = result.summary;
    item.error = result.error;
    item.doneAt = (/* @__PURE__ */ new Date()).toISOString();
    if (result.ok && item.kind === "commit" && !result.noop) this.remember("guardar", () => this.memory.addFact(r.projectId, { kind: "progress", text: `${result.summary}: ${item.message}`, source: "automata", runId: r.id, round: item.round }));
    if (result.blocked?.length) this.event({ role: "system", kind: "warning", text: `Archivos sensibles excluidos del commit: ${result.blocked.join(", ")}`, ...tag });
    this.event({ role: "system", kind: result.ok ? "success" : "warning", text: result.ok ? result.summary : result.error, ...tag });
    this.persist();
    this.notify();
    return result.ok;
  }
  async applyGit(review) {
    const r = this.active, mode = r.settings.gitMode ?? "ask-push", decision = normalizeGit(review.git);
    review.git = decision;
    if (this.demo || mode === "off" || !hasGitActions(decision)) return;
    const info = await this.git.inspect(r.project.directory);
    if (!info.repo) {
      this.event({ role: "system", kind: "warning", text: "El director propuso acciones de Git, pero esta carpeta no es un repositorio." });
      return;
    }
    const actions = [];
    if (decision.branch) actions.push({ kind: "branch", branch: decision.branch });
    if (decision.commit) actions.push({ kind: "commit", message: decision.message });
    if (decision.push) actions.push({ kind: "push" });
    if (decision.mergeInto) actions.push({ kind: "merge", into: decision.mergeInto, push: decision.push });
    for (const action of actions) {
      const item = this.queueGit(r, action);
      if (!item) continue;
      if (this.gitNeedsApproval(mode, item.kind)) {
        this.event({ role: "auditor", kind: "approval", text: "Aprobación pendiente", gitId: item.id, git: gitView(item) });
        continue;
      }
      if (!await this.runGit(r, item)) break;
    }
    this.persist();
    this.notify();
  }
  async resolveGit(runId, gitId, decision) {
    const r = this.runs.find((run) => run.id === runId);
    const item = r?.gitQueue?.find((entry) => entry.id === gitId);
    if (!item) throw new Error("No se encontró esa operación de Git.");
    if (item.status !== "pending") throw new Error("Esa operación ya se resolvió.");
    if (!["approve", "reject"].includes(decision)) throw new Error("Decisión no válida.");
    if (decision === "reject") {
      item.status = "rejected";
      item.doneAt = (/* @__PURE__ */ new Date()).toISOString();
      this.event({ role: "system", kind: "warning", text: "Operación de Git rechazada.", runId: r.id, projectId: r.projectId });
      this.persist();
      this.notify();
      return item;
    }
    if (this.gitBusy) throw new Error("Hay otra operación de Git en curso.");
    // Pushing is safe while the executor works; committing, switching and merging are not.
    if (item.kind !== "push" && this.busy) throw new Error("Espera a que termine la operación actual.");
    this.gitBusy = true;
    try {
      await this.runGit(r, item);
    } finally {
      this.gitBusy = false;
      this.persist();
      this.notify();
    }
    return item;
  }
  // The director said the app can be opened: ask the user instead of running anything on our own.
  offerRun(r, review) {
    const run = review.run;
    if (!run?.ready || !run.command) return null;
    const final = review.decision === "complete";
    r.runOffers ??= [];
    const app = this.app.view();
    if (app?.status === "running" && app.projectId === r.projectId && app.command === run.command) return null;
    const pending = r.runOffers.find((offer) => offer.status === "pending");
    if (pending && pending.command === run.command && !final) return null;
    // Mid-run the user is asked once per command; once the goal is done they are asked again.
    if (!final && r.runOffers.some((offer) => offer.command === run.command)) return null;
    if (pending) pending.status = "superseded";
    const offer = { id: randomUUID(), command: run.command, url: run.url, note: run.note, final, status: "pending", round: r.round, at: (/* @__PURE__ */ new Date()).toISOString() };
    r.runOffers.push(offer);
    this.event({ role: "auditor", kind: "runoffer", text: final ? "Proyecto terminado. ¿Quieres correr la app?" : "La app ya se puede correr. ¿Quieres probarla?", offer: { command: offer.command, url: offer.url, note: offer.note } });
    return offer;
  }
  resolveRun(runId, offerId, decision) {
    const r = this.runs.find((run) => run.id === runId);
    const offer = r?.runOffers?.find((entry) => entry.id === offerId);
    if (!offer) throw new Error("No se encontró esa propuesta.");
    if (offer.status !== "pending") throw new Error("Esa propuesta ya se resolvió.");
    if (!["approve", "reject"].includes(decision)) throw new Error("Decisión no válida.");
    const tag = { runId: r.id, projectId: r.projectId };
    if (decision === "reject") {
      offer.status = "declined";
      this.event({ role: "system", kind: "pause", text: "La app no se corrió. Puedes pedirlo después en el chat.", ...tag });
    } else {
      this.app.start({ directory: r.project.directory, command: offer.command, url: offer.url, projectId: r.projectId, runId: r.id });
      offer.status = "started";
      this.event({ role: "system", kind: "start", text: `Corriendo la app · ${offer.command}`, ...tag });
    }
    offer.doneAt = (/* @__PURE__ */ new Date()).toISOString();
    this.persist();
    this.notify();
    return offer;
  }
  async appControl(action) {
    if (action === "stop") await this.app.stop();
    else if (action === "dismiss") this.app.dismiss();
    else throw new Error("Acción desconocida.");
    this.notify();
    return this.app.view();
  }
  async loop() {
    const r = this.active, p = r.project, s = r.settings, root = this.store.runDir(r.id);
    if (!r.baseline) r.baseline = await this.evidence(p.directory);
    while (await this.boundary()) {
      const dir = path.join(root, `round-${String(r.round).padStart(2, "0")}`);
      fs.mkdirSync(dir, { recursive: true });
      if (r.stage === "plan" || r.stage === "review") {
        const phase = r.stage;
        const failing = r.checks.filter((c) => !c.passed);
        if (phase === "review" && s.fastFix !== false && !r.forceDirector && failing.length && (r.autoFixes ?? 0) < MAX_AUTO_FIXES) {
          // Red checks do not need the director's judgement: send the failures straight back to the executor.
          r.autoFixes = (r.autoFixes ?? 0) + 1;
          r.baseTask ??= r.nextPrompt;
          r.nextPrompt = fixPrompt(r.baseTask, failing);
          r.stage = "code";
          this.event({ role: "system", kind: "phase", text: `Verificaciones fallidas: el ejecutor corrige directamente (${r.autoFixes}/${MAX_AUTO_FIXES}).` });
          r.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
          this.persist();
          this.notify();
          continue;
        }
        if (phase === "review") {
          r.autoFixes = 0;
          r.forceDirector = false;
        }
        this.event({ role: "auditor", kind: "phase", text: phase === "plan" ? "Voy a inspeccionar el proyecto y preparar una tarea verificable." : "Estoy contrastando el reporte con el código y las verificaciones." });
        const evidence = await this.evidence(p.directory);
        const gitInfo = this.demo || s.gitMode === "off" ? null : await this.git.inspect(p.directory);
        const state = `ESTADO ACTUAL:
${evidence}

VERIFICACIONES:
${JSON.stringify(r.checks)}
${p.checks.length ? "" : "Sin verificaciones automáticas configuradas; exige evidencia explícita."}`;
        const evidenceFull = `CAMBIOS PREVIOS:
${r.baseline}

${state}`;
        // The first director plans. Reviewers take turns after that: each one only runs if the previous
        // approved, because a single "continue" or "blocked" already decides the round.
        const team = teamOf(s, "auditor"), reviewers = phase === "plan" ? 1 : team.length;
        const reviews = [];
        let projectChanged = false;
        // Everything the coder did since the last review, as the director "saw" it happen.
        const watched = r.watch?.length ?? 0, watch = digest(r.watch, p.directory);
        if (watched) fs.writeFileSync(path.join(dir, "watch.txt"), watch);
        // What earlier sessions learned, filtered by what is on the table now.
        const memory = this.memoryBrief(p.id, { query: `${r.coderReport}\n${r.nextPrompt}\n${p.objective}`, failing });
        if (memory) fs.writeFileSync(path.join(dir, "memory.txt"), memory);
        for (let i = 0; i < reviewers; i++) {
          const reviewDir = i === 0 ? dir : path.join(dir, `reviewer-${i + 1}`);
          fs.mkdirSync(reviewDir, { recursive: true });
          const options = { phase, report: r.coderReport, history: r.review?.summary, team: reviewers > 1 ? { index: i, count: reviewers } : null, git: { mode: s.gitMode ?? "ask-push", info: gitInfo }, watch, memory };
          const prompts = { full: directorPrompt(p, s, { ...options, evidence: evidenceFull }), short: directorPrompt(p, s, { ...options, evidence: state, short: true }) };
          const result = await this.invoke("auditor", prompts, phase, reviewDir, i);
          reviews.push(validateReview(result.review, p, phase));
          this.remember("guardar", () => this.memory.applyAgentMemory(p.id, reviews[i].memory, { source: "director", runId: r.id, round: r.round }));
          projectChanged ||= !!result.projectChanged;
          if (reviews[i].decision !== "complete" || projectChanged) break;
        }
        const review = reviewers > 1 ? combineReviews(reviews, reviews.map((_, i) => agentLabel("auditor", team, i))) : reviews[0];
        if (projectChanged) {
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
        review.git = normalizeGit(review.git);
        fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(review, null, 2));
        r.review = review;
        this.remember("guardar", () => this.memory.recordReview(p.id, { review, runId: r.id, round: r.round, criteria: p.criteria }));
        // The director has seen it: the next review only gets what happens from here on.
        r.watch = (r.watch ?? []).slice(watched);
        this.event({ role: "auditor", kind: "review", text: review.summary, review });
        if (review.decision !== "blocked") await this.applyGit(review);
        if (review.decision !== "blocked") this.offerRun(r, review);
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
        r.baseTask = review.nextPrompt;
        r.stage = "code";
      } else if (r.stage === "code") {
        if (r.round >= s.maxRounds) {
          r.status = "limit";
          this.event({ role: "system", kind: "warning", text: `Se alcanzó el límite de ${s.maxRounds} rondas. El objetivo sigue pendiente.` });
          break;
        }
        const failingBefore = r.checks.filter((c) => !c.passed);
        r.round++;
        r.checks = [];
        r.checksRound = null;
        const work = path.join(root, `round-${String(r.round).padStart(2, "0")}`);
        fs.mkdirSync(work, { recursive: true });
        // Coders take turns by round: round 1 uses the first, round 2 the second, and so on.
        const coders = teamOf(s, "coder"), turn = (r.round - 1) % coders.length;
        const teamInfo = coders.length > 1 ? { index: turn, count: coders.length } : null;
        this.event({ role: "coder", kind: "phase", text: `Ronda ${r.round} · ${r.nextPrompt}`, ...coders.length > 1 ? { agent: agentLabel("coder", coders, turn) } : {} });
        // A failure that already happened before comes with the solution that fixed it then.
        const memory = this.memoryBrief(p.id, { query: r.nextPrompt, failing: failingBefore });
        if (memory) fs.writeFileSync(path.join(work, "memory.txt"), memory);
        const prompts = { full: coderPrompt(p, s, r.nextPrompt, r.baseline, teamInfo, false, memory), short: coderPrompt(p, s, r.nextPrompt, r.baseline, teamInfo, true, memory) };
        const result = await this.invoke("coder", prompts, "code", work, turn);
        r.coderReport = result.text;
        fs.writeFileSync(path.join(work, "coder-report.md"), r.coderReport);
        this.event({ role: "coder", kind: "report", text: r.coderReport });
        this.rememberReport(p.id, r.coderReport, { source: "coder", runId: r.id, round: r.round });
        r.stage = "checks";
      } else if (r.stage === "checks") {
        r.checks = await this.checks(p, dir, this.controller.signal, (e) => this.event(e));
        r.checksRound = r.round;
        // Failing checks become open errors; a check that passes again resolves them with what changed.
        const recorded = this.remember("guardar", () => this.memory.recordChecks(p.id, { runId: r.id, round: r.round, checks: r.checks, files: changedFiles(r.watch, p.directory), report: r.coderReport }));
        if (recorded?.recurred.length) this.event({ role: "system", kind: "warning", text: `Este error ya había pasado en este proyecto (${recorded.recurred.map((id) => "E" + id).join(", ")}). La solución anterior va en la siguiente instrucción.` });
        if (recorded?.resolved.length) this.event({ role: "system", kind: "success", text: `Memoria: ${recorded.resolved.length === 1 ? "un error quedó registrado" : `${recorded.resolved.length} errores quedaron registrados`} con su solución verificada.` });
        r.stage = "review";
      } else break;
      r.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      this.persist();
      this.notify();
    }
  }
  control(action, runId) {
    if (action === "stop" && this.chatController) {
      this.chatController.abort();
      return { status: "stopping" };
    }
    // The UI acts on the run it is showing, which is not necessarily the last one started
    // (a stopped run of another project stays resumable).
    if (runId !== undefined && runId !== this.active?.id && !this.busy) {
      const target = this.runs.find((run) => run.id === runId);
      if (!target) throw new Error("No hay un trabajo activo.");
      this.active = target;
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
            // The user is talking to the director: do not let the quick fix loop bypass them.
            run.forceDirector = true;
            message.status = "delivered";
            message.answer = "Instrucción entregada al director. Se revisará antes de la siguiente tarea.";
          }
        } else {
          // A task for the director is a hand-off: the director (read-only) decides what to change, then the executor writes it.
          const handoff = message.kind === "task" && message.target === "auditor";
          const roles = message.target === "both" ? ["coder", "auditor"] : handoff ? ["auditor", "coder"] : [message.target];
          message.answers = [];
          for (const role of roles) {
            message.activeRole = role;
            this.persist();
            this.notify();
            const commands = role === "coder" ? [] : null;
            try {
              const dir = path.join(this.store.directory, "chats", message.id, role);
              fs.mkdirSync(dir, { recursive: true });
              message.settings = { ...this.settings };
              const memory = this.memoryBrief(project.id, { query: message.text });
              const result = await this.agents.run({ role, phase: message.kind === "task" ? "task" : "chat", prompt: chatPrompt(project, role, message.text, this.runs.find((r) => r.projectId === project.id)?.review?.summary, message.settings, { kind: message.kind, previousAnswers: message.answers, memory }), project, settings: message.settings, directory: dir, signal: withinRun ? this.controller.signal : this.chatController.signal, emit: (e) => {
                // Work asked from the chat also goes in front of the director's eyes.
                if (e.role === "coder" && this.active?.projectId === project.id && this.active.status !== "complete") observe(this.active.watch ??= [], e);
                if (commands && e.role === "coder") observe(commands, e);
                this.event({ ...e, projectId: project.id });
              } });
              message.answers.push({ role, text: result.text });
              this.rememberReport(project.id, result.text, { source: role === "coder" ? "coder" : "director", runId: null, round: null });
            } catch (e) {
              message.answers.push({ role, text: e.message, error: true });
            } finally {
              this.recordCommands(project.id, commands, { runId: null, round: null, directory: project.directory });
            }
            delete message.activeRole;
            this.persist();
            this.notify();
            if (handoff && message.answers.at(-1)?.error) break;
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
    await this.app.stop().catch(() => {
    });
    clearTimeout(this.appTimer);
    await this.pending?.catch(() => {
    });
    await this.chatPending?.catch(() => {
    });
    this.persist();
  }
}
