import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateReview, validateSettings, validateProject } from "../server/config.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { decodeEvent, runProcess, CliAgents, runChecks, findCodexNative } from "../server/agents.mjs";
import { createServer } from "../server/index.mjs";
const temporaryDirectories = [];
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const projectInput = (directory) => ({ name: "Proyecto de prueba", directory, objective: "Construir una función comprobada.", criteria: ["La prueba pasa."], checks: [] });
const review = (decision = "continue") => ({ decision, summary: "Revisión basada en evidencia.", nextPrompt: decision === "continue" ? "Implementa una función concreta." : "", findings: [], criteria: [{ criterion: "La prueba pasa.", met: decision === "complete", evidence: decision === "complete" ? "Resultado registrado." : "Pendiente." }] });
async function settled(c) {
  await c.pending;
  if (c.busy) await new Promise((r) => setTimeout(r, 5));
}
test("la aceptación necesita evidencia exacta, no admite fallos importantes ni aprobar en planificación", () => {
  const p = { criteria: ["La prueba pasa."] };
  assert.throws(() => validateReview(review("complete"), p, "plan"), /ejecución/);
  const r = review("complete");
  r.criteria[0].evidence = "";
  assert.throws(() => validateReview(r, p), /evidencia/);
  r.criteria[0].evidence = "Prueba real";
  r.findings = [{ severity: "major", file: "app.js", description: "Error", evidence: "Reproducido" }];
  assert.throws(() => validateReview(r, p), /pendientes/);
  assert.equal(validateReview(review("complete"), p).decision, "complete");
});
test("la configuración rechaza modelos inyectados y esfuerzos incompatibles", () => {
  assert.throws(() => validateSettings({ coderModel: "sonnet; rm" }), /modelo/);
  assert.throws(() => validateSettings({ auditorModel: "gpt-6-luna", auditorEffort: "ultra" }), /compatible/);
  assert.throws(() => validateSettings({ maxRounds: 0 }), /rondas|maxRounds/);
  assert.equal(validateSettings({ mode: "large" }).mode, "large");
});
test("un proyecto requiere carpeta concreta y criterios de aceptación", (t) => {
  const dir = fixture(t);
  assert.equal(validateProject(projectInput(dir)).directory, fs.realpathSync(dir));
  assert.throws(() => validateProject({ ...projectInput(dir), criteria: [] }), /criterios/);
  assert.throws(() => validateProject(projectInput(path.parse(dir).root)), /raíz/);
});
test("el almacenamiento impide rutas fuera de su directorio y bloquea coordinadores simultáneos", (t) => {
  const s = new Store(fixture(t)), release = s.acquire();
  t.after(release);
  s.write("test.json", { ok: true });
  assert.deepEqual(s.read("test.json"), { ok: true });
  assert.throws(() => s.location("../outside"), /válido/);
  assert.throws(() => new Store(s.directory).acquire(), /ya está/);
});
test("se interpretan eventos reales de ambas CLI sin mostrar razonamiento interno", () => {
  assert.equal(decodeEvent("auditor", JSON.stringify({ type: "thread.started", thread_id: "123" })).sessionId, "123");
  assert.equal(decodeEvent("auditor", JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "private" } })), null);
  assert.equal(decodeEvent("coder", JSON.stringify({ type: "result", result: "Reporte", is_error: false })).text, "Reporte");
  assert.equal(decodeEvent("coder", "not-json"), null);
});
test("los adaptadores ejecutan CLI por stdin, conservan modelos y leen sus reportes estructurados", async (t) => {
  const dir = fixture(t), stub = path.join(dir, "cli.mjs");
  fs.writeFileSync(stub, `import fs from 'node:fs';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2);fs.writeFileSync('invocation.json',JSON.stringify({args,prompt}));if(args[0]==='exec'){if(!args.includes('--skip-git-repo-check')){console.error('Not inside a trusted directory and --skip-git-repo-check was not specified.');process.exit(1);}fs.writeFileSync(args[args.indexOf('--output-last-message')+1],args.includes('--output-schema')?JSON.stringify(${JSON.stringify(review())}):'Consulta local verificada.');console.log(JSON.stringify({type:'thread.started',thread_id:'audit-session'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));}else{console.log(JSON.stringify({type:'result',result:'Reporte del codificador',is_error:false,session_id:'coder-session',usage:{input_tokens:9,output_tokens:3}}));}`);
  const before = { coder: process.env.AUTOMATA_CLAUDE, auditor: process.env.AUTOMATA_CODEX };
  process.env.AUTOMATA_CLAUDE = stub;
  process.env.AUTOMATA_CODEX = stub;
  t.after(() => {
    for (const [role, key] of [["coder", "AUTOMATA_CLAUDE"], ["auditor", "AUTOMATA_CODEX"]]) if (before[role] === void 0) delete process.env[key];
    else process.env[key] = before[role];
  });
  const agents = new CliAgents(), settings = validateSettings({ accessMode: "limited", coderModel: "fable", coderEffort: "high", auditorModel: "gpt-6-astra", auditorEffort: "low" }), project = projectInput(dir);
  const a = await agents.run({ role: "auditor", phase: "plan", prompt: "Inspecciona; no ejecutes $(nada).", project, settings, directory: dir, emit: () => {
  } });
  assert.equal(a.review.decision, "continue");
  assert.equal(a.sessionId, "audit-session");
  let invocation = JSON.parse(fs.readFileSync(path.join(dir, "invocation.json")));
  assert.equal(invocation.args[invocation.args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(invocation.args.includes("gpt-6-astra"));
  assert.match(invocation.prompt, /\$\(nada\)/);
  const chat = await agents.run({ role: "auditor", phase: "chat", prompt: "No necesitamos repositorio.", project, settings, directory: dir, emit: () => {} });
  assert.equal(chat.text, "Consulta local verificada.");
  assert.equal(fs.existsSync(path.join(dir, ".git")), false);
  const c = await agents.run({ role: "coder", phase: "code", prompt: "Una tarea", project, settings, directory: dir, emit: () => {
  } });
  assert.equal(c.text, "Reporte del codificador");
  invocation = JSON.parse(fs.readFileSync(path.join(dir, "invocation.json")));
  assert.ok(invocation.args.includes("fable"));
  assert.equal(invocation.args[invocation.args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.ok(!invocation.args.some((a2) => a2.includes("dangerously")));
});
test("las consultas en cola se recuperan al abrir una sesión guardada", (t) => {
  const dir = fixture(t), s = new Store(dir);
  s.write("projects.json", [{ ...projectInput(dir), id: "p" }]);
  s.write("messages.json", [{ id: "m", projectId: "p", target: "auditor", kind: "question", text: "¿Cómo va?", status: "queued" }]);
  assert.equal(new Coordinator(s).chatQueue.length, 1);
});
test("los argumentos se transmiten como datos y un proceso detenido no queda ejecutándose", async (t) => {
  const dir = fixture(t), text = 'á; $(echo NO) "hola"';
  const r = await runProcess(process.execPath, ["-e", "process.stdout.write(process.argv[1])", text], { cwd: dir });
  assert.equal(r.stdout, text);
  const controller = new AbortController();
  const promise = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: dir, signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  await assert.rejects(promise, { name: "AbortError" });
});
test("el ciclo planifica, implementa, verifica y audita; conserva el snapshot de configuración", async (t) => {
  const dir = fixture(t), calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [{ passed: true }], agents: { async run(a) {
    calls.push(a.phase);
    return a.role === "coder" ? { text: "Implementado" } : { review: review(a.phase === "review" ? "complete" : "continue") };
  } } });
  const p = c.addProject(projectInput(dir));
  c.start(p.id);
  await settled(c);
  assert.deepEqual(calls, ["plan", "code", "review"]);
  assert.equal(c.active.status, "complete");
  assert.equal(c.active.round, 1);
  c.updateSettings({ ...c.settings, coderModel: "opus" });
  assert.equal(c.active.settings.coderModel, "sonnet");
  assert.equal(new Store(path.join(dir, "data")).read("runs.json")[0].status, "complete");
});
test("ningún auditor puede aprobar si el comando de verificación falló", async (t) => {
  const dir = fixture(t);
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [{ passed: false }], agents: { async run(a) {
    return a.role === "coder" ? { text: "Dice que funciona" } : { review: review(a.phase === "review" ? "complete" : "continue") };
  } } });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "error");
  assert.match(c.active.error, /fallidas/);
});
test("el límite de rondas deja el objetivo pendiente y se puede continuar ampliándolo", async (t) => {
  const dir = fixture(t);
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    return a.role === "coder" ? { text: "Trabajo parcial" } : { review: review() };
  } } });
  c.updateSettings({ ...c.settings, maxRounds: 1 });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "limit");
  assert.equal(c.active.round, 1);
  assert.throws(() => c.control("resume"), /Aumenta/);
  c.updateSettings({ ...c.settings, maxRounds: 2 });
  c.control("resume");
  await settled(c);
  assert.equal(c.active.round, 2);
  assert.equal(c.active.status, "limit");
});
test("pausar espera el final de la operación y reanudar no repite la tarea ya completada", async (t) => {
  const dir = fixture(t);
  let releaseCode, started;
  const ready = new Promise((r) => started = r);
  const calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    calls.push(a.phase);
    if (a.role === "coder") {
      started();
      await new Promise((r) => releaseCode = r);
      return { text: "Implementado" };
    }
    return { review: review(a.phase === "review" ? "complete" : "continue") };
  } } });
  c.start(c.addProject(projectInput(dir)).id);
  await ready;
  c.control("pause");
  assert.equal(c.active.status, "pausing");
  releaseCode();
  await settled(c);
  assert.equal(c.active.status, "paused");
  assert.equal(c.active.stage, "checks");
  c.control("resume");
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.equal(calls.filter((x) => x === "code").length, 1);
});
test("al reiniciar se audita el trabajo parcial de un codificador interrumpido", (t) => {
  const dir = fixture(t), s = new Store(dir);
  s.write("runs.json", [{ id: "test", projectId: "p", status: "running", stage: "code" }]);
  const c = new Coordinator(s);
  assert.equal(c.active.status, "interrupted");
  assert.equal(c.active.stage, "checks");
  assert.match(c.active.coderReport, /interrumpió/);
});
test("una instrucción en cola no permite saltarse las verificaciones de la ronda", async (t) => {
  const dir = fixture(t);
  let release, started;
  const ready = new Promise((r) => started = r);
  const order = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => {
    order.push("checks");
    return [{ passed: true }];
  }, agents: { async run(a) {
    order.push(a.phase);
    if (a.role === "coder") {
      started();
      await new Promise((r) => release = r);
      return { text: "Trabajo terminado" };
    }
    return { review: review(a.phase === "review" ? "complete" : "continue") };
  } } });
  const p = c.addProject({ ...projectInput(dir), checks: ["node --test"] });
  c.start(p.id);
  await ready;
  await c.sendChat({ projectId: p.id, target: "auditor", kind: "instruction", text: "Revisa también el caso vacío." });
  release();
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(order, ["plan", "code", "checks", "review"]);
  assert.match(c.active.coderReport, /caso vacío/);
});
test("HTTP exige token y origen válido; la demostración ejecuta verificaciones reales", async (t) => {
  const dir = fixture(t);
  const app = await createServer({ port: 0, demo: true, dataDir: dir });
  t.after(() => app.close());
  assert.equal((await fetch(app.origin + "/api/state")).status, 401);
  const headers = { Authorization: "Bearer " + app.token };
  assert.equal((await fetch(app.origin + "/api/state", { headers: { ...headers, Origin: "https://evil.example" } })).status, 403);
  const res = await fetch(app.origin + "/api/state", { headers });
  const s = await res.json();
  assert.equal(s.demo, true);
  assert.equal(s.projects.length, 1);
  assert.equal((await fetch(app.origin + "/api/projects", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(projectInput(dir)) })).status, 422);
  app.coordinator.start("demo");
  await settled(app.coordinator);
  assert.equal(app.coordinator.active.status, "complete");
  assert.ok(app.coordinator.active.checks[0].passed);
  assert.ok(fs.existsSync(path.join(dir, "demo-project", "greet.test.mjs")));
});
test("las verificaciones conservan caracteres UTF-8 al ejecutarse desde PowerShell", async (t) => {
  const dir = fixture(t);
  const results = await runChecks({ directory: dir, checks: ["node -e \"console.log('corazón')\""] }, dir, undefined, () => {});
  assert.equal(results[0].passed, true);
  assert.match(results[0].output, /corazón/);
});

