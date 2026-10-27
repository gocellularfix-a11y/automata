import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateSettings, teamOf } from "../server/config.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { CliAgents } from "../server/agents.mjs";
import { createServer } from "../server/index.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const projectInput = (directory) => ({ name: "Proyecto de prueba", directory, objective: "Construir una función comprobada.", criteria: ["La prueba pasa."], checks: [] });
const review = (decision = "continue", extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Implementa una función concreta." : "", findings: [], criteria: [{ criterion: "La prueba pasa.", met: decision === "complete", evidence: decision === "complete" ? "Resultado registrado." : "Pendiente." }], ...extra });
async function settled(c) {
  await c.pending;
  if (c.busy) await new Promise((r) => setTimeout(r, 5));
}

test("el equipo se valida: de 1 a 3 codificadores y de 1 a 2 revisores, sin modelos inyectados", () => {
  assert.deepEqual(validateSettings({}).extraCoders, []);
  assert.deepEqual(validateSettings({}).extraAuditors, []);
  const ok = validateSettings({ extraCoders: [{ model: "opus", effort: "high", evil: "x" }, { model: "haiku" }], extraAuditors: [{ model: "gpt-6-luna", effort: "low" }] });
  assert.deepEqual(ok.extraCoders, [{ model: "opus", effort: "high" }, { model: "haiku", effort: "default" }]);
  assert.deepEqual(ok.extraAuditors, [{ model: "gpt-6-luna", effort: "low" }]);
  assert.deepEqual(teamOf(ok, "coder").map((a) => a.model), ["sonnet", "opus", "haiku"]);
  assert.deepEqual(teamOf(ok, "auditor").map((a) => a.model), ["gpt-6-sol", "gpt-6-luna"]);
  assert.throws(() => validateSettings({ extraCoders: [{ model: "a" }, { model: "b" }, { model: "c" }] }), /1 a 3 codificadores/);
  assert.throws(() => validateSettings({ extraAuditors: [{ model: "a" }, { model: "b" }] }), /1 a 2 revisores/);
  assert.throws(() => validateSettings({ extraCoders: "opus" }), /codificadores/);
  assert.throws(() => validateSettings({ extraCoders: [{ model: "sonnet; rm" }] }), /modelo/);
  assert.throws(() => validateSettings({ extraAuditors: [{ model: "gpt-6-luna", effort: "ultra" }] }), /compatible/);
  assert.throws(() => validateSettings({ extraCoders: [{ effort: "high" }] }), /modelo/);
});

test("una configuración guardada antes de existir el equipo se carga como un equipo de uno", (t) => {
  const dir = fixture(), store = new Store(dir);
  store.write("settings.json", { language: "es", mode: "small", accessMode: "full", coderModel: "sonnet", auditorModel: "gpt-6.1-sol", coderEffort: "default", auditorEffort: "high", maxRounds: 6, timeoutMinutes: 30 });
  const c = new Coordinator(store);
  assert.deepEqual(c.settings.extraCoders, []);
  assert.deepEqual(c.settings.extraAuditors, []);
  assert.equal(teamOf(c.settings, "coder").length, 1);
});

test("los codificadores se turnan por ronda con su propio modelo y razonamiento", async (t) => {
  const dir = fixture(), seen = [], prompts = [];
  let reviews = 0;
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") {
      seen.push(`${a.agent.index}:${a.agent.model}:${a.agent.effort}`);
      prompts.push(a.prompt);
      return { text: "Implementado" };
    }
    return { review: review(a.phase === "review" && ++reviews === 4 ? "complete" : "continue") };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, extraCoders: [{ model: "opus", effort: "high" }, { model: "haiku", effort: "low" }] });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(seen, ["0:sonnet:default", "1:opus:high", "2:haiku:low", "0:sonnet:default"]);
  assert.match(prompts[1], /codificador 2 de 3/);
  assert.match(prompts[2], /codificador 3 de 3/);
  const turns = c.events.filter((e) => e.role === "coder" && e.kind === "phase").map((e) => e.agent);
  assert.deepEqual(turns, ["Claude 1 · Sonnet", "Claude 2 · Opus", "Claude 3 · Haiku", "Claude 1 · Sonnet"]);
});

test("sin equipo los eventos no se etiquetan y la configuración no cambia el ciclo", async (t) => {
  const dir = fixture();
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    return a.role === "coder" ? { text: "Implementado" } : { review: review(a.phase === "review" ? "complete" : "continue") };
  } } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.ok(c.events.every((e) => !("agent" in e)));
});

