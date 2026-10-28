// Pure checks used by scripts/real-idea.mjs, kept apart so they can be tested without running agents.
import fs from "node:fs";
import path from "node:path";

// The process with this id and everything that hangs from it, in a process table.
export function descend(table, root) {
  const out = [], seen = new Set([root]), queue = [root];
  while (queue.length) {
    const parent = queue.shift();
    for (const p of table) if (p.ppid === parent && !seen.has(p.pid)) { seen.add(p.pid); out.push(p); queue.push(p.pid); }
  }
  return [...table.filter((p) => p.pid === root), ...out];
}

// Chrome started by the drill: any chrome.exe that was not running before it began (Playwright's Browser has no process()).
export const chromeProcesses = (table, baseline) => table.filter((p) => /^chrome/i.test(p.name) && !baseline.has(p.pid));

// Anything of Automata's still running after the server is gone: created since the start, by name, not in the baseline,
// and not the drill's own sampler (the powershell.exe + conhost.exe it starts to read the process table).
export function findLeftovers(after, { baseline, scriptPid, serverPid, startedAt }) {
  // Everything under the script is the sampler's, except the server and what it started: a surviving server tree must still be reported.
  const server = new Set(descend(after, serverPid).map((p) => p.pid));
  const mine = new Set(descend(after, scriptPid).map((p) => p.pid).filter((pid) => !server.has(pid)));
  return after
    .filter((p) => !baseline.has(p.pid) && !mine.has(p.pid) && p.pid !== scriptPid && /^(claude|codex|node|git|powershell|conhost)/i.test(p.name) && p.created >= startedAt - 5000 && !/chrome/i.test(p.name))
    .map((p) => ({ pid: p.pid, name: p.name, ppid: p.ppid }));
}

// A merge or push that was asked for and is still waiting for approval is the expected behavior; only one that ran is a failure.
export function classifyPushOrMerge(gitQueue = [], reflog = []) {
  const asked = gitQueue.filter((i) => ["push", "merge"].includes(i.kind));
  return {
    pending: asked.filter((i) => i.status === "pending").length,
    executed: [...asked.filter((i) => i.status !== "pending"), ...reflog.filter((l) => /^(merge|push)/i.test(l))],
  };
}

// A static page has no address: the file the command opens must exist and look like a page.
export function checkStaticPage(command, directory) {
  // A double-click launcher (Abrir.cmd): the page it opens is the one that counts.
  const launcher = /([\w./\\-]+\.(?:cmd|bat))/i.exec(command ?? "")?.[1];
  if (launcher && fs.existsSync(path.resolve(directory, launcher))) {
    const target = /%~dp0([^"\r\n&|<>]+?\.html?)/i.exec(fs.readFileSync(path.resolve(directory, launcher), "utf8"))?.[1];
    return target ? checkStaticPage(target.replace(/\\/g, "/"), directory) : null;
  }
  const file = /([\w./\\-]+\.html?)/i.exec(command ?? "")?.[1];
  const full = file ? path.resolve(directory, file) : null;
  if (!full || !fs.existsSync(full)) return null;
  const html = fs.readFileSync(full, "utf8");
  return { answered: "file", title: html.match(/<title>([^<]*)/i)?.[1] ?? null, inputs: (html.match(/<input\b/gi) ?? []).length };
}
