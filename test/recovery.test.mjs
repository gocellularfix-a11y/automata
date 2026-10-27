// P1: autonomous recovery. Usage limits, passing failures, invalid reviews, turn limits, shutdowns
// and restarts, with simulated agents and simulated CLIs. Real-CLI behaviour is covered in
// P1_RECOVERY_REPORT.md.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { classifyError, parseResetTime, resetFromInfo, planWait, describeWait, MAX_REVIEW_FIXES, MAX_LIMIT_WAITS } from "../server/recovery.mjs";
import { validateSettings } from "../server/config.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { CliAgents } from "../server/agents.mjs";
import { createServer } from "../server/index.mjs";
import { staleMentions } from "../server/memory.mjs";
import { redactSecrets } from "../server/redact.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const projectInput = (directory, extra = {}) => ({ name: "Recuperación", directory, objective: "Construir una función comprobada.", criteria: ["La prueba pasa."], checks: [], ...extra });
const review = (decision = "continue", extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Implementa la función." : "", findings: [], criteria: [{ criterion: "La prueba pasa.", met: decision === "complete", evidence: decision === "complete" ? "Resultado registrado." : "Pendiente." }], ...extra });
// Short waits so the tests finish in milliseconds; the real values live in recovery.mjs.
const FAST = { transient: [20, 40, 60, 80], limit: [30, 30, 30, 30, 30, 30, 30, 30], margin: 0 };
const limitError = (extra = {}) => Object.assign(new Error("You've hit your usage limit."), { role: "coder", agent: true, ...extra });
async function settled(c) {
  await c.pending;
  while (c.busy) await new Promise((r) => setTimeout(r, 5));
}
// Waits until the run leaves "waiting" (its appointment arrived) and the loop settled.
async function resumed(c, { timeout = 3000 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until && (c.active?.status === "waiting" || c.busy)) await new Promise((r) => setTimeout(r, 5));
  await settled(c);
}
function coordinator(dir, agents, extra = {}) {
  return new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], backoff: FAST, resumeDelayMs: 0, agents, ...extra });
}

test("clasifica límites de uso, fallos pasajeros, sesión agotada, JSON inválido, turnos, fatales y detenciones", () => {
  const now = Date.parse("2026-10-27T14:00:00-07:00");
  const limit = classifyError(Object.assign(new Error("You've hit your limit · resets 3pm (America/Los_Angeles)"), { agent: true }), { now });
  assert.equal(limit.kind, "limit");
  assert.equal(limit.resumeAt, now + 36e5, "resets 3pm en Los Ángeles es dentro de una hora");
  assert.equal(classifyError(limitError(), { now }).resumeAt, null, "sin hora no hay cita confiable");
  // Claude's older shape: text|epoch seconds.
  const legacy = classifyError(Object.assign(new Error("Claude AI usage limit reached|" + Math.floor(now / 1e3 + 1800)), { agent: true }), { now });
  assert.equal(legacy.kind, "limit");
  assert.equal(legacy.resumeAt, now + 18e5);
  // Codex: a structured usage-limit failure with no time in the text.
  const codex = classifyError(Object.assign(new Error("You've hit your usage limit."), { agent: true, rateLimit: { status: "rejected", resets_at: Math.floor(now / 1e3) + 600 } }), { now });
  assert.equal(codex.kind, "limit");
  assert.equal(codex.resumeAt, now + 6e5);
  assert.equal(classifyError(Object.assign(new Error("Rate limit exceeded. Try again in 2 hours 5 minutes."), { agent: true }), { now }).resumeAt, now + (2 * 3600 + 300) * 1e3);
  assert.equal(classifyError(Object.assign(new Error("429 Too Many Requests"), { agent: true }), { now }).kind, "limit");
  assert.equal(classifyError(Object.assign(new Error("spend limit reached (daily; resets 2026-10-28 00:00 UTC)"), { agent: true }), { now }).resumeAt, Date.parse("2026-10-28T00:00:00Z"));
  // A reset time in the past or too far away is not trusted: the wait becomes progressive.
  assert.equal(classifyError(Object.assign(new Error("usage limit reached|" + Math.floor(now / 1e3 - 60)), { agent: true }), { now }).resumeAt, null);
  for (const message of ["fetch failed", "ECONNRESET", "stream disconnected - retrying sampling request (1/5 in 200ms)...", "overloaded_error: Overloaded", "502 Bad Gateway", "La ejecución alcanzó el límite de tiempo."]) assert.equal(classifyError(Object.assign(new Error(message), { agent: true })).kind, "transient", message);
  assert.equal(classifyError(Object.assign(new Error("El agente terminó con código 1."), { agent: true, exitCode: 1 })).kind, "transient", "un fallo del proceso sin explicación merece otro intento");
  assert.equal(classifyError(new Error("Cannot read properties of undefined")).kind, "fatal", "un error interno de Automata no se reintenta");
  assert.equal(classifyError(Object.assign(new Error("context_window_exceeded: the conversation is too long"), { agent: true })).kind, "context");
  assert.equal(classifyError(Object.assign(new Error("Codex no entregó el JSON de auditoría esperado."), { kind: "malformed" })).kind, "malformed");
  assert.equal(classifyError(Object.assign(new Error("Falta evidencia para uno o más criterios de aceptación."), { kind: "malformed" })).kind, "malformed");
  assert.equal(classifyError(Object.assign(new Error("Claude terminó sin reporte final."), { subtype: "error_max_turns", agent: true })).kind, "turns");
  assert.equal(classifyError(Object.assign(new Error("Reached max turns (20)"), { agent: true })).kind, "turns");
  for (const message of ["Claude Code no está instalado.", "Not logged in · run /login", "authentication_error: invalid x-api-key", "model gpt-9 not found"]) assert.equal(classifyError(Object.assign(new Error(message), { agent: true })).kind, "fatal", message);
  assert.equal(classifyError(Object.assign(new Error("Detenido"), { name: "AbortError" })).kind, "aborted");
  assert.equal(resetFromInfo({ rate_limit_info: { retry_in_ms: 5000 } }, now), now + 5000);
  assert.equal(parseResetTime("Try again at 11:30 PM", now) > now, true);
  assert.equal(parseResetTime("nothing here", now), null);
});

