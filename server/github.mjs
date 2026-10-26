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

// Folder-safe, GitHub-safe name: "Mi Reloj Digital!" -> "mi-reloj-digital".
export const slugify = (name) => String(name).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "") || "proyecto";
// Every project gets its own folder under the projects root; an occupied name gets a numeric suffix.
export function freeFolder(root, base) {
  for (let n = 1; n < 100; n++) {
    const candidate = path.join(root, n === 1 ? base : `${base}-${n}`);
    const stat = fs.statSync(candidate, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory() && !fs.readdirSync(candidate).length) return candidate;
  }
  throw new Error("No se encontró un nombre de carpeta libre en la carpeta de proyectos.");
}
export class GitHubProjects {
  constructor({ auth, find = findGitHub, run = runProcess }) { Object.assign(this, { auth, find, run }); this.active = null; }
  async prepare(input, { root } = {}) {
    if (this.active) throw new Error("Espera a que termine la importación del repositorio actual.");
    // Without a destination, a cloned repository gets its own folder inside the projects root.
    if (input.source === "github" && !String(input.directory ?? "").trim() && (input.repositoryAction ?? "clone") === "clone") {
      if (!root) throw new Error("Define una carpeta de proyectos en Configuración o elige una carpeta de destino.");
      const folder = freeFolder(root, githubRepository(input.repository).split("/").pop());
      fs.mkdirSync(folder, { recursive: true });
      input = { ...input, directory: folder };
    }
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
        const normalized = value => {
          // Native realpath expands Windows 8.3 aliases such as RUNNER~1.
          const canonical = fs.realpathSync.native(value);
          return process.platform === "win32" ? canonical.toLowerCase() : canonical;
        };
        if (root.code !== 0 || normalized(root.stdout.trim()) !== normalized(project.directory)) throw new Error("Elige la carpeta raíz de la copia local del repositorio.");
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
  // A brand new project: its own folder and its own Git repository, optionally mirrored to a private GitHub repo.
  async createNew(input, { root } = {}) {
    if (this.active) throw new Error("Espera a que termine la creación del repositorio actual.");
    if (!root) throw new Error("Define una carpeta de proyectos en Configuración.");
    const name = String(input.name ?? "").trim(), slug = slugify(name), directory = freeFolder(root, slug);
    // Validate everything before touching the disk.
    const draft = validateProject({ ...input, directory, source: "local", repository: void 0 }, { checkDirectory: false });
    const wantsRemote = input.createRemote === true || input.createRemote === "on" || input.createRemote === "true";
    const controller = new AbortController();
    const work = { controller, pending: null };
    this.active = work;
    work.pending = (async () => {
      let cli = null;
      if (wantsRemote) {
        cli = this.find();
        if (!cli) throw new Error("Instala GitHub CLI y conecta GitHub desde Cuentas antes de crear el repositorio remoto.");
        await this.auth.requireConnected(["github"]);
      }
      fs.mkdirSync(directory, { recursive: true });
      const options = { cwd: directory, signal: controller.signal, timeoutMs: 60000, env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } };
      if ((await this.run("git", ["init", "-b", "main"], options)).code !== 0) throw new Error("No se pudo inicializar el repositorio Git. Comprueba que Git esté instalado.");
      fs.writeFileSync(path.join(directory, "README.md"), `# ${name}\n\n${draft.objective}\n`);
      await this.run("git", ["add", "-A"], options);
      const commit = await this.run("git", ["commit", "-m", "chore: inicio del proyecto"], options);
      if (!wantsRemote) return validateProject({ ...input, directory, source: "local", repository: void 0 });
      if (commit.code !== 0) throw new Error(`No se pudo crear el commit inicial (configura user.name y user.email de Git); GitHub necesita al menos uno. La carpeta local quedó en ${directory}.`);
      const created = await this.run(cli.command, [...cli.args, "repo", "create", slug, "--private", "--source", ".", "--remote", "origin", "--push"], { ...options, timeoutMs: 120000 });
      if (created.code !== 0) throw new Error(`No se pudo crear el repositorio en GitHub. La carpeta local quedó en ${directory}; puedes agregarla como proyecto Local.`);
      const remote = await this.run("git", ["remote", "get-url", "origin"], options);
      return validateProject({ ...input, directory, source: "github", repository: githubRepository(remote.stdout.trim().replace(/^git@github\.com:/, "https://github.com/")) });
    })();
    try { return await work.pending; }
    finally { if (this.active === work) this.active = null; }
  }
  async close() { this.active?.controller.abort(); await this.active?.pending.catch(() => {}); }
}
