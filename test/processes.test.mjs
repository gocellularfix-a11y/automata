import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { listProcesses, sweepOrphans, reapDescendants, useRegistry, trackChild, releaseChild, trackedChildren } from "../server/procs.mjs";
import { assess, createChecker, thresholds, DEFAULT_MIN_FREE_MB } from "../server/resources.mjs";
import { runProcess } from "../server/agents.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { Store } from "../server/store.mjs";

const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-procs-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const alive = async (pid) => (await listProcesses()).some((p) => p.pid === pid);
// A harmless process that lives until it is closed; nothing in Automata starts it.
const sleeper = () => spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
const closeAll = (...children) => { for (const child of children) try { child.kill("SIGKILL"); } catch {} };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("la comprobación de memoria distingue la memoria libre del margen del sistema y se puede ajustar", () => {
  const ok = { totalMB: 65000, freeMB: 7800, commitFreeMB: 10400 };
  assert.equal(assess(ok, { freeMB: 1536, commitMB: 2048 }).ok, true);
  const noRam = assess({ ...ok, freeMB: 900 }, { freeMB: 1536, commitMB: 2048 });
  assert.equal(noRam.ok, false);
  assert.match(noRam.message, /quedan 900 MB de memoria libre en el sistema y se necesitan al menos 1536 MB/);
  // Free RAM and no headroom is a different problem, and a different message.
  const noCommit = assess({ ...ok, commitFreeMB: 1200 }, { freeMB: 1536, commitMB: 2048 });
  assert.match(noCommit.message, /solo puede asignar 1200 MB más \(memoria virtual\)/);
  assert.equal(assess({ ...ok, commitFreeMB: null }, { freeMB: 1536, commitMB: 2048 }).ok, true, "sin dato del sistema no se inventa un problema");
  assert.equal(assess({ ...ok, freeMB: 10 }, { freeMB: 0, commitMB: 0 }).ok, true, "0 apaga la comprobación");
  assert.deepEqual(thresholds({}), { freeMB: DEFAULT_MIN_FREE_MB, commitMB: 2048 });
  assert.deepEqual(thresholds({ AUTOMATA_MIN_FREE_MB: "4096", AUTOMATA_MIN_COMMIT_MB: "0" }), { freeMB: 4096, commitMB: 0 });
  assert.deepEqual(thresholds({ AUTOMATA_MIN_FREE_MB: "mucho" }), { freeMB: DEFAULT_MIN_FREE_MB, commitMB: 2048 });
});

test("el verificador lee el sistema una vez por ráfaga, solo lee y puede forzarse", async () => {
  let reads = 0;
  const check = createChecker({ read: async () => ({ totalMB: 1, freeMB: ++reads * 100, commitFreeMB: null }), limits: () => ({ freeMB: 250, commitMB: 0 }), ttlMs: 60000 });
  assert.equal((await check()).ok, false);
  assert.equal((await check()).memory.freeMB, 100, "la segunda lectura sale de la memoria");
  assert.equal(reads, 1);
  assert.equal((await check({ force: true })).memory.freeMB, 200);
  assert.equal((await check({ force: true })).ok, true);
});

test("con poca memoria libre el trabajo espera en lugar de abrir otro agente, y sigue cuando hay", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-procs-")), folder = path.join(dir, "p"), calls = [];
  fs.mkdirSync(folder);
  let free = 600;
  const review = { decision: "complete", summary: "ok", nextPrompt: "", task: "", files: [], findings: [], criteria: [{ criterion: "Funciona", met: true, evidence: "visto" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: null };
  const resources = createChecker({ read: async () => ({ totalMB: 64000, freeMB: free, commitFreeMB: 20000 }), limits: () => ({ freeMB: 1536, commitMB: 2048 }), ttlMs: 0 });
  const c = new Coordinator(new Store(path.join(dir, "data")), { resources, backoff: { transient: [40, 40, 40, 40], limit: [40], margin: 0 }, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    calls.push(a.role);
    return a.role === "coder" ? { text: "ok" } : { review: a.phase === "plan" ? { ...review, decision: "continue", nextPrompt: "Haz", criteria: [] } : review };
  } } });
  t.after(async () => { await c.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  c.start(c.addProject({ name: "P", directory: folder, objective: "Hacer algo útil y probarlo.", criteria: ["Funciona"], checks: [] }).id);
  for (let i = 0; i < 100 && c.active.status !== "waiting"; i++) await wait(20);
  assert.equal(c.active.status, "waiting");
  assert.deepEqual(calls, [], "ningún agente se abrió");
  assert.equal(c.active.waiting.memory, true);
  assert.match(c.active.waiting.reason, /quedan 600 MB de memoria libre/);
  assert.ok(c.events.some((e) => e.kind === "wait" && /Poca memoria libre en la PC/.test(e.text)));
  // The memory comes back: the next try goes ahead without anyone pressing anything.
  free = 8000;
  for (let i = 0; i < 300 && c.active.status !== "complete"; i++) await wait(20);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.ok(calls.includes("auditor") && calls.includes("coder"));
});

test("el registro de hijos guarda lo que Automata abrió y lo olvida al terminar", async (t) => {
  const dir = tmp(t), file = path.join(dir, "children.json");
  useRegistry(file);
  t.after(() => useRegistry(null));
  const done = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 700)"], { track: { role: "coder" } });
  await wait(250);
  const during = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(during.children.length, 1);
  assert.equal(during.children[0].role, "coder");
  assert.equal(during.owner.pid, process.pid);
  assert.equal(trackedChildren().length, 1);
  await done;
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).children, []);
  assert.equal(trackedChildren().length, 0);
  releaseChild(123456789);
  trackChild({}, {});
  assert.equal(trackedChildren().length, 0);
});

