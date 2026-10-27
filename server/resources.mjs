// A look at the machine's memory before something heavy starts. It only reads; it never closes anything.
//
// Two numbers matter on Windows and they are not the same: the physical memory that is free, and the commit
// headroom (what the system can still promise to programs: RAM plus page file, minus what is already promised).
// A PC can have free RAM and no headroom, and then new programs fail to start.
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MB = 1024 * 1024;
// Claude Code, Codex and a test run need roughly this much; below it a new agent risks being cut by the system.
export const DEFAULT_MIN_FREE_MB = 1536;
export const DEFAULT_MIN_COMMIT_MB = 2048;
const minimum = (env, key, fallback) => {
  const value = Number(env[key]);
  return env[key] !== undefined && env[key] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};
// AUTOMATA_MIN_FREE_MB / AUTOMATA_MIN_COMMIT_MB change the limits; 0 turns that check off.
export const thresholds = (env = process.env) => ({ freeMB: minimum(env, "AUTOMATA_MIN_FREE_MB", DEFAULT_MIN_FREE_MB), commitMB: minimum(env, "AUTOMATA_MIN_COMMIT_MB", DEFAULT_MIN_COMMIT_MB) });

// { totalMB, freeMB, commitFreeMB | null, source }
export async function readMemory() {
  const base = { totalMB: Math.round(os.totalmem() / MB), freeMB: Math.round(os.freemem() / MB), commitFreeMB: null, source: "os" };
  if (process.platform !== "win32") return base;
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "$o = Get-CimInstance Win32_OperatingSystem; [pscustomobject]@{ total = $o.TotalVisibleMemorySize; free = $o.FreePhysicalMemory; commit = $o.FreeVirtualMemory } | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 20000 });
    const o = JSON.parse(stdout);
    return { totalMB: Math.round(o.total / 1024), freeMB: Math.round(o.free / 1024), commitFreeMB: Math.round(o.commit / 1024), source: "windows" };
  } catch {
    return base;
  }
}

export function assess(memory, limits = thresholds()) {
  const problems = [];
  if (limits.freeMB > 0 && memory.freeMB < limits.freeMB) problems.push(`quedan ${memory.freeMB} MB de memoria libre y se necesitan al menos ${limits.freeMB} MB`);
  if (limits.commitMB > 0 && memory.commitFreeMB != null && memory.commitFreeMB < limits.commitMB) problems.push(`el sistema solo puede asignar ${memory.commitFreeMB} MB más (memoria virtual) y se necesitan al menos ${limits.commitMB} MB`);
  return { ok: problems.length === 0, memory, limits, message: problems.length ? `Poca memoria en esta PC: ${problems.join("; ")}. Cierra programas que no uses y vuelve a intentarlo.` : "" };
}

// The check with a short memory: starting several things in a row does not read the system each time.
export function createChecker({ read = readMemory, limits = thresholds, ttlMs = 10000 } = {}) {
  let last = null;
  return async function check({ force = false } = {}) {
    if (!force && last && Date.now() - last.at < ttlMs) return last.result;
    const result = assess(await read(), limits());
    last = { at: Date.now(), result };
    return result;
  };
}
// The one the server and the coordinators share, so a burst of starts reads the system once.
export const sharedChecker = createChecker();
