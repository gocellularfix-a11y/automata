import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { validateSettings } from "../server/config.mjs";
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { CliAgents, decodeEvents } from "../server/agents.mjs";
import { directorPrompt } from "../server/prompts.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-test-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-test-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const projectInput = (directory, extra = {}) => ({ name: "Proyecto de prueba", directory, objective: "Construir una función comprobada.", criteria: ["La prueba pasa."], checks: [], ...extra });
const review = (decision = "continue", extra = {}) => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Implementa una función concreta." : "", findings: [], criteria: [{ criterion: "La prueba pasa.", met: decision === "complete", evidence: decision === "complete" ? "Resultado registrado." : "Pendiente." }], ...extra });
async function settled(c) {
  await c.pending;
  if (c.busy) await new Promise((r) => setTimeout(r, 5));
}
// A Git that records what the coordinator asks it to do.
function fakeGit({ repo = true, failOn = null } = {}) {
  const calls = [], steps = (command) => [{ command, code: 0, output: "ok" }];
  const answer = (kind, command, summary) => async (_dir, ...rest) => {
    calls.push([kind, ...rest.filter((value) => typeof value === "string")]);
    for (const step of steps(command)) rest.at(-1)?.onStep?.(step);
    return failOn === kind ? { ok: false, error: `falló ${kind}`, steps: [] } : { ok: true, summary, steps: steps(command) };
  };
  return {
    calls,
    inspect: async () => { calls.push(["inspect"]); return repo ? { repo: true, root: "x", nested: false, branch: "main", dirty: true, remote: "https://github.com/a/b", hasCommits: true } : { repo: false }; },
    branch: answer("branch", "git switch -c feature/x", "Rama nueva feature/x"),
    commit: answer("commit", "git commit -m x", "Commit abc1234"),
    push: answer("push", "git push -u origin main", "Push de main"),
    merge: answer("merge", "git merge --no-ff feature/x", "Merge de feature/x en main")
  };
}
const gitCalls = (git) => git.calls.filter(([kind]) => kind !== "inspect").map(([kind, arg]) => arg ? `${kind}:${arg}` : kind);

test("las sesiones se retoman con prompts cortos, por agente, y se desactivan con la opción", async (t) => {
  for (const reuse of [true, false]) {
    const dir = fixture(), seen = [];
    let counter = 0, reviews = 0;
    const c = new Coordinator(new Store(path.join(dir, "data")), { git: fakeGit(), evidence: async () => "", checks: async () => [], agents: { async run(a) {
      seen.push({ role: a.role, phase: a.phase, index: a.agent.index, resume: a.agent.resume, short: /Seguimos en la misma sesión/.test(a.prompt), fallback: /Seguimos en la misma sesión/.test(a.fallbackPrompt) });
      const sessionId = `s${++counter}`;
      if (a.role === "coder") return { text: "Implementado", sessionId };
      return { review: review(a.phase === "review" && ++reviews === 3 ? "complete" : "continue"), sessionId };
    } } });
    t.after(() => c.close());
    // This test is about resuming; the renewal rounds (3 for Codex by default) have their own tests.
    c.updateSettings({ ...c.settings, reuseSessions: reuse, auditorRefreshRounds: 8, extraCoders: [{ model: "opus", effort: "high" }] });
    c.start(c.addProject(projectInput(dir)).id);
    await settled(c);
    assert.equal(c.active.status, "complete");
    const steps = seen.map((s) => `${s.role}:${s.index}:${s.resume ? "resume" : "new"}${s.short ? ":short" : ""}`);
    if (reuse) {
      // plan(new) code0(new) review(resume) code1(new: its own session) review(resume) code0(resume) review(resume)
      assert.deepEqual(steps, ["auditor:0:new", "coder:0:new", "auditor:0:resume:short", "coder:1:new", "auditor:0:resume:short", "coder:0:resume:short", "auditor:0:resume:short"]);
      assert.ok(seen.every((s) => !s.fallback), "el prompt de respaldo es siempre el completo");
      assert.equal(seen[2].resume, "s1");
      assert.equal(seen[5].resume, "s2");
      assert.ok(c.active.sessions["coder:1"]);
    } else assert.ok(steps.every((step) => step.includes(":new") && !step.includes("short")), steps.join(" "));
    assert.equal("sessions" in c.snapshot().runs[0], false);
  }
});

