import path from "node:path";
import { runProcess, redact } from "./agents.mjs";

// The director only decides; these are the operations the executor side carries out.
// They are deliberately narrow: no force pushes, no history rewrites, no branch deletion.
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
export const validBranch = (name) => typeof name === "string" && BRANCH.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock") && !name.includes("/.");
const SENSITIVE = [
  /(^|\/)\.env(\.(?!example$|sample$|template$)[^/]*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|\/)(credentials|secrets?)(\.[^/]+)?\.(json|ya?ml|env|txt)$/i
];
export const isSensitivePath = (file) => SENSITIVE.some((pattern) => pattern.test(String(file).replace(/\\/g, "/")));
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

// Turns whatever the director wrote into a safe, minimal decision.
export function normalizeGit(raw) {
  const g = raw && typeof raw === "object" ? raw : {};
  const message = typeof g.message === "string" ? g.message.replace(control, "").trim().slice(0, 500) : "";
  const into = g.merge_into ?? g.mergeInto;
  return { commit: g.commit === true && !!message, message, push: g.push === true, branch: validBranch(g.branch) ? g.branch : "", mergeInto: validBranch(into) ? into : "" };
}
export const hasGitActions = (decision) => !!(decision.commit || decision.push || decision.branch || decision.mergeInto);

