// P3: from an idea to a project. Folder safety, the director's proposal, one approval that creates,
// plans and starts the project, file hints for the executor, and the small P2 fixes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateSettings, validateProposal, validateProject, normalizeFiles, PROPOSAL_SCHEMA, REVIEW_SCHEMA } from "../server/config.mjs";
import { directoryProblem, nestedRepositories, AUTOMATA_ROOT } from "../server/safety.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { createServer } from "../server/index.mjs";
import { CliAgents } from "../server/agents.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
async function settled(c) {
  await c.pending;
  await c.proposalPending;
  while (c.busy) await new Promise((r) => setTimeout(r, 5));
}
const CRITERIA = ["agregarProducto valida nombre y cantidad.", "La CLI lista el inventario en JSON.", "README.md explica cómo usarlo."];
const proposal = (extra = {}) => ({
  name: "Inventario de la tienda", summary: "Un programa para llevar el inventario.", objective: "Una aplicación de consola para registrar productos, existencias y ventas de una tienda pequeña.",
  features: ["Registrar productos", "Ver existencias"], criteria: CRITERIA, checks: ["node --test"], platform: "Consola de Windows",
  plan: [
    { title: "Preparar el proyecto y sus pruebas", detail: "package.json y test/", criterion: "", dependsOn: [] },
    { title: "Módulo de inventario", detail: "src/inventario.mjs", criterion: CRITERIA[0], dependsOn: ["N1"] },
    { title: "CLI", detail: "src/cli.mjs", criterion: CRITERIA[1], dependsOn: ["N2"] },
    { title: "README", detail: "", criterion: CRITERIA[2], dependsOn: ["N3"] }
  ],
  risks: ["No incluye ventas en línea.", "Los datos se guardan solo en esta PC."], questions: [], ...extra
});
const review = (decision, extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task: "", files: [], findings: [], criteria: CRITERIA.map((criterion) => ({ criterion, met: decision === "complete", evidence: decision === "complete" ? "ok" : "" })), git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan: { add: [], update: [] }, ...extra });
// What github.createNew does, without Git: a fresh folder under the projects root.
const creator = (root) => async (input) => {
  const directory = path.join(root, input.name.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-"));
  fs.mkdirSync(directory, { recursive: true });
  return validateProject({ ...input, directory, source: "local" });
};
// Every configured check passes.
const passing = async (p) => p.checks.map((command) => ({ command, passed: true, code: 0, output: "ok" }));
function coordinator(dir, agents, extra = {}) {
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: passing, resumeDelayMs: 0, agents, ...extra });
  c.updateSettings({ ...c.settings, projectsRoot: path.join(dir, "projects") });
  return c;
}