test("si fallan las verificaciones el ejecutor corrige sin pasar por el director, con un tope", async (t) => {
  const dir = fixture(), calls = [], coderPrompts = [];
  let checks = 0;
  const c = new Coordinator(new Store(path.join(dir, "data")), { git: fakeGit(), evidence: async () => "", checks: async () => (++checks === 1 ? [{ command: "npm test", passed: false, code: 1, output: "1 test falló: boom" }] : [{ command: "npm test", passed: true, code: 0, output: "ok" }]), agents: { async run(a) {
    calls.push(`${a.role}:${a.phase}`);
    if (a.role === "coder") {
      coderPrompts.push(a.prompt);
      return { text: "Implementado" };
    }
    return { review: review(a.phase === "review" ? "complete" : "continue", { nextPrompt: "Implementa la función X." }) };
  } } });
  t.after(() => c.close());
  c.start(c.addProject(projectInput(dir, { checks: ["npm test"] })).id);
  await settled(c);
  assert.equal(c.active.status, "complete");
  assert.deepEqual(calls, ["auditor:plan", "coder:code", "coder:code", "auditor:review"]);
  assert.match(coderPrompts[1], /VERIFICACIONES FALLIDAS/);
  assert.match(coderPrompts[1], /\$ npm test → código 1/);
  assert.match(coderPrompts[1], /boom/);
  assert.match(coderPrompts[1], /Implementa la función X\./);
  assert.ok(c.events.some((e) => /corrige directamente \(1\/3\)/.test(e.text)));
});

test("la corrección directa tiene un tope de intentos y se puede desactivar", async (t) => {
  // After the cap the director reviews; approving with red checks is an invalid review, so it is asked
  // again up to three times (P1) before the run stops with the error.
  const reviews = ["auditor:review", "auditor:review", "auditor:review"];
  for (const [fastFix, expected] of [[true, ["auditor:plan", "coder:code", "coder:code", "coder:code", "coder:code", ...reviews]], [false, ["auditor:plan", "coder:code", ...reviews]]]) {
    const dir = fixture(), calls = [];
    const c = new Coordinator(new Store(path.join(dir, "data")), { git: fakeGit(), evidence: async () => "", checks: async () => [{ command: "x", passed: false, code: 1, output: "rojo" }], agents: { async run(a) {
      calls.push(`${a.role}:${a.phase}`);
      return a.role === "coder" ? { text: "Implementado" } : { review: review(a.phase === "review" ? "complete" : "continue") };
    } } });
    t.after(() => c.close());
    c.updateSettings({ ...c.settings, fastFix, maxRounds: 10 });
    c.start(c.addProject(projectInput(dir, { checks: ["x"] })).id);
    await settled(c);
    assert.deepEqual(calls, expected);
    assert.equal(c.active.status, "error");
    assert.match(c.active.error, /fallidas/);
  }
});

async function runWithGit(t, { mode, git, decisions }) {
  const dir = fixture(), queue = [...decisions];
  const c = new Coordinator(new Store(path.join(dir, "data")), { git, evidence: async () => "", checks: async () => [], agents: { async run(a) {
    if (a.role === "coder") return { text: "Implementado" };
    const decision = queue.shift();
    return { review: { ...review(decision.decision), git: decision.git } };
  } } });
  t.after(() => c.close());
  c.updateSettings({ ...c.settings, gitMode: mode });
  c.start(c.addProject(projectInput(dir)).id);
  await settled(c);
  return c;
}
const plan = (git = {}) => ({ decision: "continue", git: { commit: false, message: "", push: false, branch: "", merge_into: "", ...git } });
const step = (decision, git = {}) => ({ decision, git: { commit: false, message: "", push: false, branch: "", merge_into: "", ...git } });