const quote = (arg) => /^[\w./:@=+,-]+$/.test(arg) ? arg : JSON.stringify(arg);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export class GitOps {
  constructor({ run = runProcess, env = {} } = {}) {
    this.run = run;
    this.env = env;
  }
  async git(dir, args, { signal, onStep, timeoutMs = 120000 } = {}) {
    let result;
    try {
      result = await this.run("git", args, { cwd: dir, signal, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", ...this.env } });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      result = { code: -1, stdout: "", stderr: error.message };
    }
    const output = redact(`${result.stdout ?? ""}${result.stderr ? "\n" + result.stderr : ""}`.trim()).slice(-3000);
    const step = { command: "git " + args.map(quote).join(" "), code: result.code, output };
    onStep?.(step);
    return { ...result, ...step };
  }
  async inspect(dir) {
    const inside = await this.git(dir, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.code !== 0 || inside.stdout.trim() !== "true") return { repo: false };
    const [top, branch, status, remote, head] = await Promise.all([
      this.git(dir, ["rev-parse", "--show-toplevel"]),
      this.git(dir, ["branch", "--show-current"]),
      this.git(dir, ["status", "--porcelain", "--", "."]),
      this.git(dir, ["remote", "get-url", "origin"]),
      this.git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"])
    ]);
    const root = top.stdout.trim();
    return { repo: true, root, nested: !samePath(root, dir), branch: branch.stdout.trim(), dirty: status.stdout.trim().length > 0, remote: remote.code === 0 ? remote.stdout.trim() : "", hasCommits: head.code === 0 };
  }
  // The files with changes that no commit has saved yet (this folder only), and which of them Automata never commits.
  async pending(dir) {
    const status = await this.git(dir, ["status", "--porcelain", "--", "."]);
    const files = status.code !== 0 ? [] : status.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => line.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
    const sensitive = files.filter(isSensitivePath);
    return { files, sensitive, savable: files.filter((file) => !sensitive.includes(file)) };
  }
  // Every operation returns { ok, summary | error, steps } so callers can show the exact commands.
  async commit(dir, message, options = {}) {
    const steps = [], onStep = (step) => { steps.push(step); options.onStep?.(step); }, o = { ...options, onStep };
    const fail = (error) => ({ ok: false, error, steps });
    const info = await this.inspect(dir);
    if (!info.repo) return fail("Este proyecto no es un repositorio Git.");
    if (!message?.trim()) return fail("El commit necesita un mensaje.");
    const add = await this.git(dir, ["add", "-A", "--", "."], o);
    if (add.code !== 0) return fail(add.output || "No se pudo preparar los cambios.");
    const names = (await this.git(dir, ["diff", "--cached", "--name-only", "--", "."])).stdout.split(/\r?\n/).filter(Boolean);
    const blocked = names.filter(isSensitivePath);
    if (blocked.length) await this.git(dir, ["reset", "-q", "--", ...blocked], o);
    const staged = await this.git(dir, ["diff", "--cached", "--quiet", "--", "."]);
    if (staged.code === 0) return { ok: true, noop: true, summary: "Sin cambios para confirmar.", blocked, steps };
    const commit = await this.git(dir, ["commit", "-m", message], o);
    if (commit.code !== 0) return fail(commit.output || "No se pudo crear el commit.");
    const hash = (await this.git(dir, ["rev-parse", "--short", "HEAD"])).stdout.trim();
    return { ok: true, summary: `Commit ${hash}`, hash, blocked, steps };
  }
  async branch(dir, name, options = {}) {
    const steps = [], onStep = (step) => { steps.push(step); options.onStep?.(step); }, o = { ...options, onStep };
    const fail = (error) => ({ ok: false, error, steps });
    if (!validBranch(name)) return fail("Nombre de rama no válido.");
    const info = await this.inspect(dir);
    if (!info.repo) return fail("Este proyecto no es un repositorio Git.");
    if ((await this.git(dir, ["check-ref-format", "--branch", name])).code !== 0) return fail("Nombre de rama no válido.");
    if (info.branch === name) return { ok: true, noop: true, summary: `Ya estás en ${name}.`, steps };
    const exists = (await this.git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])).code === 0;
    const sw = await this.git(dir, exists ? ["switch", name] : ["switch", "-c", name], o);
    return sw.code === 0 ? { ok: true, summary: exists ? `Rama ${name}` : `Rama nueva ${name}`, steps } : fail(sw.output || "No se pudo cambiar de rama.");
  }
  async push(dir, options = {}) {
    const steps = [], onStep = (step) => { steps.push(step); options.onStep?.(step); }, o = { ...options, onStep };
    const fail = (error) => ({ ok: false, error, steps });
    const info = await this.inspect(dir);
    if (!info.repo) return fail("Este proyecto no es un repositorio Git.");
    if (!info.branch) return fail("No hay una rama activa para publicar.");
    if (!info.remote) return fail("El repositorio no tiene un remoto origin. Conéctalo a GitHub antes de hacer push.");
    const push = await this.git(dir, ["push", "-u", "origin", info.branch], { ...o, timeoutMs: 180000 });
    return push.code === 0 ? { ok: true, summary: `Push de ${info.branch}`, steps } : fail(push.output || "No se pudo hacer push.");
  }
  async merge(dir, into, options = {}) {
    const steps = [], onStep = (step) => { steps.push(step); options.onStep?.(step); }, o = { ...options, onStep };
    const fail = (error) => ({ ok: false, error, steps });
    if (!validBranch(into)) return fail("Nombre de rama no válido.");
    const info = await this.inspect(dir);
    if (!info.repo) return fail("Este proyecto no es un repositorio Git.");
    if (!info.branch) return fail("No hay una rama activa para fusionar.");
    if (info.branch === into) return { ok: true, noop: true, summary: `Ya estás en ${into}.`, steps };
    if (info.dirty) return fail("Hay cambios sin confirmar; confírmalos antes de fusionar.");
    if ((await this.git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${into}`])).code !== 0) return fail(`La rama ${into} no existe.`);
    const from = info.branch;
    const sw = await this.git(dir, ["switch", into], o);
    if (sw.code !== 0) return fail(sw.output || "No se pudo cambiar a la rama destino.");
    const merge = await this.git(dir, ["merge", "--no-ff", "--no-edit", from], o);
    if (merge.code !== 0) {
      await this.git(dir, ["merge", "--abort"], o);
      await this.git(dir, ["switch", from], o);
      return fail(merge.output || "El merge tiene conflictos y se canceló.");
    }
    return { ok: true, summary: `Merge de ${from} en ${into}`, steps };
  }
}
