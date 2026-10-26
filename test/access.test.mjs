import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { CliAgents } from "../server/agents.mjs";
import { validateSettings } from "../server/config.mjs";
import { chatPrompt } from "../server/prompts.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { Store } from "../server/store.mjs";

const temporaryDirectories = [];
after(() => { for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true }); });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "automata-access-"));
  temporaryDirectories.push(directory);
  return directory;
}
const project = directory => ({ name: "Reloj", directory, objective: "Crear un reloj digital.", criteria: ["Funciona."], checks: [] });
const review = complete => ({ decision: complete ? "complete" : "continue", summary: "Resultado comprobado.", nextPrompt: complete ? "" : "Construye el reloj.", findings: [], criteria: [{ criterion: "Funciona.", met: complete, evidence: complete ? "Prueba aprobada." : "Pendiente." }] });

test("el acceso completo es explícito, el ejecutor recibe permiso de trabajo y el director solo lee", t => {
  const p = project(fixture(t));
  assert.equal(validateSettings().accessMode, "full");
  assert.throws(() => validateSettings({ accessMode: "admin-magic" }), /acceso/);
  const task = chatPrompt(p, "coder", "Crea la carpeta y el repositorio de GitHub.", "", validateSettings(), { kind: "task" });
  assert.match(task, /TAREA DE IMPLEMENTACIÓN AUTORIZADA/);
  assert.match(task, /crear carpetas y archivos/);
  assert.match(task, /GitHub CLI/);
  assert.match(task, /créalo privado/);
  assert.doesNotMatch(task, /CONSULTA DE SOLO LECTURA|No inicialices repositorios/);
  const director = chatPrompt(p, "auditor", "Crea la carpeta y el repositorio de GitHub.", "", validateSettings(), { kind: "task" });
  assert.match(director, /TAREA PARA EL EJECUTOR/);
  assert.match(director, /Eres de solo lectura/);
  assert.match(director, /Claude, que escribirá el código/);
  assert.doesNotMatch(director, /TAREA DE IMPLEMENTACIÓN AUTORIZADA|ACCESO COMPLETO autorizado/);
  const question = chatPrompt(p, "coder", "¿Qué cambió?", "", validateSettings(), { kind: "question" });
  assert.match(question, /CONSULTA DE SOLO LECTURA/);
  assert.doesNotMatch(question, /ACCESO COMPLETO autorizado/);
  const handoff = chatPrompt(p, "coder", "Crea el reloj.", "", validateSettings(), { kind: "task", previousAnswers: [{ role: "auditor", text: "1. Crea reloj.js" }] });
  assert.match(handoff, /INSTRUCCIONES DEL DIRECTOR/);
  assert.match(handoff, /1. Crea reloj.js/);
});

test("el ejecutor escribe con permiso de trabajo; el director es de solo lectura incluso con acceso completo", async t => {
  const dir = fixture(t), stub = path.join(dir, "cli.mjs");
  fs.writeFileSync(stub, `import fs from 'node:fs';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2),codex=args[0]==='exec';fs.writeFileSync('args.json',JSON.stringify(args));if(codex){if(args.includes('--dangerously-bypass-approvals-and-sandbox')||args[args.indexOf('--sandbox')+1]!=='read-only')process.exit(2);fs.writeFileSync(args[args.indexOf('--output-last-message')+1],'Instrucciones listas.');}else{const mode=args[args.indexOf('--permission-mode')+1],read=prompt.includes('CONSULTA DE SOLO LECTURA');if(!read){if(mode!=='bypassPermissions')process.exit(2);fs.writeFileSync('coder.txt','archivo creado');}else if(mode!=='plan')process.exit(3);console.log(JSON.stringify({type:'result',result:read?'Consulta sin cambios.':'Archivo creado.',is_error:false}));}`);
  const previous = { AUTOMATA_CLAUDE: process.env.AUTOMATA_CLAUDE, AUTOMATA_CODEX: process.env.AUTOMATA_CODEX };
  process.env.AUTOMATA_CLAUDE = process.env.AUTOMATA_CODEX = stub;
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const agents = new CliAgents(), settings = validateSettings(), p = project(dir);
  assert.equal(settings.accessMode, "full");
  const coder = await agents.run({ role: "coder", phase: "task", project: p, settings, directory: dir, prompt: chatPrompt(p, "coder", "Crea el archivo.", "", settings, { kind: "task" }), emit: () => {} });
  assert.equal(coder.text, "Archivo creado.");
  assert.equal(fs.readFileSync(path.join(dir, "coder.txt"), "utf8"), "archivo creado");
  let args = JSON.parse(fs.readFileSync(path.join(dir, "args.json")));
  assert.equal(args.includes("--output-schema"), false);
  assert.equal(args.includes("--allowedTools"), false);
  fs.unlinkSync(path.join(dir, "coder.txt"));
  await agents.run({ role: "coder", phase: "chat", project: p, settings, directory: dir, prompt: chatPrompt(p, "coder", "¿Cómo va?", "", settings, { kind: "question" }), emit: () => {} });
  assert.equal(fs.existsSync(path.join(dir, "coder.txt")), false);
  for (const [phase, kind] of [["task", "task"], ["chat", "question"]]) {
    const director = await agents.run({ role: "auditor", phase, project: p, settings, directory: dir, prompt: chatPrompt(p, "auditor", "Crea el archivo.", "", settings, { kind }), emit: () => {} });
    assert.equal(director.text, "Instrucciones listas.");
    args = JSON.parse(fs.readFileSync(path.join(dir, "args.json")));
    assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
    assert.equal(args.some((a) => a.includes("dangerously")), false);
  }
  assert.equal(fs.existsSync(path.join(dir, "auditor.txt")), false);
});