test("la política de espera es acotada: progresiva sin hora confiable, exacta con ella, y se rinde tras el tope", () => {
  const now = 1e12;
  const unknown = { kind: "limit", resumeAt: null };
  assert.deepEqual(planWait(unknown, { attempt: 1, now }), { resumeAt: now + 5 * 6e4, reliable: false });
  assert.deepEqual(planWait(unknown, { attempt: 3, now }), { resumeAt: now + 30 * 6e4, reliable: false });
  assert.equal(planWait(unknown, { attempt: 4, now }).resumeAt, now + 60 * 6e4);
  assert.equal(planWait(unknown, { attempt: MAX_LIMIT_WAITS + 1, now }), null);
  assert.deepEqual(planWait({ kind: "limit", resumeAt: now + 1e6 }, { attempt: 1, now }), { resumeAt: now + 1e6 + 6e4, reliable: true });
  assert.equal(planWait({ kind: "transient" }, { attempt: 2, now }).resumeAt, now + 12e4);
  assert.equal(planWait({ kind: "transient" }, { attempt: 5, maxRetries: 4, now }), null);
  assert.equal(planWait({ kind: "transient" }, { attempt: 1, now, totalWaits: 40 }), null, "ningún trabajo espera indefinidamente");
  assert.equal(planWait({ kind: "fatal" }, { attempt: 1, now }), null);
  assert.equal(planWait({ kind: "malformed" }, { attempt: 1, now }), null);
  assert.match(describeWait({ kind: "limit", role: "coder", resumeAt: new Date(Date.now() + 6e4).toISOString(), reliable: true, attempt: 1, maxAttempts: 8 }), /Límite de uso de Claude · sigue a las \d{2}:\d{2} \(intento 1 de 8\)/);
  assert.match(describeWait({ kind: "transient", role: "auditor", resumeAt: new Date().toISOString(), attempt: 2, maxAttempts: 4 }, "en"), /Codex failed for a passing reason · resumes at/);
});

test("un límite de uso del director deja el trabajo esperando con hora, y al llegar sigue solo desde la misma etapa", async (t) => {
  const dir = fixture(), calls = [];
  let reviews = 0;
  const c = coordinator(dir, { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.role === "coder") return { text: "Implementado" };
    if (a.phase === "review" && ++reviews === 1) throw Object.assign(new Error("You've hit your usage limit. Try again in 0 minutes 0 seconds."), { role: "auditor", agent: true, rateLimit: { status: "rejected", retry_in_ms: 120 } });
    return { review: review(a.phase === "review" ? "complete" : "continue") };
  } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  const r = c.active;
  assert.equal(r.status, "waiting");
  assert.equal(r.waiting.kind, "limit");
  assert.equal(r.waiting.role, "auditor");
  assert.equal(r.waiting.reliable, true);
  assert.equal(r.stage, "review", "la etapa pendiente se conserva");
  assert.ok(Date.parse(r.resumeAt) > Date.now(), "resumeAt está en el futuro");
  const snapshot = c.snapshot().runs[0];
  assert.equal(snapshot.status, "waiting");
  assert.ok(snapshot.waiting.resumeAt && snapshot.recovery.log.some((e) => e.kind === "limit"));
  assert.ok(c.events.some((e) => e.kind === "wait" && /Límite de uso de Codex · sigue a las/.test(e.text)));
  await resumed(c);
  assert.equal(r.status, "complete");
  // The task was not repeated: plan, one code round, the failed review, the retried review.
  assert.deepEqual(calls, ["auditor:plan", "coder:code", "auditor:review", "auditor:review"]);
  assert.equal(r.round, 1);
  assert.deepEqual(r.recovery.attempts, {});
  assert.ok(c.memory.listFacts(r.projectId, { kind: "recovery" }).length >= 1, "la espera quedó en la memoria del proyecto");
});

