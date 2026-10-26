const $ = (s) => document.querySelector(s);
const i18n = window.automataI18n, t = value => i18n.t(value);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const effortNames = { default: "Predeterminado", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Extra alto", max: "Máximo", ultra: "Ultra" };
const stateNames = { running: "Trabajando", pausing: "Pausando", paused: "En pausa", stopped: "Detenido", complete: "Completado", blocked: "Necesita tu atención", error: "Error de ejecución", interrupted: "Sesión interrumpida", limit: "Límite de rondas" };
const kindNames = { phase: "TAREA", report: "REPORTE", review: "AUDITORÍA", tool: "ACTIVIDAD", session: "SESIÓN", message: "MENSAJE", warning: "ATENCIÓN", error: "ERROR", check: "VERIFICACIÓN", success: "VERIFICADO", start: "INICIO", pause: "PAUSA", stop: "DETENIDO", complete: "COMPLETADO", approval: "APROBACIÓN" };
let state = { projects: [], settings: { language: i18n.language, mode: "small", accessMode: "full", coderModel: "sonnet", auditorModel: "gpt-6.1-sol", coderEffort: "default", auditorEffort: "high", maxRounds: 6, timeoutMinutes: 30 }, runs: [], events: [], messages: [], busy: false };
let selected = localStorage.getItem("automata.project"), capabilities = null, connection = null, streamAbort = null, toastTimer, reconnectTimer, renderTimer;
let accounts = null, authTimer, authLoading = null, accountsOpened = false;
const project = () => state.projects.find((p) => p.id === selected);
const run = () => state.runs.find((r) => r.projectId === selected);
function toast(text) {
  $("#toast").textContent = t(text);
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 5e3);
}
function connected(ok, text) {
  $("#connection").classList.toggle("offline", !ok);
  $("#connection").lastElementChild.textContent = t(text);
}
async function api(route, { method = "GET", body } = {}) {
  if (window.automata?.request) return window.automata.request(route, { method, body });
  if (!connection?.token) throw new Error("Conecta Automata con el código de acceso de tu PC.");
  const response = await fetch(connection.origin + "/api/" + route, { method, headers: { Authorization: "Bearer " + connection.token, ...body ? { "Content-Type": "application/json" } : {} }, body: body ? JSON.stringify(body) : void 0 });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "No se pudo completar la solicitud.");
  return data;
}
function showDialog(selector) {
  i18n.translateDom($(selector));
  $(selector).showModal();
}
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => {
  if (d.dataset.busy === "true") return;
  if (e.target === d) {
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  }
}));
function modelName(role, id) {
  return capabilities?.models?.[role]?.find((m) => m.id === id)?.label ?? ({ sonnet: "Sonnet", haiku: "Haiku", opus: "Opus", fable: "Fable", "gpt-6.1-sol": "Sol", "gpt-6-luna": "Luna", "gpt-6-astra": "Astra" }[id] ?? id);
}
const teamKeys = { coder: "extraCoders", auditor: "extraAuditors" };
const teamSize = (settings, role) => 1 + (settings?.[teamKeys[role]]?.length ?? 0);
const teamSuffix = (settings, role) => teamSize(settings, role) > 1 ? " ×" + teamSize(settings, role) : "";
function populateEffort(role, model, value, select = $("#" + role + "Effort")) {
  const values = role === "coder" ? ["default", "low", "medium", "high", "xhigh", "max"] : ["default", "low", "medium", "high", "xhigh", "max", .../luna/.test(model) ? [] : ["ultra"]];
  select.innerHTML = values.map((v) => `<option value="${v}">${t(effortNames[v])}</option>`).join("");
  select.value = values.includes(value) ? value : "default";
}
function syncSettings() {
  i18n.setLanguage(state.settings.language ?? i18n.language);
  $("#accessMode").value = state.settings.accessMode ?? "full";
  $("#accessMode").title = $("#accessMode").value === "full" ? "Ambos agentes pueden crear y editar archivos, ejecutar comandos y usar la red con tus permisos de Windows. Solo consultar permanece en modo de lectura." : "Director de solo lectura y Claude con edición limitada. Elige acceso completo para trabajar con archivos y servicios desde ambos agentes.";
  for (const role of ["coder", "auditor"]) {
    const model = state.settings[role + "Model"], el = $("#" + role + "Model");
    if (![...el.options].some((o) => o.value === model)) el.add(new Option(model, model), el.options[el.options.length - 1]);
    el.value = model;
    populateEffort(role, model, state.settings[role + "Effort"]);
    $("#" + role + "ModelLabel").textContent = modelName(role, model) + teamSuffix(state.settings, role);
    $("#" + role + "TeamCount").textContent = String(teamSize(state.settings, role));
  }
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.settings.mode));
  i18n.translateDom();
}
async function saveSettings(changes) {
  try {
    state.settings = await api("settings", { method: "PUT", body: { ...state.settings, ...changes } });
    syncSettings();
    render();
    toast(Object.hasOwn(changes, "accessMode") ? `Acceso ${changes.accessMode === "full" ? "completo" : "limitado"} para ambos agentes. Se aplica a la siguiente operación.` : Object.hasOwn(changes, "extraCoders") ? "Equipo guardado para el siguiente trabajo." : run() && ["running", "paused", "pausing"].includes(run().status) ? "Preferencias guardadas para el siguiente trabajo." : "Preferencias guardadas.");
    return true;
  } catch (e) {
    toast(e.message);
    syncSettings();
    return false;
  }
}
function emptyCoder() {
  return `<div class="empty-intro"><span class="tiny-line"></span>EL COMIENZO DE ALGO BUENO</div><h3 class="welcome-title">De una idea<br>a algo que <em>funciona.</em></h3><p class="welcome-description">Una tarea clara, código con intención y un reporte de lo que realmente cambió. Así empieza cada ronda.</p><div class="terminal-preview"><div class="terminal-top"><i></i><i></i><i></i><span>EL FLUJO DE TRABAJO</span></div><pre><b>01</b>  Recibir la tarea del director
<b>02</b>  Construir y documentar los cambios
<b>03</b>  Entregar el resultado <span>→ auditoría</span></pre></div><div class="welcome-steps"><div class="welcome-step"><span>ENFOQUE</span><p>Un paso a la vez</p></div><div class="welcome-step"><span>CONTEXTO</span><p>Tu proyecto primero</p></div><div class="welcome-step"><span>ENTREGA</span><p>Código + evidencia</p></div></div>`;
}
function emptyAuditor() {
  const p = project();
  return `<div class="empty-intro"><span class="tiny-line"></span>LA PERSPECTIVA COMPLETA</div><h3 class="welcome-title">Un buen siguiente paso.<br>Una <em>segunda mirada.</em></h3><p class="welcome-description" ${p ? 'data-user-content' : ''}>${p ? esc(p.objective) : "Define lo que quieres conseguir. El director convierte tu objetivo en tareas y revisa cada entrega con criterio propio."}</p>${p ? `<div class="criteria-list">${p.criteria.map((c) => `<div class="criterion">${icon("shield")}<span>${esc(c)}</span></div>`).join("")}</div>` : `<div class="first-step"><span class="step-number">01</span><div><strong>Define el destino</strong><p>Un objetivo, una carpeta y criterios claros.</p></div></div><div class="first-step"><span class="step-number">02</span><div><strong>Deja que tu equipo avance</strong><p>El director planifica. El codificador construye.</p></div></div><div class="first-step"><span class="step-number">03</span><div><strong>Cierra con evidencia</strong><p>Las pruebas y la auditoría deciden el resultado.</p></div></div>`}<div class="auditor-note">${icon("shield")}${t("Auditoría independiente · " + (state.settings.accessMode === "limited" ? "acceso limitado" : "acceso completo"))}</div>`;
}
// ───────── Terminal view: the executor's commands, diffs and code, as a session ─────────
const openDetails = new Set();
function termOutput(key, text, error) {
  const value = String(text ?? "").replace(/\s+$/, "");
  if (!value) return "";
  const lines = value.split(/\r?\n/), shown = lines.slice(0, 10), rest = lines.slice(10), cls = `term-out${error ? " err" : ""}`;
  return `<pre class="${cls}">${esc(shown.join("\n"))}</pre>` + (rest.length ? `<details class="term-more" data-key="${esc(key)}"${openDetails.has(key) ? " open" : ""}><summary>${rest.length} ${t("líneas más")}</summary><pre class="${cls}">${esc(rest.join("\n"))}</pre></details>` : "");
}
const diffHtml = (diff) => String(diff ?? "").split("\n").map((line) => `<span class="${line.startsWith("+") ? "d-add" : line.startsWith("-") ? "d-del" : "d-ctx"}">${esc(line) || " "}</span>`).join("");
const codeHtml = (content) => String(content ?? "").replace(/\n$/, "").split("\n").map((line) => `<span class="cl">${esc(line) || " "}</span>`).join("");
const toolKinds = { Bash: "TERMINAL", Edit: "CÓDIGO", MultiEdit: "CÓDIGO", Write: "CÓDIGO" };
const entryTime = (e) => new Date(e.at).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
function termEntry(e, result) {
  const tool = e.tool, error = result?.error === true;
  const status = result ? `<span class="term-status ${error ? "err" : "ok"}">${error ? "✕" : "✓"}</span>` : state.busy ? '<span class="term-status run"></span>' : "";
  let head, body = "";
  if (tool.name === "Bash") {
    const git = tool.git === true && /^git\s/.test(tool.command ?? "");
    head = `<span class="term-prompt">${git ? "git" : "$"}</span><code class="term-cmd">${esc(git ? tool.command.replace(/^git\s+/, "") : tool.command ?? "")}</code>`;
    body = termOutput(e.id, result?.text, error);
  } else if (tool.name === "Edit" || tool.name === "MultiEdit") {
    head = `<span class="term-tool">${esc(tool.name)}</span><code class="term-path">${esc(tool.path ?? "")}</code>`;
    body = `<pre class="term-diff">${diffHtml(tool.diff)}</pre>` + (error ? termOutput(e.id, result.text, true) : "");
  } else if (tool.name === "Write") {
    head = `<span class="term-tool">Write</span><code class="term-path">${esc(tool.path ?? "")}</code><span class="term-meta">${tool.lines ?? ""} ${t("líneas")}</span>`;
    body = `<pre class="term-code">${codeHtml(tool.content)}</pre>` + (error ? termOutput(e.id, result.text, true) : "");
  } else if (tool.name === "TodoWrite") {
    head = `<span class="term-tool">Todo</span>`;
    body = `<div class="term-todos">${(tool.todos ?? []).map((todo) => `<div class="term-todo ${esc(todo.status ?? "")}"><span>${todo.status === "completed" ? "☑" : todo.status === "in_progress" ? "▶" : "☐"}</span>${esc(todo.content)}</div>`).join("")}</div>`;
  } else head = `<span class="term-tool">${esc(tool.name)}</span><code class="term-path">${esc(tool.path ?? tool.pattern ?? tool.input ?? "")}</code>`;
  return `<article class="activity-entry tool term" data-term="${esc(tool.name)}"><div class="activity-meta"><span class="tiny-line"></span><span class="entry-kind">${t(toolKinds[tool.name] ?? "ACTIVIDAD")}</span>${e.agent ? `<span class="entry-agent">${esc(e.agent)}</span>` : ""}<time>${entryTime(e)}</time></div><div class="term-block"><div class="term-head">${head}${status}</div>${body}</div></article>`;
}
// ───────── Git: what the director decided, awaiting the user's OK ─────────
const gitKinds = { commit: "COMMIT", push: "PUSH", merge: "MERGE", branch: "RAMA" };
function gitText(g) {
  if (g.kind === "commit") return `${t("Commit:")} «${g.message}»`;
  if (g.kind === "push") return t("Push de la rama actual a origin");
  if (g.kind === "merge") return `${t("Merge de la rama actual en")} «${g.into}»${g.push ? " " + t("y push") : ""}`;
  return `${t("Cambiar a la rama")} «${g.branch}»`;
}
function approvalEntry(e) {
  return `<article class="activity-entry approval"><div class="activity-meta"><span class="tiny-line"></span><span class="entry-kind">${t("APROBACIÓN")}</span><time>${entryTime(e)}</time></div><p data-user-content>${esc(gitText(e.git))}</p></article>`;
}
const pendingGit = () => state.runs.filter((r) => r.projectId === selected).flatMap((r) => (r.gitQueue ?? []).filter((item) => item.status === "pending").map((item) => ({ ...item, runId: r.id })));
function renderGitBar() {
  const items = pendingGit(), bar = $("#gitBar");
  bar.hidden = !items.length;
  if (!items.length) {
    $("#gitItems").innerHTML = "";
    return;
  }
  $("#gitItems").innerHTML = items.map((item) => `<div class="git-item" data-run="${esc(item.runId)}" data-git="${esc(item.id)}"><span class="git-kind">${esc(t(gitKinds[item.kind] ?? "GIT"))}</span><span class="git-text" data-user-content title="${esc(gitText(item))}">${esc(gitText(item))}</span><span class="git-actions"><button type="button" class="button small primary" data-decision="approve">${t("Aprobar")}</button><button type="button" class="button small quiet" data-decision="reject">${t("Rechazar")}</button></span></div>`).join("");
}
$("#gitItems").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  const row = button.closest(".git-item"), buttons = row.querySelectorAll("button");
  buttons.forEach((b) => b.disabled = true);
  try {
    await api("git", { method: "POST", body: { runId: row.dataset.run, gitId: row.dataset.git, decision: button.dataset.decision } });
    state = await api("state");
    render();
    toast(button.dataset.decision === "approve" ? "Operación de Git ejecutada." : "Operación de Git rechazada.");
  } catch (error) {
    toast(error.message);
    buttons.forEach((b) => b.disabled = false);
  }
});
function entry(e, result) {
  if (e.kind === "tool" && e.tool) return termEntry(e, result);
  if (e.kind === "approval" && e.git) return approvalEntry(e);
  const time = new Date(e.at).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" });
  const review = e.review;
  return `<article class="activity-entry ${esc(e.kind)}"><div class="activity-meta"><span class="tiny-line"></span><span class="entry-kind">${t(kindNames[e.kind] ?? "ACTIVIDAD")}</span>${e.agent ? `<span class="entry-agent">${esc(e.agent)}</span>` : ""}<time>${time}</time></div>${e.kind === "report" ? `<pre>${esc(e.text)}</pre>` : `<p>${esc(["phase", "start", "pause", "stop", "check", "success", "warning", "complete"].includes(e.kind) ? t(e.text) : e.text)}</p>`}${review ? `${review.findings.map((f) => `<div class="finding"><strong>${esc(f.severity.toUpperCase())} · ${esc(f.file)}</strong>${esc(f.description)}<br>${esc(f.evidence)}</div>`).join("")}<div class="criteria-list">${review.criteria.map((c) => `<div class="criterion ${c.met ? "met" : ""}">${icon(c.met ? "check" : "shield")}<span>${esc(c.criterion)}<br><small>${esc(c.evidence)}</small></span></div>`).join("")}</div>` : ""}</article>`;
}
function chatEntry(m, role) {
  const a = m.answers?.find((a2) => a2.role === role);
  const name = role === "coder" ? "Claude" : "Codex";
  const pending = m.status === "processing" ? m.activeRole === role ? `${name} está ${m.kind === "task" ? "trabajando en tu petición" : "respondiendo"}…` : `Esperando el turno de ${name}…` : m.status === "interrupted" ? "Consulta interrumpida. Puedes enviarla de nuevo." : state.busy ? "En cola · el equipo termina una operación en curso." : "Consulta pendiente · se retoma al continuar el trabajo o enviar otra consulta.";
  return `<article class="activity-entry user" data-message-id="${esc(m.id)}"><div class="activity-meta">${t("TÚ · " + (m.kind === "instruction" ? "INSTRUCCIÓN" : m.kind === "task" ? "TRABAJO" : "CONSULTA"))}<time>${new Date(m.at).toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit" })}</time></div><p>${esc(m.text)}</p>${a ? `<p class="chat-answer${a.error ? " form-error" : ""}">${esc(a.text)}</p>` : m.answer ? `<p class="chat-answer">${esc(m.answer)}</p>` : m.error ? `<p class="chat-answer form-error">${esc(m.error)}</p>` : `<p class="chat-answer pending-msg">${esc(t(pending))}</p>`}</article>`;
}
const deferredFeeds = new Set();
const selectionIn = (el) => {
  const selection = getSelection();
  return !!selection && !selection.isCollapsed && !!selection.anchorNode && el.contains(selection.anchorNode);
};
// Rebuilding a feed under the user's selection would drop it; they are probably copying output.
document.addEventListener("selectionchange", () => {
  if (deferredFeeds.size && !["coder", "auditor"].some((role) => selectionIn($("#" + role + "Feed")))) {
    deferredFeeds.clear();
    scheduleRender();
  }
});
for (const role of ["coder", "auditor"]) $("#" + role + "Feed").addEventListener("toggle", (event) => {
  const key = event.target.dataset?.key;
  if (key) event.target.open ? openDetails.add(key) : openDetails.delete(key);
}, true);
function renderFeed(role) {
  const el = $("#" + role + "Feed");
  if (selectionIn(el)) {
    deferredFeeds.add(role);
    return;
  }
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 55;
  const events = state.events.filter((e) => e.projectId === selected && (e.role === role || e.role === "system"));
  const results = new Map(events.filter((e) => e.kind === "toolresult").map((e) => [e.toolId, e]));
  // A task for the director is handed to the executor afterwards, so both panels show it.
  const messages = state.messages.filter((m) => m.projectId === selected && (m.target === role || m.target === "both" || m.kind === "instruction" && role === "auditor" || m.kind === "task" && m.target === "auditor" && role === "coder"));
  const items = [...events.filter((e) => e.kind !== "toolresult").map((e) => ({ at: e.at, html: entry(e, results.get(e.toolId)) })), ...messages.map((m) => ({ at: m.at, html: chatEntry(m, role) }))].sort((a, b) => a.at.localeCompare(b.at));
  el.innerHTML = items.length ? items.slice(-100).map((i) => i.html).join("") : role === "coder" ? emptyCoder() : emptyAuditor();
  if (atBottom && items.length) el.scrollTop = el.scrollHeight;
}
function render() {
  syncSettings();
  if (!selected && state.projects.length) selected = state.projects[0].id;
  const p = project(), r = run();
  $("#projectName").textContent = p?.name ?? t("Selecciona tu próximo proyecto");
  $("#projectPath").textContent = p?.directory ?? t("Un objetivo claro es el primer paso.");
  $("#projectPath").title = p?.directory ?? "";
  $("#demoBadge").hidden = !state.demo;
  $("#runState").textContent = r ? stateNames[r.status] ?? r.status : "Todo listo para empezar";
  $("#runState").className = "run-state " + (r?.status ?? "");
  const active = !!r && ["running", "pausing"].includes(r.status), resumable = !!r && ["paused", "interrupted", "error", "blocked", "limit", "stopped"].includes(r.status);
  $("#startButton span").textContent = resumable ? "Continuar" : r?.status === "complete" ? "Nuevo trabajo" : "Iniciar trabajo";
  $("#startButton").disabled = !connection?.token || state.busy && !active || active;
  $("#pauseButton").disabled = !active || r.status === "pausing";
  $("#stopButton").disabled = !state.busy && (!r || !["running", "pausing", "paused", "interrupted", "error", "blocked", "limit"].includes(r.status));
  for (const role of ["coder", "auditor"]) {
    const replying = state.messages.find(message => message.projectId === selected && message.status === "processing" && message.activeRole === role);
    const working = replying || active && (role === "coder" ? r.stage === "code" : ["plan", "review"].includes(r.stage));
    $("#" + role + "Status").innerHTML = `<i></i>${replying ? replying.kind === "task" ? "Trabajando" : "Respondiendo" : working ? "Trabajando" : r?.status === "complete" ? "Completado" : "En espera"}`;
    $("#" + role + "Status").classList.toggle("active", working);
    {
      const source = r && ["running", "pausing", "paused"].includes(r.status) ? r.settings : state.settings;
      $("#" + role + "ModelLabel").textContent = modelName(role, source[role + "Model"]) + teamSuffix(source, role);
    }
  }
  const stages = { plan: 1, code: 2, checks: 3, review: 4, complete: 4 };
  document.querySelectorAll(".workflow-line>span").forEach((el, i) => el.classList.toggle("current", i === (stages[r?.stage] ?? 0)));
  $("#roundCount").textContent = r ? `RONDA ${String(r.round).padStart(2, "0")} / ${r.settings.maxRounds}` : "RONDA —";
  $("#tokenCount").textContent = r?.tokens ? `TOKENS ${Intl.NumberFormat(i18n.language, { notation: "compact" }).format(r.tokens)}` : "TOKENS —";
  const replying = state.messages.find(message => message.projectId === selected && message.status === "processing");
  $("#bottomStatus").textContent = state.demo ? "Demostración local · no llama a las AI ni consume créditos." : replying ? `${replying.activeRole === "coder" ? "Claude" : "Codex"} está ${replying.kind === "task" ? "trabajando en tu petición" : "respondiendo a tu consulta"}…` : r?.error ?? (active ? "Tu equipo está trabajando. Puedes dejarle un mensaje." : r?.status === "complete" ? "Objetivo completado. Revisa la evidencia en el panel del auditor." : "Tu siguiente proyecto empieza aquí.");
  renderFeed("coder");
  renderFeed("auditor");
  renderGitBar();
  i18n.translateDom();
}
function scheduleRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, 100);
}
async function listen() {
  if (window.automata?.onState) {
    if (!window.__automataListening) {
      window.__automataListening = true;
      window.automata.onState((payload) => {
        state = payload;
        scheduleRender();
      });
      window.automata.onActivity((payload) => {
        if (!state.events.some((e) => e.id === payload.id)) state.events.push(payload);
        scheduleRender();
      });
    }
    connected(true, "Coordinador local");
    return;
  }
  streamAbort?.abort();
  streamAbort = new AbortController();
  try {
    const res = await fetch(connection.origin + "/api/events", { headers: { Authorization: "Bearer " + connection.token }, signal: streamAbort.signal });
    if (!res.ok) throw new Error("Conexión de actividad interrumpida.");
    connected(true, "Conectado a tu PC");
    let pending = "";
    const reader = res.body.getReader(), decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const packets = pending.split("\n\n");
      pending = packets.pop();
      for (const packet of packets) {
        const line = packet.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (packet.startsWith("event: state")) {
          state = payload;
          scheduleRender();
        } else if (packet.startsWith("event: activity")) {
          if (!state.events.some((e) => e.id === payload.id)) state.events.push(payload);
          scheduleRender();
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") return;
  }
  connected(false, "Reconectando");
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => void connect(), 3e3);
}
async function connect() {
  try {
    [state, capabilities] = await Promise.all([api("state"), api("capabilities")]);
    $(".version").textContent = connection?.compatibilityMode ? `WINDOWS / ${capabilities.version} · COMPATIBILIDAD` : `WORKSPACE / ${capabilities.version}`;
    syncSettings();
    render();
    connected(true, "Conectado a tu PC");
    void listen();
    if (!accountsOpened && !state.demo) {
      accountsOpened = true;
      if (!document.querySelector("dialog[open]")) void openAccounts();
    } else if (accounts) void loadAccounts();
  } catch (e) {
    connected(false, "Sin conexión");
    render();
    toast(e.message);
  }
}
function newProject() {
  if (state.demo) {
    toast("La demostración usa un proyecto aislado. Reinicia sin --demo para agregar el tuyo.");
    return;
  }
  $("#projectError").textContent = "";
  syncProjectSource();
  showDialog("#projectDialog");
}
$("#newProjectTop").addEventListener("click", newProject);
$("#projectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  const source = e.target.elements.source.value, githubClone = source === "github" && e.target.elements.repositoryAction.value === "clone";
  $("#projectDialog").dataset.busy = "true";
  $("#projectDialog").querySelectorAll("[data-close]").forEach(close => close.disabled = true);
  $("#projectSubmitLabel").textContent = source === "new" ? "Creando repositorio…" : githubClone ? "Clonando repositorio…" : "Creando proyecto…";
  try {
    const p = await api("projects", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    selected = p.id;
    localStorage.setItem("automata.project", selected);
    $("#projectDialog").close();
    e.target.reset();
    syncProjectSource();
    state = await api("state");
    render();
    toast(source === "new" ? "Repositorio creado en tu carpeta de proyectos." : p.source === "github" ? "Repositorio conectado. Los cambios se trabajan en tu PC." : "Proyecto local creado. Tu equipo está listo.");
  } catch (err) {
    $("#projectError").textContent = err.message;
  } finally {
    button.disabled = false;
    $("#projectDialog").dataset.busy = "false";
    $("#projectDialog").querySelectorAll("[data-close]").forEach(close => close.disabled = false);
    syncProjectSource();
  }
});
const slugOf = (value) => String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "") || "proyecto";
function syncProjectSource() {
  const form = $("#projectForm"), source = form.elements.source.value, github = source === "github", fresh = source === "new", clone = form.elements.repositoryAction.value === "clone";
  $("#githubProjectFields").hidden = !github;
  $("#newRepoFields").hidden = !fresh;
  form.elements.repository.disabled = !github;
  form.elements.repository.required = github;
  form.elements.repositoryAction.disabled = !github;
  form.elements.createRemote.disabled = !fresh;
  $("#projectDirectoryField").hidden = fresh;
  form.elements.directory.disabled = fresh;
  form.elements.directory.required = !fresh && !(github && clone);
  $("#projectSubmitLabel").textContent = t(fresh ? "Crear repositorio" : github && clone ? "Clonar y crear proyecto" : "Crear proyecto");
  $("#projectDirectoryHint").textContent = github ? clone ? "Opcional: elige una carpeta vacía; si la dejas en blanco se guarda en tu carpeta de proyectos." : "Selecciona la raíz de tu copia local. Se comprobará que coincida con el repositorio indicado." : "Claude trabajará aquí. Puedes usar una carpeta local sin Git.";
  if (fresh) {
    const root = capabilities?.projectsRoot ?? "", separator = root.includes("\\") ? "\\" : "/";
    $("#newRepoPath").textContent = `${t("Se creará en")} ${root}${root.endsWith(separator) ? "" : separator}${slugOf(form.elements.name.value)}`;
  }
}
$("#projectForm").elements.name.addEventListener("input", () => { if ($("#projectForm").elements.source.value === "new") syncProjectSource(); });
$("#projectForm").elements.source.forEach(input => input.addEventListener("change", syncProjectSource));
$("#projectForm").elements.repositoryAction.addEventListener("change", syncProjectSource);
$("#projectDialog").addEventListener("cancel", event => { if (event.target.dataset.busy === "true") event.preventDefault(); });
$("#browseButton").addEventListener("click", async () => {
  if (window.automata?.chooseDirectory) {
    const directory = await window.automata.chooseDirectory();
    if (directory) $("#projectForm [name=directory]").value = directory;
  } else toast("Escribe la ruta de la carpeta en la PC que ejecuta Automata.");
});
function projectList() {
  $("#listTitle").textContent = t("Tus proyectos");
  $("#listContent").innerHTML = state.projects.map((p) => `<button class="project-item" data-project="${esc(p.id)}"><strong>${esc(p.name)}</strong><p>${esc(p.objective.slice(0, 160))}</p><p>${esc(p.directory)}</p></button>`).join("") || '<div class="list-empty">El primer paso es elegir qué quieres construir.</div>';
  const add = document.createElement("button");
  add.className = "button primary";
  add.innerHTML = icon("plus") + "Nuevo proyecto";
  add.addEventListener("click", () => {
    $("#listDialog").close();
    newProject();
  });
  $("#listContent").append(add);
  $("#listContent").querySelectorAll("[data-project]").forEach((b) => b.addEventListener("click", () => {
    selected = b.dataset.project;
    localStorage.setItem("automata.project", selected);
    $("#listDialog").close();
    render();
  }));
  showDialog("#listDialog");
}
$("#projectPicker").addEventListener("click", projectList);
$("#projectsButton").addEventListener("click", projectList);
$("#workspaceButton").addEventListener("click", () => document.querySelectorAll("dialog[open]").forEach((d) => d.close()));
$("#briefButton").addEventListener("click", () => {
  const p = project();
  if (!p) return newProject();
  $("#listTitle").textContent = p.name;
  $("#listContent").innerHTML = `<div class="note" data-user-content>${esc(p.objective)}</div><div class="criteria-list">${p.criteria.map((c) => `<div class="criterion">${icon("shield")}<span>${esc(c)}</span></div>`).join("")}</div><h4>Verificaciones</h4><div class="pairing-code">${esc(p.checks.join("\n") || "Sin comandos configurados.")}</div><h4>Restricciones</h4><p class="note" data-user-content>${esc(p.constraints || t("Conservar los cambios existentes."))}</p>`;
  showDialog("#listDialog");
});
$("#historyButton").addEventListener("click", () => {
  $("#listTitle").textContent = t("Cada paso cuenta.");
  $("#listContent").innerHTML = state.runs.map((r) => `<article class="run-item"><strong>${esc(r.project.name)} · ${esc(stateNames[r.status])}</strong><p>${new Date(r.createdAt).toLocaleString(i18n.language)} · ${r.round} rondas · ${esc(modelName("coder", r.settings.coderModel))} + ${esc(modelName("auditor", r.settings.auditorModel))}</p><p>${esc(r.review?.summary ?? r.error ?? "Pendiente de auditoría.")}</p></article>`).join("") || '<div class="list-empty">Tu historial aparecerá aquí después del primer trabajo.</div>';
  showDialog("#listDialog");
});
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => void saveSettings({ mode: b.dataset.mode })));
$("#accessMode").addEventListener("change", event => void saveSettings({ accessMode: event.target.value }));
for (const role of ["coder", "auditor"]) {
  $("#" + role + "Model").addEventListener("change", async (e) => {
    if (e.target.value === "custom") {
      $("#listTitle").textContent = t("Elige tu modelo");
      $("#listContent").innerHTML = '<form id="customModelForm"><label>Identificador del modelo<input name="model" placeholder="El identificador que admite tu CLI" required pattern="[a-zA-Z0-9][a-zA-Z0-9._:\\[\\]-]{0,99}"></label><div class="note">Se usará exactamente este identificador. Si tu cuenta no tiene acceso, Automata mostrará el error del proveedor.</div><button class="button primary" type="submit">Usar modelo</button></form>';
      $("#customModelForm").addEventListener("submit", (event) => {
        event.preventDefault();
        const id = new FormData(event.target).get("model");
        $("#listDialog").close();
        void saveSettings({ [role + "Model"]: id, [role + "Effort"]: "default" });
      });
      showDialog("#listDialog");
      syncSettings();
    } else await saveSettings({ [role + "Model"]: e.target.value, [role + "Effort"]: "default" });
  });
  $("#" + role + "Effort").addEventListener("change", (e) => void saveSettings({ [role + "Effort"]: e.target.value }));
}
$("#startButton").addEventListener("click", async () => {
  try {
    if (!await ensureAccounts()) return;
    if (!project()) return newProject();
    const r = run();
    const resumable = r && ["paused", "interrupted", "error", "blocked", "limit", "stopped"].includes(r.status);
    await api(resumable ? "control" : "start", { method: "POST", body: resumable ? { action: "resume", runId: r.id } : { projectId: selected } });
  } catch (e) {
    if (/en Cuentas antes de continuar/.test(e.message)) void openAccounts();
    toast(e.message);
  }
});
for (const action of ["pause", "stop"]) $("#" + action + "Button").addEventListener("click", async () => {
  try {
    await api("control", { method: "POST", body: { action, runId: run()?.id } });
  } catch (e) {
    toast(e.message);
  }
});
const teamRoles = {
  coder: { rows: "#teamCoderRows", add: "#addCoder", counter: "#teamCoderCount", list: "settingsCoderModels" },
  auditor: { rows: "#teamAuditorRows", add: "#addAuditor", counter: "#teamAuditorCount", list: "settingsAuditorModels" }
};
let teamDraft = null;
const teamLimit = (role) => (role === "coder" ? capabilities?.team?.coders : capabilities?.team?.auditors) ?? (role === "coder" ? 3 : 2);
const teamFromSettings = (settings, role) => [{ model: settings[role + "Model"], effort: settings[role + "Effort"] }, ...(settings[teamKeys[role]] ?? []).map((agent) => ({ model: agent.model, effort: agent.effort ?? "default" }))];
function renderTeam() {
  for (const [role, cfg] of Object.entries(teamRoles)) {
    const rows = teamDraft[role], limit = teamLimit(role);
    $(cfg.rows).innerHTML = rows.map((agent, i) => `<div class="team-row" data-role="${role}" data-index="${i}"><span class="team-index">${i + 1}</span><label class="team-model"><span class="control-label">MODELO</span><input name="model" list="${cfg.list}" value="${esc(agent.model)}" required maxlength="100" autocomplete="off"></label><label class="team-effort"><span class="control-label">RAZONAMIENTO</span><select name="effort"></select></label>${i === 0 ? '<span class="team-end team-badge">Principal</span>' : '<button type="button" class="icon-button team-end" data-remove aria-label="Quitar"><svg><use href="#i-close"/></svg></button>'}</div>`).join("");
    $(cfg.rows).querySelectorAll(".team-row").forEach((row, i) => {
      const select = row.querySelector("select");
      populateEffort(role, rows[i].model, rows[i].effort, select);
      rows[i].effort = select.value;
    });
    $(cfg.counter).textContent = `${rows.length} / ${limit}`;
    $(cfg.add).disabled = rows.length >= limit;
  }
  i18n.translateDom($("#teamDialog"));
}
function openTeam() {
  if (capabilities && !capabilities.features?.team) return toast("La PC necesita una versión más reciente de Automata para usar equipos de agentes.");
  teamDraft = { coder: teamFromSettings(state.settings, "coder"), auditor: teamFromSettings(state.settings, "auditor") };
  $("#teamError").textContent = "";
  renderTeam();
  showDialog("#teamDialog");
}
$("#teamDialog").addEventListener("input", (event) => {
  const row = event.target.closest(".team-row");
  if (!row || event.target.name !== "model") return;
  const role = row.dataset.role, agent = teamDraft[role][Number(row.dataset.index)], select = row.querySelector("select");
  agent.model = event.target.value;
  populateEffort(role, agent.model, agent.effort, select);
  agent.effort = select.value;
});
$("#teamDialog").addEventListener("change", (event) => {
  const row = event.target.closest(".team-row");
  if (row && event.target.name === "effort") teamDraft[row.dataset.role][Number(row.dataset.index)].effort = event.target.value;
});
$("#teamDialog").addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove]");
  if (!remove) return;
  const row = remove.closest(".team-row");
  teamDraft[row.dataset.role].splice(Number(row.dataset.index), 1);
  renderTeam();
});
for (const [role, cfg] of Object.entries(teamRoles)) $(cfg.add).addEventListener("click", () => {
  const rows = teamDraft[role];
  if (rows.length >= teamLimit(role)) return;
  const last = rows[rows.length - 1];
  rows.push({ model: last.model, effort: last.effort });
  renderTeam();
  $(cfg.rows).querySelector(".team-row:last-child input")?.focus();
});
$("#teamForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const [coders, auditors] = [teamDraft.coder, teamDraft.auditor].map((rows) => rows.map(({ model, effort }) => ({ model: model.trim(), effort })));
  const saved = await saveSettings({ coderModel: coders[0].model, coderEffort: coders[0].effort, extraCoders: coders.slice(1), auditorModel: auditors[0].model, auditorEffort: auditors[0].effort, extraAuditors: auditors.slice(1) });
  if (saved) $("#teamDialog").close();
  else $("#teamError").textContent = $("#toast").textContent;
});
$("#teamButton").addEventListener("click", openTeam);
document.querySelectorAll("[data-team]").forEach((button) => button.addEventListener("click", openTeam));
$("#settingsTeam").addEventListener("click", () => { $("#settingsDialog").close(); openTeam(); });
$("#settingsButton").addEventListener("click", () => {
  const f = $("#settingsForm");
  $("#settingsError").textContent = "";
  for (const [key, value] of Object.entries(state.settings)) if (f.elements.namedItem(key)) f.elements.namedItem(key).value = value;
  for (const role of ["coder", "auditor"]) populateEffort(role, state.settings[role + "Model"], state.settings[role + "Effort"], f.elements.namedItem(role + "Effort"));
  f.elements.reuseSessions.checked = state.settings.reuseSessions !== false;
  f.elements.fastFix.checked = state.settings.fastFix !== false;
  f.elements.projectsRoot.placeholder = capabilities?.projectsRoot ?? "";
  for (const element of f.elements) if (element.name !== "language" && element.type !== "submit" && element.tagName !== "BUTTON") element.disabled = !connection?.token;
  showDialog("#settingsDialog");
});
for (const role of ["coder", "auditor"]) $("#settingsForm").elements.namedItem(role + "Model").addEventListener("input", event => {
  const select = $("#settingsForm").elements.namedItem(role + "Effort");
  populateEffort(role, event.target.value, select.value, select);
});
$("#browseRoot").addEventListener("click", async () => {
  if (window.automata?.chooseDirectory) {
    const directory = await window.automata.chooseDirectory();
    if (directory) $("#settingsForm").elements.projectsRoot.value = directory;
  } else toast("Escribe la ruta de la carpeta en la PC que ejecuta Automata.");
});
$("#settingsAccounts").addEventListener("click", () => { $("#settingsDialog").close(); void openAccounts(); });
$("#settingsPhone").addEventListener("click", () => { $("#settingsDialog").close(); void connectionDialog(); });
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const changes = Object.fromEntries(new FormData(e.target));
  changes.reuseSessions = e.target.elements.reuseSessions.checked;
  changes.fastFix = e.target.elements.fastFix.checked;
  if (!connection?.token) {
    state.settings.language = changes.language;
    syncSettings(); render();
    toast("Idioma guardado en este dispositivo. Conecta la PC para guardar las demás opciones.");
    $("#settingsDialog").close();
    return;
  }
  if (await saveSettings(changes)) $("#settingsDialog").close();
  else $("#settingsError").textContent = $("#toast").textContent;
});
$("#mobileSettings").addEventListener("click", () => $("#settingsButton").click());
$("#mobileHistory").addEventListener("click", () => $("#historyButton").click());
$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!project()) return toast("Selecciona un proyecto para conversar.");
    if (["question", "task"].includes($("#chatKind").value) && !await ensureAccounts($("#chatTarget").value === "both" || $("#chatTarget").value === "auditor" && $("#chatKind").value === "task" ? ["coder", "auditor"] : [$("#chatTarget").value])) return;
    const message = await api("chat", { method: "POST", body: { projectId: selected, target: $("#chatTarget").value, kind: $("#chatKind").value, text: $("#chatText").value } });
    $("#chatText").value = "";
    $("#chatText").style.height = "auto";
    toast(message.status === "queued" ? "Mensaje en cola. El equipo termina una operación en curso." : message.status === "processing" ? `${message.activeRole === "coder" ? "Claude" : "Codex"} está ${message.kind === "task" ? "trabajando en tu petición" : "respondiendo"}…` : message.status === "delivered" ? "Instrucción entregada al director." : message.status === "error" ? "No se pudo completar el mensaje. Revisa el detalle en el panel." : "Mensaje enviado.");
  } catch (err) {
    if (/en Cuentas antes de continuar/.test(err.message)) void openAccounts();
    toast(err.message);
  }
});
$("#chatText").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    $("#chatForm").requestSubmit();
  }
});
$("#chatText").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 90) + "px";
});
document.querySelectorAll("[data-agent-tab]").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll("[data-agent-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  $("#agents").classList.toggle("show-auditor", b.dataset.agentTab === "auditor");
  const feed = $("#" + b.dataset.agentTab + "Feed");
  requestAnimationFrame(() => {
    feed.scrollTop = feed.scrollHeight;
  });
}));
async function connectionDialog() {
  $("#connectionForm").elements.origin.value = connection?.origin ?? "";
  $("#connectionForm").elements.token.value = "";
  $("#pairingInfo").innerHTML = "";
  if (connection?.token) {
    try {
      const pair = await api("pairing");
      $("#pairingInfo").innerHTML = `<div class="note">${pair.lan ? "En Android, escribe una de estas direcciones y el código de abajo. Mantén la PC encendida." : "Para conectar Android, inicia Automata en tu PC con la opción --lan. El acceso remoto no está habilitado en esta sesión."}</div>${pair.lan ? `<p class="pairing-code">${pair.addresses.map(esc).join("<br>")}</p><details><summary>Mostrar código de acceso</summary><p class="pairing-code">${esc(pair.token)}</p></details>` : ""}`;
    } catch {
    }
  }
  showDialog("#connectionDialog");
}
$("#phoneButton").addEventListener("click", () => void connectionDialog());
$("#connection").addEventListener("click", () => void connectionDialog());
$("#connectionForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    const u = new URL(data.origin);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/") throw new Error("Usa una dirección HTTP o HTTPS sin ruta ni contraseña.");
    connection = { origin: u.origin, token: data.token.trim() };
    await api("state");
    localStorage.setItem("automata.connection", JSON.stringify(connection));
    $("#connectionDialog").close();
    await connect();
  } catch (err) {
    toast(err.message);
  }
});
const accountStateNames = { connected: "Conectado", disconnected: "Sin conectar", missing: "Falta instalar", error: "Revisar conexión", pending: "Esperando acceso", unknown: "Comprobando", demo: "Demostración" };
function renderAccounts() {
  const providers = accounts?.providers ?? {};
  const count = ["coder", "auditor"].filter(role => providers[role]?.connected).length;
  $("#accountCount").textContent = state.demo ? "DEMO" : accounts ? `${count}/2` : "—";
  $("#accountsButton").classList.toggle("accounts-ready", count === 2);
  for (const role of ["coder", "auditor", "github"]) {
    const provider = providers[role] ?? { status: "unknown", message: "Comprobando la sesión en esta PC…" };
    const card = $("#" + role + "Account"), button = card.querySelector("[data-login]");
    card.dataset.status = provider.status;
    $("#" + role + "AccountState").textContent = accountStateNames[provider.status] ?? "Comprobando";
    $("#" + role + "AccountMessage").textContent = provider.message;
    button.hidden = provider.connected || provider.status === "pending" || provider.status === "demo";
    button.disabled = !accounts?.canLogin || !provider.installed || state.busy;
    const flow = provider.flow;
    $("#" + role + "AccountFlow").hidden = !flow;
    const link = $("#" + role + "AuthLink");
    link.hidden = !flow?.url;
    if (flow?.url) link.href = flow.url;
    else link.removeAttribute("href");
  }
  $("#claudeCodeForm").hidden = !providers.coder?.flow?.acceptsCode;
  $("#deviceCodeSection").hidden = !providers.auditor?.flow?.deviceCode;
  $("#deviceCode").textContent = providers.auditor?.flow?.deviceCode ?? "";
  $("#githubDeviceCode").textContent = providers.github?.flow?.deviceCode ?? "";
  $("#deviceLoginButton").disabled = !accounts?.canLogin || !providers.auditor?.installed || providers.auditor?.status === "pending" || providers.auditor?.connected || state.busy;
  $("#accountsContinue").disabled = !state.demo && count !== 2;
  $("#accountContext").textContent = state.demo ? "Esta sesión de demostración no utiliza tus cuentas ni consume créditos. Abre Automata sin --demo para conectar a los proveedores." : accounts && !accounts.canLogin ? "Conecta tus cuentas desde la aplicación de Windows. Android utiliza las sesiones de esa PC." : "Si ya iniciaste sesión, puedes usarla aquí. Conectar una cuenta no garantiza acceso a todos los modelos.";
  i18n.translateDom($("#accountsDialog"));
}
function scheduleAuthRefresh() {
  clearTimeout(authTimer);
  if ($("#accountsDialog").open) authTimer = setTimeout(() => void loadAccounts(), 2000);
}
async function loadAccounts(force = false) {
  if (authLoading) return authLoading;
  authLoading = (async () => {
    try {
      accounts = await api("auth", force ? { method: "POST", body: { action: "refresh" } } : {});
      renderAccounts();
    } catch (error) {
      $("#accountError").textContent = error.message;
    } finally {
      authLoading = null;
      scheduleAuthRefresh();
    }
  })();
  return authLoading;
}
async function openAccounts() {
  $("#accountError").textContent = "";
  renderAccounts();
  showDialog("#accountsDialog");
  await loadAccounts();
}
async function ensureAccounts(required = ["coder", "auditor"]) {
  if (state.demo) return true;
  await loadAccounts();
  if (required.every(role => accounts?.providers[role]?.connected)) return true;
  await openAccounts();
  $("#accountError").textContent = "Conecta las cuentas necesarias antes de iniciar el trabajo.";
  return false;
}
async function accountAction(body) {
  $("#accountError").textContent = "";
  clearTimeout(authTimer);
  try {
    await authLoading;
    accounts = await api("auth", { method: "POST", body });
    renderAccounts();
  } catch (error) {
    $("#accountError").textContent = error.message;
  } finally { scheduleAuthRefresh(); }
}
$("#accountsButton").addEventListener("click", () => void openAccounts());
$("#refreshAccounts").addEventListener("click", () => void loadAccounts(accounts?.canLogin === true));
document.querySelectorAll("[data-login]").forEach(button => button.addEventListener("click", () => void accountAction({ action: "login", role: button.dataset.login, method: "browser" })));
document.querySelectorAll("[data-auth-cancel]").forEach(button => button.addEventListener("click", () => void accountAction({ action: "cancel", role: button.dataset.authCancel })));
$("#deviceLoginButton").addEventListener("click", () => void accountAction({ action: "login", role: "auditor", method: "device" }));
$("#claudeCodeForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = event.target.elements.code;
  const code = input.value;
  input.value = "";
  await accountAction({ action: "code", role: "coder", code });
});
$("#accountsDialog").addEventListener("close", () => {
  clearTimeout(authTimer);
  $("#claudeCodeForm").reset();
  $("#deviceCode").textContent = "";
  $("#githubDeviceCode").textContent = "";
  for (const role of ["coder", "auditor", "github"]) {
    $("#" + role + "AuthLink").removeAttribute("href");
    if (accounts?.providers[role]) delete accounts.providers[role].flow;
  }
});
window.addEventListener("beforeunload", () => {
  streamAbort?.abort();
  clearTimeout(reconnectTimer);
  clearTimeout(authTimer);
});
async function init() {
  if (window.automata?.connection) connection = await window.automata.connection();
  else {
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.has("token")) {
      connection = { origin: location.origin, token: hash.get("token") };
      history.replaceState(null, "", location.pathname);
      localStorage.setItem("automata.connection", JSON.stringify(connection));
    } else {
      try {
        connection = JSON.parse(localStorage.getItem("automata.connection"));
      } catch {
      }
    }
  }
  if (connection?.compatibilityMode) {
    $(".version").textContent = "WINDOWS / COMPATIBILIDAD";
    $("#connection").title = "Compatibilidad de Windows: interfaz local con contexto aislado y sin acceso a Node. El aislamiento de proceso de Chromium no está activo.";
    $("#settingsDialog .note").append(document.createTextNode(" Modo de compatibilidad de Windows activo: la página mantiene contexto aislado y Node deshabilitado; el sandbox de proceso de Chromium está desactivado. Solo se carga la interfaz local de Automata."));
  }
  syncSettings();
  render();
  if (connection) await connect();
  else {
    connected(false, "Conectar PC");
    $("#bottomStatus").textContent = "Conecta tu PC para empezar. Pulsa el indicador de conexión.";
  }
}
void init().catch(error => {
  connected(false, "Error de inicio");
  render();
  toast(error.message);
});
