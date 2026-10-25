import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { githubRepository, validateProject } from "../server/config.mjs";
import { GitHubProjects } from "../server/github.mjs";
import { gitEvidence, runProcess } from "../server/agents.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "automata-github-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const input = directory => ({ name: "Reloj digital", directory, objective: "Crear un reloj local comprobable.", criteria: ["Muestra la hora actual."], source: "github", repository: "example/clock" });

test("las fuentes de proyecto aceptan Local o GitHub, con URLs sin credenciales ni opciones inyectadas", t => {
  const root = fixture(t);
  assert.equal(githubRepository("example/clock.git"), "https://github.com/example/clock");
  assert.equal(githubRepository("https://github.com/example/clock/"), "https://github.com/example/clock");
  for (const value of ["--upload-pack=evil", "https://user:secret@github.com/a/b", "http://github.com/a/b", "https://github.com.evil.test/a/b", "https://github.com/a/b/tree/main", "https://github.com/a/b?token=secret", "https://github.com/a/b#part", "a/b;whoami", "a/..", "https://github.com:8443/a/b"]) assert.throws(() => githubRepository(value));
  assert.equal(validateProject({ ...input(root), source: "local", repository: "ignored-stale-value" }).repository, null);
  assert.equal(validateProject(input(root)).repository, "https://github.com/example/clock");
  assert.throws(() => validateProject({ ...input(root), source: "ftp" }), /Local o GitHub/);
});

test("clonar conserva carpetas ocupadas y transmite el repo como argumento; una copia existente debe coincidir", async t => {
  const root = fixture(t), origin = path.join(root, "origin.git"), destination = path.join(root, "clock");
  fs.mkdirSync(destination);
  const initialized = await runProcess("git", ["init", "--bare", origin], { cwd: root });
  assert.equal(initialized.code, 0);
  const calls = [], requirements = [];
  const github = new GitHubProjects({
    auth: { async requireConnected(roles) { requirements.push(roles); } },
    find: () => ({ command: "gh-test", args: [] }),
    run: async (command, args, options) => {
      calls.push({ command, args });
      return command === "gh-test" ? runProcess("git", ["clone", origin, args[3]], options) : runProcess(command, args, options);
    }
  });
  t.after(() => github.close());
  fs.writeFileSync(path.join(destination, "keep.txt"), "mis cambios");
  await assert.rejects(github.prepare(input(destination)), /carpeta vacía/);
  assert.equal(fs.readFileSync(path.join(destination, "keep.txt"), "utf8"), "mis cambios");
  assert.equal(calls.length, 0);
  fs.unlinkSync(path.join(destination, "keep.txt"));
  const project = await github.prepare(input(destination));
  assert.equal(project.source, "github");
  assert.deepEqual(requirements, [["github"]]);
  assert.deepEqual(calls[0].args, ["repo", "clone", "https://github.com/example/clock", fs.realpathSync(destination)]);
  assert.equal(fs.existsSync(path.join(destination, ".git")), true);
  await runProcess("git", ["remote", "set-url", "origin", "https://github.com/example/clock.git"], { cwd: destination });
  assert.equal((await github.prepare({ ...input(destination), repositoryAction: "existing" })).repository, project.repository);
  await assert.rejects(github.prepare({ ...input(destination), repository: "example/other", repositoryAction: "existing" }), /no coincide/);
  const actual = await runProcess("git", ["remote", "get-url", "origin"], { cwd: destination });
  assert.equal(actual.stdout.trim(), "https://github.com/example/clock.git");
});

test("un fallo de clonación no se registra como proyecto ni expone la salida de credenciales", async t => {
  const root = fixture(t);
  const github = new GitHubProjects({ auth: { async requireConnected() {} }, find: () => ({ command: "gh-test", args: [] }), run: async () => ({ code: 1, stderr: "secret credential", stdout: "" }) });
  await assert.rejects(github.prepare(input(root)), error => /No se pudo clonar/.test(error.message) && !/secret credential/.test(error.message));
  assert.equal(github.active, null);
  assert.deepEqual(fs.readdirSync(root), []);
});

test("una carpeta local no necesita GitHub y la falta de Git no impide recoger evidencia", async t => {
  const root = fixture(t);
  const github = new GitHubProjects({ auth: { requireConnected() { throw Error("must not authenticate"); } }, find: () => { throw Error("must not find gh"); } });
  const local = await github.prepare({ ...input(root), source: "local" });
  assert.equal(local.source, "local");
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
  const evidence = await gitEvidence(root);
  assert.match(evidence, /archivos|git status/);
  assert.equal(fs.existsSync(path.join(root, ".git")), false);
});