test("lo que dejó una sesión anterior de Automata se cierra solo si es de verdad suyo", async (t) => {
  const dir = tmp(t), file = path.join(dir, "children.json");
  const orphan = sleeper(), recycled = sleeper(), stranger = sleeper();
  t.after(() => closeAll(orphan, recycled, stranger));
  await wait(400);
  const table = await listProcesses();
  const info = (child) => table.find((p) => p.pid === child.pid);
  assert.ok(info(orphan) && info(recycled) && info(stranger), "los tres procesos existen");
  // The previous Automata (a pid that does not exist) had started the orphan and the "recycled" one; the stranger is the user's.
  fs.writeFileSync(file, JSON.stringify({ owner: { pid: 2147483000, startedAt: 1000 }, children: [
    { pid: orphan.pid, startedAt: info(orphan).created, name: info(orphan).name, role: "coder" },
    // The id exists but belongs to another process than the one Automata started (it started long ago).
    { pid: recycled.pid, startedAt: info(recycled).created - 3600000, name: info(recycled).name, role: "auditor" },
    { pid: 999999, startedAt: 5, name: "claude.exe", role: "coder" }
  ] }));
  const closed = await sweepOrphans(file);
  assert.deepEqual(closed.map((p) => p.pid), [orphan.pid], JSON.stringify(closed));
  await wait(600);
  assert.equal(await alive(orphan.pid), false, "el huérfano de Automata se cerró");
  assert.equal(await alive(recycled.pid), true, "un id reutilizado por otro proceso no se toca");
  assert.equal(await alive(stranger.pid), true, "lo que no está en el registro no se toca");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).children, [], "el registro queda vacío");
  assert.deepEqual(await sweepOrphans(path.join(dir, "no-existe.json")), []);
});

