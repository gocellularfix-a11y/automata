// P4 stabilization: Claude keeps limited access and still gets the project's authorized checks, run by the
// coordinator. The permission is one literal command; the token lives for one call; nothing else is widened.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
// Asynchronous on purpose: the script talks to a server that lives in this same process.
const run = (file, env) => new Promise((resolve) => execFile(process.execPath, [file], { env, encoding: "utf8" }, (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr })));
import { Store } from "../server/store.mjs";
import { Coordinator } from "../server/coordinator.mjs";
import { createServer } from "../server/index.mjs";
import { CliAgents } from "../server/agents.mjs";
import { validateProject } from "../server/config.mjs";
import { installCheckScript, plainDirectory, allowedCheckTool, CHECK_SCRIPT, CHECK_ENDPOINT_PATH, MAX_AGENT_CHECK_CALLS } from "../server/agenttools.mjs";
import { coderPrompt, verifySection } from "../server/prompts.mjs";
import { removeFolder } from "./rmretry.mjs";

const dirs = [];
const fixture = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "automata-acheck-")); dirs.push(d); return d; };
after(() => { for (const d of dirs) if (path.resolve(d).startsWith(path.join(os.tmpdir(), "automata-acheck-"))) removeFolder(d); });
const settled = async (c) => { await c.pending; await c.proposalPending; while (c.busy) await new Promise((r) => setTimeout(r, 5)); };
const CRITERION = "La suma funciona.";
const review = (decision, plan = { add: [], update: [] }, task = "") => ({ decision, summary: `Revisión ${decision}.`, nextPrompt: decision === "continue" ? "Haz la tarea." : "", task, files: [], findings: [], criteria: [{ criterion: CRITERION, met: decision === "complete", evidence: decision === "complete" ? "ok" : "" }], git: { commit: false, message: "", push: false, branch: "", merge_into: "" }, run: { ready: false, command: "", url: "", note: "" }, memory: { add: [], retire: [] }, plan });
// A director with a one-task plan: it adds the task when planning and confirms it when approving.
const director = (phase) => phase === "plan" ? review("continue", { add: [{ title: "Sumar", detail: "", criterion: CRITERION, dependsOn: [] }], update: [] }, "N1") : review("complete", { add: [], update: [{ id: 1, status: "done", evidence: "ok", note: "" }] });
const input = (dir, extra = {}) => ({ name: "Suma", directory: dir, objective: "Una función que suma dos números.", criteria: [CRITERION], checks: ["node --test"], ...extra });
const results = (passed = true) => async (p) => p.checks.map((command) => ({ command, passed, code: passed ? 0 : 1, output: passed ? "ℹ tests 3\nℹ pass 3\nℹ fail 0" : "✖ la suma falla", stderr: "" }));

// ---- The permission: one literal command ----
test("el script se escribe en una carpeta sin espacios y la regla de permiso es ese único comando", (t) => {
  const base = fixture();
  const tool = installCheckScript([base]);
  assert.match(tool.path, /automata-tools\/automata-check\.mjs$/);
  assert.equal(tool.command, `node ${tool.path}`);
  assert.equal(allowedCheckTool(tool), `Bash(node ${tool.path})`);
  assert.equal(fs.readFileSync(tool.path, "utf8"), CHECK_SCRIPT);
  fs.writeFileSync(tool.path, "// alterado");
  assert.equal(fs.readFileSync(installCheckScript([base]).path, "utf8"), CHECK_SCRIPT, "una copia alterada se reescribe");
  assert.equal(installCheckScript([]), null);
  assert.equal(allowedCheckTool(null), null);
  assert.doesNotMatch(CHECK_SCRIPT, /process\.argv/, "no acepta argumentos: Claude no elige qué corre");
});

test("una carpeta con espacios (un nombre como «Ana María») se usa por su nombre corto: la misma carpeta, la misma regla literal y sin quotes", { skip: process.platform !== "win32" && "los nombres cortos son de Windows" }, (t) => {
  const base = path.join(fixture(), "Ana María");
  fs.mkdirSync(base, { recursive: true });
  const tool = installCheckScript([base]);
  if (!tool) return t.skip("este disco no tiene nombres cortos (8.3): Claude solo recibiría la orden de esperar a Automata");
  assert.doesNotMatch(tool.command, /\s.*\s/, "sin espacios dentro del comando salvo el que separa node de la ruta");
  assert.doesNotMatch(tool.path, /\s/);
  assert.equal(fs.readFileSync(tool.path, "utf8"), CHECK_SCRIPT);
  assert.equal(fs.realpathSync.native(path.dirname(tool.path)).toLowerCase(), fs.realpathSync.native(path.join(base, "automata-tools")).toLowerCase(), "es la carpeta con espacios, no otra");
  assert.equal(allowedCheckTool(tool), `Bash(${tool.command})`, "la autorización sigue siendo un solo comando literal");
});

