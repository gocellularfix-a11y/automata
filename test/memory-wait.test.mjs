import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Coordinator } from "../server/coordinator.mjs";
import { Store } from "../server/store.mjs";
import { createChecker } from "../server/resources.mjs";

// A wait of hours without waiting hours: Date and setTimeout are replaced by a clock the test moves by hand.
// The default backoff is used on purpose (memory 1, 2, 5, then every 10 minutes; passing failures 30 s, 2, 5, 10 min).
const MIN = 6e4, HOUR = 60 * MIN;
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
const advance = async (t, ms) => {
  for (let left = ms; left > 0; left -= Math.min(left, MIN)) {
    t.mock.timers.tick(Math.min(left, MIN));
    await flush();
  }
};
// Real time is only used to let the run's own file and git work finish; nothing here sleeps on the mocked clock.
// With `t`, the mocked clock also moves a little on every turn: the review waits 50 ms for the file watcher.
const until = async (condition, ms = 10000, t = null) => {
  const limit = process.hrtime.bigint() + BigInt(ms) * 1000000n;
  while (!condition() && process.hrtime.bigint() < limit) {
    if (t) t.mock.timers.tick(50);
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const review = { decision: "complete", summary: "ok", nextPrompt: "", task: "", files: [], findings: [], criteria: [{ criterion: "Funciona", met: true, evidence: "visto" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: null };

// A coordinator whose memory the test controls. `state.low` makes every reading short; `state.dropInCoder` makes it
// short as soon as Claude finishes, so the run waits at the checks with its report and stage already saved.
function rig(t, dir, state, { coder } = {}) {
  const resources = createChecker({ read: async () => { state.reads++; return { totalMB: 64000, freeMB: state.low ? 600 : 8000, commitFreeMB: 20000 }; }, limits: () => ({ freeMB: 1536, commitMB: 2048 }), ttlMs: 0 });
  const all = [];
  const make = () => all[all.push(new Coordinator(new Store(path.join(dir, "data")), { resources, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    state.calls.push(a.role);
    if (a.role === "coder") {
      if (state.dropInCoder) state.low = true;
      return coder ? coder(a) : { text: "Hecho" };
    }
    return { review: a.phase === "plan" ? { ...review, decision: "continue", nextPrompt: "Haz", criteria: [] } : review };
  } } })) - 1];
  const c = make();
  // Every coordinator is closed before the folder goes away.
  t.after(async () => {
    for (const x of all) await x.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { c, make };
}
const setup = (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 9, 28, 20, 0, 0) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-memwait-")), folder = path.join(dir, "p");
  fs.mkdirSync(folder);
  return { dir, folder, state: { low: false, dropInCoder: false, reads: 0, calls: [] } };
};
const project = (c, folder) => c.addProject({ name: "P", directory: folder, objective: "Hacer algo útil y probarlo.", criteria: ["Funciona"], checks: [] }).id;
const waitingForMemory = async (c) => { await until(() => c.active.status === "waiting"); assert.equal(c.active.status, "waiting"); assert.equal(c.active.waiting.memory, true); };

test("ocho horas sin memoria: el trabajo sigue en espera, no gasta reintentos ni cuota de esperas, sondea poco y sigue solo al volver", async (t) => {
  const { dir, folder, state } = setup(t);
  state.dropInCoder = true;
  const { c } = rig(t, dir, state);
  c.start(project(c, folder));
  await waitingForMemory(c);
  const r = c.active, id = r.id, eventsBefore = c.events.length;
  assert.equal(r.stage, "checks", "espera justo antes de las verificaciones");
  assert.equal(r.coderReport, "Hecho");
  assert.deepEqual(state.calls, ["auditor", "coder"]);

  await advance(t, 8 * HOUR);
  assert.equal(c.active.id, id);
  assert.equal(c.active.status, "waiting", "sigue esperando, no pasó a error");
  assert.equal(c.active.waiting.memory, true);
  assert.deepEqual(state.calls, ["auditor", "coder"], "ningún agente se abrió durante la espera");
  assert.equal(r.recovery.attempts.transient ?? 0, 0, "no se gastó ningún reintento de errores");
  assert.equal(r.recovery.waits, 0, "tampoco la cuota de esperas por trabajo");
  assert.equal(r.waiting.attempt, undefined);
  assert.equal(r.waiting.maxAttempts, undefined, "sin «intento X de Y»");
  assert.equal(r.status, "waiting");
  // Few readings in 8 hours (1, 2, 5, then every 10 minutes), and one record instead of one line per reading.
  const w = r.recovery.memoryWait;
  assert.equal(w.checks, state.reads - 2, "las lecturas del registro son las hechas (antes hubo una por el plan y otra por Claude)");
  assert.ok(w.checks >= 40 && w.checks <= 60, `lecturas: ${w.checks}`);
  assert.equal(w.minFreeMB, 600);
  assert.ok(Date.now() - Date.parse(w.since) >= 8 * HOUR);
  assert.ok(r.recovery.log.length <= 3, `registro de recuperación: ${r.recovery.log.length}`);
  assert.ok(c.events.length - eventsBefore <= 1, `eventos nuevos en 8 h: ${c.events.length - eventsBefore}`);
  assert.equal(c.events.filter((e) => e.kind === "wait" && /Poca memoria libre en la PC/.test(e.text)).length, 1);
  assert.deepEqual(c.events.filter((e) => e.kind === "warning" && /memoria|reanudar/i.test(e.text)), [], "sin avisos repetidos por cada lectura");
  assert.ok(Date.parse(r.waiting.resumeAt) - Date.now() <= 10 * MIN, "el intervalo se queda en 10 minutos");

  // The memory is back: the next appointment continues by itself, from the same stage, without repeating Claude.
  state.low = false;
  await advance(t, 10 * MIN);
  await until(() => c.active.status === "complete", 10000, t);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.id, id);
  assert.equal(state.calls.filter((x) => x === "coder").length, 1, "Claude no repitió el trabajo");
  assert.equal(r.recovery.attempts.transient ?? 0, 0);
  assert.equal(r.recovery.waits, 0);
  assert.equal(r.recovery.memoryWait, undefined);
  assert.equal(r.recovery.memoryWaits.length, 1);
  assert.equal(r.recovery.memoryWaits[0].how, "auto");
  assert.ok(r.recovery.memoryWaits[0].ms >= 8 * HOUR);
  assert.ok(c.events.some((e) => /Ya hay memoria suficiente \(esperó \d+ min, \d+ lecturas\)/.test(e.text)));
});

test("la espera por memoria sobrevive a un reinicio de Automata, sigue sin abrir agentes y continúa sola cuando hay memoria", async (t) => {
  const { dir, folder, state } = setup(t);
  state.dropInCoder = true;
  const { c, make } = rig(t, dir, state);
  c.start(project(c, folder));
  await waitingForMemory(c);
  await advance(t, 3 * HOUR);
  const before = { id: c.active.id, stage: c.active.stage, round: c.active.round, report: c.active.coderReport, checks: c.active.recovery.memoryWait.checks, since: c.active.recovery.memoryWait.since };
  await c.close();

  // Automata starts again two hours later with the memory still short.
  t.mock.timers.tick(2 * HOUR);
  const c2 = make();
  assert.equal(c2.active.status, "waiting", "la espera se recuperó del disco");
  assert.equal(c2.active.waiting.memory, true);
  assert.equal(c2.active.id, before.id);
  assert.equal(c2.active.stage, before.stage);
  assert.equal(c2.active.round, before.round);
  assert.equal(c2.active.coderReport, before.report);
  assert.equal(c2.active.recovery.memoryWait.since, before.since, "es la misma espera, no una nueva");
  c2.startAutoResume();
  await advance(t, 2 * HOUR);
  assert.equal(c2.active.status, "waiting");
  assert.deepEqual(state.calls, ["auditor", "coder"], "tras reiniciar tampoco se abrió ningún agente");
  assert.ok(c2.active.recovery.memoryWait.checks > before.checks);
  assert.equal(c2.active.recovery.attempts.transient ?? 0, 0);
  assert.equal(c2.active.recovery.waits, 0);

  state.low = false;
  await advance(t, 10 * MIN);
  await until(() => c2.active.status === "complete", 10000, t);
  assert.equal(c2.active.status, "complete", c2.active.error);
  assert.equal(state.calls.filter((x) => x === "coder").length, 1);
  assert.equal(c2.active.recovery.memoryWaits[0].how, "auto");
});

test("Pausar y Detener mandan sobre la espera por memoria: nada se lee ni se reanuda, ni aunque vuelva la memoria", async (t) => {
  const { dir, folder, state } = setup(t);
  state.dropInCoder = true;
  const { c } = rig(t, dir, state);
  c.start(project(c, folder));
  await waitingForMemory(c);
  await advance(t, 2 * HOUR);

  c.control("pause");
  assert.equal(c.active.status, "paused");
  assert.equal(c.active.recovery.memoryWait, undefined);
  assert.equal(c.active.recovery.memoryWaits.at(-1).how, "pause");
  const readsAtPause = state.reads;
  state.low = false;
  await advance(t, 3 * HOUR);
  assert.equal(c.active.status, "paused", "la memoria que vuelve no reanuda lo que el usuario pausó");
  assert.equal(state.reads, readsAtPause, "pausado no se sondea");
  assert.deepEqual(state.calls, ["auditor", "coder"]);

  // Continuar with the memory short again: it waits again, still spending nothing.
  state.low = true;
  c.control("resume");
  await waitingForMemory(c);
  assert.equal(c.active.stage, "checks");
  assert.equal(c.active.recovery.attempts.transient ?? 0, 0);
  assert.equal(c.active.recovery.waits, 0);

  // Detener ends the wait for good.
  c.control("stop");
  assert.equal(c.active.status, "stopped");
  assert.equal(c.active.waiting, undefined);
  const readsAtStop = state.reads;
  state.low = false;
  await advance(t, 3 * HOUR);
  assert.equal(c.active.status, "stopped");
  assert.equal(state.reads, readsAtStop, "detenido no se sondea");
  assert.deepEqual(state.calls, ["auditor", "coder"]);
  assert.equal(c.active.recovery.memoryWaits.at(-1).how, "stop");
  assert.ok(c.active.recovery.memoryWaits.length <= 20);
});

test("Continuar con memoria otra vez disponible sigue desde la etapa guardada y termina", async (t) => {
  const { dir, folder, state } = setup(t);
  state.dropInCoder = true;
  const { c } = rig(t, dir, state);
  c.start(project(c, folder));
  await waitingForMemory(c);
  c.control("pause");
  state.low = false;
  c.control("resume");
  await until(() => c.active.status === "complete", 10000, t);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(state.calls.filter((x) => x === "coder").length, 1);
});

test("Pausar pedido mientras corre gana si en ese momento falta memoria: queda en pausa, no en espera", async (t) => {
  const { dir, folder, state } = setup(t);
  const { c } = rig(t, dir, state, { coder: async () => { c.control("pause"); state.low = true; return { text: "Hecho" }; } });
  c.start(project(c, folder));
  await until(() => c.active.status === "paused");
  assert.equal(c.active.status, "paused");
  assert.equal(c.active.waiting, undefined);
  await advance(t, 2 * HOUR);
  assert.equal(c.active.status, "paused");
});

test("los errores reales de Claude siguen teniendo límite aunque haya esperas por memoria en medio", async (t) => {
  const { dir, folder, state } = setup(t);
  let failures = 0;
  const { c } = rig(t, dir, state, { coder: async () => { failures++; throw Object.assign(new Error("ECONNRESET: connection reset"), { role: "coder", agent: true }); } });
  c.start(project(c, folder));
  const coderCalls = () => state.calls.filter((x) => x === "coder").length;
  // Two real failures, each followed by its normal wait.
  await until(() => coderCalls() === 1 && c.active.status === "waiting");
  await advance(t, MIN);
  await until(() => coderCalls() === 2 && c.active.status === "waiting");
  assert.equal(c.active.recovery.attempts.transient, 2);
  assert.equal(c.active.waiting.memory, undefined, "un fallo pasajero real no es una espera por memoria");
  // The PC runs short for three hours in the middle: that wait does not count as a third failure.
  state.low = true;
  await advance(t, 3 * HOUR);
  assert.equal(c.active.status, "waiting");
  assert.equal(c.active.waiting.memory, true);
  assert.equal(coderCalls(), 2, "con poca memoria no se abrió Claude");
  assert.equal(c.active.recovery.attempts.transient, 2, "la espera por memoria no sumó");
  state.low = false;
  await advance(t, 10 * MIN);
  // Back to the normal limits: maxRetries (4) waits and then it stops and asks.
  for (let i = 0; i < 40 && c.active.status !== "error"; i++) { await until(() => c.active.status !== "running", 3000); await advance(t, 10 * MIN); }
  assert.equal(c.active.status, "error");
  assert.equal(coderCalls(), 5, "1 intento + 4 reintentos: el límite de errores reales no cambió");
  assert.equal(c.active.recovery.attempts.transient, 5);
  assert.match(c.active.error, /Claude falló 5 veces seguidas/);
  assert.equal(c.active.recovery.waits, 4);
});