test("el director decide Git: los commits se ejecutan solos y push y merge esperan la aprobación del usuario", async (t) => {
  const git = fakeGit();
  const c = await runWithGit(t, { mode: "ask-push", git, decisions: [plan({ branch: "feature/x" }), step("continue", { commit: true, message: "feat: hito" }), step("complete", { commit: true, message: "feat: final", push: true, merge_into: "main" })] });
  assert.equal(c.active.status, "complete");
  assert.deepEqual(gitCalls(git), ["branch:feature/x", "commit:feat: hito", "commit:feat: final"]);
  const pending = c.active.gitQueue.filter((item) => item.status === "pending");
  assert.deepEqual(pending.map((item) => item.kind), ["push", "merge"]);
  assert.equal(pending[1].into, "main");
  assert.deepEqual(c.events.filter((e) => e.kind === "approval").map((e) => e.git.kind), ["push", "merge"]);
  assert.equal(c.active.review.git.mergeInto, "main");
  // el ejecutor las muestra como comandos de terminal
  const commands = c.events.filter((e) => e.role === "coder" && e.kind === "tool" && e.tool?.git).map((e) => e.tool.command);
  assert.deepEqual(commands, ["git switch -c feature/x", "git commit -m x", "git commit -m x"]);
  // aprobar ejecuta; rechazar descarta; no se puede resolver dos veces
  const [push, merge] = pending;
  await c.resolveGit(c.active.id, push.id, "approve");
  assert.equal(push.status, "done");
  assert.deepEqual(gitCalls(git).slice(3), ["push"]);
  await c.resolveGit(c.active.id, merge.id, "reject");
  assert.equal(merge.status, "rejected");
  assert.equal(gitCalls(git).includes("merge:main"), false);
  await assert.rejects(c.resolveGit(c.active.id, push.id, "approve"), /ya se resolvió/);
  await assert.rejects(c.resolveGit(c.active.id, "no-existe", "approve"), /No se encontró/);
});

test("en modo automático Git se ejecuta en orden: rama, commit, push, merge y push del destino", async (t) => {
  const git = fakeGit();
  const c = await runWithGit(t, { mode: "auto", git, decisions: [plan(), step("complete", { branch: "feature/x", commit: true, message: "feat: todo", push: true, merge_into: "main" })] });
  assert.equal(c.active.status, "complete");
  assert.deepEqual(gitCalls(git), ["branch:feature/x", "commit:feat: todo", "push", "merge:main", "push"]);
  assert.deepEqual(c.active.gitQueue.map((item) => item.status), ["done", "done", "done", "done"]);
  assert.equal(c.events.filter((e) => e.kind === "approval").length, 0);
});

test("con aprobación total incluso los commits esperan, y si un paso falla no se ejecutan los siguientes", async (t) => {
  const asking = fakeGit();
  const c = await runWithGit(t, { mode: "ask-all", git: asking, decisions: [plan(), step("complete", { commit: true, message: "feat: x", push: true })] });
  assert.deepEqual(gitCalls(asking), []);
  assert.deepEqual(c.active.gitQueue.map((item) => `${item.kind}:${item.status}`), ["commit:pending", "push:pending"]);
  const failing = fakeGit({ failOn: "commit" });
  const f = await runWithGit(t, { mode: "auto", git: failing, decisions: [plan(), step("complete", { commit: true, message: "feat: x", push: true })] });
  assert.equal(f.active.status, "complete");
  assert.deepEqual(gitCalls(failing), ["commit:feat: x"]);
  assert.equal(f.active.gitQueue[0].status, "failed");
  assert.match(f.active.gitQueue[0].error, /falló commit/);
  assert.ok(f.events.some((e) => e.kind === "warning" && /falló commit/.test(e.text)));
});

test("sin Git activado o fuera de un repositorio el director no ejecuta nada", async (t) => {
  const off = fakeGit();
  await runWithGit(t, { mode: "off", git: off, decisions: [plan(), step("complete", { commit: true, message: "feat: x" })] });
  assert.deepEqual(off.calls, []);
  const outside = fakeGit({ repo: false });
  const c = await runWithGit(t, { mode: "auto", git: outside, decisions: [plan(), step("complete", { commit: true, message: "feat: x" })] });
  assert.deepEqual(gitCalls(outside), []);
  assert.ok(c.events.some((e) => /no es un repositorio/.test(e.text)));
  assert.equal(c.active.status, "complete");
});

