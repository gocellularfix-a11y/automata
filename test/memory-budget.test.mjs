import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { treeUsage, readTree, budgetState, assess, createChecker, defaultBudget, DEFAULT_RAM_BUDGET_MB, NEW_PROCESS_RESERVE_MB } from "../server/resources.mjs";
import { descendantsOf } from "../server/procs.mjs";
import { DEFAULT_SETTINGS, validateSettings } from "../server/config.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { Store } from "../server/store.mjs";

const MB = 1024 * 1024;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proc = (pid, ppid, name, workingMB, privateMB = workingMB) => ({ pid, ppid, name, created: 1, workingSet: workingMB * MB, privateBytes: privateMB * MB });

test("el presupuesto es de 30 GiB por defecto, se puede fijar con la variable de entorno y se valida en Ajustes", () => {
  assert.equal(DEFAULT_RAM_BUDGET_MB, 30720);
  assert.equal(defaultBudget({}), 30720);
  assert.equal(defaultBudget({ AUTOMATA_RAM_BUDGET_MB: "40960" }), 40960);
  assert.equal(defaultBudget({ AUTOMATA_RAM_BUDGET_MB: "0" }), 0, "0 lo desactiva");
  assert.equal(defaultBudget({ AUTOMATA_RAM_BUDGET_MB: "mucho" }), 30720);
  assert.equal(defaultBudget({ AUTOMATA_RAM_BUDGET_MB: "-5" }), 30720);
  assert.equal(DEFAULT_SETTINGS.ramBudgetMB, defaultBudget(), "el valor inicial sale de la variable de entorno");
  assert.equal(validateSettings({ ramBudgetMB: 30720 }).ramBudgetMB, 30720);
  assert.equal(validateSettings({ ramBudgetMB: 0 }).ramBudgetMB, 0);
  assert.equal(validateSettings({ ramBudgetMB: "8192" }).ramBudgetMB, 8192);
  assert.throws(() => validateSettings({ ramBudgetMB: 512 }), /ramBudgetMB: usa 0 \(sin presupuesto\) o un número entre 2048 y 1048576/);
  assert.throws(() => validateSettings({ ramBudgetMB: -1 }), /ramBudgetMB/);
  assert.throws(() => validateSettings({ ramBudgetMB: 2e6 }), /ramBudgetMB/);
  assert.throws(() => validateSettings({ ramBudgetMB: 1.5 }), /ramBudgetMB/);
});

test("el consumo propio cuenta solo el árbol de Automata: ni el entrenamiento ni otras sesiones de Claude", () => {
  const table = [
    proc(100, 1, "node.exe", 300, 250),        // Automata
    proc(101, 100, "claude.exe", 700, 900),    // its Claude
    proc(102, 101, "node.exe", 200, 150),      // something Claude started
    proc(103, 100, "codex.exe", 400, 300),     // its Codex
    proc(104, 100, "powershell.exe", 80, 60),  // a check
    proc(200, 1, "python.exe", 58000, 3000),   // another program (training)
    proc(201, 200, "python.exe", 9000, 2700),
    proc(300, 1, "claude.exe", 480, 900),      // an interactive Claude session of the user
    proc(400, 100000, "node.exe", 500)         // parent that no longer exists
  ];
  assert.deepEqual(descendantsOf(table, 100).map((p) => p.pid).sort(), [100, 101, 102, 103, 104]);
  const use = treeUsage(table, 100);
  assert.deepEqual(use, { usedMB: 300 + 700 + 200 + 400 + 80, privateMB: 250 + 900 + 150 + 300 + 60, processes: 5, claudeMB: 700, codexMB: 400, nodeMB: 500 });
  assert.deepEqual(treeUsage(table, 999999), { usedMB: 0, privateMB: 0, processes: 0, claudeMB: 0, codexMB: 0, nodeMB: 0 });
});

