import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DEFAULT_SETTINGS, validateProject, validateSettings, validateReview, invalidReview, validateProposal, projectsRootOf, teamOf, agentLabel, combineReviews } from "./config.mjs";
import { AUTOMATA_ROOT } from "./safety.mjs";
import { slugify, freeFolder } from "./github.mjs";
import { CliAgents, DemoAgents, gitEvidence, runChecks } from "./agents.mjs";
import { GitOps, normalizeGit, hasGitActions } from "./git.mjs";
import { directorPrompt, coderPrompt, chatPrompt, reviewFixPrompt, continuationPrompt, proposalPrompt } from "./prompts.mjs";
import { observe, digest } from "./watch.mjs";
import { AppRunner } from "./apprun.mjs";
import { MemoryStore, parseRemember, changedFiles, staleMentions, shallowNames } from "./memory.mjs";
import { PlanStore, invalidPlan } from "./plan.mjs";
import { isCasual, casualAnswer } from "./chat.mjs";
import { classifyError, planWait, describeWait, agentName, DEFAULT_BACKOFF, MAX_REVIEW_FIXES, MAX_LIMIT_WAITS } from "./recovery.mjs";
const LIVE = /* @__PURE__ */ new Set(["running", "pausing"]);
// Statuses the user can continue from. "waiting" continues on its own; Continuar just skips the wait.
const RESUMABLE = ["paused", "interrupted", "error", "blocked", "limit", "stopped", "waiting"];
// When checks fail the executor fixes them straight away; the director only steps in after this many tries.
const MAX_AUTO_FIXES = 3;
const now = () => (/* @__PURE__ */ new Date()).toISOString();
const tail = (text, max) => {
  const value = String(text ?? "");
  return value.length > max ? "…" + value.slice(-max) : value;
};
const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? value.slice(0, max - 1) + "…" : value;
};
const fixPrompt = (task, failing) => `Las verificaciones automáticas fallaron. Corrige el código para que pasen, sin cambiar los criterios ni debilitar o borrar las pruebas, y vuelve a ejecutarlas.

TAREA ORIGINAL:
${task}

VERIFICACIONES FALLIDAS:
${failing.map((check) => `$ ${check.command ?? "(sin comando)"} → código ${check.code ?? "?"}\n${tail(check.output, 2500)}${check.stderr ? "\n" + tail(check.stderr, 800) : ""}`).join("\n\n")}`;
const gitView = ({ kind, message, branch, into, push }) => ({ kind, message, branch, into, push });
// A stored result of an interrupted operation: read back only if it belongs to the attempt that was in flight.
function completedAttempt(inflight) {
  if (!inflight?.id || !inflight.dir || !inflight.phase) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(inflight.dir, `${inflight.phase}-result.json`), "utf8"));
    return saved.attemptId === inflight.id ? saved : null;
  } catch {
    return null;
  }
}
export class Coordinator extends EventEmitter {
  constructor(store, { demo = false, agents, checks = runChecks, evidence = gitEvidence, git, app, memory, backoff, beforeResume = null, resumeDelayMs = 1500 } = {}) {
    super();
    this.store = store;
    this.demo = demo;
    // One SQLite file per project, next to the rest of Automata's data and outside the project folder.
    this.memory = memory ?? new MemoryStore(path.join(store.directory, "memory"));
    // The project plan lives in the same file as the memory (P2).
    this.plan = new PlanStore(this.memory);
    this.planStats = {};
    this.agents = agents ?? (demo ? new DemoAgents() : new CliAgents());
    this.checks = checks;
    this.evidence = evidence;
    this.git = git ?? new GitOps();
    this.gitBusy = false;
    this.app = app ?? new AppRunner();
    // Waits between retries; tests shorten them.
    this.backoff = backoff ?? DEFAULT_BACKOFF;
    // Called before a run resumes on its own (the server checks that both accounts are connected).
    this.beforeResume = beforeResume;
    this.resumeDelayMs = resumeDelayMs;
    this.waitTimer = null;
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
    // Ideas turned into project proposals (P3); a proposal being drafted when Automata closed can be retried.
    this.proposals = store.read("proposals.json", []);
    for (const proposal of this.proposals) if (["drafting", "accepting"].includes(proposal.status)) { proposal.status = proposal.draft ? "ready" : "error"; proposal.error = proposal.draft ? null : "Automata se cerró mientras se preparaba la propuesta. Vuelve a enviarla."; }
    this.busy = false;
    this.controller = null;
    this.chatController = null;
    this.toResume = [];
    this.restoreMessages();
    this.chatQueue = this.messages.filter((m) => m.status === "queued").map((message) => ({ message, project: this.projects.find((p) => p.id === message.projectId) })).filter((m) => m.project);
    this.active = this.runs.find((r) => LIVE.has(r.status) || r.status === "waiting" || RESUMABLE.includes(r.status)) ?? null;
    this.restoreRuns();
    this.persist();
  }
  // Automata closed while runs were in progress: keep what finished, continue what did not.
  restoreRuns() {
    for (const run of this.runs) {
      for (const item of run.gitQueue ?? []) if (item.status === "pending" && item.startedAt) {
        // The command was running when Automata closed: a push or merge may or may not have happened.
        item.status = "uncertain";
        item.error = "Automata se cerró mientras se ejecutaba. Comprueba el resultado en el repositorio antes de repetirla.";
        item.doneAt = now();
      }
      // Closing Automata is not pressing Stop: a run cut by the shutdown is picked up again.
      const closed = run.status === "interrupted" && run.interruptedBy === "close";
      if (!LIVE.has(run.status) && run.status !== "waiting" && !closed) continue;
      delete run.interruptedBy;
      const wasWaiting = run.status === "waiting", stageAtShutdown = run.stage;
      const saved = completedAttempt(run.inflight);
      run.recovery ??= { attempts: {}, log: [], waits: 0 };
      run.recovery.log.push({ at: now(), kind: "shutdown", stage: stageAtShutdown, round: run.round, completed: !!saved, waiting: wasWaiting ? run.waiting?.kind ?? null : null });
      run.recovery.log = run.recovery.log.slice(-60);
      if (saved) {
        // The agent finished and Automata closed before noting it: the result is reused, not repeated.
        run.inflight = { ...run.inflight, completed: saved };
      } else {
        run.inflight = null;
        if (run.stage === "code" && !wasWaiting) {
          run.stage = "checks";
          run.codeStarted = null;
          delete run.continuation;
          run.coderReport = "La ejecución anterior se interrumpió. Inspecciona el trabajo parcial antes de dar la siguiente instrucción.";
        }
      }
      this.remember("guardar", () => this.memory.addFact(run.projectId, { kind: "recovery", text: `Automata se cerró durante la etapa ${stageAtShutdown} de la ronda ${run.round}${saved ? "; el resultado del agente se recuperó sin repetir la operación" : stageAtShutdown === "code" && !wasWaiting ? "; el trabajo parcial de Claude pasó a verificación" : ""}${wasWaiting ? "; estaba esperando para reintentar" : ""}.`, source: "automata", runId: run.id, round: run.round }));
      if (this.settings.autoResume) {
        // Waiting runs keep their appointment; interrupted ones continue shortly after startup.
        if (wasWaiting && run.waiting?.resumeAt) this.toResume.push({ run, at: run.waiting.resumeAt });
        else {
          run.status = "interrupted";
          delete run.waiting;
          run.resumeAt = null;
          this.toResume.push({ run, at: null });
        }
      } else {
        run.status = "interrupted";
        delete run.waiting;
        run.resumeAt = null;
      }
    }
  }
  // A message that was being answered when Automata closed is queued again once, keeping the answers
  // it already got. A second interruption leaves it for the user.
  restoreMessages() {
    for (const message of this.messages) {
      if (message.status !== "processing") continue;
      const saved = completedAttempt(message.inflight);
      if (saved && message.inflight?.role && !(message.answers ?? []).some((a) => a.role === message.inflight.role)) {
        (message.answers ??= []).push({ role: message.inflight.role, text: saved.text, recovered: true });
      }
      message.inflight = null;
      delete message.activeRole;
      if (this.settings.autoResume && !(message.requeued > 0)) {
        message.requeued = 1;
        message.status = "queued";
        message.note = "Automata se cerró mientras se procesaba. Se retoma sin repetir lo ya respondido.";
      } else {
        message.status = "interrupted";
        message.error = "La consulta se interrumpió al cerrar Automata. Puedes enviarla de nuevo.";
      }
    }
  }
  // Continues what the shutdown left behind, if the user allows it. The server calls this once it listens.
  startAutoResume() {
    const planned = this.toResume;
    this.toResume = [];
    if (!this.settings.autoResume) return;
    const target = planned.find((item) => item.run === this.active) ?? planned[0];
    if (target) {
      const r = target.run;
      if (target.at) {
        this.active = r;
        this.event({ role: "system", kind: "wait", text: describeWait(r.waiting, this.settings.language), runId: r.id, projectId: r.projectId });
        this.scheduleWait(r);
      } else {
        const timer = setTimeout(() => void this.resumeNow(r, "startup"), this.resumeDelayMs);
        timer.unref?.();
      }
    } else if (this.chatQueue.length && !this.busy) this.chatPending = this.drainChats();
  }
  persist() {
    clearTimeout(this.eventsTimer);
    this.eventsTimer = null;
    for (const [name, data] of Object.entries({ projects: this.projects, settings: this.settings, runs: this.runs, events: this.events.slice(-700), messages: this.messages.slice(-200), proposals: this.proposals })) this.store.write(`${name}.json`, data);
  }
  // Plan counts per project, cached until the plan changes (the snapshot is built often).
  planStatsFor(projectId) {
    if (!this.planStats[projectId]) {
      const p = this.projects.find((project) => project.id === projectId);
      this.planStats[projectId] = this.remember("leer", () => this.plan.stats(projectId, p?.criteria ?? [])) ?? { total: 0, active: 0, done: 0, byCriterion: [] };
    }
    return this.planStats[projectId];
  }
  planChanged(projectId) {
    delete this.planStats[projectId];
  }
  // Context and output per agent for the whole run, from the per-call log.
  usageSummary(r) {
    const summary = { coder: { calls: 0, context: 0, output: 0 }, auditor: { calls: 0, context: 0, output: 0 }, refreshes: (r.sessionLog ?? []).length };
    for (const item of r.usageLog ?? []) {
      const s = summary[item.role] ?? (summary[item.role] = { calls: 0, context: 0, output: 0 });
      s.calls++;
      s.context += item.context;
      s.output += item.output;
    }
    return summary;
  }
  snapshot() {
    return { projects: this.projects, settings: this.settings, runs: this.runs.map((run) => { const { baseline, coderReport, nextPrompt, sessions, watch, inflight, continuation, usageLog, ...r } = run; return { ...r, watched: watch?.length ?? 0, usage: this.usageSummary(run) }; }), activeId: this.active?.id ?? null, events: this.events.slice(-250), messages: this.messages.slice(-100).map(({ inflight, ...m }) => m), proposals: this.proposals.filter((p) => p.status !== "discarded").slice(-10).map((p) => this.proposalView(p)), demo: this.demo, busy: this.busy, app: this.app.view(), plans: Object.fromEntries(this.projects.map((p) => [p.id, this.planStatsFor(p.id)])) };
  }
  notify() {
    this.emit("state", this.snapshot());
  }
  event(event) {
    const item = { id: randomUUID(), at: now(), runId: this.active?.id ?? null, projectId: this.active?.projectId ?? null, ...event };
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
  // Where projects may live (safety.mjs). The demo project lives inside Automata's data on purpose.
  safetyContext() {
    return this.demo ? null : { automataRoot: AUTOMATA_ROOT, dataDir: this.store.directory, projectsRoot: projectsRootOf(this.settings) };
  }
  addProject(input, extra = {}) {
    if (this.demo) throw new Error("En demostración usa el proyecto de ejemplo. Reinicia sin --demo para agregar tus proyectos.");
    const p = { ...validateProject(input, { safety: this.safetyContext() }), ...extra, id: randomUUID(), createdAt: now() };
    this.projects.push(p);
    this.persist();
    this.notify();
    return p;
  }
  // ---- From an idea to a project: the director proposes, the person approves once ----
  proposalView(proposal) {
    const { sessionId, ...rest } = proposal;
    return rest;
  }
  environment() {
    return `Windows, Node.js ${process.versions.node}, Git y PowerShell. Sin otros lenguajes instalados garantizados, sin cuentas de servicios y sin publicar en Internet.`;
  }
  // Starts (or adjusts) a proposal. The director works read-only in an empty scratch folder.
  propose({ idea, adjustments = "", id = null } = {}) {
    idea = String(idea ?? "").trim();
    adjustments = String(adjustments ?? "").trim().slice(0, 4000);
    let proposal = id ? this.proposals.find((p) => p.id === id) : null;
    if (id && !proposal) throw new Error("No se encontró esa propuesta.");
    if (proposal && ["accepted", "drafting"].includes(proposal.status)) throw new Error(proposal.status === "accepted" ? "Esa propuesta ya se convirtió en proyecto." : "La propuesta todavía se está preparando.");
    if (!proposal) {
      if (idea.length < 8 || idea.length > 4000) throw new Error("Describe tu idea en una o dos frases.");
      // "Buen trabajo" is not an idea: nothing starts.
      if (isCasual(idea)) throw new Error("Eso no parece una idea de proyecto. Cuéntame qué quieres crear, por ejemplo: «Quiero una aplicación para administrar el inventario de mi tienda».");
    } else if (!adjustments) throw new Error("Escribe qué quieres cambiar de la propuesta.");
    if (this.busy) throw new Error("Tu equipo está ocupado con otra tarea. Espera a que termine o pausa el trabajo para preparar una propuesta.");
    if (!proposal) {
      proposal = { id: randomUUID(), idea, status: "drafting", at: now(), versions: 0, usage: [] };
      this.proposals.push(proposal);
      this.proposals = this.proposals.slice(-30);
    }
    proposal.status = "drafting";
    proposal.error = null;
    if (adjustments) (proposal.adjustments ??= []).push({ text: adjustments, at: now() });
    this.busy = true;
    this.chatController = new AbortController();
    this.persist();
    this.notify();
    this.proposalPending = this.draftProposal(proposal, adjustments).finally(() => {
      this.busy = false;
      this.chatController = null;
      this.persist();
      this.notify();
      if (this.chatQueue.length) this.chatPending = this.drainChats();
    });
    return this.proposalView(proposal);
  }
  async draftProposal(proposal, adjustments) {
    const base = path.join(this.store.directory, "proposals", proposal.id);
    const workspace = path.join(base, "workspace");
    const dir = path.join(base, `v${++proposal.versions}`);
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(dir, { recursive: true });
    const team = teamOf(this.settings, "auditor");
    let fix = "";
    for (let attempt = 1; attempt <= MAX_REVIEW_FIXES; attempt++) {
      const prompt = proposalPrompt(proposal.idea, this.settings, { adjustments, previous: adjustments ? proposal.draft : null, environment: this.environment() }) + (fix ? `\nRESPUESTA ANTERIOR RECHAZADA (intento ${attempt - 1} de ${MAX_REVIEW_FIXES}): ${fix}` : "");
      try {
        const result = await this.agents.run({ role: "auditor", phase: "define", prompt, fallbackPrompt: prompt, project: { name: "Propuesta", directory: workspace, objective: proposal.idea, criteria: [], checks: [] }, settings: { ...this.settings }, directory: dir, signal: this.chatController.signal, agent: { ...team[0], index: 0, count: 1, label: agentLabel("auditor", team, 0), resume: null }, emit: (e) => this.event({ ...e, runId: null, projectId: null, proposalId: proposal.id }) });
        const u = result.usage;
        if (u) proposal.usage.push({ at: now(), context: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), cached: u.cached_input_tokens ?? u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0 });
        proposal.draft = validateProposal(result.proposal);
        proposal.status = "ready";
        proposal.readyAt = now();
        const root = projectsRootOf(this.settings);
        try { proposal.folder = freeFolder(root, slugify(proposal.draft.name)); } catch { proposal.folder = path.join(root, slugify(proposal.draft.name)); }
        fs.writeFileSync(path.join(dir, "proposal.json"), JSON.stringify(proposal.draft, null, 2));
        return;
      } catch (error) {
        if (error.name === "AbortError") {
          proposal.status = proposal.draft ? "ready" : "error";
          proposal.error = "Se detuvo la preparación de la propuesta.";
          return;
        }
        if (classifyError(error).kind === "malformed" && attempt < MAX_REVIEW_FIXES) {
          fix = error.message;
          this.event({ role: "system", kind: "warning", text: `Propuesta no válida (${attempt}/${MAX_REVIEW_FIXES}): ${error.message} Se le pide al director que la corrija.`, runId: null, projectId: null });
          continue;
        }
        proposal.status = proposal.draft ? "ready" : "error";
        proposal.error = classifyError(error).kind === "limit" ? `El límite de uso de Codex no deja preparar la propuesta ahora. Inténtalo más tarde. (${clip(error.message, 160)})` : clip(error.message, 400);
        return;
      }
    }
  }
  discardProposal(id) {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error("No se encontró esa propuesta.");
    if (proposal.status === "drafting") throw new Error("Espera a que termine de prepararse.");
    if (proposal.status !== "accepted") proposal.status = "discarded";
    this.persist();
    this.notify();
    return this.proposalView(proposal);
  }
  // The single approval: the folder is created (create: github.createNew), the plan seeded and the work started.
  async acceptProposal(id, create) {
    const proposal = this.proposals.find((p) => p.id === id);
    if (!proposal) throw new Error("No se encontró esa propuesta.");
    if (proposal.status !== "ready") throw new Error(proposal.status === "accepted" ? "Esa propuesta ya se convirtió en proyecto." : "La propuesta todavía no está lista.");
    if (this.busy || this.active && ["paused", "interrupted", "waiting", ...LIVE].includes(this.active.status)) throw new Error("Continúa o detén el trabajo actual antes de iniciar otro.");
    const d = proposal.draft;
    proposal.status = "accepting";
    const objective = `${d.objective}\n\nFUNCIONES PRINCIPALES:\n${d.features.map((f) => "- " + f).join("\n")}\nPLATAFORMA: ${d.platform || "la más simple que cumpla el objetivo"}`;
    const constraints = [
      "Proyecto creado desde una idea de una persona que no sabe programar. Trabaja solo dentro de esta carpeta; no leas ni modifiques otros proyectos.",
      "No publiques nada, no compres ni contrates servicios, no crees cuentas, no hagas push ni merge y no instales programas fuera de la carpeta. Si algo lo requiere, detente y explícalo (decision blocked).",
      "Las pruebas aprobadas demuestran los criterios, no garantizan calidad comercial: no lo afirmes en reportes ni en el README.",
      d.risks.length ? `Limitaciones aceptadas: ${d.risks.join(" · ")}` : ""
    ].filter(Boolean).join("\n");
    let project;
    try {
      const created = await create({ name: d.name, objective, criteria: d.criteria, checks: d.checks, constraints, source: "new" });
      project = this.addProject(created, { proposalId: proposal.id, platform: d.platform });
    } catch (error) {
      proposal.status = "ready";
      this.persist();
      this.notify();
      throw error;
    }
    // The approved plan becomes the project's plan; the director refines it when planning.
    this.plan.apply(project.id, { add: d.plan }, { by: "director", key: `proposal:${proposal.id}`, criteria: project.criteria, requireCoverage: true });
    this.planChanged(project.id);
    this.remember("guardar", () => {
      this.memory.addFact(project.id, { kind: "decision", text: `Plataforma elegida al proponer el proyecto: ${d.platform}`, source: "director" });
      for (const risk of d.risks.slice(0, 4)) this.memory.addFact(project.id, { kind: "note", text: `Limitación aceptada por la persona: ${risk}`, source: "user" });
    });
    proposal.status = "accepted";
    proposal.projectId = project.id;
    proposal.acceptedAt = now();
    this.persist();
    const run = this.start(project.id);
    return { project, run: { id: run.id, status: run.status }, proposal: this.proposalView(proposal) };
  }
  seedDemo() {
    if (!this.demo) return;
    const dir = path.join(this.store.directory, "demo-project");
    fs.mkdirSync(dir, { recursive: true });
    if (!this.projects.some((p) => p.id === "demo")) this.projects.push({ id: "demo", name: "Hola, Automata", directory: dir, objective: "Crear un saludo sencillo y verificarlo con una prueba automatizada.", criteria: ["El saludo incluye el nombre y la prueba pasa."], checks: ["node --test"], constraints: "Solo modificar el proyecto de demostración. No llamar a servicios de AI.", createdAt: now() });
    this.persist();
  }
  updateSettings(input) {
    const previousAccess = this.settings.accessMode;
    this.settings = validateSettings(input);
    if (this.active?.settings) {
      this.active.settings.language = this.settings.language;
      // Plan or API key is a property of this PC, not of a run.
      this.active.settings.planOnly = this.settings.planOnly;
      this.active.settings.maxRetries = this.settings.maxRetries;
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
    if (this.busy || this.active && ["paused", "interrupted", "waiting", ...LIVE].includes(this.active.status)) throw new Error("Continúa o detén el trabajo actual antes de iniciar otro.");
    const p = this.projects.find((p2) => p2.id === projectId);
    if (!p) throw new Error("Selecciona un proyecto.");
    // Checked again here: a project registered before these rules (or a folder that changed) is refused now.
    validateProject(p, { safety: this.safetyContext() });
    if (!p.checks.length) this.event({ role: "system", kind: "warning", text: "Este proyecto no tiene verificaciones automáticas. El director pedirá crear pruebas como primera tarea y no aprobará sin evidencia comprobable.", projectId: p.id, runId: null });
    const run = { id: randomUUID(), projectId: p.id, project: { ...p }, settings: JSON.parse(JSON.stringify(this.settings)), status: "running", stage: "plan", round: 0, createdAt: now(), updatedAt: now(), baseline: "", coderReport: "", nextPrompt: "", review: null, checks: [], tokens: 0, costUsd: 0, sessions: {}, gitQueue: [], recovery: { attempts: {}, log: [], waits: 0 } };
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
    this.clearWait();
    this.active.status = "running";
    delete this.active.waiting;
    this.active.resumeAt = null;
    this.notify();
    this.pending = this.loop().catch((e) => this.recover(e)).finally(async () => {
      this.busy = false;
      this.controller = null;
      this.active.updatedAt = now();
      this.persist();
      this.notify();
      if (this.chatQueue.length) this.chatPending = this.drainChats();
    });
  }
  // ---- Recovery: what happens when the loop fails ------------------------------------------------
  recover(e) {
    const r = this.active;
    if (e.name === "AbortError") {
      if (e.paused) return;
      if (this.closing) {
        // Shutdown, not Stop: the next start decides whether to continue (autoResume).
        r.status = "interrupted";
        r.interruptedBy = "close";
        return;
      }
      r.status = "stopped";
      if (r.stage === "code") {
        r.stage = "checks";
        r.codeStarted = null;
        r.coderReport = "Ejecución detenida por el usuario. Revisa el trabajo parcial.";
      }
      return;
    }
    const verdict = classifyError(e);
    const role = e.role ?? (r.stage === "code" ? "coder" : ["plan", "review"].includes(r.stage) ? "auditor" : "system");
    verdict.role = role;
    r.recovery ??= { attempts: {}, log: [], waits: 0 };
    const key = verdict.kind === "context" ? "transient" : verdict.kind;
    const attempt = (r.recovery.attempts[key] ?? 0) + 1;
    r.recovery.attempts[key] = attempt;
    const plan = planWait(verdict, { attempt, maxRetries: r.settings.maxRetries ?? DEFAULT_SETTINGS.maxRetries, backoff: this.backoff, totalWaits: r.recovery.waits ?? 0 });
    const entry = { at: now(), kind: verdict.kind, role, stage: r.stage, round: r.round, attempt, message: clip(e.message, 300), resumeAt: plan?.resumeAt ? new Date(plan.resumeAt).toISOString() : null, reliable: plan?.reliable ?? null, progressed: !!e.progressed };
    r.recovery.log = [...r.recovery.log, entry].slice(-60);
    // Work the coder did before failing is kept: the retry continues the same task and session.
    if (e.progressed && r.stage === "code" && role === "coder") r.continuation = { reason: verdict.kind === "limit" ? "límite de uso" : verdict.kind === "context" ? "sesión demasiado larga" : "fallo pasajero", at: now() };
    if (verdict.kind === "context") {
      // The session itself is the problem: the next attempt starts a fresh one with the full prompt.
      for (const sessionKey of Object.keys(r.sessions ?? {})) if (sessionKey.startsWith(role + ":")) delete r.sessions[sessionKey];
    }
    if (!plan) {
      r.status = "error";
      r.error = this.giveUpText(verdict, attempt, e.message);
      if (r.stage === "code") {
        r.stage = "checks";
        r.codeStarted = null;
        delete r.continuation;
        r.coderReport = `El codificador terminó con error (${clip(e.message, 200)}). Revisa los archivos parciales y el registro de errores antes de reintentar.`;
      }
      this.event({ role: "system", kind: "error", text: r.error });
      this.remember("guardar", () => this.memory.addFact(r.projectId, { kind: "recovery", text: `Ronda ${r.round}, etapa ${entry.stage}: ${agentName(role)} falló (${verdict.kind}) y Automata se detuvo tras ${attempt} intento(s): ${clip(e.message, 160)}`, source: "automata", runId: r.id, round: r.round }));
      return;
    }
    r.recovery.waits = (r.recovery.waits ?? 0) + 1;
    r.status = "waiting";
    r.waiting = { kind: verdict.kind, role, reason: clip(e.message, 400), resumeAt: new Date(plan.resumeAt).toISOString(), reliable: plan.reliable, attempt, maxAttempts: verdict.kind === "limit" ? MAX_LIMIT_WAITS : (r.settings.maxRetries ?? DEFAULT_SETTINGS.maxRetries), stage: r.stage, round: r.round, since: now() };
    r.resumeAt = r.waiting.resumeAt;
    const text = describeWait(r.waiting, r.settings.language);
    this.event({ role: "system", kind: "wait", text: `${text}. Motivo: ${clip(e.message, 240)}`, waiting: r.waiting });
    this.remember("guardar", () => this.memory.addFact(r.projectId, { kind: "recovery", text: `Ronda ${r.round}, etapa ${entry.stage}: ${text}. Motivo: ${clip(e.message, 160)}`, source: "automata", runId: r.id, round: r.round }));
    this.scheduleWait(r);
  }
  giveUpText(verdict, attempt, message) {
    const who = agentName(verdict.role);
    if (verdict.kind === "limit") return `El límite de uso de ${who} no se liberó tras ${attempt} esperas. Revisa tu plan y pulsa Continuar cuando quieras reintentar. Último mensaje: ${clip(message, 300)}`;
    if (verdict.kind === "transient") return `${who} falló ${attempt} veces seguidas por un motivo pasajero. Pulsa Continuar para reintentar. Último mensaje: ${clip(message, 300)}`;
    if (verdict.kind === "malformed") return clip(message, 600);
    return clip(message, 600);
  }
  clearWait() {
    clearTimeout(this.waitTimer);
    this.waitTimer = null;
  }
  // Checks every minute at most, so a PC that slept through the appointment resumes when it wakes.
  scheduleWait(r) {
    this.clearWait();
    const tick = () => {
      this.waitTimer = null;
      if (r.status !== "waiting" || !r.waiting?.resumeAt) return;
      const remaining = new Date(r.waiting.resumeAt).getTime() - Date.now();
      if (remaining > 0 || this.busy) {
        this.waitTimer = setTimeout(tick, Math.min(Math.max(remaining, 25), 6e4));
        this.waitTimer.unref?.();
        return;
      }
      void this.resumeNow(r, "auto");
    };
    tick();
  }
  async resumeNow(r, how) {
    if (this.busy || !["waiting", "interrupted"].includes(r.status) || !this.settings.autoResume && how !== "manual") return;
    if (this.beforeResume && how !== "manual") {
      try {
        await this.beforeResume(r);
      } catch (error) {
        // Accounts are not ready: try again in a few minutes without consuming attempts.
        if (r.status === "waiting") {
          r.waiting.resumeAt = new Date(Date.now() + 5 * 6e4).toISOString();
          r.waiting.note = error.message;
          r.resumeAt = r.waiting.resumeAt;
          this.scheduleWait(r);
        }
        this.event({ role: "system", kind: "warning", text: `No se pudo reanudar solo: ${error.message}${r.status === "waiting" ? " Se volverá a intentar en 5 minutos." : " Pulsa Continuar cuando esté resuelto."}`, runId: r.id, projectId: r.projectId });
        this.persist();
        this.notify();
        return;
      }
      if (this.busy || !["waiting", "interrupted"].includes(r.status)) return;
    }
    this.active = r;
    r.recovery ??= { attempts: {}, log: [], waits: 0 };
    r.recovery.log = [...r.recovery.log, { at: now(), kind: "resume", how, stage: r.stage, round: r.round }].slice(-60);
    this.event({ role: "system", kind: "start", text: how === "startup" ? "Automata reanuda el trabajo interrumpido." : how === "manual" ? "Continuando ahora, sin esperar." : `Reanudando: ${agentName(r.waiting?.role)} vuelve a intentarlo.`, runId: r.id, projectId: r.projectId });
    delete r.error;
    this.launch();
    this.persist();
    this.notify();
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
    const directory = this.projects.find((p) => p.id === projectId)?.directory ?? "";
    return this.remember("leer", () => this.memory.brief(projectId, { ...options, directory }))?.text ?? "";
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
      case "list": {
        const facts = m.listFacts(p.id, { status: ["active", "retired", "all"].includes(input.status) ? input.status : "active", q: input.q });
        const shallow = shallowNames(p.directory);
        // Facts that mention files no longer in the project are flagged, never removed.
        return { facts: facts.map((fact) => ({ ...fact, stale: staleMentions(fact.text, p.directory, { shallow }) })), errors: m.listErrors(p.id, { q: input.q }), stats: m.stats(p.id) };
      }
      case "brief": return m.brief(p.id, { query: String(input.q ?? ""), directory: p.directory });
      case "add": return { fact: m.addFact(p.id, { kind: input.kind, text: input.text, source: "user" }) };
      case "update": return { fact: m.updateFact(p.id, id, { text: input.text, kind: input.kind, by: "user" }) };
      case "retire": return { fact: m.setFactStatus(p.id, id, "retired", { reason: input.reason || "Retirado por el usuario", by: "user" }) };
      case "restore": return { fact: m.setFactStatus(p.id, id, "active", { by: "user" }) };
      case "history": return { history: m.history(p.id, id) };
      case "errorStatus": return { error: m.setErrorStatus(p.id, id, input.status) };
      default: throw new Error("Acción de memoria no válida.");
    }
  }
  // The Plan panel and POST /api/plan: the user adds, edits, reorders, drops and restores tasks.
  // Nothing is deleted; every change keeps its history. A rule broken here is the user's error, not the director's.
  planAction(input = {}) {
    const p = this.projects.find((project) => project.id === input.projectId);
    if (!p) throw new Error("Selecciona un proyecto.");
    const id = Number(input.id), by = "user", criteria = p.criteria;
    const run = this.runs.find((r) => r.projectId === p.id && r.status !== "complete");
    const meta = { by, runId: run?.id ?? null, round: run?.round ?? null, criteria };
    const done = () => {
      this.planChanged(p.id);
      this.notify();
      return { tasks: this.plan.list(p.id), stats: this.planStatsFor(p.id) };
    };
    try {
      switch (input.action ?? "list") {
        case "list": return { tasks: this.plan.list(p.id), stats: this.planStatsFor(p.id), currentTaskId: this.runs.find((r) => r.projectId === p.id)?.taskId ?? null };
        case "history": return { history: this.plan.history(p.id, id) };
        case "add": {
          const task = this.plan.addUserTask(p.id, { title: input.title, detail: input.detail ?? "", criterion: input.criterion ?? "", ...meta });
          return { ...done(), task };
        }
        case "update": {
          this.plan.apply(p.id, { update: [{ id, status: input.status ?? null, evidence: input.evidence ?? null, note: input.note ?? null, title: input.title ?? null, detail: input.detail ?? null, criterion: input.criterion ?? null, dependsOn: Array.isArray(input.dependsOn) ? input.dependsOn : null }] }, meta);
          return done();
        }
        case "drop": {
          this.plan.apply(p.id, { update: [{ id, status: "dropped", note: input.note || "Descartada por el usuario" }] }, meta);
          return done();
        }
        case "restore": {
          this.plan.apply(p.id, { update: [{ id, status: "todo" }] }, meta);
          return done();
        }
        // A direct task waits "por confirmar": the person (who asked for it) can confirm it from the panel
        // when no review will happen soon, or send it back to the director.
        case "confirm": {
          const task = this.plan.get(p.id, id);
          if (task?.status !== "review") throw new Error("Solo se confirman las tareas que esperan confirmación.");
          this.plan.apply(p.id, { update: [{ id, status: "done", evidence: `Confirmada por la persona. ${task.evidence}`.trim() }] }, meta);
          return done();
        }
        case "reopen": {
          const task = this.plan.get(p.id, id);
          if (task?.status !== "review") throw new Error("Solo se devuelven al plan las tareas que esperan confirmación.");
          this.plan.apply(p.id, { update: [{ id, status: "todo", note: input.note || "La persona pidió revisarla de nuevo." }] }, meta);
          return done();
        }
        case "reorder": {
          if (!Array.isArray(input.ids)) throw new Error("Indica el orden de las tareas.");
          this.plan.reorder(p.id, input.ids, meta);
          return done();
        }
        default: throw new Error("Acción del plan no válida.");
      }
    } catch (error) {
      // The reason is for the person, in plain words; it is not a run failure.
      throw new Error(error.message);
    }
  }
  // The director's decision about the plan, validated as a whole and applied once per review (restart-safe).
  applyPlanDecision(review, phase, index, project) {
    const r = this.active;
    let result;
    try {
      result = this.plan.apply(project.id, review.plan, { by: "director", runId: r.id, round: r.round, key: `${r.id}:${r.round}:${phase}:${index}`, criteria: project.criteria, requireCoverage: phase === "plan" && !!review.plan, decision: review.decision, task: review.task, requireTask: !!review.plan });
    } catch (error) {
      // A rule the director broke goes back to the director; a broken memory file must not stop the work.
      if (error.plan) throw error;
      this.remember("guardar", () => { throw error; });
      return { added: [], updated: [], taskId: null, skipped: true };
    }
    this.planChanged(project.id);
    if (result.added.length || result.updated.length) this.event({ role: "auditor", kind: "plan", text: `Plan: ${result.added.length ? `${result.added.length} tarea(s) nueva(s)` : ""}${result.added.length && result.updated.length ? ", " : ""}${result.updated.length ? `${result.updated.length} actualizada(s)` : ""}.`, plan: this.planStatsFor(project.id) });
    return result;
  }
  // Chat sessions per project and agent: the next message continues the conversation.
  resetChat(projectId, target = null) {
    const p = this.projects.find((project) => project.id === projectId);
    if (!p) throw new Error("Selecciona un proyecto.");
    const roles = target === "coder" || target === "auditor" ? [target] : [null];
    for (const role of roles) this.remember("reiniciar", () => this.memory.resetChatSession(p.id, role));
    this.event({ role: "system", kind: "stop", text: target === "coder" ? "Conversación con Claude reiniciada." : target === "auditor" ? "Conversación con Codex reiniciada." : "Conversación reiniciada para ambos agentes.", runId: null, projectId: p.id });
    this.notify();
    return { ok: true };
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
  // allowRefresh: this is a safe point (a stage start, not a retry) where a long session may be renewed.
  async invoke(role, prompts, phase, dir, index = 0, { allowRefresh = true } = {}) {
    const r = this.active;
    const team = teamOf(r.settings, role), member = team[index] ?? team[0];
    const sessionKey = `${role}:${index}`;
    let resume = r.settings.reuseSessions !== false ? r.sessions?.[sessionKey] ?? null : null;
    // A session that has served sessionRefreshRounds rounds is replaced by a fresh one: the full prompt
    // brings the plan and the memory, so nothing is lost and the context stops growing.
    const refreshEvery = r.settings.sessionRefreshRounds ?? DEFAULT_SETTINGS.sessionRefreshRounds;
    r.sessionRounds ??= {};
    if (resume && allowRefresh && refreshEvery > 0 && r.round - (r.sessionRounds[sessionKey] ?? r.round) >= refreshEvery) {
      const served = r.round - r.sessionRounds[sessionKey];
      delete r.sessions[sessionKey];
      resume = null;
      r.sessionLog = [...r.sessionLog ?? [], { at: now(), role, index, round: r.round, served, reason: "rounds" }].slice(-100);
      this.event({ role: "system", kind: "session", text: `Sesión de ${agentName(role)} renovada tras ${served} rondas: la nueva recibe el plan y la memoria en el prompt completo.` });
    }
    const full = typeof prompts === "string" ? prompts : prompts.full;
    const short = typeof prompts === "string" ? prompts : prompts.short ?? prompts.full;
    const agent = { ...member, index, count: team.length, label: agentLabel(role, team, index), resume };
    let result;
    // The agent finished this very operation before Automata closed: its answer is used as is.
    const saved = r.inflight?.completed;
    if (saved && r.inflight.role === role && r.inflight.phase === phase && r.inflight.index === index) {
      r.inflight = null;
      this.event({ role: "system", kind: "success", text: `${agentName(role)} ya había terminado esta operación antes del cierre; se usa su resultado sin repetirla.` });
      result = saved;
    } else {
      r.inflight = { id: randomUUID(), role, phase, index, dir, round: r.round, at: now() };
      this.persist();
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
      // This call's own commands, so failed builds and tests (and their fixes) reach the project memory once.
      const commands = role === "coder" ? [] : null;
      try {
        result = await this.agents.run({ role, prompt: resume ? short : full, fallbackPrompt: full, phase, directory: dir, project: r.project, settings: { ...r.settings }, agent, attemptId: r.inflight.id, signal: this.controller.signal, emit: (e) => {
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
      } catch (error) {
        error.role ??= role;
        throw error;
      } finally {
        watcher?.close();
        this.recordCommands(r.projectId, commands, { runId: r.id, round: r.round, directory: r.project.directory });
      }
      r.inflight = null;
      if (projectChanged) result = { ...result, projectChanged: true };
    }
    if (result.usage) {
      const u = result.usage;
      r.tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
      // Context = everything the model read this call (Claude counts the cache apart; Codex inside input_tokens).
      const context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      r.usageLog = [...r.usageLog ?? [], { at: now(), round: r.round, role, phase, context, cached: u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0, output: u.output_tokens ?? 0, resumed: !!resume, files: role === "coder" ? (r.files?.length ?? 0) : undefined }].slice(-300);
    }
    if (Number.isFinite(result.cost)) r.costUsd += result.cost;
    if (result.sessionId) {
      // A call that did not resume started this session; its age is counted from this round.
      if (!resume || !result.resumed && result.resumed !== undefined) r.sessionRounds[sessionKey] = r.round;
      (r.sessions ??= {})[sessionKey] = result.sessionId;
      r[`${role}SessionId`] = result.sessionId;
    }
    return result;
  }
  gitNeedsApproval(mode, kind) {
    return mode === "ask-all" || mode === "ask-push" && (kind === "push" || kind === "merge");
  }
  // One entry per decision and round: a review applied again after a restart does not queue it twice.
  queueGit(r, action) {
    r.gitQueue ??= [];
    const same = (item) => !["failed", "rejected"].includes(item.status) && item.round === r.round && item.kind === action.kind && item.branch === action.branch && item.message === action.message && item.into === action.into;
    if (r.gitQueue.some(same)) return null;
    const item = { id: randomUUID(), ...action, status: "pending", at: now(), round: r.round };
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
    // Marked before running: if Automata dies now, the item is never repeated on its own.
    item.startedAt = now();
    this.persist();
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
    item.doneAt = now();
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
    if (!["pending", "uncertain"].includes(item.status)) throw new Error("Esa operación ya se resolvió.");
    if (!["approve", "reject"].includes(decision)) throw new Error("Decisión no válida.");
    if (decision === "reject") {
      item.status = "rejected";
      item.doneAt = now();
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
      item.status = "pending";
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
    if (pending && pending.command === run.command && (!final || pending.final)) return null;
    // Mid-run the user is asked once per command; once the goal is done they are asked again.
    if (!final && r.runOffers.some((offer) => offer.command === run.command)) return null;
    if (pending) pending.status = "superseded";
    const offer = { id: randomUUID(), command: run.command, url: run.url, note: run.note, final, status: "pending", round: r.round, at: now() };
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
    offer.doneAt = now();
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
  // One reviewer's turn. An invalid answer (bad JSON, approval without evidence…) is sent back to
  // the same session with the reason, up to MAX_REVIEW_FIXES times; then the run stops with the error.
  async review(role, phase, options, evidence, reviewDir, index, project) {
    let fix = null;
    for (let attempt = 1; ; attempt++) {
      const fixText = fix ? `${fix.message}` : "";
      const prompts = {
        full: directorPrompt(project, this.active.settings, { ...options, evidence: evidence.full, fix: fixText }),
        short: fix ? reviewFixPrompt(fixText, attempt - 1, MAX_REVIEW_FIXES) : directorPrompt(project, this.active.settings, { ...options, evidence: evidence.short, short: true })
      };
      try {
        const result = await this.invoke(role, prompts, phase, reviewDir, index, { allowRefresh: !fix });
        const review = validateReview(result.review, project, phase);
        if (review.decision === "complete" && this.active.checks.some((c) => !c.passed)) throw invalidReview("El auditor intentó aprobar con verificaciones fallidas. Revisa la evidencia antes de continuar.");
        // The plan is the last check: a decision that breaks it rolls back whole and comes back here.
        const planResult = this.applyPlanDecision(review, phase, index, project);
        return { result, review, taskId: planResult.taskId ?? null };
      } catch (error) {
        if (classifyError(error).kind !== "malformed") throw error;
        const r = this.active;
        r.recovery ??= { attempts: {}, log: [], waits: 0 };
        r.recovery.log = [...r.recovery.log, { at: now(), kind: "malformed", role, stage: r.stage, round: r.round, attempt, message: clip(error.message, 300) }].slice(-60);
        this.remember("guardar", () => this.memory.addFact(r.projectId, { kind: "recovery", text: `Ronda ${r.round}: la revisión del director no fue válida (${clip(error.message, 120)}); intento ${attempt} de ${MAX_REVIEW_FIXES}.`, source: "automata", runId: r.id, round: r.round }));
        if (attempt >= MAX_REVIEW_FIXES) throw Object.assign(new Error(`El director no entregó una revisión válida en ${MAX_REVIEW_FIXES} intentos. Último motivo: ${error.message}`), { kind: "fatal", role });
        this.event({ role: "system", kind: "warning", text: `Revisión no válida (${attempt}/${MAX_REVIEW_FIXES}): ${error.message} Se le pide al director que la corrija.` });
        fix = error;
        if (this.controller.signal.aborted) throw Object.assign(new Error("Detenido"), { name: "AbortError" });
        if (this.pauseIfRequested()) throw Object.assign(new Error("Pausado"), { name: "AbortError", paused: true });
      }
    }
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
          r.updatedAt = now();
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
        // One file per phase: the coder and the director of the same round each get their own.
        if (memory) fs.writeFileSync(path.join(dir, `memory-${phase}.txt`), memory);
        // The plan as it stands, and what the user asked for in the chat since the last review.
        const planText = this.remember("leer", () => this.plan.brief(p.id, { current: r.taskId ?? null }))?.text ?? "";
        if (planText) fs.writeFileSync(path.join(dir, `plan-${phase}.txt`), planText);
        const requests = this.remember("leer", () => this.memory.conversationBrief(p.id, { since: r.reviewedAt ?? r.createdAt, limit: 5, budgetTokens: 300, title: "" }))?.trim() ?? "";
        let taskId = null;
        for (let i = 0; i < reviewers; i++) {
          const reviewDir = i === 0 ? dir : path.join(dir, `reviewer-${i + 1}`);
          fs.mkdirSync(reviewDir, { recursive: true });
          const options = { planExists: phase === "plan" && !!planText, phase, report: r.coderReport, history: r.review?.summary, team: reviewers > 1 ? { index: i, count: reviewers } : null, git: { mode: s.gitMode ?? "ask-push", info: gitInfo }, watch, memory, plan: planText, requests };
          const { result, review, taskId: assigned } = await this.review("auditor", phase, options, { full: evidenceFull, short: state }, reviewDir, i, p);
          reviews.push(review);
          if (assigned) taskId = assigned;
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
        if (review.decision === "complete" && p.checks.length && (r.checksRound !== r.round || r.checks.length !== p.checks.length)) {
          // Not the director's fault: the round's checks have not run. Run them once and ask again.
          if (r.checksRetried === r.round) throw new Error("Faltan verificaciones de la ronda actual.");
          r.checksRetried = r.round;
          this.event({ role: "system", kind: "warning", text: "Faltan verificaciones de la ronda actual. Se ejecutan antes de aceptar la aprobación." });
          r.stage = "checks";
          r.forceDirector = true;
          r.updatedAt = now();
          this.persist();
          this.notify();
          continue;
        }
        review.git = normalizeGit(review.git);
        fs.writeFileSync(path.join(dir, "review.json"), JSON.stringify(review, null, 2));
        r.review = review;
        r.reviewedAt = now();
        if (review.decision === "continue") {
          r.taskId = taskId ?? r.taskId ?? null;
          // Where the executor should start reading, according to the director.
          r.files = review.files ?? [];
        }
        this.remember("guardar", () => this.memory.recordReview(p.id, { review, runId: r.id, round: r.round, criteria: p.criteria }));
        // The director has seen it: the next review only gets what happens from here on.
        r.watch = (r.watch ?? []).slice(watched);
        this.event({ role: "auditor", kind: "review", text: review.summary, review });
        // The decision is saved before acting on it: a crash while applying it never asks the director again.
        r.stage = "apply";
      } else if (r.stage === "apply") {
        const review = r.review;
        if (review.decision !== "blocked") await this.applyGit(review);
        if (review.decision !== "blocked") this.offerRun(r, review);
        if (review.decision === "complete") {
          r.status = "complete";
          r.stage = "complete";
          r.finishedAt = now();
          this.event({ role: "system", kind: "complete", text: "Objetivo completado con evidencia para todos los criterios." });
          break;
        }
        if (review.decision === "blocked") {
          r.status = "blocked";
          r.stage = "review";
          this.event({ role: "system", kind: "warning", text: "Se necesita tu intervención: " + review.summary });
          break;
        }
        r.nextPrompt = review.nextPrompt;
        r.baseTask = review.nextPrompt;
        // The assigned task is "doing" from here until the director confirms it (idempotent: same state, no change).
        if (r.taskId) this.remember("guardar", () => { this.plan.setStatus(p.id, r.taskId, "doing", { by: "automata", runId: r.id, round: r.round }); this.planChanged(p.id); });
        r.stage = "code";
      } else if (r.stage === "code") {
        // A retry of the round that failed keeps its number, folder and session.
        const retry = r.codeStarted != null && r.codeStarted === r.round;
        const failingBefore = retry ? [] : r.checks.filter((c) => !c.passed);
        if (!retry) {
          if (r.round >= s.maxRounds) {
            r.status = "limit";
            this.event({ role: "system", kind: "warning", text: `Se alcanzó el límite de ${s.maxRounds} rondas. El objetivo sigue pendiente.` });
            break;
          }
          r.round++;
          r.checks = [];
          r.checksRound = null;
          r.codeStarted = r.round;
        }
        const work = path.join(root, `round-${String(r.round).padStart(2, "0")}`);
        fs.mkdirSync(work, { recursive: true });
        // Coders take turns by round: round 1 uses the first, round 2 the second, and so on.
        const coders = teamOf(s, "coder"), turn = (r.round - 1) % coders.length;
        const teamInfo = coders.length > 1 ? { index: turn, count: coders.length } : null;
        const continuation = r.continuation ?? null;
        delete r.continuation;
        const task = continuation ? continuationPrompt(r.nextPrompt, continuation) : r.nextPrompt;
        this.event({ role: "coder", kind: "phase", text: `Ronda ${r.round} · ${continuation ? "Continúa la tarea interrumpida · " : ""}${r.nextPrompt}`, ...coders.length > 1 ? { agent: agentLabel("coder", coders, turn) } : {} });
        // A failure that already happened before comes with the solution that fixed it then.
        const memory = this.memoryBrief(p.id, { query: r.nextPrompt, failing: failingBefore });
        if (memory) fs.writeFileSync(path.join(work, "memory-code.txt"), memory);
        const planText = this.remember("leer", () => this.plan.brief(p.id, { current: r.taskId ?? null, forCoder: true }))?.text ?? "";
        if (planText) fs.writeFileSync(path.join(work, "plan-code.txt"), planText);
        // Already normalized by validateReview: relative paths inside the project, no "..".
        const files = r.files ?? [];
        const prompts = { full: coderPrompt(p, s, task, r.baseline, teamInfo, false, memory, planText, files), short: coderPrompt(p, s, task, r.baseline, teamInfo, true, memory, planText, files) };
        this.persist();
        let result;
        try {
          result = await this.invoke("coder", prompts, "code", work, turn, { allowRefresh: !continuation && !retry });
        } catch (error) {
          const verdict = classifyError(error);
          // Out of turns, or out of time after real work: the partial result goes to the checks and the
          // director, which is cheaper and safer than starting the task over.
          if (verdict.kind === "turns" || verdict.reason === "timeout" && error.progressed) {
            const why = verdict.kind === "turns" ? "alcanzó el máximo de turnos" : "alcanzó el límite de tiempo de la llamada";
            r.coderReport = `${String(error.lastMessage ?? "").trim() || "(sin reporte)"}\n\n[Automata] Claude ${why} antes de entregar el reporte final. El trabajo es parcial: las verificaciones y el director deciden cómo seguir.`;
            fs.writeFileSync(path.join(work, "coder-report.md"), r.coderReport);
            this.event({ role: "system", kind: "warning", text: `Claude ${why}. Se verifica el trabajo parcial y el director decide cómo seguir.` });
            this.remember("guardar", () => this.memory.addFact(p.id, { kind: "recovery", text: `Ronda ${r.round}: Claude ${why}; el trabajo parcial pasó a verificación.`, source: "automata", runId: r.id, round: r.round }));
            r.codeStarted = null;
            r.stage = "checks";
            r.updatedAt = now();
            this.persist();
            this.notify();
            continue;
          }
          throw error;
        }
        r.coderReport = result.text;
        fs.writeFileSync(path.join(work, "coder-report.md"), r.coderReport);
        this.event({ role: "coder", kind: "report", text: r.coderReport });
        this.rememberReport(p.id, r.coderReport, { source: "coder", runId: r.id, round: r.round });
        r.codeStarted = null;
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
      // A stage finished: consecutive-failure counters start over.
      if (r.recovery) r.recovery.attempts = {};
      r.updatedAt = now();
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
      if (this.active?.status === "waiting") throw new Error("Detén o continúa el trabajo que está esperando antes de usar otro.");
      this.active = target;
    }
    const r = this.active;
    if (!r) throw new Error("No hay un trabajo activo.");
    if (action === "pause") {
      if (r.status === "waiting") {
        // Pause beats any retry: the appointment is dropped and nothing resumes until the user says so.
        this.clearWait();
        r.status = "paused";
        r.resumeAt = null;
        this.event({ role: "system", kind: "pause", text: "Espera cancelada. El trabajo queda en pausa hasta que pulses Continuar." });
      } else {
        if (!LIVE.has(r.status)) throw new Error("No hay una ejecución que pausar.");
        r.status = "pausing";
        this.event({ role: "system", kind: "pause", text: "Pausa solicitada. Terminará la operación actual antes de detener el ciclo." });
      }
    } else if (action === "stop") {
      this.clearWait();
      this.controller?.abort();
      r.status = "stopped";
      r.resumeAt = null;
      delete r.waiting;
      this.event({ role: "system", kind: "stop", text: "Trabajo detenido. Los archivos existentes se conservan." });
    } else if (action === "resume") {
      if (this.busy) throw new Error("Espera a que termine la operación actual.");
      if (!RESUMABLE.includes(r.status)) throw new Error("Este trabajo no se puede continuar.");
      if (r.status === "limit") {
        if (this.settings.maxRounds <= r.round) throw new Error("Aumenta el límite de rondas antes de continuar.");
        r.settings.maxRounds = this.settings.maxRounds;
      }
      if (r.status === "error" && r.stage === "code") {
        r.stage = "checks";
        r.codeStarted = null;
        r.coderReport = "El codificador terminó con error. Revisa los archivos parciales y el registro de errores antes de reintentar.";
      }
      // Continuar after an error starts the retry counters over: the user decided to try again.
      if (r.recovery) r.recovery.attempts = {};
      delete r.error;
      this.clearWait();
      this.launch();
    } else throw new Error("Acción desconocida.");
    this.persist();
    this.notify();
    return r;
  }
  async sendChat({ projectId, target, text, kind = "question", reset = false }) {
    const p = this.projects.find((p2) => p2.id === projectId);
    if (!p) throw new Error("Selecciona un proyecto para conversar.");
    text = String(text ?? "").trim();
    if (!text || text.length > 12e3) throw new Error("Escribe un mensaje de hasta 12 000 caracteres.");
    if (!["coder", "auditor", "both"].includes(target) || !["task", "question", "instruction"].includes(kind)) throw new Error("Destino o tipo de mensaje no válido.");
    if (reset) this.resetChat(projectId, target === "both" ? null : target);
    const message = { id: randomUUID(), projectId, target, text, kind, status: "queued", at: now() };
    // "Buen trabajo" is not a request: Automata answers it itself, without running anything.
    if (isCasual(text)) {
      message.status = "answered";
      message.casual = true;
      message.answers = [{ role: "system", text: casualAnswer(this.settings.language) }];
      message.finishedAt = now();
      this.messages.push(message);
      this.persist();
      this.notify();
      return message;
    }
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
        message.startedAt = now();
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
            // And it enters the plan as a task of the user's: the director assigns it or drops it with a reason.
            const task = this.remember("guardar", () => this.plan.addUserTask(project.id, { title: clip(message.text, 100), detail: message.text, by: "user", runId: run.id, round: run.round }));
            this.planChanged(project.id);
            this.remember("guardar", () => this.memory.recordExchange(project.id, { role: "auditor", kind: "instruction", messageId: message.id, request: message.text, answer: task ? `Entró al plan como T${task.id}.` : "Entregada al director." }));
            message.status = "delivered";
            message.taskId = task?.id ?? null;
            message.answer = task ? `Instrucción entregada al director y anotada en el plan como T${task.id}. Se revisará antes de la siguiente tarea.` : "Instrucción entregada al director. Se revisará antes de la siguiente tarea.";
          }
        } else {
          // A task for the director is a hand-off: the director (read-only) decides what to change, then the executor writes it.
          const handoff = message.kind === "task" && message.target === "auditor";
          const roles = message.target === "both" ? ["coder", "auditor"] : handoff ? ["auditor", "coder"] : [message.target];
          message.answers ??= [];
          for (const role of roles) {
            // Already answered before an interruption: not asked again.
            if (message.answers.some((answer) => answer.role === role && !answer.error)) continue;
            message.activeRole = role;
            const dir = path.join(this.store.directory, "chats", message.id, role);
            const phase = message.kind === "task" ? "task" : "chat";
            message.inflight = { id: randomUUID(), role, phase, dir, at: now() };
            this.persist();
            this.notify();
            const commands = role === "coder" ? [] : null;
            try {
              fs.mkdirSync(dir, { recursive: true });
              message.settings = { ...this.settings };
              const memory = this.memoryBrief(project.id, { query: message.text });
              const planText = this.remember("leer", () => this.plan.brief(project.id, { current: this.runs.find((r) => r.projectId === project.id)?.taskId ?? null, forCoder: role === "coder" }))?.text ?? "";
              // The conversation of this project and agent continues where it left off; a fresh one gets a summary instead.
              const session = message.settings.reuseSessions !== false ? this.remember("leer", () => this.memory.chatSession(project.id, role))?.session_id ?? null : null;
              const conversation = session ? "" : this.remember("leer", () => this.memory.conversationBrief(project.id, { limit: 5 })) ?? "";
              const options = { kind: message.kind, previousAnswers: message.answers, memory, interrupted: message.requeued > 0, plan: planText };
              const context = this.runs.find((r) => r.projectId === project.id)?.review?.summary;
              const team = teamOf(message.settings, role);
              const result = await this.agents.run({ role, phase, prompt: chatPrompt(project, role, message.text, context, message.settings, { ...options, conversation, short: !!session }), fallbackPrompt: chatPrompt(project, role, message.text, context, message.settings, { ...options, conversation: this.remember("leer", () => this.memory.conversationBrief(project.id, { limit: 5 })) ?? "" }), project, settings: message.settings, directory: dir, attemptId: message.inflight.id, agent: { ...team[0], index: 0, count: 1, label: agentLabel(role, team, 0), resume: session }, signal: withinRun ? this.controller.signal : this.chatController.signal, emit: (e) => {
                // Work asked from the chat also goes in front of the director's eyes.
                if (e.role === "coder" && this.active?.projectId === project.id && this.active.status !== "complete") observe(this.active.watch ??= [], e);
                if (commands && e.role === "coder") observe(commands, e);
                this.event({ ...e, projectId: project.id });
              } });
              message.answers.push({ role, text: result.text, resumed: !!result.resumed });
              if (result.sessionId) this.remember("guardar", () => this.memory.setChatSession(project.id, role, result.sessionId));
              this.remember("guardar", () => this.memory.recordExchange(project.id, { role, kind: message.kind, messageId: message.id, request: message.text, answer: result.text, files: changedFiles(commands, project.directory) }));
              this.rememberReport(project.id, result.text, { source: role === "coder" ? "coder" : "director", runId: null, round: null });
            } catch (e) {
              if (this.closing) {
                // Cut by the shutdown, not failed: it stays "processing" so the next start can pick it up.
                this.recordCommands(project.id, commands, { runId: null, round: null, directory: project.directory });
                return;
              }
              message.answers.push({ role, text: e.message, error: true });
              this.remember("guardar", () => this.memory.recordExchange(project.id, { role, kind: message.kind, messageId: message.id, request: message.text, answer: e.message, error: true }));
            } finally {
              if (!this.closing) this.recordCommands(project.id, commands, { runId: null, round: null, directory: project.directory });
            }
            message.inflight = null;
            delete message.activeRole;
            this.persist();
            this.notify();
            if (handoff && message.answers.at(-1)?.error) break;
          }
          message.status = message.answers.some((a) => a.error) ? "error" : "answered";
          // A direct task that the executor carried out waits in the plan for the director to confirm it;
          // one that failed stays open for the director to decide.
          if (message.kind === "task" && message.answers.some((a) => a.role === "coder")) {
            const coderAnswer = message.answers.find((a) => a.role === "coder");
            const task = this.remember("guardar", () => this.plan.addUserTask(project.id, { title: clip(message.text, 100), detail: message.text, status: coderAnswer.error ? "todo" : "review", evidence: coderAnswer.error ? "" : clip(coderAnswer.text, 400), note: coderAnswer.error ? clip(`Falló: ${coderAnswer.text}`, 300) : "", by: "user", runId: this.active?.projectId === project.id ? this.active.id : null, round: this.active?.projectId === project.id ? this.active.round : null }));
            this.planChanged(project.id);
            message.taskId = task?.id ?? null;
          }
          if (withinRun && message.kind === "task" && this.active?.projectId === project.id) {
            this.active.coderReport += `\n\nTAREA DIRECTA DEL USUARIO:\n${message.text}\nRESULTADO:\n${message.answers.map(answer => `${answer.role}: ${answer.text}`).join("\n")}`;
            if (this.active.stage === "review") {
              this.active.stage = "checks";
              this.active.checks = [];
              this.active.checksRound = null;
            }
          }
        }
        message.finishedAt = now();
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
    this.closing = true;
    this.clearWait();
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