test("si Claude ya había trabajado cuando llegó el límite, al reanudar continúa la misma ronda y no repite la tarea", async (t) => {
  const dir = fixture(), prompts = [];
  let codes = 0;
  const c = coordinator(dir, { async run(a) {
    if (a.role === "coder") {
      prompts.push({ prompt: a.prompt, resume: a.agent.resume });
      if (++codes === 1) {
        a.emit({ role: "coder", kind: "tool", toolId: "w1", tool: { name: "Write", path: path.join(dir, "a.js"), content: "1", lines: 1 }, text: "Write" });
        throw limitError({ progressed: true, lastMessage: "Escribí a.js" });
      }
      return { text: "Terminado", sessionId: "s-coder" };
    }
    return { review: review(a.phase === "review" ? "complete" : "continue"), sessionId: "s-dir" };
  } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "waiting");
  assert.equal(c.active.waiting.reliable, false, "sin hora en el mensaje: espera progresiva");
  assert.equal(c.active.round, 1);
  assert.ok(c.active.continuation);
  await resumed(c);
  assert.equal(c.active.status, "complete");
  assert.equal(c.active.round, 1, "la ronda interrumpida conserva su número");
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /se interrumpió \(límite de uso\) después de hacer trabajo parcial/);
  assert.match(prompts[1].prompt, /no repitas lo que ya está hecho/);
  assert.match(prompts[1].prompt, /Implementa la función\./);
  assert.equal(c.active.watch?.length ?? 0, 0, "el director vio lo escrito antes del límite");
  assert.ok(c.events.some((e) => e.kind === "phase" && /Continúa la tarea interrumpida/.test(e.text)));
});

test("un fallo pasajero se reintenta con espera creciente hasta maxRetries y luego se detiene con el error", async (t) => {
  const dir = fixture(), stamps = [];
  const c = coordinator(dir, { async run(a) {
    stamps.push(Date.now());
    throw Object.assign(new Error("fetch failed: ECONNRESET"), { role: "auditor", agent: true });
  } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, maxRetries: 2 });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "waiting");
  assert.equal(c.active.waiting.kind, "transient");
  assert.equal(c.active.waiting.maxAttempts, 2);
  for (let i = 0; i < 3 && c.active.status === "waiting"; i++) await resumed(c);
  assert.equal(c.active.status, "error");
  assert.match(c.active.error, /falló 3 veces seguidas por un motivo pasajero/);
  assert.equal(stamps.length, 3, "intento inicial más dos reintentos");
  // The planned waits grow (20 ms, then 40 ms with the test backoff); wall-clock gaps are too noisy to compare.
  const planned = c.active.recovery.log.filter((e) => e.kind === "transient" && e.resumeAt).map((e) => Date.parse(e.resumeAt) - Date.parse(e.at));
  assert.ok(planned.length >= 2 && planned[1] > planned[0], `la segunda espera es mayor que la primera: ${planned}`);
  const log = c.active.recovery.log.filter((e) => e.kind === "transient");
  assert.deepEqual(log.map((e) => e.attempt), [1, 2, 3]);
  // Continuar after the error starts the counters over.
  assert.deepEqual(c.active.recovery.attempts, { transient: 3 });
  c.control("resume");
  await settled(c);
  assert.equal(c.active.status, "waiting");
  assert.equal(c.active.waiting.attempt, 1);
  c.control("stop");
  assert.equal(c.active.status, "stopped");
});