test("si el Automata dueño del registro sigue vivo, sus hijos no son huérfanos; ni el propio proceso ni los del sistema se cierran", async () => {
  const killed = [];
  const kill = async (pid) => { killed.push(pid); return true; };
  const now = Date.now();
  const table = [{ pid: 500, ppid: 1, name: "node.exe", created: now - 5000 }, { pid: 501, ppid: 500, name: "claude.exe", created: now - 4000 }];
  const file = path.join(os.tmpdir(), `automata-owner-${process.pid}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify({ owner: { pid: 500, startedAt: now - 5000 }, children: [{ pid: 501, startedAt: now - 4000, name: "claude.exe" }] }));
    assert.deepEqual(await sweepOrphans(file, { processes: table, kill }), []);
    assert.deepEqual(killed, []);
    // Owner gone: now the child is an orphan, but a child with the process' own id or a system id is never closed.
    fs.writeFileSync(file, JSON.stringify({ owner: { pid: 500, startedAt: now - 99999 }, children: [{ pid: 501, startedAt: now - 4000, name: "claude.exe" }, { pid: process.pid, startedAt: now, name: "node.exe" }, { pid: 4, startedAt: now, name: "System" }] }));
    const closed = await sweepOrphans(file, { processes: [...table, { pid: process.pid, ppid: 1, name: "node.exe", created: now }, { pid: 4, ppid: 0, name: "System", created: now }], kill: async (pid) => (pid === process.pid || pid <= 4 ? false : (killed.push(pid), true)) });
    assert.deepEqual(closed.map((p) => p.pid), [501]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("al terminar un agente se cierra lo que dejó abierto en segundo plano, y solo eso", async (t) => {
  const dir = tmp(t), pidFile = path.join(dir, "left.pid");
  const stranger = sleeper();
  t.after(() => closeAll(stranger));
  // A "program" that starts a server-like process, detaches it, and ends (what an agent can do with a dev server).
  const script = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true }); require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setTimeout(() => {}, 300);`;
  const reaped = [];
  const result = await runProcess(process.execPath, ["-e", script], { track: { role: "coder" }, reap: true, onReaped: (closed) => reaped.push(...closed) });
  assert.equal(result.code, 0);
  const left = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(left > 4);
  assert.deepEqual(reaped.map((p) => p.pid), [left], "se cerró exactamente lo que el agente dejó");
  await wait(400);
  assert.equal(await alive(left), false);
  assert.equal(await alive(stranger.pid), true, "un proceso ajeno no se toca");
});

test("la limpieza solo cuenta procesos creados mientras vivía el agente", async () => {
  const killed = [];
  const kill = async (pid) => { killed.push(pid); return true; };
  const start = 1_000_000, end = 1_060_000;
  const table = [
    { pid: 10, ppid: 77, name: "node.exe", created: start + 5000 },
    { pid: 11, ppid: 10, name: "node.exe", created: start + 6000 },
    { pid: 12, ppid: 77, name: "node.exe", created: start - 3_600_000 },
    { pid: 13, ppid: 77, name: "node.exe", created: end + 3_600_000 },
    { pid: 14, ppid: 78, name: "node.exe", created: start + 5000 }
  ];
  const closed = await reapDescendants(77, { startedAt: start, endedAt: end, processes: table, kill });
  assert.deepEqual(killed.sort((a, b) => a - b), [10, 11], "ni un id reutilizado antes ni uno creado después");
  assert.equal(closed.length, 2);
  assert.deepEqual(await reapDescendants(0, { startedAt: start, processes: table, kill }), []);
});

test("al abrir Automata se cierran los huérfanos de la sesión anterior, y con poca memoria la API no empieza nada", async (t) => {
  const { createServer } = await import("../server/index.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-procs-")), data = path.join(dir, "data");
  fs.mkdirSync(data);
  const orphan = sleeper();
  t.after(() => closeAll(orphan));
  await wait(400);
  const mine = (await listProcesses()).find((p) => p.pid === orphan.pid);
  fs.writeFileSync(path.join(data, "children.json"), JSON.stringify({ owner: { pid: 2147483000, startedAt: 1000 }, children: [{ pid: orphan.pid, startedAt: mine.created, name: mine.name, role: "auditor" }] }));
  const auth = { async requireConnected() {}, async status() { return {}; }, invalidate() {}, async close() {} };
  let free = 300;
  const resources = createChecker({ read: async () => ({ totalMB: 64000, freeMB: free, commitFreeMB: 30000 }), limits: () => ({ freeMB: 1536, commitMB: 2048 }), ttlMs: 0 });
  const app = await createServer({ port: 0, dataDir: data, auth, resources, evidence: async () => "", checks: async () => [], agents: { async run() { throw new Error("no debe llamarse"); } } });
  t.after(async () => { await app.close(); useRegistry(null); fs.rmSync(dir, { recursive: true, force: true }); });
  await wait(500);
  assert.equal(await alive(orphan.pid), false, "el huérfano registrado se cerró al abrir");
  assert.ok(app.coordinator.events.some((e) => /Se cerraron 1 proceso\(s\) que una sesión anterior de Automata dejó abiertos/.test(e.text)));
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const post = async (route, body) => { const response = await fetch(app.origin + "/api/" + route, { method: "POST", headers, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() }; };
  const refused = await post("ideas", { action: "propose", idea: "Quiero una aplicación para administrar el inventario de mi tienda" });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /Poca memoria para empezar algo nuevo: quedan 300 MB de memoria libre/);
  assert.equal(app.coordinator.proposals.length, 0, "no se creó ninguna propuesta");
  assert.equal((await post("start", { projectId: "x" })).status, 422);
  free = 9000;
  const allowed = await post("ideas", { action: "propose", idea: "" });
  assert.match(allowed.body.error, /Describe tu idea/, "con memoria suficiente la petición sigue su camino normal");
});