test("las decisiones de Git no válidas del director se descartan", async (t) => {
  const git = fakeGit();
  const c = await runWithGit(t, { mode: "auto", git, decisions: [plan({ branch: "--force" }), step("complete", { commit: true, message: "   ", merge_into: "a..b" })] });
  assert.deepEqual(gitCalls(git), []);
  assert.deepEqual(c.active.review.git, { commit: false, message: "", push: false, branch: "", mergeInto: "" });
});

test("el prompt del director es de solo lectura, explica el estado de Git y cambia con el modo", () => {
  const project = { name: "P", directory: "C:/p", objective: "Algo", criteria: ["Funciona."], checks: [] };
  const settings = validateSettings();
  const base = { phase: "review", report: "r", evidence: "e" };
  const asking = directorPrompt(project, settings, { ...base, git: { mode: "ask-push", info: { repo: true, branch: "feature/x", dirty: true, remote: "https://github.com/a/b" } } });
  assert.match(asking, /Eres de solo lectura/);
  assert.match(asking, /NO edites archivos/);
  assert.match(asking, /Rama actual: feature\/x\. Cambios sin confirmar: sí\. Remoto origin: sí\./);
  assert.match(asking, /push y merge los aprueba el usuario/);
  assert.match(directorPrompt(project, settings, { ...base, git: { mode: "auto", info: { repo: true } } }), /se ejecutan automáticamente/);
  assert.match(directorPrompt(project, settings, { ...base, git: { mode: "off" } }), /no decides operaciones de Git/);
  assert.match(directorPrompt(project, settings, { ...base, git: { mode: "ask-all", info: { repo: false } } }), /no es un repositorio Git/);
  assert.doesNotMatch(asking, /ACCESO COMPLETO autorizado/);
});

test("una tarea para el director es un relevo: él decide en solo lectura y el ejecutor escribe", async (t) => {
  const dir = fixture(), calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { git: fakeGit(), agents: { async run(a) {
    calls.push({ role: a.role, phase: a.phase, prompt: a.prompt });
    return { text: a.role === "auditor" ? "1. Crea reloj.js con la hora actual." : "reloj.js creado." };
  } } });
  t.after(() => c.close());
  const p = c.addProject(projectInput(dir));
  const message = await c.sendChat({ projectId: p.id, target: "auditor", kind: "task", text: "Haz un reloj." });
  await c.chatPending;
  assert.equal(message.status, "answered");
  assert.deepEqual(calls.map((call) => call.role), ["auditor", "coder"]);
  assert.match(calls[0].prompt, /TAREA PARA EL EJECUTOR/);
  assert.match(calls[1].prompt, /INSTRUCCIONES DEL DIRECTOR/);
  assert.match(calls[1].prompt, /Crea reloj\.js con la hora actual/);
  assert.deepEqual(message.answers.map((answer) => answer.role), ["auditor", "coder"]);
  // si el director falla, el ejecutor no escribe nada
  const failing = new Coordinator(new Store(path.join(fixture(), "data")), { git: fakeGit(), agents: { async run(a) { calls.push({ role: "again:" + a.role }); throw new Error("sin conexión"); } } });
  t.after(() => failing.close());
  const q = failing.addProject(projectInput(dir));
  const broken = await failing.sendChat({ projectId: q.id, target: "auditor", kind: "task", text: "Haz un reloj." });
  await failing.chatPending;
  assert.equal(broken.status, "error");
  assert.deepEqual(broken.answers.map((answer) => answer.role), ["auditor"]);
  assert.equal(calls.some((call) => call.role === "again:coder"), false);
});

test("los eventos se guardan agrupados, no uno por uno", async (t) => {
  const dir = fixture(), store = new Store(path.join(dir, "data"));
  const c = new Coordinator(store, { git: fakeGit() });
  t.after(() => c.close());
  const before = store.read("events.json", []).length;
  for (let i = 0; i < 20; i++) c.event({ role: "coder", kind: "message", text: `evento ${i}` });
  assert.equal(store.read("events.json", []).length, before);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(store.read("events.json", []).length, before + 20);
});

