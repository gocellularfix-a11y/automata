// A look at the machine's memory, and at what Automata itself uses, before something heavy starts.
// It only reads; it never closes, pauses or changes any process.
//
// Three different numbers matter on Windows:
//  - the physical memory that is free in the whole system (what Windows and the other programs still have),
//  - the commit headroom (what the system can still promise to programs: RAM plus page file, minus what is
//    already promised) — a PC can have free RAM and no headroom, and then new programs fail to start,
//  - what Automata's own process tree uses: Automata, Claude, Codex, the checks and the app it runs. Nothing else.
// The budget is a ceiling Automata sets for that third number. It is supervision, not a hard limit: Automata does
// not start new processes when the next one would not fit, but a process already running is never closed for it.
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { listProcesses, descendantsOf } from "./procs.mjs";

const run = promisify(execFile);
const MB = 1024 * 1024;
// Claude Code, Codex and a test run need roughly this much; below it a new agent risks being cut by the system.
export const DEFAULT_MIN_FREE_MB = 1536;
export const DEFAULT_MIN_COMMIT_MB = 2048;
// 30 GiB: the most Automata's own processes may use together, unless Settings or AUTOMATA_RAM_BUDGET_MB say otherwise.
export const DEFAULT_RAM_BUDGET_MB = 30720;
// Room kept for the next process Automata would start (an agent's CLI is about 0.5 GB, plus what it loads).
export const NEW_PROCESS_RESERVE_MB = 1024;
// From this share of the budget the state is "near": the next agent only starts if it still fits.
export const NEAR_RATIO = 0.85;
const minimum = (env, key, fallback) => {
  const value = Number(env[key]);
  return env[key] !== undefined && env[key] !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
};
// AUTOMATA_MIN_FREE_MB / AUTOMATA_MIN_COMMIT_MB change the limits; 0 turns that check off.
export const thresholds = (env = process.env) => ({ freeMB: minimum(env, "AUTOMATA_MIN_FREE_MB", DEFAULT_MIN_FREE_MB), commitMB: minimum(env, "AUTOMATA_MIN_COMMIT_MB", DEFAULT_MIN_COMMIT_MB) });
// The starting value of the budget setting; once saved in Settings, that value rules. 0 turns the budget off.
export const defaultBudget = (env = process.env) => Math.round(minimum(env, "AUTOMATA_RAM_BUDGET_MB", DEFAULT_RAM_BUDGET_MB));

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

// What the process tree under `root` (Automata itself and everything it started) uses, from a process table.
export function treeUsage(table, root = process.pid) {
  const tree = descendantsOf(table, root);
  const sum = (key, test = () => true) => Math.round(tree.filter(test).reduce((a, p) => a + (p[key] ?? 0), 0) / MB);
  return { usedMB: sum("workingSet"), privateMB: sum("privateBytes"), processes: tree.length, claudeMB: sum("workingSet", (p) => /claude/i.test(p.name)), codexMB: sum("workingSet", (p) => /codex/i.test(p.name)), nodeMB: sum("workingSet", (p) => /^node/i.test(p.name)) };
}
export async function readTree(root = process.pid) {
  return treeUsage(await listProcesses(), root);
}

// The budget's state for a given use: off, ok, near (next process may not fit) or over (above the ceiling).
export function budgetState(usedMB, budgetMB, reserveMB = NEW_PROCESS_RESERVE_MB) {
  if (!(budgetMB > 0)) return "off";
  if (usedMB > budgetMB) return "over";
  return usedMB >= budgetMB * NEAR_RATIO || usedMB + reserveMB > budgetMB ? "near" : "ok";
}

// memory: readMemory() plus tree (treeUsage) when it was read. budgetMB: the ceiling for the tree (0 = none).
export function assess(memory, limits = thresholds(), budgetMB = 0) {
  const problems = [];
  if (limits.freeMB > 0 && memory.freeMB < limits.freeMB) problems.push(`quedan ${memory.freeMB} MB de memoria libre en el sistema y se necesitan al menos ${limits.freeMB} MB para no quitarle memoria a Windows y a otros programas`);
  if (limits.commitMB > 0 && memory.commitFreeMB != null && memory.commitFreeMB < limits.commitMB) problems.push(`el sistema solo puede asignar ${memory.commitFreeMB} MB más (memoria virtual) y se necesitan al menos ${limits.commitMB} MB`);
  const budget = { budgetMB, usedMB: memory.tree?.usedMB ?? null, state: memory.tree ? budgetState(memory.tree.usedMB, budgetMB) : "off" };
  if (budget.state === "near" || budget.state === "over") problems.push(`Automata y sus procesos usan ${budget.usedMB} MB de su presupuesto de ${budgetMB} MB y no cabe otro proceso (hacen falta ${NEW_PROCESS_RESERVE_MB} MB libres dentro del presupuesto)`);
  return { ok: problems.length === 0, memory, limits, budget, message: problems.length ? `Poca memoria para empezar algo nuevo: ${problems.join("; ")}. Se espera a que haya; lo que ya está en marcha no se cierra.` : "" };
}

// The check with a short memory: starting several things in a row does not read the system each time. The reading
// is what is kept; the budget and the limits are applied to it on every call, so changing them takes effect at once.
export function createChecker({ read = async ({ budget } = {}) => { const [memory, tree] = await Promise.all([readMemory(), budget ? readTree().catch(() => null) : null]); return { ...memory, tree }; }, limits = thresholds, ttlMs = 10000 } = {}) {
  let last = null;
  return async function check({ force = false, budgetMB = 0 } = {}) {
    if (force || !last || Date.now() - last.at >= ttlMs || budgetMB > 0 && !last.memory.tree) last = { at: Date.now(), memory: await read({ budget: budgetMB > 0 }) };
    return assess(last.memory, limits(), budgetMB);
  };
}
// The one the server and the coordinators share, so a burst of starts reads the system once.
export const sharedChecker = createChecker();