test("el director recibe hasta tres oportunidades para corregir una revisión inválida; a la cuarta el trabajo queda en error", async (t) => {
  // Invalid JSON twice, then a valid review: the run goes on.
  const dir = fixture(), prompts = [];
  let bad = 0;
  const c = coordinator(dir, { async run(a) {
    if (a.role === "coder") return { text: "Implementado" };
    prompts.push(a.prompt);
    if (a.phase === "plan") return { review: review("continue"), sessionId: "d1" };
    if (++bad <= 2) throw Object.assign(new Error(bad === 1 ? "Codex no entregó el JSON de auditoría esperado." : "Codex terminó sin respuesta."), { kind: "malformed", role: "auditor", agent: true });
    return { review: review("complete"), sessionId: "d1" };
  } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.equal(prompts.length, 4, "plan, revisión inválida, dos correcciones");
  assert.match(prompts[2], /Tu respuesta anterior no se pudo aceptar \(intento 1 de 3\): Codex no entregó el JSON/);
  assert.match(prompts[3], /intento 2 de 3.*sin respuesta/);
  assert.equal(c.events.filter((e) => /Revisión no válida \(\d\/3\)/.test(e.text)).length, 2);
  // Approval without evidence is also invalid; three in a row stop the run.
  const dir2 = fixture(), seen = [];
  const d = coordinator(dir2, { async run(a) {
    if (a.role === "coder") return { text: "Implementado" };
    seen.push(a.prompt);
    if (a.phase === "plan") return { review: review("continue") };
    return { review: review("complete", { criteria: [{ criterion: "La prueba pasa.", met: true, evidence: "" }] }) };
  } });
  t.after(() => d.close());
  d.start(d.addProject(projectInput(dir2)).id);
  await settled(d);
  assert.equal(d.active.status, "error");
  assert.match(d.active.error, new RegExp(`no entregó una revisión válida en ${MAX_REVIEW_FIXES} intentos.*Falta evidencia`));
  assert.equal(seen.length, 1 + MAX_REVIEW_FIXES);
  assert.match(seen.at(-1), /RESPUESTA ANTERIOR RECHAZADA: Falta evidencia/, "sin sesión, el prompt completo lleva el motivo");
  assert.equal(d.memory.listFacts(d.active.projectId, { kind: "recovery" }).length >= 3, true);
});

test("si Claude agota sus turnos el trabajo parcial pasa a verificación y el director decide", async (t) => {
  const dir = fixture(), calls = [];
  let codes = 0;
  const c = coordinator(dir, { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.role === "coder") {
      if (++codes === 1) throw Object.assign(new Error("Claude terminó sin reporte final."), { subtype: "error_max_turns", role: "coder", agent: true, progressed: true, lastMessage: "Voy a la mitad." });
      return { text: "Terminado" };
    }
    return { review: review(a.phase === "review" ? calls.filter((x) => x === "auditor:review").length === 1 ? "continue" : "complete" : "continue") };
  } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls, ["auditor:plan", "coder:code", "auditor:review", "coder:code", "auditor:review"]);
  assert.ok(c.events.some((e) => /alcanzó el máximo de turnos/.test(e.text)));
  assert.match(fs.readFileSync(path.join(c.store.runDir(c.active.id), "round-01", "coder-report.md"), "utf8"), /Voy a la mitad[\s\S]*máximo de turnos/);
});

test("al cerrar y volver a abrir con autoResume el trabajo sigue solo, y un resultado ya terminado no se repite", async (t) => {
  // A run saved mid-round: the coder had finished (its result file exists for the attempt in flight)
  // but Automata closed before recording it.
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const runDir = store.runDir("run-1"), work = path.join(runDir, "round-01");
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(work, "code-result.json"), JSON.stringify({ attemptId: "attempt-7", text: "Reporte recuperado", sessionId: "s1" }));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  store.write("runs.json", [{ id: "run-1", projectId: "p", project, settings: validateSettings(), status: "running", stage: "code", round: 1, codeStarted: 1, nextPrompt: "Haz X", baseline: "", coderReport: "", checks: [], tokens: 0, costUsd: 0, sessions: {}, gitQueue: [], inflight: { id: "attempt-7", role: "coder", phase: "code", index: 0, dir: work, round: 1 } }]);
  const calls = [];
  const c = new Coordinator(store, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    return a.role === "coder" ? { text: "no debería llamarse" } : { review: review("complete") };
  } } });
  t.after(() => c.close());
  assert.equal(c.active.status, "interrupted");
  assert.equal(c.active.stage, "code", "la etapa no cambia cuando el resultado ya existe");
  c.startAutoResume();
  await new Promise((r) => setTimeout(r, 20));
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls, ["auditor:review"], "Claude no se vuelve a llamar");
  assert.equal(c.active.coderReport, "Reporte recuperado");
  assert.equal(c.active.sessions["coder:0"], "s1");
  assert.ok(c.events.some((e) => /ya había terminado esta operación antes del cierre/.test(e.text)));
  assert.ok(c.events.some((e) => /reanuda el trabajo interrumpido/.test(e.text)));
  // Without a stored result the partial work is checked and reviewed, as before.
  const store2 = new Store(path.join(fixture(), "data"));
  store2.write("projects.json", [project]);
  store2.write("runs.json", [{ id: "run-2", projectId: "p", project, settings: validateSettings(), status: "running", stage: "code", round: 1, codeStarted: 1, nextPrompt: "Haz X", checks: [], sessions: {}, gitQueue: [], inflight: { id: "nope", role: "coder", phase: "code", index: 0, dir: work, round: 1 } }]);
  const d = new Coordinator(store2, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run(a) { calls.push("d:" + a.phase); return a.role === "coder" ? { text: "x" } : { review: review("complete") }; } } });
  t.after(() => d.close());
  assert.equal(d.active.stage, "checks");
  assert.equal(d.active.inflight, null);
  d.startAutoResume();
  await new Promise((r) => setTimeout(r, 20));
  await settled(d);
  assert.equal(d.active.status, "complete");
  assert.deepEqual(calls.filter((x) => x.startsWith("d:")), ["d:review"]);
  // autoResume off: the run waits for Continuar.
  const store3 = new Store(path.join(fixture(), "data"));
  store3.write("settings.json", { ...validateSettings(), autoResume: false });
  store3.write("projects.json", [project]);
  store3.write("runs.json", [{ id: "run-3", projectId: "p", project, settings: validateSettings(), status: "running", stage: "plan", round: 0, checks: [], sessions: [], gitQueue: [] }]);
  const e = new Coordinator(store3, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("e"); return { review: review("continue") }; } } });
  t.after(() => e.close());
  e.startAutoResume();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(e.active.status, "interrupted");
  assert.equal(calls.includes("e"), false);
});