test("los revisores confirman por turnos: el segundo solo interviene si el primero aprueba y todos deben coincidir", async (t) => {
  const dir = fixture(), calls = [], coderPrompts = [], directorPrompts = {};
  const script = { "review:0": ["continue", "complete", "complete"], "review:1": ["continue", "complete"] };
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") {
      coderPrompts.push(a.prompt);
      return { text: "Implementado" };
    }
    calls.push(`${a.phase}:${a.agent.index}:${a.agent.model}`);
    (directorPrompts[`${a.phase}:${a.agent.index}`] ??= []).push(a.prompt);
    if (a.phase === "plan") return { review: review("continue") };
    const decision = script[`review:${a.agent.index}`].shift();
    return { review: review(decision, decision === "continue" && a.agent.index === 1 ? { nextPrompt: "Falta cubrir el caso vacío." } : {}) };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, extraAuditors: [{ model: "gpt-6-luna", effort: "low" }] });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls, ["plan:0:gpt-6-sol", "review:0:gpt-6-sol", "review:0:gpt-6-sol", "review:1:gpt-6-luna", "review:0:gpt-6-sol", "review:1:gpt-6-luna"]);
  assert.equal(coderPrompts.length, 3);
  assert.match(coderPrompts[2], /Falta cubrir el caso vacío/);
  assert.doesNotMatch(directorPrompts["plan:0"][0], /EQUIPO/);
  assert.match(directorPrompts["review:0"][0], /revisor 1 de 2/);
  assert.match(directorPrompts["review:1"][0], /revisor 2 de 2/);
  assert.doesNotMatch(coderPrompts[0], /codificador 1 de/);
  const final = c.active.review;
  assert.equal(final.decision, "complete");
  assert.match(final.summary, /Codex 1 · Sol/);
  assert.match(final.summary, /Codex 2 · Luna/);
  assert.match(final.criteria[0].evidence, /Codex 1 · Sol: Resultado registrado\./);
  assert.match(final.criteria[0].evidence, /Codex 2 · Luna: Resultado registrado\./);
  assert.equal(final.criteria[0].met, true);
});

test("un revisor que bloquea detiene la ronda aunque otro haya aprobado", async (t) => {
  const dir = fixture(), calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") return { text: "Implementado" };
    calls.push(`${a.phase}:${a.agent.index}`);
    if (a.phase === "plan") return { review: review("continue") };
    return { review: review(a.agent.index === 0 ? "complete" : "blocked", a.agent.index === 1 ? { summary: "Falta una credencial." } : {}) };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, extraAuditors: [{ model: "gpt-6-luna", effort: "low" }] });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  assert.equal(c.active.status, "blocked");
  assert.deepEqual(calls, ["plan:0", "review:0", "review:1"]);
  assert.match(c.active.review.summary, /Codex 2 · Luna: Falta una credencial\./);
});

test("cada agente del equipo pasa su modelo y su razonamiento a la CLI", async (t) => {
  const dir = fixture(), stub = path.join(dir, "cli.mjs");
  fs.writeFileSync(stub, `import fs from 'node:fs';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2);fs.writeFileSync('invocation.json',JSON.stringify({args}));if(args[0]==='exec'){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Respuesta local.');console.log(JSON.stringify({type:'thread.started',thread_id:'s'}));}else{console.log(JSON.stringify({type:'result',result:'Reporte',is_error:false,session_id:'c'}));}`);
  const before = { coder: process.env.AUTOMATA_CLAUDE, auditor: process.env.AUTOMATA_CODEX };
  process.env.AUTOMATA_CLAUDE = stub;
  process.env.AUTOMATA_CODEX = stub;
  t.after(() => {
    for (const [role, key] of [["coder", "AUTOMATA_CLAUDE"], ["auditor", "AUTOMATA_CODEX"]]) if (before[role] === void 0) delete process.env[key];
    else process.env[key] = before[role];
  });
  const agents = new CliAgents(), settings = validateSettings({ accessMode: "limited" }), project = projectInput(dir);
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, "invocation.json"))).args;
  await agents.run({ role: "auditor", phase: "chat", prompt: "Hola", project, settings, directory: dir, emit: () => {}, agent: { model: "gpt-6-luna", effort: "low", index: 1, count: 2 } });
  let args = read();
  assert.equal(args[args.indexOf("--model") + 1], "gpt-6-luna");
  assert.ok(args.includes('model_reasoning_effort="low"'));
  assert.ok(!args.includes("gpt-6-sol"));
  await agents.run({ role: "coder", phase: "code", prompt: "Tarea", project, settings, directory: dir, emit: () => {}, agent: { model: "opus", effort: "max", index: 2, count: 3 } });
  args = read();
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  await agents.run({ role: "coder", phase: "code", prompt: "Tarea", project, settings, directory: dir, emit: () => {} });
  args = read();
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  assert.ok(!args.includes("--effort"));
});

test("el servidor anuncia el equipo y los límites, y guarda el equipo de la configuración", async (t) => {
  const app = await createServer({ port: 0, demo: true, dataDir: fixture() });
  t.after(() => app.close());
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const caps = await (await fetch(app.origin + "/api/capabilities", { headers })).json();
  assert.equal(caps.features.team, true);
  assert.deepEqual(caps.team, { coders: 3, auditors: 2 });
  const settings = await (await fetch(app.origin + "/api/state", { headers })).json().then((s) => s.settings);
  const saved = await fetch(app.origin + "/api/settings", { method: "PUT", headers, body: JSON.stringify({ ...settings, extraCoders: [{ model: "opus", effort: "high" }] }) });
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).extraCoders, [{ model: "opus", effort: "high" }]);
  const refused = await fetch(app.origin + "/api/settings", { method: "PUT", headers, body: JSON.stringify({ ...settings, extraCoders: [{ model: "a" }, { model: "b" }, { model: "c" }] }) });
  assert.equal(refused.status, 422);
  assert.deepEqual(app.coordinator.settings.extraCoders, [{ model: "opus", effort: "high" }]);
});