test("las carpetas peligrosas se rechazan: raíz, Automata, sus datos, el sistema, el usuario entero, la carpeta de proyectos y carpetas con otros repositorios", () => {
  const dir = fixture(), home = os.homedir();
  const fakeAutomata = path.join(dir, "automata"), data = path.join(dir, "data"), projects = path.join(dir, "projects");
  for (const folder of [fakeAutomata, data, projects]) fs.mkdirSync(folder, { recursive: true });
  const ctx = { automataRoot: fakeAutomata, dataDir: data, projectsRoot: projects };
  assert.match(directoryProblem(path.parse(dir).root, ctx), /raíz del disco/);
  assert.match(directoryProblem(fakeAutomata, ctx), /es Automata/);
  assert.match(directoryProblem(path.join(fakeAutomata, "server"), ctx), /es Automata/);
  assert.match(directoryProblem(dir, ctx), /es Automata \(o la contiene\)/, "una carpeta que contiene a Automata");
  assert.match(directoryProblem(path.join(data, "x"), ctx), /datos de Automata/);
  assert.match(directoryProblem(projects, ctx), /carpeta de todos los proyectos/);
  assert.match(directoryProblem(home, ctx), /contiene carpetas del sistema|usuario entero|o la contiene/);
  assert.match(directoryProblem(path.join(home, "Documents"), ctx), /usuario entero o una de sus carpetas principales/);
  assert.match(directoryProblem(path.join(home, ".ssh", "x"), ctx), /datos privados/);
  if (process.env.APPDATA) assert.match(directoryProblem(path.join(process.env.APPDATA, "algo"), ctx), /sistema, a los programas instalados o a datos privados/);
  if (process.env.SystemRoot) assert.match(directoryProblem(path.join(process.env.SystemRoot, "System32"), ctx), /sistema/);
  assert.equal(directoryProblem(path.join(home, "Documents", "mi-app"), ctx), null, "una subcarpeta de Documentos sí");
  assert.equal(directoryProblem(path.join(projects, "mi-app"), ctx), null);
  // A folder holding other repositories (like C:\proyectos held Automata and 22 more) is refused.
  const parent = path.join(projects, "varios");
  for (const name of ["a", "b"]) fs.mkdirSync(path.join(parent, name, ".git"), { recursive: true });
  fs.mkdirSync(path.join(parent, "node_modules", "pkg", ".git"), { recursive: true });
  assert.deepEqual(nestedRepositories(parent).map((r) => path.basename(r)).sort(), ["a", "b"], "node_modules no cuenta");
  assert.match(directoryProblem(parent, ctx), /contiene 2 repositorios \(a, b\)/);
  // Its own .git is fine.
  const own = path.join(projects, "propio");
  fs.mkdirSync(path.join(own, ".git"), { recursive: true });
  assert.equal(directoryProblem(own, ctx), null);
  // The real Automata folder and its parent.
  assert.match(directoryProblem(AUTOMATA_ROOT, {}), /es Automata/);
  assert.match(directoryProblem(path.dirname(AUTOMATA_ROOT), {}), /es Automata \(o la contiene\)/);
});

test("registrar o iniciar un proyecto en una carpeta insegura se rechaza, incluso si se registró antes de estas reglas", (t) => {
  const dir = fixture();
  const c = coordinator(dir, { async run() { throw new Error("no debe correr"); } });
  t.after(() => c.close());
  const parent = path.join(dir, "varios");
  fs.mkdirSync(path.join(parent, "otro", ".git"), { recursive: true });
  assert.throws(() => c.addProject({ name: "Mal", directory: parent, objective: "x", criteria: ["y"], checks: [] }), /contiene otro repositorio/);
  assert.throws(() => c.addProject({ name: "Automata", directory: AUTOMATA_ROOT, objective: "x", criteria: ["y"], checks: [] }), /es Automata/);
  assert.throws(() => c.addProject({ name: "Datos", directory: c.store.directory, objective: "x", criteria: ["y"], checks: [] }), /datos de Automata/);
  // Registered by an older version: refused at start, nothing runs.
  c.projects.push({ id: "viejo", name: "Viejo", directory: parent, objective: "x", criteria: ["y"], checks: [], source: "local" });
  assert.throws(() => c.start("viejo"), /contiene otro repositorio/);
  assert.equal(c.runs.length, 0);
  // A project without checks starts with a warning.
  const ok = path.join(dir, "bien");
  fs.mkdirSync(ok);
  const p = c.addProject({ name: "Bien", directory: ok, objective: "x", criteria: ["y"], checks: [] });
  assert.equal(p.directory, fs.realpathSync(ok));
});

