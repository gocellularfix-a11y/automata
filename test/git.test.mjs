import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { GitOps, normalizeGit, validBranch, isSensitivePath, hasGitActions } from "../server/git.mjs";

const identity = { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
const temporaryDirectories = [];
after(() => { for (const dir of temporaryDirectories) if (path.resolve(dir).startsWith(path.join(os.tmpdir(), "automata-git-"))) fs.rmSync(dir, { recursive: true, force: true }); });
const sh = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...identity }, encoding: "utf8" }).trim();
function repo({ commits = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-git-"));
  temporaryDirectories.push(dir);
  sh(dir, "init", "-q", "-b", "main");
  if (commits) {
    fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}
const ops = () => new GitOps({ env: identity });

test("las decisiones de Git del director se normalizan y los nombres peligrosos se descartan", () => {
  assert.deepEqual(normalizeGit(undefined), { commit: false, message: "", push: false, branch: "", mergeInto: "" });
  assert.deepEqual(normalizeGit({ commit: true, message: "  feat: añade reloj  ", push: true, branch: "feature/reloj", merge_into: "main" }), { commit: true, message: "feat: añade reloj", push: true, branch: "feature/reloj", mergeInto: "main" });
  assert.equal(normalizeGit({ commit: true, message: "   " }).commit, false);
  assert.equal(normalizeGit({ commit: "true", message: "x", push: "yes" }).commit, false);
  assert.equal(normalizeGit({ commit: true, message: "x", push: "yes" }).push, false);
  for (const bad of ["--force", "-D main", "a..b", "x;rm -rf", "feat/.hidden", "a//b", "rama.lock", "/abs", "", "x y"]) {
    assert.equal(validBranch(bad), false, bad);
    assert.equal(normalizeGit({ branch: bad, merge_into: bad }).branch, "", bad);
  }
  for (const good of ["main", "feature/reloj-1", "release_1.2"]) assert.equal(validBranch(good), true, good);
  assert.equal(hasGitActions(normalizeGit({})), false);
  assert.equal(hasGitActions(normalizeGit({ push: true })), true);
  assert.equal(normalizeGit({ commit: true, message: "a\u0000b" }).message, "ab");
});

test("los archivos con secretos se reconocen", () => {
  for (const file of [".env", "app/.env.local", "certs/server.pem", "id_rsa", "config/credentials.json", "android/release.keystore"]) assert.equal(isSensitivePath(file), true, file);
  for (const file of [".env.example", "src/environment.js", "id_rsa.pub", "README.md"]) assert.equal(isSensitivePath(file), false, file);
});

test("commit confirma los cambios del proyecto, deja fuera los secretos y no repite si no hay cambios", async () => {
  const dir = repo(), git = ops(), seen = [];
  fs.writeFileSync(path.join(dir, "app.js"), "console.log(1)\n");
  fs.writeFileSync(path.join(dir, ".env"), "TOKEN=secreto\n");
  const result = await git.commit(dir, "feat: primera versión", { onStep: (step) => seen.push(step.command) });
  assert.equal(result.ok, true, result.error);
  assert.match(result.summary, /^Commit [0-9a-f]+$/);
  assert.deepEqual(result.blocked, [".env"]);
  assert.ok(seen.some((command) => command.startsWith("git commit")));
  assert.equal(sh(dir, "log", "-1", "--format=%s"), "feat: primera versión");
  assert.match(sh(dir, "show", "--name-only", "--format=", "HEAD"), /app\.js/);
  assert.doesNotMatch(sh(dir, "show", "--name-only", "--format=", "HEAD"), /\.env/);
  const again = await git.commit(dir, "feat: nada nuevo");
  assert.equal(again.ok, true);
  assert.equal(again.noop, true);
  assert.equal(sh(dir, "rev-list", "--count", "HEAD"), "2");
});

test("commit funciona en un repositorio recién creado y solo toca la carpeta del proyecto cuando está anidado", async () => {
  const fresh = repo({ commits: false }), git = ops();
  fs.writeFileSync(path.join(fresh, "a.txt"), "a");
  assert.equal((await git.commit(fresh, "chore: inicio")).ok, true);
  const outer = repo(), inner = path.join(outer, "proyecto");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, "dentro.txt"), "1");
  fs.writeFileSync(path.join(outer, "fuera.txt"), "2");
  const info = await git.inspect(inner);
  assert.equal(info.repo, true);
  assert.equal(info.nested, true);
  assert.equal((await git.commit(inner, "feat: solo el proyecto")).ok, true);
  const files = sh(outer, "show", "--name-only", "--format=", "HEAD");
  assert.match(files, /proyecto\/dentro\.txt/);
  assert.doesNotMatch(files, /fuera\.txt/);
});

