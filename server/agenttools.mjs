// The one command Claude may run while its access is limited: «run this project's authorized checks». Claude cannot
// run node, npm or PowerShell on its own (limited access asks for approval nobody can give), so the checks the person
// approved in the proposal are run for it by the coordinator, the same way and with the same function that runs them
// after Claude's turn. The script below only asks the coordinator over loopback with a token that exists for this one
// call; it takes no arguments, so Claude cannot choose what runs. Nothing else is allowed by this: not another command,
// not another file, not a wider permission.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Writes the script to a folder without spaces (a permission rule is matched literally and a path with spaces needs
// quotes that the rule does not match). Returns { path, command } or null when no such folder exists: Claude is then
// simply told that Automata runs the checks after its turn.
export function installCheckScript(baseDirs = [os.tmpdir()]) {
  for (const base of baseDirs) {
    if (!base || /\s/.test(base)) continue;
    try {
      const directory = path.join(base, "automata-tools");
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "automata-check.mjs");
      if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== CHECK_SCRIPT) fs.writeFileSync(file, CHECK_SCRIPT);
      const forward = file.replace(/\\/g, "/");
      return { path: forward, command: `node ${forward}` };
    } catch { /* try the next one */ }
  }
  return null;
}
// The extra permission, exactly the command above and nothing else.
export const allowedCheckTool = (tool) => tool?.command ? `Bash(${tool.command})` : null;