test("los eventos de Claude se decodifican como una sesión de terminal: comandos, diffs, código y resultados", () => {
  const assistant = decodeEvents("coder", JSON.stringify({ type: "assistant", message: { content: [
    { type: "text", text: "Voy a crear el reloj." },
    { type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test", description: "Ejecuta las pruebas" } },
    { type: "tool_use", id: "t2", name: "Edit", input: { file_path: "src/a.js", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 10;" } },
    { type: "tool_use", id: "t3", name: "Write", input: { file_path: "src/b.js", content: "línea 1\nlínea 2\n" } },
    { type: "tool_use", id: "t4", name: "Read", input: { file_path: "README.md" } },
    { type: "tool_use", id: "t5", name: "Bash", input: { command: "echo sk-abcdefghijklmnop1234" } }
  ] } }));
  assert.deepEqual(assistant.map((e) => e.kind), ["message", "tool", "tool", "tool", "tool", "tool"]);
  assert.deepEqual(assistant[1].tool, { name: "Bash", command: "npm test", description: "Ejecuta las pruebas" });
  assert.equal(assistant[1].toolId, "t1");
  assert.equal(assistant[2].tool.diff, "- const a = 1;\n- const b = 2;\n+ const a = 10;");
  assert.equal(assistant[2].tool.path, "src/a.js");
  assert.equal(assistant[3].tool.content, "línea 1\nlínea 2\n");
  assert.equal(assistant[4].text, "Read · README.md");
  assert.doesNotMatch(JSON.stringify(assistant[5]), /sk-abcdefghijklmnop1234/);
  const results = decodeEvents("coder", JSON.stringify({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "t1", content: "3 pruebas aprobadas" },
    { type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "listo" }], is_error: false },
    { type: "tool_result", tool_use_id: "t3", content: "falló", is_error: true }
  ] } }));
  assert.deepEqual(results.map((e) => [e.kind, e.toolId, e.text, e.error]), [["toolresult", "t1", "3 pruebas aprobadas", false], ["toolresult", "t2", "listo", false], ["toolresult", "t3", "falló", true]]);
  const long = decodeEvents("coder", JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "a".repeat(9000) }] } }));
  assert.ok(long[0].text.length <= 3001);
  const codex = [
    ...decodeEvents("auditor", JSON.stringify({ type: "item.started", item: { id: "c1", type: "command_execution", command: "rg reloj src" } })),
    ...decodeEvents("auditor", JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "rg reloj src", aggregated_output: "src/a.js:1", exit_code: 0 } })),
    ...decodeEvents("auditor", JSON.stringify({ type: "item.completed", item: { id: "c2", type: "command_execution", aggregated_output: "no existe", exit_code: 2 } }))
  ];
  assert.deepEqual(codex.map((e) => [e.kind, e.toolId, e.error]), [["tool", "c1", undefined], ["toolresult", "c1", false], ["toolresult", "c2", true]]);
  assert.equal(codex[0].tool.command, "rg reloj src");
});

function cliStub(dir, body) {
  const stub = path.join(dir, "cli.mjs");
  fs.writeFileSync(stub, `import fs from 'node:fs';let prompt='';for await(const c of process.stdin)prompt+=c;const args=process.argv.slice(2);const log=JSON.parse(fs.existsSync('calls.json')?fs.readFileSync('calls.json','utf8'):'[]');log.push({args,prompt});fs.writeFileSync('calls.json',JSON.stringify(log));${body}`);
  return stub;
}
async function withStubs(t, dir, body, work) {
  const before = { coder: process.env.AUTOMATA_CLAUDE, auditor: process.env.AUTOMATA_CODEX };
  process.env.AUTOMATA_CLAUDE = process.env.AUTOMATA_CODEX = cliStub(dir, body);
  t.after(() => {
    for (const [role, key] of [["coder", "AUTOMATA_CLAUDE"], ["auditor", "AUTOMATA_CODEX"]]) if (before[role] === void 0) delete process.env[key];
    else process.env[key] = before[role];
  });
  await work();
  return JSON.parse(fs.readFileSync(path.join(dir, "calls.json"), "utf8"));
}

