import fs from "node:fs";
import path from "node:path";
import { runProcess } from "./agents.mjs";
import { githubRepository, validateProject } from "./config.mjs";

export function findGitHub() {
  const override = process.env.AUTOMATA_GITHUB;
  const candidates = [override, process.env.ProgramFiles && path.join(process.env.ProgramFiles, "GitHub CLI", "gh.exe"), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "gh.exe"), process.env.USERPROFILE && path.join(process.env.USERPROFILE, "scoop", "shims", "gh.exe")].filter(Boolean);
  for (const file of candidates) if (fs.existsSync(file)) return { command: file, args: [] };
  return process.platform === "win32" ? null : { command: "gh", args: [] };
}

export class GitHubProjects {
  constructor({ auth, find = findGitHub, run = runProcess }) { Object.assign(this, { auth, find, run }); this.active = null; }
  async prepare(input) {
    if (this.active) throw new Error("Espera a que termine la importación del repositorio actual.");
    const project = validateProject(input);
    if (project.source !== "github") return project;
    const action = input.repositoryAction ?? "clone";
    if (!["clone", "existing"].includes(action)) throw new Error("Elige clonar el repositorio o usar una copia local existente.");
    const controller = new AbortController();
    const work = { controller, pending: null };
    this.active = work;
    work.pending = (async () => {
      if (action === "existing") {
        const root = await this.run("git", ["rev-parse", "--show-toplevel"], { cwd: project.directory, signal: controller.signal, timeoutMs: 20000 });
        const normalized = value => process.platform === "win32" ? value.toLowerCase() : value;
        if (root.code !== 0 || normalized(fs.realpathSync(root.stdout.trim())) !== normalized(project.directory)) throw new Error("Elige la carpeta raíz de la copia local del repositorio.");
        const remote = await this.run("git", ["remote", "get-url", "origin"], { cwd: project.directory, signal: controller.signal, timeoutMs: 20000 });
        let actual;
        try { actual = githubRepository(remote.stdout.trim().replace(/^git@github\.com:/, "https://github.com/")); } catch {}
        if (remote.code !== 0 || actual?.toLowerCase() !== project.repository.toLowerCase()) throw new Error("El repositorio indicado no coincide con origin en esa carpeta. No se cambió su conexión.");
        return project;
      }
      if (fs.readdirSync(project.directory).length) throw new Error("Para clonar, elige una carpeta vacía. Para conservar archivos existentes, usa Local o Copia local existente.");
      const cli = this.find();
      if (!cli) throw new Error("Instala GitHub CLI y conecta GitHub desde Cuentas antes de clonar.");
      await this.auth.requireConnected(["github"]);
      const result = await this.run(cli.command, [...cli.args, "repo", "clone", project.repository, project.directory], { cwd: path.dirname(project.directory), signal: controller.signal, timeoutMs: 5 * 60 * 1000, env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
      if (result.code !== 0) throw new Error("No se pudo clonar el repositorio. Revisa tu conexión, permisos de GitHub y carpeta de destino. No se registró el proyecto; conserva o revisa los archivos descargados antes de reintentar.");
      return project;
    })();
    try { return await work.pending; }
    finally { if (this.active === work) this.active = null; }
  }
  async close() { this.active?.controller.abort(); await this.active?.pending.catch(() => {}); }
}
