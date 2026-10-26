import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { runProcess, runChecks } from "../server/agents.mjs";
import { AuthManager } from "../server/auth.mjs";
import { createServer } from "../server/index.mjs";
const temporaryDirectories = [];
function fixture(t, name = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  if (!name) return dir;
  const nested = path.join(dir, name);
  fs.mkdirSync(nested);
  return nested;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const projectInput = (directory, name = "Proyecto de prueba") => ({ name, directory, objective: "Construir una función comprobada.", criteria: ["La prueba pasa."], checks: [] });
const review = (decision = "continue") => ({ decision, summary: "Revisión basada en evidencia.", nextPrompt: decision === "continue" ? "Implementa una función concreta." : "", findings: [], criteria: [{ criterion: "La prueba pasa.", met: decision === "complete", evidence: decision === "complete" ? "Resultado registrado." : "Pendiente." }] });
const gate = () => {
  let open;
  const promise = new Promise((resolve) => open = resolve);
  return { promise, open };
};
async function settled(c) {
  await c.pending;
  if (c.busy) await new Promise((r) => setTimeout(r, 5));
}
const scripted = (calls, { before = async () => {} } = {}) => ({ async run(a) {
  calls.push(`${a.project.name}:${a.role}:${a.phase}`);
  await before(a);
  return a.role === "coder" ? { text: "Implementado" } : { review: review(a.phase === "review" ? "complete" : "continue") };
} });

test("Continuar reanuda el trabajo del proyecto que se muestra, no el último que se inició", async (t) => {
  const calls = [];
  const c = new Coordinator(new Store(path.join(fixture(t), "data")), { evidence: async () => "", checks: async () => [], agents: scripted(calls) });
  t.after(() => c.close());
  const a = c.addProject(projectInput(fixture(t, "a"), "A")), b = c.addProject(projectInput(fixture(t, "b"), "B"));
  c.start(a.id);
  c.control("stop");
  await settled(c);
  const runA = c.runs.find((r) => r.projectId === a.id);
  assert.equal(runA.status, "stopped");
  c.start(b.id);
  await settled(c);
  const runB = c.active;
  assert.equal(runB.projectId, b.id);
  assert.equal(runB.status, "complete");
  assert.throws(() => c.control("resume", "no-existe"), /No hay un trabajo activo/);
  assert.equal(c.active, runB);
  c.control("resume", runA.id);
  await settled(c);
  assert.equal(c.active, runA);
  assert.equal(runA.status, "complete");
  assert.deepEqual(calls.filter((x) => x.startsWith("A:")), ["A:auditor:plan", "A:coder:code", "A:auditor:review"]);
});

test("Continuar en un proyecto no toca el trabajo detenido de otro ni interrumpe una operación en curso", async (t) => {
  const calls = [], planB = gate();
  const c = new Coordinator(new Store(path.join(fixture(t), "data")), { evidence: async () => "", checks: async () => [], agents: scripted(calls, { before: async (a) => {
    if (a.project.name === "B" && a.phase === "plan") await planB.promise;
  } }) });
  t.after(() => c.close());
  const a = c.addProject(projectInput(fixture(t, "a"), "A")), b = c.addProject(projectInput(fixture(t, "b"), "B"));
  c.start(a.id);
  c.control("stop");
  await settled(c);
  const runA = c.runs.find((r) => r.projectId === a.id);
  c.start(b.id);
  const runB = c.active;
  assert.throws(() => c.control("resume", runA.id), /Espera/);
  assert.equal(c.active, runB);
  assert.equal(runA.status, "stopped");
  planB.open();
  await settled(c);
  assert.equal(runB.status, "complete");
  c.control("resume", runA.id);
  await settled(c);
  assert.equal(runA.status, "complete");
  assert.equal(runB.status, "complete");
  assert.equal(calls.filter((x) => x.startsWith("B:")).length, 3);
});

test("una pausa pedida durante una tarea directa no inicia otra operación", async (t) => {
  const calls = [], chat = gate(), chatStarted = gate();
  const c = new Coordinator(new Store(path.join(fixture(t), "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.phase === "task") {
      chatStarted.open();
      await chat.promise;
      return { text: "Hecho" };
    }
    return a.role === "coder" ? { text: "Implementado" } : { review: review(a.phase === "review" ? "complete" : "continue") };
  } } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(fixture(t)));
  c.start(p.id);
  // The first loop boundary drains queued chats, so the task runs before the director plans.
  await c.sendChat({ projectId: p.id, target: "coder", kind: "task", text: "Añade un README." });
  await chatStarted.promise;
  c.control("pause");
  chat.open();
  await settled(c);
  assert.equal(c.active.status, "paused");
  assert.deepEqual(calls, ["coder:task"]);
  c.control("resume");
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls.slice(1), ["auditor:plan", "coder:code", "auditor:review"]);
});