test("la propuesta se valida: criterios, verificaciones, plan que cubre cada criterio y dependencias propias", () => {
  assert.equal(validateProposal(proposal()).plan.length, 4);
  assert.throws(() => validateProposal(proposal({ criteria: CRITERIA.slice(0, 2) })), /al menos 3 criterios/);
  assert.throws(() => validateProposal(proposal({ checks: [] })), /comando de verificación/);
  assert.throws(() => validateProposal(proposal({ plan: proposal().plan.slice(0, 3) })), /Sin tarea: «README\.md explica/);
  assert.throws(() => validateProposal(proposal({ plan: proposal().plan.map((t, i) => i === 2 ? { ...t, dependsOn: ["N9"] } : t) })), /depende de «N9»/);
  assert.throws(() => validateProposal(proposal({ plan: [...proposal().plan, { title: "Extra", detail: "", criterion: "inventado", dependsOn: [] }] })), /criterio exacto/);
  // A criterion quoted shortened (and without accents) is linked when only one criterion matches.
  const shortened = validateProposal(proposal({ plan: proposal().plan.map((task, i) => i === 2 ? { ...task, criterion: "La CLI lista el inventario en J" } : i === 1 ? { ...task, criterion: "agregarproducto VALIDA nombre y cantidad" } : task) }));
  assert.equal(shortened.plan[2].criterion, CRITERIA[1]);
  assert.equal(shortened.plan[1].criterion, CRITERIA[0]);
  assert.throws(() => validateProposal(proposal({ plan: proposal().plan.map((task, i) => i === 2 ? { ...task, criterion: "La CLI" } : task) })), /Sin tarea: «La CLI lista/, "una cita demasiado corta no se adivina");
  assert.ok(PROPOSAL_SCHEMA.required.includes("risks") && PROPOSAL_SCHEMA.required.includes("plan"));
  assert.ok(REVIEW_SCHEMA.required.includes("files"));
  assert.deepEqual(normalizeFiles(["src/a.mjs", "./README.md", "C:/Windows/x", "../otro/x.js", "/etc/passwd", "src\\b.mjs", "a|b", "src/a.mjs"]), ["src/a.mjs", "README.md", "src/b.mjs"]);
});