test("el chat ocioso empieza a responder y solo el siguiente mensaje espera en cola", async t => {
  const dir = fixture(t), replies = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { agents: { run({ signal }) {
    return new Promise((resolve, reject) => { replies.push(resolve); signal.addEventListener("abort", () => reject(new Error("Consulta detenida")), { once: true }); });
  } } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  const first = await c.sendChat({ projectId: p.id, target: "auditor", text: "¿Cómo va?" });
  assert.equal(first.status, "processing");
  assert.equal(first.activeRole, "auditor");
  const second = await c.sendChat({ projectId: p.id, target: "coder", text: "Revisa el saludo." });
  assert.equal(second.status, "queued");
  assert.equal(replies.length, 1);
  replies[0]({ text: "Primera respuesta" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.status, "answered");
  assert.equal(second.status, "processing");
  assert.equal(second.activeRole, "coder");
  replies[1]({ text: "Segunda respuesta" });
  await c.chatPending;
  assert.equal(second.status, "answered");
  assert.equal(c.busy, false);
});

test("consultar a ambos publica la primera respuesta sin esperar la segunda y detener limpia el estado", async t => {
  const dir = fixture(t), replies = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { agents: { run({ signal }) {
    return new Promise((resolve, reject) => { replies.push(resolve); signal.addEventListener("abort", () => reject(new Error("Consulta detenida")), { once: true }); });
  } } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  const message = await c.sendChat({ projectId: p.id, target: "both", text: "¿Qué falta?" });
  replies[0]({ text: "Claude: primer resultado" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(message.answers[0].text, "Claude: primer resultado");
  assert.equal(message.status, "processing");
  assert.equal(message.activeRole, "auditor");
  c.control("stop");
  await c.chatPending;
  assert.equal(message.status, "error");
  assert.equal(message.answers[1].error, true);
  assert.equal(message.activeRole, undefined);
  assert.equal(c.busy, false);
});

test("una consulta en proceso al cerrar se muestra interrumpida sin reenviarla automáticamente", t => {
  const dir = fixture(t), store = new Store(dir);
  store.write("messages.json", [{ id: "old-chat", projectId: "p", target: "auditor", kind: "question", text: "Estado", status: "processing", activeRole: "auditor" }]);
  const c = new Coordinator(store);
  assert.equal(c.messages[0].status, "interrupted");
  assert.match(c.messages[0].error, /interrumpió/);
  assert.equal(c.messages[0].activeRole, undefined);
  assert.equal(c.chatQueue.length, 0);
});

test("Windows resuelve el ejecutable nativo de Codex instalado por npm sin un lanzador intermedio", t => {
  const root = fixture(t), pkg = path.join(root, "node_modules", "@openai", "codex-win32-x64");
  const native = path.join(pkg, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"@openai/codex"}');
  fs.writeFileSync(path.join(pkg, "package.json"), '{"name":"@openai/codex-win32-x64"}');
  fs.writeFileSync(native, "fixture-not-executed");
  const found = findCodexNative(root, { platform: "win32", arch: "x64" });
  assert.equal(found.command, native);
  assert.deepEqual(found.args, []);
  assert.equal(found.env.CODEX_MANAGED_PACKAGE_ROOT, fs.realpathSync(root));
  assert.equal(findCodexNative(root, { platform: "linux", arch: "x64" }), null);
  fs.unlinkSync(native);
  assert.equal(findCodexNative(root, { platform: "win32", arch: "x64" }), null);
  const legacy = path.join(root, "vendor", "x86_64-pc-windows-msvc", "codex", "codex.exe");
  fs.mkdirSync(path.dirname(legacy), { recursive: true });
  fs.writeFileSync(legacy, "fixture-not-executed");
  assert.equal(findCodexNative(root, { platform: "win32", arch: "x64" }).command, legacy);
});