test("el estado del presupuesto avisa antes de llegar al tope y reserva lugar para el siguiente proceso", () => {
  assert.equal(budgetState(100, 0), "off");
  assert.equal(budgetState(1000, 30720), "ok");
  assert.equal(budgetState(30720 * 0.85 - 1, 30720), "ok");
  assert.equal(budgetState(30720 * 0.85, 30720), "near");
  assert.equal(budgetState(30720 - NEW_PROCESS_RESERVE_MB + 1, 30720), "near", "no cabe otro proceso");
  assert.equal(budgetState(30720, 30720), "near", "justo en el tope todavía no es excederlo");
  assert.equal(budgetState(30721, 30720), "over");
  assert.equal(budgetState(500, 1000, 600), "near", "la reserva es ajustable");
});

test("la evaluación separa lo que usa Automata, lo que le queda al sistema y el margen de memoria virtual", () => {
  const limits = { freeMB: 1536, commitMB: 2048 };
  const memory = { totalMB: 64912, freeMB: 8000, commitFreeMB: 12000, tree: { usedMB: 2000, privateMB: 1800, processes: 4, claudeMB: 700, codexMB: 400, nodeMB: 800 } };
  const ok = assess(memory, limits, 30720);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.budget, { budgetMB: 30720, usedMB: 2000, state: "ok" });
  // Plenty of budget, but Windows and the other programs are short: the system reserve wins.
  const system = assess({ ...memory, freeMB: 900 }, limits, 30720);
  assert.equal(system.ok, false);
  assert.match(system.message, /quedan 900 MB de memoria libre en el sistema.*Windows y a otros programas/);
  assert.doesNotMatch(system.message, /presupuesto/);
  // Plenty of system memory, but Automata is at its own ceiling.
  const own = assess({ ...memory, tree: { ...memory.tree, usedMB: 30000 } }, limits, 30720);
  assert.equal(own.ok, false);
  assert.equal(own.budget.state, "near");
  assert.match(own.message, /Automata y sus procesos usan 30000 MB de su presupuesto de 30720 MB y no cabe otro proceso/);
  assert.match(own.message, /lo que ya está en marcha no se cierra/);
  // No headroom is a third, separate reason.
  assert.match(assess({ ...memory, commitFreeMB: 1000 }, limits, 30720).message, /solo puede asignar 1000 MB más/);
  // Budget off, or not measured: it never blocks by itself.
  assert.equal(assess({ ...memory, tree: { ...memory.tree, usedMB: 99999 } }, limits, 0).ok, true);
  assert.equal(assess({ ...memory, tree: null }, limits, 30720).budget.state, "off");
});

test("el verificador aplica el presupuesto vigente a la última lectura, sin releer, y puede forzarse", async () => {
  let reads = 0;
  const read = async () => ({ totalMB: 64000, freeMB: 8000, commitFreeMB: 12000, tree: { usedMB: 20000 + ++reads, privateMB: 0, processes: 3, claudeMB: 0, codexMB: 0, nodeMB: 0 } });
  const check = createChecker({ read, limits: () => ({ freeMB: 0, commitMB: 0 }), ttlMs: 60000 });
  assert.equal((await check({ budgetMB: 30720 })).ok, true);
  assert.equal((await check({ budgetMB: 21000 })).ok, false, "el presupuesto nuevo se aplica a la misma lectura");
  assert.equal(reads, 1);
  assert.equal((await check({ budgetMB: 30720, force: true })).memory.tree.usedMB, 20002);
});