test("un trabajo detenido o pausado a propósito nunca se reanuda solo, y cerrar Automata no cuenta como Detener", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  store.write("runs.json", [
    { id: "stopped", projectId: "p", project, settings: validateSettings(), status: "stopped", stage: "review", round: 1, checks: [], sessions: {}, gitQueue: [] },
    { id: "paused", projectId: "p", project, settings: validateSettings(), status: "paused", stage: "review", round: 1, checks: [], sessions: {}, gitQueue: [] }
  ]);
  const calls = [];
  const c = new Coordinator(store, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run(a) { calls.push(a.phase); return { review: review("complete") }; } } });
  t.after(() => c.close());
  c.startAutoResume();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(calls, []);
  assert.deepEqual(c.runs.map((r) => r.status), ["stopped", "paused"]);
  // Closing while the coder works leaves the run interrupted (by the shutdown), not stopped.
  const dir2 = fixture();
  let started;
  const ready = new Promise((r) => started = r);
  const d = coordinator(dir2, { async run(a) {
    if (a.role === "coder") { started(); await new Promise((r) => a.signal.addEventListener("abort", () => r(), { once: true })); throw Object.assign(new Error("Ejecución detenida."), { name: "AbortError" }); }
    return { review: review("continue") };
  } });
  d.start(d.addProject(projectInput(dir2)).id);
  await ready;
  await d.close();
  const saved = new Store(path.join(dir2, "data")).read("runs.json")[0];
  assert.equal(saved.status, "interrupted");
  assert.equal(saved.interruptedBy, "close");
  // Reopened: it is picked up again (stage code → checks, since the coder was cut).
  const e = new Coordinator(new Store(path.join(dir2, "data")), { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run(a) { calls.push("e:" + a.phase); return a.role === "coder" ? { text: "x" } : { review: review("complete") }; } } });
  t.after(() => e.close());
  assert.equal(e.active.status, "interrupted");
  assert.equal(e.active.stage, "checks");
  e.startAutoResume();
  await new Promise((r) => setTimeout(r, 20));
  await settled(e);
  assert.equal(e.active.status, "complete");
  assert.deepEqual(calls, ["e:review"]);
});

test("una espera guardada sobrevive al reinicio, y Pausar o Detener durante la espera tienen prioridad", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  const waiting = (resumeAt) => ({ id: "w", projectId: "p", project, settings: validateSettings(), status: "waiting", stage: "review", round: 1, checks: [], sessions: {}, gitQueue: [], waiting: { kind: "limit", role: "auditor", reason: "límite", resumeAt, reliable: true, attempt: 1, maxAttempts: 8, stage: "review", round: 1 }, resumeAt, recovery: { attempts: { limit: 1 }, log: [], waits: 1 } });
  // Appointment already passed: resumes right after startup.
  store.write("runs.json", [waiting(new Date(Date.now() - 1000).toISOString())]);
  const calls = [];
  const c = new Coordinator(store, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run(a) { calls.push(a.phase); return { review: review("complete") }; } } });
  t.after(() => c.close());
  assert.equal(c.active.status, "waiting");
  c.startAutoResume();
  await resumed(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls, ["review"]);
  assert.ok(c.active.recovery.log.some((e) => e.kind === "shutdown" && e.waiting === "limit"));
  // Future appointment: still waiting; Stop cancels it for good.
  const store2 = new Store(path.join(fixture(), "data"));
  store2.write("projects.json", [project]);
  store2.write("runs.json", [waiting(new Date(Date.now() + 150).toISOString())]);
  const d = new Coordinator(store2, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("d"); return { review: review("complete") }; } } });
  t.after(() => d.close());
  d.startAutoResume();
  assert.equal(d.active.status, "waiting");
  assert.throws(() => d.start("p"), /Continúa o detén/);
  d.control("stop");
  assert.equal(d.active.status, "stopped");
  assert.equal(d.active.waiting, undefined);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.includes("d"), false, "detenido no se reanuda cuando llega la hora");
  // Pause while waiting: no retry until Continuar.
  const store3 = new Store(path.join(fixture(), "data"));
  store3.write("projects.json", [project]);
  store3.write("runs.json", [waiting(new Date(Date.now() + 150).toISOString())]);
  const e = new Coordinator(store3, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("e"); return { review: review("complete") }; } } });
  t.after(() => e.close());
  e.startAutoResume();
  e.control("pause");
  assert.equal(e.active.status, "paused");
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.includes("e"), false);
  e.control("resume");
  await settled(e);
  assert.equal(e.active.status, "complete");
  // Continuar while waiting skips the wait.
  const store4 = new Store(path.join(fixture(), "data"));
  store4.write("projects.json", [project]);
  store4.write("runs.json", [waiting(new Date(Date.now() + 6e4).toISOString())]);
  const f = new Coordinator(store4, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("f"); return { review: review("complete") }; } } });
  t.after(() => f.close());
  f.startAutoResume();
  f.control("resume");
  await settled(f);
  assert.equal(f.active.status, "complete");
  assert.equal(calls.filter((x) => x === "f").length, 1);
  // With autoResume off a saved wait becomes "interrupted" and nothing fires.
  const store5 = new Store(path.join(fixture(), "data"));
  store5.write("settings.json", { ...validateSettings(), autoResume: false });
  store5.write("projects.json", [project]);
  store5.write("runs.json", [waiting(new Date(Date.now() - 1000).toISOString())]);
  const g = new Coordinator(store5, { evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("g"); return { review: review("complete") }; } } });
  t.after(() => g.close());
  g.startAutoResume();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(g.active.status, "interrupted");
  assert.equal(calls.includes("g"), false);
});