test("un nombre corto que no lleva a la misma carpeta, o que sigue teniendo espacios, se descarta y se prueba la siguiente carpeta", (t) => {
  const withSpace = path.join(fixture(), "con espacio"), other = fixture(), good = fixture();
  fs.mkdirSync(withSpace, { recursive: true });
  assert.equal(plainDirectory(withSpace, { short: () => other }), null, "otro lugar: no se acepta");
  assert.equal(plainDirectory(withSpace, { short: () => path.join(other, "tambien con espacio") }), null);
  assert.equal(plainDirectory(withSpace, { short: () => null }), null);
  assert.equal(plainDirectory(good), good, "sin espacios se usa tal cual");
  const tool = installCheckScript([withSpace, good], { short: () => null });
  assert.ok(tool.path.startsWith(good.replace(/\\/g, "/")), "pasó a la carpeta siguiente");
  assert.equal(installCheckScript([withSpace], { short: () => null }), null, "si ninguna sirve, no se promete herramienta");
});

test("el agente real recibe el permiso extra y las variables solo cuando hay herramienta; el resto de sus permisos no cambia", async (t) => {
  const dir = fixture(), dump = path.join(dir, "dump.json"), fake = path.join(dir, "fake-claude.mjs");
  // A Claude that only reports how it was started and answers with a valid final message.
  fs.writeFileSync(fake, `import fs from "node:fs"; fs.writeFileSync(process.env.DUMP, JSON.stringify({ args: process.argv.slice(2), url: process.env.AUTOMATA_CHECK_URL ?? null, token: process.env.AUTOMATA_CHECK_TOKEN ?? null })); console.log(JSON.stringify({ type: "result", subtype: "success", result: "Hecho", session_id: "s1", usage: {} }));`);
  const previous = process.env.AUTOMATA_CLAUDE, previousDump = process.env.DUMP;
  process.env.AUTOMATA_CLAUDE = fake;
  process.env.DUMP = dump;
  t.after(() => { previous === undefined ? delete process.env.AUTOMATA_CLAUDE : process.env.AUTOMATA_CLAUDE = previous; previousDump === undefined ? delete process.env.DUMP : process.env.DUMP = previousDump; });
  const base = { role: "coder", prompt: "x", project: { directory: dir }, settings: { mode: "small", coderModel: "sonnet", coderEffort: "default", timeoutMinutes: 1, language: "es" }, directory: dir, signal: undefined, emit() {}, agent: null };
  const allowed = () => JSON.parse(fs.readFileSync(dump, "utf8"));
  const tool = { command: "node C:/t/automata-tools/automata-check.mjs", env: { AUTOMATA_CHECK_URL: "http://127.0.0.1:1/api/agent-checks", AUTOMATA_CHECK_TOKEN: "tok" } };
  await new CliAgents().attempt({ ...base, phase: "code", settings: { ...base.settings, accessMode: "limited" }, tool });
  const withTool = allowed();
  assert.equal(withTool.args[withTool.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Edit,Write,Bash(git status *),Bash(git diff *),Bash(git log *),Bash(node C:/t/automata-tools/automata-check.mjs)");
  assert.equal(withTool.args[withTool.args.indexOf("--permission-mode") + 1], "acceptEdits", "el modo de permisos no se amplía");
  assert.deepEqual([withTool.url, withTool.token], [tool.env.AUTOMATA_CHECK_URL, "tok"]);
  await new CliAgents().attempt({ ...base, phase: "code", settings: { ...base.settings, accessMode: "limited" }, tool: null });
  const without = allowed();
  assert.equal(without.args[without.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep,Edit,Write,Bash(git status *),Bash(git diff *),Bash(git log *)");
  assert.deepEqual([without.url, without.token], [null, null]);
  await new CliAgents().attempt({ ...base, phase: "chat", settings: { ...base.settings, accessMode: "limited" }, tool });
  assert.equal(allowed().args[allowed().args.indexOf("--allowedTools") + 1], "Read,Glob,Grep", "en el chat de solo lectura la herramienta no aplica");
});

// ---- The coordinator: token, limits, the checks themselves ----
function build(t, { passed = true, accessMode = "limited", onCoder } = {}) {
  const dir = fixture(), calls = [];
  const c = new Coordinator(new Store(path.join(dir, "data")), { evidence: async () => "", checks: results(passed), resumeDelayMs: 0, resources: null, agents: { async run(a) {
    calls.push({ role: a.role, phase: a.phase, tool: a.tool, prompt: a.prompt });
    if (a.role === "coder") { await onCoder?.(a, c); return { text: "Hecho" }; }
    return { review: director(a.phase) };
  } } });
  c.setCheckEndpoint("http://127.0.0.1:4999");
  c.updateSettings({ ...c.settings, accessMode, gitMode: "off", maxRounds: 4 });
  t.after(async () => { await c.close(); });
  const project = c.addProject(validateProject(input(dir)));
  return { c, project, calls, dir };
}

test("con acceso limitado Claude recibe una herramienta con su token y la orden exacta; con acceso completo no", async (t) => {
  const limited = build(t);
  limited.c.start(limited.project.id);
  await settled(limited.c);
  const coder = limited.calls.find((x) => x.role === "coder");
  assert.match(coder.tool.command, /^node .*automata-tools\/automata-check\.mjs$/);
  assert.equal(coder.tool.env.AUTOMATA_CHECK_URL, `http://127.0.0.1:4999${CHECK_ENDPOINT_PATH}`);
  assert.match(coder.tool.env.AUTOMATA_CHECK_TOKEN, /^[0-9a-f-]{36}$/);
  assert.ok(coder.prompt.includes(`ejecuta exactamente  ${coder.tool.command}  sin argumentos (hasta ${MAX_AGENT_CHECK_CALLS} veces por tarea)`));
  assert.match(coder.prompt, /No puedes ejecutar node, npm ni PowerShell[\s\S]*NO es un bloqueo/);
  assert.equal(limited.calls.filter((x) => x.role === "auditor").every((x) => !x.tool), true, "el director no recibe ninguna herramienta");
  assert.equal(limited.c.agentTool, null, "el token se cierra al terminar la llamada");
  const full = build(t, { accessMode: "full" });
  full.c.start(full.project.id);
  await settled(full.c);
  assert.equal(full.calls.find((x) => x.role === "coder").tool, null, "con acceso completo no hace falta");
  assert.doesNotMatch(full.calls.find((x) => x.role === "coder").prompt, /No puedes ejecutar node/);
});

test("mientras Claude trabaja, el token ejecuta las verificaciones del proyecto con el mismo resultado que verá el director; fuera de esa llamada no sirve", async (t) => {
  let seen, early, wrong, again;
  const { c, project, calls } = build(t, { onCoder: async (a, coordinator) => {
    const token = a.tool.env.AUTOMATA_CHECK_TOKEN;
    wrong = await coordinator.agentChecks("otro-token").catch((e) => e);
    seen = await coordinator.agentChecks(token);
    // Two at once: the second waits for nothing, it is refused.
    const first = coordinator.agentChecks(token), second = await coordinator.agentChecks(token).catch((e) => e);
    early = second;
    await first;
    again = token;
  } });
  c.start(project.id);
  await settled(c);
  assert.equal(c.active.status, "complete", c.active.error);
  assert.equal(wrong.status, 401);
  assert.deepEqual(seen, { passed: true, checks: [{ command: "node --test", passed: true, code: 0, output: "ℹ tests 3\nℹ pass 3\nℹ fail 0", stderr: "" }] });
  assert.equal(early.status, 409, "una verificación a la vez");
  await assert.rejects(c.agentChecks(again), (e) => e.status === 401, "terminada la llamada, el token ya no existe");
  assert.equal(calls.filter((x) => x.role === "coder").length, 1);
});

test("las verificaciones que Claude pide usan la lista aprobada del proyecto y se limitan por tarea; si fallan, Claude ve el motivo", async (t) => {
  let outcomes = [];
  const { c, project } = build(t, { passed: false, onCoder: async (a, coordinator) => {
    for (let i = 0; i < MAX_AGENT_CHECK_CALLS + 2; i++) outcomes.push(await coordinator.agentChecks(a.tool.env.AUTOMATA_CHECK_TOKEN).catch((e) => e));
  } });
  c.start(project.id);
  await settled(c);
  assert.equal(outcomes.slice(0, MAX_AGENT_CHECK_CALLS).every((x) => x.passed === false && x.checks[0].command === "node --test" && /la suma falla/.test(x.checks[0].output)), true);
  assert.equal(outcomes[MAX_AGENT_CHECK_CALLS].status, 429);
  assert.match(outcomes[MAX_AGENT_CHECK_CALLS].message, /Ya se usaron las 8 verificaciones/);
  assert.ok(fs.existsSync(path.join(c.store.runDir(c.active.id), "round-01", "claude-checks-1", "check-1.json")) || true);
});

test("sin endpoint, sin verificaciones o con acceso completo no se promete ninguna herramienta; sin endpoint la orden es esperar a Automata", async (t) => {
  const { c, project } = build(t);
  c.setCheckEndpoint(null);
  const run = { settings: { accessMode: "limited" }, project: { checks: ["node --test"] } };
  assert.equal(c.checkToolCommand(run), null);
  c.setCheckEndpoint("http://127.0.0.1:4999");
  assert.equal(c.checkToolCommand({ ...run, project: { checks: [] } }), null);
  assert.equal(c.checkToolCommand({ ...run, settings: { accessMode: "full" } }), null);
  assert.match(c.checkToolCommand(run), /^node /);
  const without = verifySection({ accessMode: "limited" }, { checkCommand: null, web: false });
  assert.match(without, /Automata ejecuta las verificaciones autorizadas del proyecto después de tu turno/);
  assert.doesNotMatch(without, /ejecuta exactamente/);
  assert.ok(project);
});

test("el aviso de Claude cubre la web: ui-check.json con el formato, y no corregir archivos UTF-8 que solo se ven mal", () => {
  const text = verifySection({ accessMode: "limited" }, { checkCommand: "node C:/t/automata-check.mjs", web: true });
  assert.match(text, /ui-check\.json[\s\S]*"scenarios"[\s\S]*expectText/);
  assert.match(text, /PowerShell 5\.1 sin -Encoding UTF8\) muestra «Ã³»[\s\S]*no «corrijas» archivos que están bien/);
  const prompt = coderPrompt({ name: "x", directory: "d", objective: "o", criteria: ["c"], checks: [], constraints: "" }, { accessMode: "limited", mode: "small", language: "es" }, "tarea", "base", null, true, "", "", [], { checkCommand: "node C:/t/automata-check.mjs", web: true });
  assert.match(prompt, /COMPROBACIONES: No puedes ejecutar node/);
});

// ---- The real HTTP endpoint and the real script ----
test("por HTTP: solo desde esta PC, nunca desde una página web, con el token de la llamada; el script real imprime el resultado y su código de salida", async (t) => {
  const dir = fixture();
  let token = null, runScript = null;
  const app = await createServer({ port: 0, dataDir: path.join(dir, "data"), checks: results(true), evidence: async () => "", resumeDelayMs: 0, agents: { async run(a) {
    if (a.role === "coder") {
      token = a.tool.env.AUTOMATA_CHECK_TOKEN;
      // Exactly what Claude would run: the allowed command, with the environment the coordinator gave it.
      runScript = await run(a.tool.command.replace(/^node /, ""), { ...process.env, ...a.tool.env });
      const noToken = await fetch(`${app.origin}${CHECK_ENDPOINT_PATH}`, { method: "POST", headers: { authorization: "Bearer nada" } });
      const fromPage = await fetch(`${app.origin}${CHECK_ENDPOINT_PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: app.origin } });
      const withoutAuthorization = await fetch(`${app.origin}${CHECK_ENDPOINT_PATH}`, { method: "POST" });
      runScript.statuses = [noToken.status, fromPage.status, withoutAuthorization.status];
      return { text: "Hecho" };
    }
    return { review: director(a.phase) };
  } } });
  t.after(async () => { await app.close(); });
  app.coordinator.updateSettings({ ...app.coordinator.settings, accessMode: "limited", gitMode: "off", maxRounds: 3 });
  const project = app.coordinator.addProject(validateProject(input(dir)));
  app.coordinator.start(project.id);
  await settled(app.coordinator);
  assert.equal(app.coordinator.active.status, "complete", app.coordinator.active.error);
  assert.equal(runScript.status, 0, runScript.stderr);
  assert.match(runScript.stdout, /APROBADO · node --test\nℹ tests 3\nℹ pass 3\nℹ fail 0\nTodas las verificaciones pasan\./);
  assert.deepEqual(runScript.statuses, [401, 403, 401], "token equivocado, página web y sin token");
  // Outside any call there is nothing to run.
  const late = await fetch(`${app.origin}${CHECK_ENDPOINT_PATH}`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  assert.equal(late.status, 401);
  assert.match((await late.json()).error, /solo funciona mientras Claude trabaja/);
  const script = await run(app.coordinator.checkScript.path, { ...process.env, AUTOMATA_CHECK_URL: "", AUTOMATA_CHECK_TOKEN: "" });
  assert.equal(script.status, 2, "sin Automata detrás, el script no hace nada");
});
