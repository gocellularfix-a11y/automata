// Child processes: which ones Automata started, and cleaning up what they leave behind.
//
// Nothing here ever kills a process just because of its name. A process is only closed when Automata can prove
// it is its own: it was started by Automata (it is in the registry file, with the moment it started) or it was
// created, by a process Automata started, while that process was running. A recycled process id, a process with
// the same name that the user started, or the user's own Automata never match.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const windows = process.platform === "win32";
// How far apart the clock of Node and the creation time Windows reports may be for the same process.
const SKEW_MS = 5000;

// Every process on the machine: { pid, ppid, name, created (ms since the epoch) }.
export async function listProcesses() {
  try {
    if (windows) {
      const script = "Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; ws = [int64]$_.WorkingSetSize; priv = [int64]$_.PrivatePageCount } } | ConvertTo-Json -Compress";
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
      const parsed = JSON.parse(stdout);
      return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.pid, ppid: p.ppid, name: String(p.name ?? ""), created: p.created, workingSet: p.ws, privateBytes: p.priv }));
    }
    const { stdout } = await run("ps", ["-eo", "pid=,ppid=,lstart=,rss=,comm="], { maxBuffer: 16 * 1024 * 1024, timeout: 15000 });
    return stdout.split("\n").flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]{8} \d{4})\s+(\d+)\s+(.*)$/.exec(line);
      return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), created: Date.parse(m[3]), workingSet: Number(m[4]) * 1024, privateBytes: 0, name: path.basename(m[5].trim()) }] : [];
    });
  } catch {
    return [];
  }
}

// The process with this id and everything that hangs from it, in a process table.
export function descendantsOf(table, root) {
  const found = table.filter((p) => p.pid === root), seen = new Set([root]), queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of table) if (p.ppid === parent && !seen.has(p.pid)) { seen.add(p.pid); found.push(p); queue.push(p.pid); }
  }
  return found;
}

async function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 4 || pid === process.pid) return false;
  try {
    if (windows) await run("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true });
    else {
      try { process.kill(-pid, "SIGKILL"); } catch { process.kill(pid, "SIGKILL"); }
    }
    return true;
  } catch {
    return false;
  }
}

// ---- Registry: the children of this Automata, in a file next to its data ------------------------------------
const state = { file: null, owner: { pid: process.pid, startedAt: Date.now() - Math.round(process.uptime() * 1000) }, children: new Map() };
const write = () => {
  if (!state.file) return;
  try {
    fs.mkdirSync(path.dirname(state.file), { recursive: true });
    fs.writeFileSync(state.file, JSON.stringify({ owner: state.owner, children: [...state.children.values()] }));
  } catch {
    // The registry helps cleaning; it must never stop the work.
  }
};
export function useRegistry(file) {
  state.file = file;
  state.children.clear();
  write();
}
export function trackChild(child, meta = {}) {
  if (!child?.pid) return;
  state.children.set(child.pid, { pid: child.pid, startedAt: Date.now(), name: path.basename(child.spawnfile ?? meta.command ?? ""), ...meta });
  write();
}
export function releaseChild(pid) {
  if (state.children.delete(pid)) write();
}
export const trackedChildren = () => [...state.children.values()];

// What a previous Automata left running (it was closed hard, or crashed). Returns the processes closed.
export async function sweepOrphans(file, { processes = null, kill = killPid } = {}) {
  let saved;
  try {
    saved = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const table = processes ?? await listProcesses();
  const byPid = new Map(table.map((p) => [p.pid, p]));
  const owner = saved.owner, alive = owner && byPid.get(owner.pid);
  // Its Automata is still there (same process, same start): these children are not orphans.
  if (alive && owner.pid !== process.pid && Math.abs(alive.created - owner.startedAt) <= SKEW_MS) return [];
  const closed = [];
  for (const entry of saved.children ?? []) {
    const found = byPid.get(entry.pid);
    // Same id is not enough: it must be the same process (same start moment, same program).
    if (!found || Math.abs(found.created - entry.startedAt) > SKEW_MS || entry.name && found.name.toLowerCase() !== entry.name.toLowerCase()) continue;
    if (await kill(entry.pid)) closed.push({ pid: entry.pid, name: found.name, role: entry.role ?? null });
  }
  // What those children had started and left behind (their parent id still points at them). Only for children that
  // are gone or were just closed as ours: if the id is alive as another program, what hangs from it is not ours.
  for (const entry of saved.children ?? []) if (!byPid.has(entry.pid) || closed.some((c) => c.pid === entry.pid)) for (const p of table) {
    if (p.ppid === entry.pid && p.created >= entry.startedAt - SKEW_MS && p.pid !== process.pid && !closed.some((c) => c.pid === p.pid)) {
      if (await kill(p.pid)) closed.push({ pid: p.pid, name: p.name, role: entry.role ?? null, leftover: true });
    }
  }
  try { fs.writeFileSync(file, JSON.stringify({ owner: state.owner, children: [] })); } catch {}
  return closed;
}

// After an agent (or a check) ends: whatever it started during its run and left running is closed.
// Only descendants created between its start and its end count, so a recycled id never matches.
export async function reapDescendants(root, { startedAt, endedAt = Date.now(), processes = null, kill = killPid, keep = [] } = {}) {
  if (!root || !startedAt) return [];
  const table = processes ?? await listProcesses();
  const inside = (p) => p.created >= startedAt - SKEW_MS && p.created <= endedAt + SKEW_MS;
  const found = new Map(), queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of table) if (p.ppid === parent && p.pid !== process.pid && p.pid > 4 && inside(p) && !found.has(p.pid)) {
      found.set(p.pid, p);
      queue.push(p.pid);
    }
  }
  const closed = [];
  for (const p of found.values()) {
    if (keep.includes(p.pid)) continue;
    // A child of a child that is already closed goes down with it; this only counts those that did.
    if (await kill(p.pid)) closed.push({ pid: p.pid, name: p.name });
  }
  return closed;
}