test("si las cuentas no están listas al reanudar solo, el trabajo espera un poco más en vez de fallar", async (t) => {
  const dir = fixture(), calls = [];
  let allow = false;
  const c = coordinator(dir, { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.role === "coder") return { text: "x" };
    if (calls.length === 1) throw Object.assign(new Error("fetch failed"), { role: "auditor", agent: true });
    return { review: review(a.phase === "review" ? "complete" : "continue") };
  } }, { beforeResume: async () => { if (!allow) throw new Error("Conecta Codex en Cuentas antes de continuar."); } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "waiting");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(c.active.status, "waiting", "sigue esperando, no falla");
  assert.ok(c.events.some((e) => /No se pudo reanudar solo: Conecta Codex/.test(e.text)));
  assert.ok(Date.parse(c.active.resumeAt) - Date.now() > 4 * 6e4, "vuelve a intentar en unos 5 minutos");
  assert.equal(calls.length, 1);
  allow = true;
  c.control("resume");
  await settled(c);
  assert.equal(c.active.status, "complete");
});

test("un mensaje interrumpido conserva las respuestas que ya tenía y solo pregunta a los agentes que faltan", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  // The coder had answered; the director's result file exists for the attempt that was in flight.
  const chatDir = path.join(store.directory, "chats", "m1", "auditor");
  fs.mkdirSync(chatDir, { recursive: true });
  fs.writeFileSync(path.join(chatDir, "chat-result.json"), JSON.stringify({ attemptId: "a-9", text: "Respuesta del director recuperada" }));
  store.write("messages.json", [
    { id: "m1", projectId: "p", target: "both", kind: "question", text: "¿Cómo va?", status: "processing", activeRole: "auditor", answers: [{ role: "coder", text: "Claude ya respondió" }], inflight: { id: "a-9", role: "auditor", phase: "chat", dir: chatDir } },
    { id: "m2", projectId: "p", target: "coder", kind: "task", text: "Haz un README.", status: "processing", activeRole: "coder", answers: [], inflight: { id: "a-10", role: "coder", phase: "task", dir: path.join(store.directory, "chats", "m2", "coder") } }
  ]);
  const calls = [];
  const c = new Coordinator(store, { resumeDelayMs: 0, agents: { async run(a) { calls.push({ role: a.role, phase: a.phase, prompt: a.prompt }); return { text: `Respuesta de ${a.role}` }; } } });
  t.after(() => c.close());
  const [m1, m2] = c.messages;
  assert.equal(m1.status, "queued");
  assert.deepEqual(m1.answers.map((a) => [a.role, a.text, !!a.recovered]), [["coder", "Claude ya respondió", false], ["auditor", "Respuesta del director recuperada", true]]);
  assert.equal(m2.status, "queued");
  c.startAutoResume();
  await c.chatPending;
  await settled(c);
  assert.equal(m1.status, "answered");
  assert.equal(m2.status, "answered");
  assert.deepEqual(calls.map((x) => `${x.role}:${x.phase}`), ["coder:task"], "solo la tarea sin respuesta se vuelve a pedir");
  assert.match(calls[0].prompt, /un intento anterior de esta misma petición se interrumpió[\s\S]*no lo repitas/);
  assert.equal("inflight" in c.snapshot().messages[0], false);
});

test("una operación de Git que corría al cerrar queda como incierta y no se repite sola; el usuario decide", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  store.write("runs.json", [{ id: "g", projectId: "p", project, settings: validateSettings(), status: "complete", stage: "complete", round: 2, checks: [], sessions: {}, gitQueue: [
    { id: "i1", kind: "push", status: "pending", startedAt: "2026-10-27T00:00:00Z", round: 2 },
    { id: "i2", kind: "merge", into: "main", status: "pending", round: 2 }
  ] }]);
  const git = { calls: [], inspect: async () => ({ repo: true }), push: async () => { git.calls.push("push"); return { ok: true, summary: "Push de main" }; }, merge: async () => ({ ok: true, summary: "merge" }), commit: async () => ({ ok: true }), branch: async () => ({ ok: true }) };
  const c = new Coordinator(store, { git, resumeDelayMs: 0 });
  t.after(() => c.close());
  const [uncertain, pending] = c.runs[0].gitQueue;
  assert.equal(uncertain.status, "uncertain");
  assert.match(uncertain.error, /Comprueba el resultado/);
  assert.equal(pending.status, "pending", "una operación que nunca empezó sigue pendiente de aprobación");
  c.startAutoResume();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(git.calls, []);
  await c.resolveGit("g", "i1", "approve");
  assert.deepEqual(git.calls, ["push"]);
  assert.equal(uncertain.status, "done");
});

test("si Automata se cierra mientras aplica la decisión del director, al reabrir no vuelve a preguntarle ni repite el commit", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const project = { ...projectInput(dir), id: "p" };
  store.write("projects.json", [project]);
  const decided = { ...review("complete"), git: { commit: true, message: "feat: hito", push: false, branch: "", mergeInto: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] } };
  store.write("runs.json", [{ id: "a", projectId: "p", project, settings: { ...validateSettings(), gitMode: "auto" }, status: "running", stage: "apply", round: 1, checks: [], sessions: {}, review: decided, gitQueue: [{ id: "c1", kind: "commit", message: "feat: hito", status: "done", round: 1, summary: "Commit abc" }] }]);
  const calls = [], git = { inspect: async () => ({ repo: true }), commit: async () => { calls.push("commit"); return { ok: true, summary: "Commit otra vez" }; } };
  const c = new Coordinator(store, { git, evidence: async () => "", checks: async () => [], resumeDelayMs: 0, agents: { async run() { calls.push("agent"); return { review: review("complete") }; } } });
  t.after(() => c.close());
  c.startAutoResume();
  await new Promise((r) => setTimeout(r, 20));
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls, [], "ni el director ni Git se vuelven a ejecutar");
  assert.equal(c.active.gitQueue.length, 1);
});

