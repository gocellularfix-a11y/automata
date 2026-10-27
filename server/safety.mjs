// Where a project may live. Claude works with full access inside the project folder, so the folder
// must be its own: not the disk, not Windows, not the user's whole profile, not a folder that holds
// other repositories (one of them was Automata itself the day the calculator was built), not Automata,
// not Automata's data. Checked when a project is registered and again when a run starts.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
export const AUTOMATA_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const norm = (p) => {
  const resolved = path.resolve(String(p ?? ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
// Folders nobody should hand to an agent with full access. "trees" are refused with everything inside
// them (Windows, programs, app data, credentials); "roots" only as a whole (a subfolder of Documents is fine).
function systemFolders() {
  const env = process.env, home = os.homedir();
  const trees = [env.APPDATA, env.LOCALAPPDATA, env.ProgramData, env.ProgramFiles, env["ProgramFiles(x86)"], env.SystemRoot ?? env.windir, "/etc", "/usr", "/bin", "/sbin", "/var", "/opt", "/System", "/Library", "/private"].filter(Boolean).map(norm);
  for (const sub of [".ssh", ".gnupg", ".claude", ".codex", ".config", ".aws", ".azure"]) trees.push(norm(path.join(home, sub)));
  const roots = [home, ...[env.TEMP, env.TMP].filter(Boolean).map(norm)];
  for (const sub of ["Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music", "OneDrive"]) roots.push(norm(path.join(home, sub)));
  return { trees: [...new Set(trees)], roots: [...new Set(roots)] };
}
// Git repositories inside a folder (not its own .git), up to `depth` levels, skipping heavy folders.
export function nestedRepositories(directory, depth = 3) {
  const found = [];
  const walk = (dir, level) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".automata" || entry.name.startsWith(".") && entry.name !== ".git") continue;
      const file = path.join(dir, entry.name);
      if (entry.name === ".git") { if (level > 0) found.push(path.dirname(file)); continue; }
      if (level < depth) walk(file, level + 1);
    }
  };
  walk(directory, 0);
  return found;
}
// Returns null when the folder is acceptable, or a plain-language reason when it is not.
export function directoryProblem(directory, { automataRoot = AUTOMATA_ROOT, dataDir = null, projectsRoot = null, depth = 3 } = {}) {
  const dir = norm(directory);
  if (dir === norm(path.parse(dir).root)) return "Selecciona la carpeta de un proyecto, no la raíz del disco.";
  const automata = norm(automataRoot);
  if (within(dir, automata) || within(automata, dir)) return "Esa carpeta es Automata (o la contiene). Elige una carpeta propia para el proyecto.";
  if (dataDir && within(dir, norm(dataDir))) return "Esa carpeta guarda los datos de Automata. Elige una carpeta propia para el proyecto.";
  const { trees, roots } = systemFolders();
  // A subfolder of the temporary folder is a throwaway project (and where the tests work): allowed,
  // although on Windows TEMP lives inside LOCALAPPDATA.
  const temp = [process.env.TEMP, process.env.TMP, os.tmpdir()].filter(Boolean).map(norm);
  const inTemp = temp.some((folder) => dir !== folder && within(dir, folder));
  for (const folder of inTemp ? [] : trees) {
    if (within(dir, folder)) return "Esa carpeta pertenece al sistema, a los programas instalados o a datos privados. Elige una carpeta propia para el proyecto.";
    if (within(folder, dir)) return "Esa carpeta contiene carpetas del sistema o de tu usuario. Elige una carpeta más específica.";
  }
  for (const folder of roots) {
    if (dir === folder) return "Esa carpeta es tu usuario entero o una de sus carpetas principales. Crea una subcarpeta solo para el proyecto.";
    if (!inTemp && within(folder, dir)) return "Esa carpeta contiene carpetas del sistema o de tu usuario. Elige una carpeta más específica.";
  }
  if (projectsRoot && dir === norm(projectsRoot)) return "Esa es la carpeta de todos los proyectos. Elige o crea una subcarpeta para este.";
  const repositories = nestedRepositories(directory, depth);
  if (repositories.length) return `Esa carpeta contiene ${repositories.length === 1 ? "otro repositorio" : `${repositories.length} repositorios`} (${repositories.slice(0, 3).map((r) => path.basename(r)).join(", ")}${repositories.length > 3 ? "…" : ""}). Elige la carpeta de un solo proyecto.`;
  return null;
}
export function assertSafeDirectory(directory, context) {
  const problem = directoryProblem(directory, context);
  if (problem) throw Object.assign(new Error(problem), { code: "unsafe-directory" });
}