test("el cuerpo JSON conserva los caracteres UTF-8 partidos entre fragmentos", async (t) => {
  const app = await createServer({ port: 0, demo: true, dataDir: fixture(t) });
  t.after(() => app.close());
  const text = "señal de ñandú — áéíóú ".repeat(10).trim();
  const body = Buffer.from(JSON.stringify({ projectId: "demo", target: "auditor", kind: "question", text }));
  const cut = body.indexOf(Buffer.from("ñ")) + 1;
  assert.ok(cut > 0 && cut < body.length);
  const reply = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: app.server.address().port, path: "/api/chat", method: "POST", headers: { authorization: "Bearer " + app.token, "content-type": "application/json", "content-length": body.length } }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => out += chunk);
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(out) }));
    });
    req.on("error", reject);
    req.write(body.subarray(0, cut), () => setTimeout(() => req.end(body.subarray(cut)), 50));
  });
  assert.equal(reply.status, 202);
  assert.equal(reply.json.text, text);
});

test("el límite de tamaño del cuerpo cuenta bytes y sigue rechazando solicitudes enormes", async (t) => {
  const app = await createServer({ port: 0, demo: true, dataDir: fixture(t) });
  t.after(() => app.close());
  const res = await fetch(app.origin + "/api/chat", { method: "POST", headers: { Authorization: "Bearer " + app.token, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "demo", target: "auditor", text: "ñ".repeat(80000) }) });
  assert.equal(res.status, 422);
  assert.match((await res.json()).error, /demasiado grande/);
});

test("ELECTRON_RUN_AS_NODE solo llega a los procesos que reutilizan este ejecutable como Node", async (t) => {
  const dir = fixture(t), before = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  t.after(() => {
    if (before === void 0) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = before;
  });
  const asNode = await runProcess(process.execPath, ["-p", "process.env.ELECTRON_RUN_AS_NODE ?? 'unset'"], { cwd: dir });
  assert.equal(asNode.stdout.trim(), "1");
  const [command, args] = process.platform === "win32"
    ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "if ($null -eq $env:ELECTRON_RUN_AS_NODE) { 'unset' } else { $env:ELECTRON_RUN_AS_NODE }"]]
    : ["/bin/sh", ["-c", 'echo "${ELECTRON_RUN_AS_NODE-unset}"']];
  const other = await runProcess(command, args, { cwd: dir });
  assert.equal(other.stdout.trim(), "unset");
  const spawned = [];
  const manager = new AuthManager({
    find: () => ({ command: process.execPath, args: ["codex.js"] }),
    run: async () => ({ code: 1, stdout: "", stderr: "Not logged in" }),
    spawnLogin: (spawnCommand, spawnArgs, options) => {
      spawned.push({ command: spawnCommand, env: options.env });
      return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    },
    stop: async () => {}
  });
  t.after(() => manager.close());
  await manager.start("auditor");
  assert.equal(spawned[0].env.ELECTRON_RUN_AS_NODE, "1");
  await manager.cancel("auditor");
  manager.find = () => ({ command: "codex.exe", args: [] });
  await manager.start("auditor");
  assert.equal(spawned[1].env.ELECTRON_RUN_AS_NODE, void 0);
});

test("una verificación con varios comandos falla si cualquiera de ellos falla", async (t) => {
  const dir = fixture(t);
  const [failsFirst, failsLast, passes] = await runChecks({ directory: dir, checks: ['node -e "process.exit(3)"; node -e "0"', 'node -e "0"; node -e "process.exit(4)"', 'node -e "0"; node -e "0"'] }, dir, void 0, () => {});
  assert.equal(failsFirst.passed, false);
  assert.equal(failsFirst.code, 3);
  assert.equal(failsLast.passed, false);
  assert.equal(failsLast.code, 4);
  assert.equal(passes.passed, true);
});

test("las verificaciones de PowerShell conservan variables y salida entre sentencias y siguen fallando con errores", { skip: process.platform !== "win32" }, async (t) => {
  const dir = fixture(t);
  const results = await runChecks({ directory: dir, checks: ["$n = 21; Write-Output ($n * 2)", "function Say { 'dos' }; Say", "Write-Output hola; exit 5", "Write-Output (", 'throw "fallo"'] }, dir, void 0, () => {});
  assert.equal(results[0].passed, true);
  assert.match(results[0].output, /42/);
  assert.equal(results[1].passed, true);
  assert.match(results[1].output, /dos/);
  assert.equal(results[2].passed, false);
  assert.equal(results[2].code, 5);
  assert.match(results[2].output, /hola/);
  assert.equal(results[3].passed, false);
  assert.equal(results[4].passed, false);
});