function cliStub(dir, body) {
  const stub = path.join(dir, "cli.mjs");
  fs.writeFileSync(stub, `import fs from 'node:fs';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2);${body}`);
  return stub;
}
async function withStubs(t, stub, work) {
  const before = { coder: process.env.AUTOMATA_CLAUDE, auditor: process.env.AUTOMATA_CODEX };
  process.env.AUTOMATA_CLAUDE = process.env.AUTOMATA_CODEX = stub;
  t.after(() => {
    for (const [role, key] of [["coder", "AUTOMATA_CLAUDE"], ["auditor", "AUTOMATA_CODEX"]]) if (before[role] === void 0) delete process.env[key];
    else process.env[key] = before[role];
  });
  await work();
}

test("las CLI simuladas producen errores clasificables: límite con hora, aviso de límite de Claude, turnos y error de Codex", async (t) => {
  const dir = fixture(), agents = new CliAgents(), settings = validateSettings(), project = projectInput(dir);
  const base = { project, settings, directory: dir, emit: () => {}, fallbackPrompt: "largo" };
  const epoch = Math.floor(Date.now() / 1e3) + 900;
  // Claude: a rate_limit_event followed by a failed result without a readable time.
  await withStubs(t, cliStub(dir, `console.log(JSON.stringify({type:'system',subtype:'rate_limit_event',rate_limit_info:{status:'rejected',rate_limit_type:'five_hour',resets_at:${epoch}}}));console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,result:'Usage limit reached',session_id:'s'}));process.exit(1);`), async () => {
    const error = await agents.run({ ...base, role: "coder", phase: "code", prompt: "x" }).catch((e) => e);
    const verdict = classifyError(error);
    assert.equal(verdict.kind, "limit");
    assert.equal(verdict.resumeAt, epoch * 1e3);
    assert.equal(error.role, "coder");
    assert.equal(error.agent, true);
  });
  // Claude: out of turns, with work done.
  await withStubs(t, cliStub(dir, `console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'t',name:'Write',input:{file_path:'a.js',content:'1'}}]}}));console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,num_turns:20,session_id:'s'}));`), async () => {
    const error = await agents.run({ ...base, role: "coder", phase: "code", prompt: "x" }).catch((e) => e);
    assert.equal(classifyError(error).kind, "turns");
    assert.equal(error.progressed, true);
    assert.equal(error.subtype, "error_max_turns");
  });
  // Codex: an error event with a usage-limit code and a retry time in the text.
  await withStubs(t, cliStub(dir, `console.log(JSON.stringify({type:'thread.started',thread_id:'th'}));console.log(JSON.stringify({type:'error',message:"You've hit your usage limit. Try again in 1 hours 30 minutes.",error:{type:'usage_limit_exceeded'}}));process.exit(1);`), async () => {
    const error = await agents.run({ ...base, role: "auditor", phase: "review", prompt: "x" }).catch((e) => e);
    const verdict = classifyError(error);
    assert.equal(verdict.kind, "limit");
    assert.ok(verdict.resumeAt > Date.now() + 89 * 6e4 && verdict.resumeAt <= Date.now() + 91 * 6e4);
    assert.equal(error.failureCode, "usage_limit_exceeded");
    assert.equal(error.rateLimit.status, "rejected");
  });
  // Codex: a transient stream failure; and a session resume refused by a limit is not retried as a new session.
  await withStubs(t, cliStub(dir, `console.log(JSON.stringify({type:'turn.failed',error:{message:'stream disconnected before completion: Transport error'}}));process.exit(1);`), async () => {
    const error = await agents.run({ ...base, role: "auditor", phase: "review", prompt: "x" }).catch((e) => e);
    assert.equal(classifyError(error).kind, "transient");
  });
  const calls = path.join(dir, "calls.txt");
  await withStubs(t, cliStub(dir, `fs.appendFileSync(${JSON.stringify(calls)},'call\\n');console.error("You've hit your usage limit");process.exit(1);`), async () => {
    const error = await agents.run({ ...base, role: "coder", phase: "code", prompt: "corto", agent: { model: "sonnet", effort: "default", resume: "vieja" } }).catch((e) => e);
    assert.equal(classifyError(error).kind, "limit");
    assert.equal(fs.readFileSync(calls, "utf8").split("\n").filter(Boolean).length, 1, "con un límite no se abre otra sesión");
  });
  // A successful attempt leaves its result file, keyed by the attempt id.
  await withStubs(t, cliStub(dir, `console.log(JSON.stringify({type:'result',result:'Reporte',is_error:false,session_id:'ok'}));`), async () => {
    const result = await agents.run({ ...base, role: "coder", phase: "code", prompt: "x", attemptId: "att-1" });
    assert.equal(result.text, "Reporte");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "code-result.json"), "utf8"));
    assert.equal(saved.attemptId, "att-1");
    assert.equal(saved.text, "Reporte");
    assert.match(fs.readFileSync(path.join(dir, "code-coder.jsonl"), "utf8"), /"automata":"attempt","id":"att-1"/);
  });
});