test("las tareas directas no exigen iniciar el ciclo y ambos agentes reciben el resultado anterior", async t => {
  const dir = fixture(t), calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { agents: { async run(call) { calls.push(call); fs.writeFileSync(path.join(dir, call.role + ".txt"), "resultado"); return { text: call.role + ": archivo creado." }; } } });
  t.after(() => c.close());
  const p = c.addProject(project(dir));
  const message = await c.sendChat({ projectId: p.id, kind: "task", target: "both", text: "Implementa la petición." });
  await c.chatPending;
  assert.equal(message.status, "answered");
  assert.deepEqual(calls.map(call => call.phase), ["task", "task"]);
  assert.match(calls[1].prompt, /RESULTADOS DEL AGENTE ANTERIOR/);
  assert.match(calls[1].prompt, /coder: archivo creado/);
  assert.equal(c.runs.length, 0);
});

test("si el director modifica archivos al revisar, no se aprueba con verificaciones anteriores", async t => {
  const dir = fixture(t), calls = [];
  let reviews = 0, checks = 0;
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => { checks++; return [{ passed: true }]; }, agents: { async run(call) {
    calls.push(call.phase);
    if (call.phase === "review" && reviews++ === 0) fs.writeFileSync(path.join(dir, "director-fix.txt"), "corrección");
    return call.role === "coder" ? { text: "Entrega revisable." } : { review: review(call.phase === "review") };
  } } });
  t.after(() => c.close());
  c.start(c.addProject({ ...project(dir), checks: ["verificar"] }).id);
  await c.pending;
  assert.equal(c.active.status, "complete");
  assert.equal(checks, 2);
  assert.deepEqual(calls, ["plan", "code", "review", "code", "review"]);
});

test("cambiar permisos afecta a la siguiente operación sin alterar la llamada ya iniciada", async t => {
  const dir = fixture(t), calls = [];
  let release, notify;
  const ready = new Promise(resolve => notify = resolve);
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => [], agents: { async run(call) {
    calls.push(call);
    if (call.phase === "plan") { notify(); await new Promise(resolve => release = resolve); }
    return call.role === "coder" ? { text: "Entrega." } : { review: review(call.phase === "review") };
  } } });
  t.after(() => c.close());
  c.start(c.addProject(project(dir)).id);
  await ready;
  c.updateSettings({ ...c.settings, accessMode: "limited" });
  assert.equal(calls[0].settings.accessMode, "full");
  release();
  await c.pending;
  assert.equal(calls[1].settings.accessMode, "limited");
  assert.equal(c.active.status, "complete");
});

test("una tarea directa antes de auditar vuelve a ejecutar los checks de la ronda", async t => {
  const dir = fixture(t);
  let checks = 0, release, notify;
  const ready = new Promise(resolve => notify = resolve);
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: async () => {
    if (++checks === 1) { notify(); await new Promise(resolve => release = resolve); }
    return [{ passed: true }];
  }, agents: { async run(call) {
    if (call.phase === "task") { fs.writeFileSync(path.join(dir, "direct-task.txt"), "cambio"); return { text: "Cambio directo hecho." }; }
    return call.role === "coder" ? { text: "Entrega." } : { review: review(call.phase === "review") };
  } } });
  t.after(() => c.close());
  const p = c.addProject({ ...project(dir), checks: ["verificar"] });
  c.start(p.id);
  await ready;
  await c.sendChat({ projectId: p.id, target: "auditor", kind: "task", text: "Haz este cambio directo." });
  release();
  await c.pending;
  assert.equal(checks, 2);
  assert.equal(c.active.status, "complete");
  assert.match(c.active.coderReport, /Cambio directo hecho/);
});
