import path from "node:path";
// The director's view of the coder: while Claude works, Automata keeps a compact log of what it
// read, changed and ran. The director gets that log at its next review, so it can check the work
// starting from what changed instead of reading the whole project again.
const MAX_RECORDS = 400;
const clip = (value, max) => {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) + "…" : text;
};
const tailOf = (value, max) => {
  const text = String(value ?? "").trim();
  return text.length > max ? "…" + text.slice(-max) : text;
};
// Adds one coder event (tool call, tool result or message) to the log. Returns the log.
export function observe(log, e) {
  if (!Array.isArray(log) || !e) return log;
  if (e.kind === "tool" && e.tool) {
    const tool = e.tool;
    if (tool.name === "Bash") log.push({ t: "cmd", id: e.toolId, command: clip(tool.command, 400) });
    else if (tool.name === "Edit" || tool.name === "MultiEdit") log.push({ t: "edit", id: e.toolId, path: tool.path, diff: clip(tool.diff, 1500) });
    else if (tool.name === "Write") log.push({ t: "write", id: e.toolId, path: tool.path, lines: tool.lines, preview: clip(String(tool.content ?? "").split("\n").slice(0, 12).join("\n"), 700) });
    else if (tool.name === "Read") log.push({ t: "read", path: tool.path });
    else if (tool.name === "TodoWrite") log.push({ t: "todo", todos: (tool.todos ?? []).map((todo) => `${todo.status === "completed" ? "[x]" : todo.status === "in_progress" ? "[>]" : "[ ]"} ${todo.content}`) });
  } else if (e.kind === "toolresult" && e.toolId) {
    const record = log.findLast((item) => item.id === e.toolId);
    if (record) {
      record.ok = e.error !== true;
      if (record.t === "cmd" || !record.ok) record.output = tailOf(e.text, record.ok ? 300 : 700);
    }
  } else if (e.kind === "message" && e.text?.trim()) log.push({ t: "note", text: clip(e.text.trim(), 400) });
  if (log.length > MAX_RECORDS) log.splice(0, log.length - MAX_RECORDS);
  return log;
}
const relative = (directory, file) => {
  if (!file) return "?";
  if (!directory) return file;
  const rel = path.relative(directory, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.replaceAll("\\", "/") : file;
};
// Text for the director's prompt, within a size budget: lists first, then commands, then diffs.
export function digest(log, directory, max = 14e3) {
  if (!Array.isArray(log) || !log.length) return "";
  const rel = (file) => relative(directory, file);
  const edited = new Map(), created = new Set(), read = new Set();
  for (const item of log) {
    if (item.t === "edit") edited.set(rel(item.path), (edited.get(rel(item.path)) ?? 0) + 1);
    else if (item.t === "write") created.add(rel(item.path));
    else if (item.t === "read") read.add(rel(item.path));
  }
  const out = [];
  if (created.size) out.push(`Escribió (crear o reemplazar): ${[...created].join(", ")}`);
  if (edited.size) out.push(`Editó: ${[...edited].map(([file, n]) => n > 1 ? `${file} (${n} ediciones)` : file).join(", ")}`);
  if (read.size) out.push(`Leyó: ${[...read].slice(0, 40).join(", ")}${read.size > 40 ? ` y ${read.size - 40} más` : ""}`);
  const commands = log.filter((item) => item.t === "cmd");
  if (commands.length) {
    out.push("Comandos (✓ éxito, ✕ error, … sin resultado):");
    for (const item of commands.slice(-30)) out.push(`$ ${item.command} ${item.ok === undefined ? "…" : item.ok ? "✓" : "✕"}${item.output ? "\n  " + item.output.replace(/\n/g, "\n  ") : ""}`);
  }
  const failures = log.filter((item) => item.t !== "cmd" && item.ok === false);
  for (const item of failures.slice(-8)) out.push(`Falló ${item.t} en ${rel(item.path)}: ${item.output ?? ""}`);
  const todos = log.findLast((item) => item.t === "todo");
  if (todos?.todos?.length) out.push("Su lista de pendientes:\n" + todos.todos.join("\n"));
  const notes = log.filter((item) => item.t === "note").slice(-4);
  if (notes.length) out.push("Lo que fue diciendo:\n" + notes.map((item) => "- " + item.text.replace(/\n/g, " ")).join("\n"));
  let text = out.join("\n");
  // Diffs fill whatever room is left, newest first, because the latest edit is what stays in the code.
  const changes = log.filter((item) => item.t === "edit" || item.t === "write").reverse();
  const blocks = [];
  let room = max - text.length - 200;
  for (const item of changes) {
    const block = item.t === "edit" ? `--- ${rel(item.path)}\n${item.diff}` : `--- ${rel(item.path)} (escrito, ${item.lines ?? "?"} líneas; inicio)\n${item.preview}`;
    if (block.length > room) break;
    blocks.unshift(block);
    room -= block.length + 1;
  }
  if (blocks.length) text += `\nCambios que viste (${blocks.length} de ${changes.length}, los más recientes):\n${blocks.join("\n")}`;
  return text.slice(0, max);
}