test("la configuración valida autoResume, maxRetries e inicio con Windows, y la API expone y controla la espera", async (t) => {
  assert.equal(validateSettings().autoResume, true);
  assert.equal(validateSettings().autoStart, false);
  assert.equal(validateSettings().maxRetries, 4);
  assert.throws(() => validateSettings({ maxRetries: 11 }), /maxRetries/);
  assert.throws(() => validateSettings({ autoResume: "sí" }), /autoResume/);
  const dir = fixture();
  let fail = true;
  const demoReview = (decision) => ({ ...review(decision), criteria: [{ criterion: "El saludo incluye el nombre y la prueba pasa.", met: decision === "complete", evidence: "ok" }] });
  const app = await createServer({ port: 0, demo: true, dataDir: path.join(dir, "data"), backoff: FAST, checks: async (p) => p.checks.map((command) => ({ command, passed: true, code: 0, output: "ok" })), agents: { async run(a) {
    if (a.role === "coder") return { text: "x" };
    if (fail) { fail = false; throw Object.assign(new Error("overloaded_error: Overloaded"), { role: "auditor", agent: true }); }
    return { review: demoReview(a.phase === "review" ? "complete" : "continue") };
  } } });
  t.after(() => app.close());
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const caps = await (await fetch(app.origin + "/api/capabilities", { headers })).json();
  assert.equal(caps.features.autoResume, true);
  assert.equal(typeof caps.features.loginItem, "boolean");
  app.coordinator.start("demo");
  await settled(app.coordinator);
  assert.equal(app.coordinator.active.status, "waiting");
  const state = await (await fetch(app.origin + "/api/state", { headers })).json();
  assert.equal(state.runs[0].status, "waiting");
  assert.equal(state.runs[0].waiting.role, "auditor");
  // Continuar over HTTP skips the wait.
  const resume = await fetch(app.origin + "/api/control", { method: "POST", headers, body: JSON.stringify({ action: "resume", runId: state.runs[0].id }) });
  assert.equal(resume.status, 200);
  await settled(app.coordinator);
  assert.equal(app.coordinator.active.status, "complete");
  const saved = await fetch(app.origin + "/api/settings", { method: "PUT", headers, body: JSON.stringify({ ...app.coordinator.settings, autoResume: false, maxRetries: 2 }) });
  assert.equal((await saved.json()).maxRetries, 2);
  assert.equal(app.coordinator.settings.autoResume, false);
});

test("los identificadores de las CLI no se confunden con secretos, pero una clave de la misma forma sí se oculta", () => {
  const line = JSON.stringify({ type: "user", message: { content: [{ tool_use_id: "toolu_01GSpbcSgkWBsEfbk3CSDRCQ9Xy2Lm", id: "msg_011CgRrYqJ87t9bVKmtdkxZgAb12Cd", type: "tool_result" }] } });
  assert.equal(redactSecrets(line), line, "los ids de herramientas y mensajes siguen enteros");
  assert.doesNotMatch(redactSecrets("key: Ab3dEf7gHi9jKl2mNo5pQr8sTu1vWx4yZa6b"), /Ab3dEf7gHi9jKl2mNo5pQr8sTu1vWx4yZa6b/);
  assert.doesNotMatch(redactSecrets("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"), /sk-ant/);
});

test("la memoria marca los recuerdos que mencionan archivos borrados sin retirarlos, y los prompts llevan el aviso", async (t) => {
  const dir = fixture();
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "suma.mjs"), "");
  fs.writeFileSync(path.join(dir, "package.json"), "{}");
  assert.deepEqual(staleMentions("Las pruebas están en test/subtotal.test.mjs y la suma en src/suma.mjs", dir), ["test/subtotal.test.mjs"]);
  assert.deepEqual(staleMentions("Revisa package.json y suma.mjs; usa npm test y node --test", dir), [], "nombres sueltos que existen en los dos primeros niveles no se marcan");
  assert.deepEqual(staleMentions("Archivo borrado: C:\\no\\existe\\x.mjs y https://ejemplo.com/a.js", dir), ["C:\\no\\existe\\x.mjs"]);
  assert.deepEqual(staleMentions("Sin archivos: compilar con JDK 21, e.g. gradle", dir), []);
  const c = coordinator(dir, { async run() { return { text: "x" }; } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  c.memory.addFact(p.id, { kind: "decision", text: "La prueba vive en test/vieja.test.mjs", source: "coder" });
  c.memory.addFact(p.id, { kind: "env", text: "Node 24", source: "coder" });
  const listed = c.memoryAction({ projectId: p.id, action: "list" });
  assert.deepEqual(listed.facts.map((f) => f.stale), [[], ["test/vieja.test.mjs"]]);
  assert.equal(listed.facts.every((f) => f.status === "active"), true, "no se retira nada solo");
  assert.match(c.memoryBrief(p.id, { query: "prueba" }), /test\/vieja\.test\.mjs \(⚠ ya no existe: test\/vieja\.test\.mjs\)/);
  assert.doesNotMatch(c.memoryBrief(p.id, { query: "prueba" }), /Node 24 \(⚠/);
});
