// The one command Claude may run while its access is limited: «run this project's authorized checks». Claude cannot
// run node, npm or PowerShell on its own (limited access asks for approval nobody can give), so the checks the person
// approved in the proposal are run for it by the coordinator, the same way and with the same function that runs them
// after Claude's turn. The script below only asks the coordinator over loopback with a token that exists for this one
// call; it takes no arguments, so Claude cannot choose what runs. Nothing else is allowed by this: not another command,
// not another file, not a wider permission.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const CHECK_ENDPOINT_PATH = "/api/agent-checks";
export const MAX_AGENT_CHECK_CALLS = 8;
// Written out at start-up: a packaged app keeps its own files inside an archive that an external node cannot run.
export const CHECK_SCRIPT = `// Automata: runs the project's authorized checks through the coordinator that started this call. No arguments.
const url = process.env.AUTOMATA_CHECK_URL, token = process.env.AUTOMATA_CHECK_TOKEN;
if (!url || !token) { console.error("Automata no abrió esta herramienta para esta tarea."); process.exit(2); }
try {
  const response = await fetch(url, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(6 * 60 * 1000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { console.error(data.error || "Automata respondió " + response.status); process.exit(2); }
  for (const c of data.checks) console.log((c.passed ? "APROBADO" : "FALLÓ") + " · " + c.command + (c.passed ? "" : " (código " + c.code + ")") + (c.output ? "\\n" + c.output : "") + (c.stderr ? "\\n" + c.stderr : ""));
  console.log(data.passed ? "Todas las verificaciones pasan." : "Hay verificaciones que fallan.");
  process.exit(data.passed ? 0 : 1);
} catch (error) {
  console.error("No se pudo hablar con Automata: " + error.message);
  process.exit(2);
}
`;

// A permission rule is matched literally and a path with spaces needs quotes that the rule does not match, so the
// script must live at a path without whitespace. A folder with spaces (a user name like «Ana María») is used through
// its Windows short name (8.3) when the PC has one: the same folder, checked below by resolving both to the same place.
export function plainDirectory(directory, { short = shortName } = {}) {
  if (!/\s/.test(directory)) return directory;
  const alias = short(directory);
  if (!alias || /\s/.test(alias)) return null;
  try { return fs.realpathSync.native(alias).toLowerCase() === fs.realpathSync.native(directory).toLowerCase() ? alias : null; } catch { return null; }
}
function shortName(directory) {
  if (process.platform !== "win32") return null;
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:AUTOMATA_FOLDER).ShortPath"], { encoding: "utf8", windowsHide: true, timeout: 15000, env: { ...process.env, AUTOMATA_FOLDER: directory } }).trim() || null;
  } catch { return null; }
}
// Writes the script where the rule can name it. Returns { path, command } or null when no such folder exists: Claude is
// then simply told that Automata runs the checks after its turn.
export function installCheckScript(baseDirs = [os.tmpdir(), path.join(os.homedir(), ".automata")], { short } = {}) {
  for (const base of baseDirs) {
    if (!base) continue;
    try {
      const directory = path.join(base, "automata-tools");
      fs.mkdirSync(directory, { recursive: true });
      const plain = plainDirectory(directory, short ? { short } : undefined);
      if (!plain) continue;
      const file = path.join(plain, "automata-check.mjs");
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== CHECK_SCRIPT) fs.writeFileSync(file, CHECK_SCRIPT);
      const forward = file.replace(/\\/g, "/");
      return { path: forward, command: `node ${forward}` };
    } catch { /* try the next one */ }
  }
  return null;
}
// The extra permission, exactly the command above and nothing else.
export const allowedCheckTool = (tool) => tool?.command ? `Bash(${tool.command})` : null;