test("de una idea a un proyecto: propuesta del director, ajuste, una aprobación que crea la carpeta, siembra el plan y empieza", async (t) => {
  const dir = fixture(), calls = [];
  let drafts = 0;
  const c = coordinator(dir, { async run(a) {
    calls.push({ role: a.role, phase: a.phase, prompt: a.prompt, directory: a.project.directory });
    if (a.phase === "define") {
      drafts++;
      if (drafts === 1) return { proposal: proposal({ plan: proposal().plan.slice(0, 3) }) };
      if (drafts === 2) return { proposal: proposal() };
      return { proposal: proposal({ features: ["Registrar productos", "Ver existencias", "Alertas de existencias bajas"] }) };
    }
    if (a.role === "coder") return { text: "Hecho", usage: { input_tokens: 10, output_tokens: 1 } };
    if (a.phase === "plan") return { review: review("continue", { task: "T1", files: ["package.json", "test/inventario.test.mjs", "../fuera.js"] }) };
    return { review: review("complete", { plan: { add: [], update: [1, 2, 3, 4].map((id) => ({ id, status: "done", evidence: "ok", note: "" })) } }) };
  } });
  t.after(() => c.close());
  // Casual or empty messages never start anything.
  assert.throws(() => c.propose({ idea: "¡Buen trabajo, jóvenes!" }), /no parece una idea/);
  assert.throws(() => c.propose({ idea: "hola" }), /Describe tu idea/);
  assert.equal(calls.length, 0);
  const draft = c.propose({ idea: "Quiero una aplicación para administrar el inventario de mi tienda" });
  assert.equal(draft.status, "drafting");
  assert.throws(() => c.propose({ idea: "Otra idea para mi negocio de flores" }), /ocupado/);
  await settled(c);
  const ready = c.proposals[0];
  assert.equal(ready.status, "ready");
  assert.equal(drafts, 2, "la primera propuesta no cubría un criterio y se pidió corregirla");
  assert.match(calls[1].prompt, /RESPUESTA ANTERIOR RECHAZADA \(intento 1 de 3\): Cada criterio necesita al menos una tarea/);
  assert.match(calls[0].prompt, /IDEA DE LA PERSONA:\nQuiero una aplicación para administrar el inventario/);
  assert.match(calls[0].prompt, /no garantizan calidad comercial/);
  assert.ok(calls[0].directory.includes(path.join("proposals", ready.id, "workspace")), "el director trabaja en una carpeta vacía");
  assert.equal(ready.folder, path.join(dir, "projects", "inventario-de-la-tienda"));
  assert.equal("sessionId" in c.snapshot().proposals[0], false);
  // Adjust: the previous proposal travels with the request.
  c.propose({ id: ready.id, adjustments: "Agrega alertas cuando quede poco de un producto." });
  await settled(c);
  assert.match(calls.at(-1).prompt, /AJUSTES QUE PIDE LA PERSONA[\s\S]*alertas[\s\S]*PROPUESTA ANTERIOR/);
  assert.deepEqual(c.proposals[0].draft.features.at(-1), "Alertas de existencias bajas");
  // The single approval.
  const accepted = await c.acceptProposal(ready.id, creator(path.join(dir, "projects")));
  const project = accepted.project;
  assert.equal(project.name, "Inventario de la tienda");
  assert.deepEqual(project.criteria, CRITERIA);
  assert.deepEqual(project.checks, ["node --test"]);
  assert.match(project.constraints, /No publiques nada, no compres[\s\S]*no hagas push ni merge[\s\S]*Los commits locales sí/);
  assert.match(project.objective, /FUNCIONES PRINCIPALES:[\s\S]*Alertas de existencias bajas[\s\S]*PLATAFORMA: Consola de Windows/);
  assert.equal(project.proposalId, ready.id);
  assert.equal(c.proposals[0].status, "accepted");
  await assert.rejects(c.acceptProposal(ready.id, creator(path.join(dir, "projects"))), /ya se convirtió/);
  await settled(c);
  const tasks = c.plan.list(project.id);
  assert.deepEqual(tasks.map((x) => [x.id, x.dependsOn, x.status]), [[1, [], "done"], [2, [1], "done"], [3, [2], "done"], [4, [3], "done"]]);
  assert.equal(c.active.status, "complete", c.active.error);
  // The director plans on top of the approved plan, without repeating it.
  const planning = calls.find((x) => x.role === "auditor" && x.phase === "plan");
  assert.match(planning.prompt, /PLAN DEL PROYECTO \(0 de 4 tareas hechas[\s\S]*el plan de arriba ya existe/);
  // The director's file hints reach Claude, without paths outside the project.
  const coder = calls.find((x) => x.role === "coder");
  assert.match(coder.prompt, /ARCHIVOS RELEVANTES PARA ESTA TAREA[\s\S]*- package\.json\n- test\/inventario\.test\.mjs/);
  assert.doesNotMatch(coder.prompt, /fuera\.js/);
  assert.equal(c.active.usageLog.find((u) => u.role === "coder").files, 2);
  assert.ok(c.memory.listFacts(project.id).some((f) => /Plataforma elegida al proponer el proyecto: Consola de Windows/.test(f.text)));
  assert.ok(c.memory.listFacts(project.id).some((f) => /Limitación aceptada por la persona: No incluye ventas en línea/.test(f.text)));
  // Discard keeps it out of the list.
  const other = c.propose({ idea: "Una agenda de citas para mi peluquería" });
  await settled(c);
  c.discardProposal(other.id);
  assert.equal(c.snapshot().proposals.some((p) => p.id === other.id), false);
});

test("una propuesta que falla por límite o corte no deja el trabajo bloqueado y se puede reintentar", async (t) => {
  const dir = fixture();
  let n = 0;
  const c = coordinator(dir, { async run(a) {
    if (a.phase !== "define") throw new Error("no");
    if (++n === 1) throw Object.assign(new Error("You've hit your usage limit"), { agent: true, role: "auditor" });
    return { proposal: proposal() };
  } });
  t.after(() => c.close());
  c.propose({ idea: "Quiero una aplicación para administrar el inventario de mi tienda" });
  await settled(c);
  assert.equal(c.proposals[0].status, "error");
  assert.match(c.proposals[0].error, /límite de uso de Codex/);
  assert.equal(c.busy, false);
  // A proposal being drafted when Automata closed is marked for retry on the next start.
  c.proposals[0].status = "drafting";
  c.persist();
  const reopened = new Coordinator(new Store(path.join(dir, "data")), { agents: { async run() { return { proposal: proposal() }; } } });
  t.after(() => reopened.close());
  assert.equal(reopened.proposals[0].status, "error");
  assert.match(reopened.proposals[0].error, /Vuelve a enviarla/);
});

test("las tareas directas se confirman o se devuelven desde el panel, y reordenar queda en el historial", async (t) => {
  const dir = fixture();
  const c = coordinator(dir, { async run() { return { text: "README creado" }; } });
  t.after(() => c.close());
  const folder = path.join(dir, "proyecto");
  fs.mkdirSync(folder);
  const p = c.addProject({ name: "P", directory: folder, objective: "Algo útil", criteria: ["Funciona."], checks: [] });
  await c.sendChat({ projectId: p.id, target: "coder", kind: "task", text: "Haz un README con instrucciones." });
  await c.chatPending;
  const [task] = c.plan.list(p.id);
  assert.equal(task.status, "review");
  assert.throws(() => c.planAction({ projectId: p.id, action: "confirm", id: 99 }), /Solo se confirman/);
  c.planAction({ projectId: p.id, action: "confirm", id: task.id });
  const confirmed = c.plan.get(p.id, task.id);
  assert.equal(confirmed.status, "done");
  assert.match(confirmed.evidence, /^Confirmada por la persona\. README creado/);
  await c.sendChat({ projectId: p.id, target: "coder", kind: "task", text: "Agrega una prueba del README." });
  await c.chatPending;
  const second = c.plan.list(p.id).find((x) => x.status === "review");
  c.planAction({ projectId: p.id, action: "reopen", id: second.id });
  assert.equal(c.plan.get(p.id, second.id).status, "todo");
  assert.match(c.plan.get(p.id, second.id).note, /revisarla de nuevo/);
  c.planAction({ projectId: p.id, action: "reorder", ids: [second.id, task.id] });
  const history = c.plan.history(p.id, second.id).filter((h) => h.action === "reorder");
  assert.deepEqual(history.map((h) => [h.before, h.after, h.by]), [["2", "1", "user"]]);
});

test("la API de ideas: proponer, aceptar con una sola aprobación (carpeta nueva con Git) y rechazar en demostración", async (t) => {
  const dir = fixture(), root = path.join(dir, "projects");
  const auth = { async requireConnected() {}, async status() { return {}; }, invalidate() {}, async close() {} };
  const app = await createServer({ port: 0, dataDir: path.join(dir, "data"), auth, checks: passing, evidence: async () => "", resumeDelayMs: 0, agents: { async run(a) {
    if (a.phase === "define") return { proposal: proposal() };
    if (a.role === "coder") return { text: "Hecho" };
    return { review: a.phase === "plan" ? review("continue", { task: "T1" }) : review("complete", { plan: { add: [], update: [1, 2, 3, 4].map((id) => ({ id, status: "done", evidence: "ok", note: "" })) } }) };
  } } });
  t.after(() => app.close());
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const post = async (route, body) => {
    const response = await fetch(app.origin + "/api/" + route, { method: route === "settings" ? "PUT" : "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  await post("settings", { ...app.coordinator.settings, projectsRoot: root });
  assert.equal((await post("ideas", { action: "propose", idea: "gracias" })).status, 422);
  const proposed = await post("ideas", { action: "propose", idea: "Quiero una aplicación para administrar el inventario de mi tienda" });
  assert.equal(proposed.status, 202);
  await settled(app.coordinator);
  const state = await (await fetch(app.origin + "/api/state", { headers })).json();
  assert.equal(state.proposals[0].status, "ready");
  const accepted = await post("ideas", { action: "accept", id: proposed.body.id });
  assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
  const folder = accepted.body.project.directory;
  assert.equal(path.dirname(folder), fs.realpathSync(root));
  assert.ok(fs.existsSync(path.join(folder, ".git")), "carpeta propia con Git");
  assert.ok(fs.existsSync(path.join(folder, "README.md")));
  await settled(app.coordinator);
  assert.equal(app.coordinator.active.status, "complete");
  const caps = await (await fetch(app.origin + "/api/capabilities", { headers })).json();
  assert.equal(caps.features.ideas, true);
  // The demo never creates folders from ideas.
  const demo = await createServer({ port: 0, demo: true, dataDir: path.join(dir, "demo") });
  t.after(() => demo.close());
  const dh = { Authorization: "Bearer " + demo.token, "Content-Type": "application/json" };
  const dp = await (await fetch(demo.origin + "/api/ideas", { method: "POST", headers: dh, body: JSON.stringify({ action: "propose", idea: "Quiero una aplicación para administrar el inventario de mi tienda" }) })).json();
  await settled(demo.coordinator);
  assert.equal(demo.coordinator.proposals[0].status, "ready", "la demostración propone");
  const refused = await fetch(demo.origin + "/api/ideas", { method: "POST", headers: dh, body: JSON.stringify({ action: "accept", id: dp.id }) });
  assert.equal(refused.status, 422);
});

test("la CLI simulada recibe el esquema de propuesta en la fase define, en solo lectura", async (t) => {
  const dir = fixture(), stub = path.join(dir, "cli.mjs");
  fs.writeFileSync(stub, `import fs from 'node:fs';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2);fs.writeFileSync('invocation.json',JSON.stringify({args}));const schema=JSON.parse(fs.readFileSync(args[args.indexOf('--output-schema')+1],'utf8'));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(${JSON.stringify(proposal())}));console.log(JSON.stringify({type:'thread.started',thread_id:'p'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:100,cached_input_tokens:0,output_tokens:10},schema:schema.required}));`);
  const before = process.env.AUTOMATA_CODEX;
  process.env.AUTOMATA_CODEX = stub;
  t.after(() => { before === undefined ? delete process.env.AUTOMATA_CODEX : process.env.AUTOMATA_CODEX = before; });
  const result = await new CliAgents().run({ role: "auditor", phase: "define", prompt: "idea", project: { directory: dir }, settings: validateSettings(), directory: dir, emit: () => {} });
  assert.equal(result.proposal.name, "Inventario de la tienda");
  const args = JSON.parse(fs.readFileSync(path.join(dir, "invocation.json"), "utf8")).args;
  assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");
  assert.ok(fs.readFileSync(path.join(dir, "proposal-schema.json"), "utf8").includes("questions"));
});

test("con cambios sin confirmar, la regla de Git le pide al director guardar el hito, también al completar", async () => {
  const { directorPrompt } = await import("../server/prompts.mjs");
  const project = { name: "P", directory: "C:/p", objective: "Algo", criteria: ["Funciona."], checks: [] };
  const dirty = directorPrompt(project, validateSettings(), { phase: "review", git: { mode: "ask-push", info: { repo: true, branch: "main", dirty: true } } });
  assert.match(dirty, /Hay cambios sin confirmar: si las verificaciones pasan[\s\S]*o si marcas complete\), decide commit=true/);
  const clean = directorPrompt(project, validateSettings(), { phase: "review", git: { mode: "ask-push", info: { repo: true, branch: "main", dirty: false } } });
  assert.doesNotMatch(clean, /Hay cambios sin confirmar/);
});