test("al retomar una sesión cada CLI recibe su comando de reanudación y el director sigue en solo lectura", async (t) => {
  const dir = fixture(), agents = new CliAgents(), settings = validateSettings(), project = projectInput(dir);
  const body = `if(args[0]==='exec'){fs.writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify({decision:'continue',summary:'ok',nextPrompt:'x',findings:[],criteria:[],git:{commit:false,message:'',push:false,branch:'',merge_into:''}}));console.log(JSON.stringify({type:'thread.started',thread_id:'nuevo-d'}));}else{console.log(JSON.stringify({type:'result',result:'Reporte',is_error:false,session_id:'nuevo-c'}));}`;
  const calls = await withStubs(t, dir, body, async () => {
    const coder = await agents.run({ role: "coder", phase: "code", prompt: "corto", fallbackPrompt: "largo", project, settings, directory: dir, emit: () => {}, agent: { model: "sonnet", effort: "default", resume: "sesion-c" } });
    assert.equal(coder.sessionId, "nuevo-c");
    assert.equal(coder.resumed, true);
    const director = await agents.run({ role: "auditor", phase: "review", prompt: "corto", fallbackPrompt: "largo", project, settings, directory: dir, emit: () => {}, agent: { model: "gpt-6.1-sol", effort: "high", resume: "sesion-d" } });
    assert.equal(director.review.decision, "continue");
    assert.equal(director.sessionId, "nuevo-d");
  });
  const [claude, codex] = calls;
  assert.equal(claude.args[claude.args.indexOf("--resume") + 1], "sesion-c");
  assert.equal(claude.prompt, "corto");
  assert.deepEqual(codex.args.slice(0, 2), ["exec", "resume"]);
  assert.ok(codex.args.includes("sandbox_mode=\"read-only\""));
  assert.equal(codex.args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.ok(codex.args.includes("--output-schema"));
  assert.equal(codex.args.at(-2), "sesion-d");
  assert.equal(codex.args.at(-1), "-");
  assert.equal(codex.prompt, "corto");
});

test("si una sesión no se puede retomar se empieza otra con el prompt completo, pero no si ya trabajó", async (t) => {
  const dir = fixture(), agents = new CliAgents(), settings = validateSettings(), project = projectInput(dir), warnings = [];
  const body = `if(args.includes('--resume')){console.error('No conversation found');process.exit(1);}console.log(JSON.stringify({type:'result',result:'Reporte completo',is_error:false,session_id:'fresca'}));`;
  const calls = await withStubs(t, dir, body, async () => {
    const result = await agents.run({ role: "coder", phase: "code", prompt: "corto", fallbackPrompt: "largo", project, settings, directory: dir, emit: (e) => warnings.push(e), agent: { model: "sonnet", effort: "default", resume: "caducada" } });
    assert.equal(result.text, "Reporte completo");
    assert.equal(result.sessionId, "fresca");
    assert.equal(result.resumed, false);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].args.includes("--resume"), false);
  assert.equal(calls[1].prompt, "largo");
  assert.ok(warnings.some((e) => e.kind === "warning" && /retomar la sesión/.test(e.text)));
  const worked = fixture();
  const callsWorked = await withStubs(t, worked, `if(args.includes('--resume')){console.log(JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',id:'a',name:'Bash',input:{command:'npm install'}}]}}));process.exit(1);}console.log(JSON.stringify({type:'result',result:'no debería llegar',is_error:false}));`, async () => {
    await assert.rejects(agents.run({ role: "coder", phase: "code", prompt: "corto", fallbackPrompt: "largo", project: projectInput(worked), settings, directory: worked, emit: () => {}, agent: { model: "sonnet", effort: "default", resume: "trabajada" } }), /código 1/);
  });
  assert.equal(callsWorked.length, 1, "una sesión que ya ejecutó herramientas no se repite");
});