test("fuera de un repositorio ninguna operación hace nada y lo explica", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "automata-git-"));
  temporaryDirectories.push(dir);
  const git = ops();
  assert.deepEqual(await git.inspect(dir), { repo: false });
  for (const result of [await git.commit(dir, "x"), await git.branch(dir, "feature/x"), await git.push(dir), await git.merge(dir, "main")]) {
    assert.equal(result.ok, false);
    assert.match(result.error, /no es un repositorio/);
  }
});

test("branch crea o cambia de rama y rechaza nombres no válidos", async () => {
  const dir = repo(), git = ops();
  assert.equal((await git.branch(dir, "feature/reloj")).summary, "Rama nueva feature/reloj");
  assert.equal(sh(dir, "branch", "--show-current"), "feature/reloj");
  assert.equal((await git.branch(dir, "feature/reloj")).noop, true);
  assert.equal((await git.branch(dir, "main")).summary, "Rama main");
  assert.equal((await git.branch(dir, "--detach")).ok, false);
  assert.equal(sh(dir, "branch", "--show-current"), "main");
});

test("push publica la rama actual en origin y nunca fuerza; sin remoto avisa", async () => {
  const dir = repo(), remote = fs.mkdtempSync(path.join(os.tmpdir(), "automata-git-")), git = ops();
  temporaryDirectories.push(remote);
  sh(remote, "init", "-q", "--bare", "-b", "main");
  const none = await git.push(dir);
  assert.equal(none.ok, false);
  assert.match(none.error, /remoto origin/);
  sh(dir, "remote", "add", "origin", remote);
  await git.branch(dir, "feature/x");
  fs.writeFileSync(path.join(dir, "x.txt"), "x");
  await git.commit(dir, "feat: x");
  const pushed = await git.push(dir);
  assert.equal(pushed.ok, true, pushed.error);
  assert.equal(pushed.summary, "Push de feature/x");
  assert.equal(sh(remote, "rev-parse", "--verify", "refs/heads/feature/x"), sh(dir, "rev-parse", "HEAD"));
  assert.ok(pushed.steps.every((step) => !step.command.includes("--force")));
});

test("merge fusiona la rama actual en la destino, y cancela y vuelve atrás si hay conflicto o cambios sin confirmar", async () => {
  const dir = repo(), git = ops();
  await git.branch(dir, "feature/a");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  await git.commit(dir, "feat: a");
  fs.writeFileSync(path.join(dir, "sucio.txt"), "sin confirmar");
  const dirty = await git.merge(dir, "main");
  assert.equal(dirty.ok, false);
  assert.match(dirty.error, /sin confirmar/);
  fs.unlinkSync(path.join(dir, "sucio.txt"));
  assert.match((await git.merge(dir, "no-existe")).error, /no existe/);
  const merged = await git.merge(dir, "main");
  assert.equal(merged.ok, true, merged.error);
  assert.equal(merged.summary, "Merge de feature/a en main");
  assert.equal(sh(dir, "branch", "--show-current"), "main");
  assert.ok(fs.existsSync(path.join(dir, "a.txt")));
  // conflicto
  await git.branch(dir, "feature/b");
  fs.writeFileSync(path.join(dir, "README.md"), "# desde b\n");
  await git.commit(dir, "feat: b");
  await git.branch(dir, "main");
  fs.writeFileSync(path.join(dir, "README.md"), "# desde main\n");
  await git.commit(dir, "feat: main");
  await git.branch(dir, "feature/b");
  const conflict = await git.merge(dir, "main");
  assert.equal(conflict.ok, false);
  assert.equal(sh(dir, "branch", "--show-current"), "feature/b");
  assert.equal(sh(dir, "status", "--porcelain"), "");
  assert.equal(fs.readFileSync(path.join(dir, "README.md"), "utf8").replace(/\r\n/g, "\n"), "# desde b\n");
});
