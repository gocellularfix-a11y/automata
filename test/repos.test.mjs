import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GitHubProjects, slugify, freeFolder } from "../server/github.mjs";
import { runProcess } from "../server/agents.mjs";
import { createServer } from "../server/index.mjs";
const temporaryDirectories = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-repos-"));
  temporaryDirectories.push(dir);
  return dir;
}
after(() => {
  for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-repos-"))) fs.rmSync(dir, { recursive: true, force: true });
});
const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
// Git needs an identity to make the initial commit; give the child processes one without touching global config.
const withIdentity = (run) => (command, args, options = {}) => run(command, args, { ...options, env: { ...identity, ...options.env } });
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
const projectInput = (extra = {}) => ({ name: "Mi Reloj Digital", objective: "Crear un reloj local comprobable.", criteria: ["Muestra la hora actual."], checks: [], ...extra });
const auth = (calls = []) => ({ async requireConnected(roles) { calls.push(roles); } });

test("los nombres de proyecto se convierten en carpetas y repositorios seguros, sin repetirse", () => {
  assert.equal(slugify("Mi Reloj Digital"), "mi-reloj-digital");
  assert.equal(slugify("  ¡Acción & Reacción!  "), "accion-reaccion");
  assert.equal(slugify("../../etc/passwd"), "etc-passwd");
  assert.equal(slugify("!!!"), "proyecto");
  assert.equal(slugify("x".repeat(200)).length, 60);
  const root = fixture();
  assert.equal(freeFolder(root, "reloj"), path.join(root, "reloj"));
  fs.mkdirSync(path.join(root, "reloj"));
  assert.equal(freeFolder(root, "reloj"), path.join(root, "reloj"), "una carpeta vacía se puede reutilizar");
  fs.writeFileSync(path.join(root, "reloj", "a.txt"), "x");
  assert.equal(freeFolder(root, "reloj"), path.join(root, "reloj-2"));
  fs.mkdirSync(path.join(root, "reloj-2"));
  fs.writeFileSync(path.join(root, "reloj-2", "b.txt"), "x");
  assert.equal(freeFolder(root, "reloj"), path.join(root, "reloj-3"));
});