test("con un presupuesto casi lleno el trabajo espera sin cerrar lo que corre, anota los máximos y sigue cuando baja", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-budget-")), folder = path.join(dir, "p");
  fs.mkdirSync(folder);
  let used = 1000, free = 9000, commit = 15000, aborted = false;
  const reading = () => ({ totalMB: 64912, freeMB: free, commitFreeMB: commit, tree: { usedMB: used, privateMB: used - 100, processes: 4, claudeMB: Math.round(used / 2), codexMB: Math.round(used / 4), nodeMB: 100 } });
  const resources = createChecker({ read: async () => reading(), limits: () => ({ freeMB: 1536, commitMB: 2048 }), ttlMs: 0 });
  const review = { decision: "complete", summary: "ok", nextPrompt: "", task: "", files: [], findings: [], criteria: [{ criterion: "Funciona", met: true, evidence: "visto" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: null };
  const calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { resources, monitorMs: 15, backoff: { transient: [60, 60, 60, 60], limit: [60], margin: 0 }, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    calls.push(a.role);
    if (a.role === "coder") {
      // While Claude works, Automata's processes grow past the budget and the system gets tight.
      used = 31000; free = 3000; commit = 5000;
      a.signal.addEventListener("abort", () => { aborted = true; });
      await wait(250);
      return { text: "Hecho" };
    }
    return { review: a.phase === "plan" ? { ...review, decision: "continue", nextPrompt: "Haz", criteria: [] } : review };
  } } });
  t.after(async () => { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  c.updateSettings({ ...c.settings, ramBudgetMB: 30720 });
  c.start(c.addProject({ name: "P", directory: folder, objective: "Hacer algo útil y probarlo.", criteria: ["Funciona"], checks: [] }).id);
  for (let i = 0; i < 200 && c.active.status !== "waiting"; i++) await wait(15);
  // The running call was not touched; the next thing to start (the checks) waits.
  assert.equal(c.active.status, "waiting");
  assert.equal(aborted, false, "nada de lo que corría se cerró");
  assert.deepEqual(calls, ["auditor", "coder"]);
  assert.equal(c.active.waiting.memory, true);
  assert.match(c.active.waiting.reason, /usan 31000 MB de su presupuesto de 30720 MB/);
  const over = c.events.filter((e) => /por encima de su presupuesto de 30720 MB/.test(e.text));
  assert.equal(over.length, 1, "se avisa una vez al cruzar el tope");
  assert.match(over[0].text, /los que ya están en marcha no se cierran \(el presupuesto se supervisa, no se impone\)/);
  // Everything measured is kept apart: Automata's own use, the system's free memory and the commit headroom.
  const m = c.active.memory;
  assert.equal(m.budgetMB, 30720);
  assert.equal(m.peakUsedMB, 31000);
  assert.equal(m.peakClaudeMB, 15500);
  assert.equal(m.minFreeMB, 3000);
  assert.equal(m.minCommitFreeMB, 5000);
  assert.ok(m.samples >= 3 && m.overSamples >= 1);
  assert.equal(m.state, "over");
  // Memory comes back: the run goes on by itself and finishes.
  used = 1200; free = 9000; commit = 15000;
  for (let i = 0; i < 300 && c.active.status !== "complete"; i++) await wait(20);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(c.active.memory.peakUsedMB, 31000, "el máximo no baja");
  assert.equal(c.snapshot().runs[0].memory.peakUsedMB, 31000, "el estado lo muestra");
});

test("con el presupuesto en 0 no se mide ni se bloquea nada por él", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-budget-")), folder = path.join(dir, "p");
  fs.mkdirSync(folder);
  let treeReads = 0;
  const resources = createChecker({ read: async ({ budget }) => ({ totalMB: 1, freeMB: 9000, commitFreeMB: 9000, tree: budget ? (treeReads++, { usedMB: 99999 }) : null }), limits: () => ({ freeMB: 0, commitMB: 0 }), ttlMs: 0 });
  const c = new Coordinator(new Store(path.join(dir, "data")), { resources, monitorMs: 10, evidence: async () => "", checks: async () => [], agents: { async run() { return { text: "x" }; } } });
  t.after(async () => { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  c.updateSettings({ ...c.settings, ramBudgetMB: 0 });
  assert.equal(await c.requireResources().then(() => "ok"), "ok");
  assert.equal(treeReads, 0);
  assert.equal(c.monitorTimer, null, "sin presupuesto no hay vigilancia periódica");
});

test("la lectura real del árbol (solo lectura) ve a este proceso y no inventa consumo", async () => {
  const use = await readTree(process.pid);
  assert.ok(use.processes >= 1, "al menos este proceso");
  assert.ok(use.usedMB > 10 && use.usedMB < 4096, `memoria propia plausible: ${use.usedMB} MB`);
});