test("un repositorio nuevo tiene su propia carpeta, su propio Git y un primer commit; nada se crea si los datos no son válidos", async () => {
  const root = fixture(), github = new GitHubProjects({ auth: auth(), find: () => { throw new Error("no debe buscar gh"); }, run: withIdentity(runProcess) });
  await assert.rejects(github.createNew({ ...projectInput(), criteria: [] }, { root }), /criterios/);
  await assert.rejects(github.createNew(projectInput(), {}), /carpeta de proyectos/);
  assert.deepEqual(fs.readdirSync(root), []);
  const first = await github.createNew(projectInput(), { root });
  assert.equal(first.source, "local");
  assert.equal(first.repository, null);
  assert.equal(first.directory, fs.realpathSync(path.join(root, "mi-reloj-digital")));
  assert.equal(sh(first.directory, "branch", "--show-current"), "main");
  assert.equal(sh(first.directory, "log", "-1", "--format=%s"), "chore: inicio del proyecto");
  assert.match(fs.readFileSync(path.join(first.directory, "README.md"), "utf8"), /# Mi Reloj Digital[\s\S]*Crear un reloj local comprobable\./);
  const second = await github.createNew(projectInput(), { root });
  assert.equal(second.directory, fs.realpathSync(path.join(root, "mi-reloj-digital-2")));
  assert.notEqual(sh(second.directory, "rev-parse", "--show-toplevel").toLowerCase(), sh(first.directory, "rev-parse", "--show-toplevel").toLowerCase());
  assert.equal(github.active, null);
});

test("un repositorio nuevo puede crear su espejo privado en GitHub y queda registrado como proyecto de GitHub", async () => {
  const root = fixture(), required = [], ghCalls = [];
  const run = withIdentity(async (command, args, options) => {
    if (command !== "gh-test") return runProcess(command, args, options);
    ghCalls.push(args);
    await runProcess("git", ["remote", "add", "origin", "https://github.com/ana/mi-reloj-digital.git"], options);
    return { code: 0, stdout: "", stderr: "" };
  });
  const github = new GitHubProjects({ auth: auth(required), find: () => ({ command: "gh-test", args: [] }), run });
  const project = await github.createNew(projectInput({ createRemote: "on" }), { root });
  assert.deepEqual(required, [["github"]]);
  assert.deepEqual(ghCalls, [["repo", "create", "mi-reloj-digital", "--private", "--source", ".", "--remote", "origin", "--push"]]);
  assert.equal(project.source, "github");
  assert.equal(project.repository, "https://github.com/ana/mi-reloj-digital");
});

test("si GitHub no está disponible o falla, el error lo explica y no expone credenciales", async () => {
  const root = fixture(), missing = new GitHubProjects({ auth: auth(), find: () => null, run: withIdentity(runProcess) });
  await assert.rejects(missing.createNew(projectInput({ createRemote: true }), { root }), /Instala GitHub CLI/);
  assert.deepEqual(fs.readdirSync(root), []);
  const failing = new GitHubProjects({ auth: auth(), find: () => ({ command: "gh-test", args: [] }), run: withIdentity(async (command, args, options) => command === "gh-test" ? { code: 1, stdout: "", stderr: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789 denegado" } : runProcess(command, args, options)) });
  await assert.rejects(failing.createNew(projectInput({ createRemote: true }), { root }), (error) => /No se pudo crear el repositorio en GitHub/.test(error.message) && /Local/.test(error.message) && !/ghp_/.test(error.message));
  assert.equal(failing.active, null);
});

test("clonar sin elegir carpeta guarda cada repositorio en su propia subcarpeta de la carpeta de proyectos", async () => {
  const root = fixture(), origin = path.join(root, "origen.git"), projects = path.join(root, "proyectos");
  assert.equal((await runProcess("git", ["init", "--bare", origin], { cwd: root })).code, 0);
  const github = new GitHubProjects({ auth: auth(), find: () => ({ command: "gh-test", args: [] }), run: async (command, args, options) => command === "gh-test" ? runProcess("git", ["clone", origin, args[3]], options) : runProcess(command, args, options) });
  const request = { name: "Reloj", objective: "Un reloj.", criteria: ["Funciona."], source: "github", repository: "example/clock" };
  await assert.rejects(github.prepare(request), /carpeta de proyectos/);
  const first = await github.prepare(request, { root: projects });
  assert.equal(first.directory, fs.realpathSync(path.join(projects, "clock")));
  assert.ok(fs.existsSync(path.join(first.directory, ".git")));
  const again = await github.prepare(request, { root: projects });
  assert.equal(again.directory, fs.realpathSync(path.join(projects, "clock-2")));
  // una carpeta elegida a mano sigue mandando
  const chosen = path.join(root, "elegida");
  fs.mkdirSync(chosen);
  assert.equal((await github.prepare({ ...request, directory: chosen }, { root: projects })).directory, fs.realpathSync(chosen));
});

test("por HTTP: la carpeta de proyectos se configura, un repositorio nuevo se crea y se registra, y la demostración no los crea", async (t) => {
  const dataDir = fixture(), root = fixture();
  const github = new GitHubProjects({ auth: auth(), find: () => null, run: withIdentity(runProcess) });
  const app = await createServer({ port: 0, dataDir, auth: { async requireConnected() {}, async status() { return {}; }, async close() {} }, github });
  t.after(() => app.close());
  const headers = { Authorization: "Bearer " + app.token, "Content-Type": "application/json" };
  const caps = await (await fetch(app.origin + "/api/capabilities", { headers })).json();
  assert.equal(caps.features.git, true);
  assert.equal(caps.features.newRepos, true);
  assert.deepEqual(caps.gitModes, ["ask-push", "ask-all", "auto", "off"]);
  assert.equal(caps.projectsRoot, path.join(os.homedir(), "Automata Projects"));
  const settings = (await (await fetch(app.origin + "/api/state", { headers })).json()).settings;
  assert.equal(settings.gitMode, "ask-push");
  const saved = await fetch(app.origin + "/api/settings", { method: "PUT", headers, body: JSON.stringify({ ...settings, projectsRoot: root }) });
  assert.equal(saved.status, 200);
  assert.equal((await (await fetch(app.origin + "/api/capabilities", { headers })).json()).projectsRoot, path.resolve(root));
  assert.equal((await fetch(app.origin + "/api/settings", { method: "PUT", headers, body: JSON.stringify({ ...settings, projectsRoot: "relativa" }) })).status, 422);
  const created = await fetch(app.origin + "/api/projects", { method: "POST", headers, body: JSON.stringify({ ...projectInput(), source: "new" }) });
  assert.equal(created.status, 201);
  const project = await created.json();
  assert.equal(project.directory, fs.realpathSync(path.join(root, "mi-reloj-digital")));
  assert.equal(sh(project.directory, "branch", "--show-current"), "main");
  assert.equal(app.coordinator.projects.length, 1);
  const refused = await fetch(app.origin + "/api/git", { method: "POST", headers, body: JSON.stringify({ runId: "x", gitId: "y", decision: "approve" }) });
  assert.equal(refused.status, 422);
  assert.match((await refused.json()).error, /No se encontró/);

  const demo = await createServer({ port: 0, demo: true, dataDir: fixture() });
  t.after(() => demo.close());
  const blocked = await fetch(demo.origin + "/api/projects", { method: "POST", headers: { ...headers, Authorization: "Bearer " + demo.token }, body: JSON.stringify({ ...projectInput(), source: "new" }) });
  assert.equal(blocked.status, 422);
  assert.match((await blocked.json()).error, /sin --demo/);
});
