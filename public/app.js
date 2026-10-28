const $ = (s) => document.querySelector(s);
const i18n = window.automataI18n, t = value => i18n.t(value);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const effortNames = { default: "Predeterminado", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Extra alto", max: "Máximo", ultra: "Ultra" };
const stateNames = { running: "Trabajando", pausing: "Pausando", paused: "En pausa", stopped: "Detenido", complete: "Completado", blocked: "Necesita tu atención", error: "Error de ejecución", interrupted: "Sesión interrumpida", limit: "Límite de rondas", waiting: "Esperando para continuar" };
const kindNames = { phase: "TAREA", report: "REPORTE", review: "AUDITORÍA", tool: "ACTIVIDAD", session: "SESIÓN", message: "MENSAJE", warning: "ATENCIÓN", error: "ERROR", check: "VERIFICACIÓN", success: "VERIFICADO", start: "INICIO", pause: "PAUSA", stop: "DETENIDO", complete: "COMPLETADO", approval: "APROBACIÓN", runoffer: "APP", wait: "ESPERA", plan: "PLAN" };
// Why Automata waits, which agent is affected and when it will try again (mirrors describeWait on the server).
function waitText(w) {
  const who = w.role === "coder" ? "Claude" : "Codex";
  const reason = w.memory ? t("Poca memoria libre en la PC") : w.kind === "limit" ? `${t("Límite de uso de")} ${who}${w.reliable ? "" : " · " + t("sin hora confiable")}` : w.kind === "context" ? `${t("Sesión de")} ${who} ${t("demasiado larga")}` : `${t("Fallo pasajero de")} ${who}`;
  const at = w.resumeAt ? new Date(w.resumeAt) : null;
  const clock = at ? at.toLocaleTimeString(i18n.language, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }) + (at.toDateString() === new Date().toDateString() ? "" : " " + at.toLocaleDateString(i18n.language, { day: "numeric", month: "short" })) : "";
  return `${reason} · ${t("sigue a las")} ${clock}${w.maxAttempts ? ` (${t("intento")} ${w.attempt}/${w.maxAttempts})` : ""}`;
}
let state = { projects: [], settings: { language: i18n.language, mode: "small", accessMode: "full", coderModel: "sonnet", auditorModel: "gpt-6-sol", coderEffort: "default", auditorEffort: "high", maxRounds: 6, timeoutMinutes: 30 }, runs: [], events: [], messages: [], busy: false };
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
  return capabilities?.models?.[role]?.find((m) => m.id === id)?.label ?? ({ sonnet: "Sonnet", haiku: "Haiku", opus: "Opus", fable: "Fable", "gpt-6-sol": "Sol", "gpt-6-luna": "Luna", "gpt-6-astra": "Astra" }[id] ?? id);
}
const teamKeys = { coder: "extraCoders", auditor: "extraAuditors" };
const teamSize = (settings, role) => 1 + (settings?.[teamKeys[role]]?.length ?? 0);
const teamSuffix = (settings, role) => teamSize(settings, role) > 1 ? " ×" + teamSize(settings, role) : "";
// The PC sends the director's models from Codex itself; the pickers and lists follow that catalog.
function applyModelCatalog() {
  for (const role of ["coder", "auditor"]) {
    const models = capabilities?.models?.[role];
    if (!models?.length) continue;
    const options = models.map((m) => `<option value="${esc(m.id)}" title="${esc(m.detail ?? "")}">${esc(m.label)}</option>`).join("");
    $("#" + role + "Model").innerHTML = options + `<option value="custom">${esc(t("Otro modelo…"))}</option>`;
    $(role === "coder" ? "#settingsCoderModels" : "#settingsAuditorModels").innerHTML = options;
  }
}
function populateEffort(role, model, value, select = $("#" + role + "Effort")) {
  const known = role === "coder" ? ["default", "low", "medium", "high", "xhigh", "max"] : ["default", "low", "medium", "high", "xhigh", "max", .../luna/.test(model) ? [] : ["ultra"]];
  // Codex says which reasoning levels each model accepts; offer only those.
  const catalog = capabilities?.models?.[role]?.find((m) => m.id === model)?.efforts;
  const values = catalog?.length ? known.filter((v) => catalog.includes(v)) : known;
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
    syncAccountModel(role);
  }
  if (typeof renderPlanOnly === "function" && $("#accountsDialog").open) renderPlanOnly();
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
  if (g.kind === "commit" && g.gate) return `${t("Guardar los cambios pendientes antes de terminar:")} «${g.message}»`;
  if (g.kind === "commit") return `${t("Commit:")} «${g.message}»`;
  if (g.kind === "push") return t("Push de la rama actual a origin");
  if (g.kind === "merge") return `${t("Merge de la rama actual en")} «${g.into}»${g.push ? " " + t("y push") : ""}`;
  return `${t("Cambiar a la rama")} «${g.branch}»`;
}
function approvalEntry(e) {
  return `<article class="activity-entry approval"><div class="activity-meta"><span class="tiny-line"></span><span class="entry-kind">${t("APROBACIÓN")}</span><time>${entryTime(e)}</time></div><p data-user-content>${esc(gitText(e.git))}</p></article>`;
}
// Pending: waiting for the OK. Uncertain: it was running when Automata closed; only the user may repeat it.
const pendingGit = () => state.runs.filter((r) => r.projectId === selected).flatMap((r) => (r.gitQueue ?? []).filter((item) => item.status === "pending" || item.status === "uncertain" || item.gate && item.status === "failed").map((item) => ({ ...item, runId: r.id })));
// ───────── The app: the director asks before running it, then it can be watched and stopped ─────────
const pendingRuns = () => state.runs.filter((r) => r.projectId === selected).flatMap((r) => (r.runOffers ?? []).filter((offer) => offer.status === "pending").map((offer) => ({ ...offer, runId: r.id })));
let appOutputOpen = false;
const onAndroid = /Android/i.test(navigator.userAgent);
function runOfferRow(offer) {
  return `<div class="git-item run-offer" data-run="${esc(offer.runId)}" data-offer="${esc(offer.id)}"><span class="git-kind app-kind">${t("APP")}</span><span class="git-text app-text"><span>${t(offer.final ? "Proyecto terminado. ¿Quieres correr la app?" : "La app ya se puede correr. ¿Quieres probarla?")}</span><code data-user-content title="${esc(offer.command)}">${esc(offer.command)}</code>${offer.note ? `<small data-user-content title="${esc(offer.note)}">${esc(offer.note)}</small>` : ""}</span><span class="git-actions"><button type="button" class="button small primary" data-app="approve">${t("Correr")}</button><button type="button" class="button small quiet" data-app="reject">${t("Ahora no")}</button></span></div>`;
}
function appRow(app) {
  const running = app.status === "running";
  const status = running ? t("En marcha") : app.status === "stopped" ? t("Detenida") : app.status === "failed" ? t("No pudo iniciar") : `${t("Se cerró")} · ${t("código")} ${app.code}`;
  const actions = [
    app.url && running && !onAndroid ? `<button type="button" class="button small primary" data-app="open">${t("Abrir")}</button>` : "",
    `<button type="button" class="button small quiet" data-app="output">${t(appOutputOpen ? "Ocultar salida" : "Ver salida")}</button>`,
    running ? `<button type="button" class="button small quiet" data-app="stop">${t("Detener")}</button>` : `<button type="button" class="button small quiet" data-app="dismiss">${t("Cerrar")}</button>`
  ].join("");
  return `<div class="app-panel"><div class="git-item app-row"><span class="git-kind app-kind${running ? " live" : ""}">${t("APP")}</span><span class="git-text app-text"><span>${status}</span><code data-user-content title="${esc(app.command)}">${esc(app.command)}</code>${app.url ? `<small data-user-content>${esc(app.url)}</small>` : ""}</span><span class="git-actions">${actions}</span></div>${appOutputOpen ? `<pre class="app-output" data-user-content>${esc(app.output || app.error || t("Sin salida todavía."))}</pre>` : ""}</div>`;
}
// ───────── Delivery: the app is ready to be handed to a person (P4) ─────────
// Only the latest work of the project speaks: a new one that has not delivered yet hides the old row.
const deliveries = () => state.runs.filter((r) => r.projectId === selected).slice(-1).filter((r) => ["ready", "failed"].includes(r.delivery?.status)).map((r) => ({ ...r.delivery, runId: r.id }));
function deliveryRow(d) {
  if (d.status === "failed") return `<div class="git-item uncertain" data-run="${esc(d.runId)}"><span class="git-kind">${t("ENTREGA")}</span><span class="git-text" data-user-content title="${esc((d.problems ?? []).join(" "))}">${esc(t("Todavía no está lista para entregarse"))} · ${esc(d.problems?.[0] ?? "")}</span></div>`;
  // Opening something on the screen is for the PC where Automata runs; a phone only reads the guide.
  const here = !onAndroid;
  return `<div class="git-item delivery-row" data-run="${esc(d.runId)}"><span class="git-kind app-kind">${t("ENTREGA")}</span><span class="git-text app-text"><span>${t("Tu aplicación está lista")}</span><small data-user-content title="${esc(d.folder)}">${esc(t("Se guardó en"))} ${esc(d.folder)}</small></span><span class="git-actions">${here ? `<button type="button" class="button small primary" data-delivery="open">${t("Abrir aplicación")}</button>` : ""}<button type="button" class="button small quiet" data-delivery="details">${t("Guía y detalles")}</button>${here ? `<button type="button" class="button small quiet" data-delivery="folder">${t("Abrir carpeta")}</button>` : ""}</span></div>`;
}
// How each check is told to the person: what it means for them, not what was run.
const stepText = { launcher: "El lanzador está y no instala nada", guide: "La guía tiene todas sus secciones", page: "La página principal existe", files: "Los archivos que usa están completos", start: "La aplicación arrancó", browser: "Se abrió en el navegador sin errores" };
const guideHtml = (text) => text.split(/\r?\n/).map((line) => { const h = /^#{1,4}\s+(.*)$/.exec(line); return h ? `<h5>${esc(h[1])}</h5>` : line.trim() ? `<p>${esc(line.replace(/^\s*[-*]\s+/, "• "))}</p>` : ""; }).join("");
function deliveryHtml(d, guide) {
  const how = d.open?.type === "url" ? "Haz doble clic en Abrir.cmd, o usa el botón «Abrir aplicación»: se enciende y se abre en tu navegador." : "Haz doble clic en Abrir.cmd, o usa el botón «Abrir aplicación»: se abre en tu navegador.";
  const checked = (d.steps ?? []).map((s) => `<li>${esc(t(stepText[s.name] ?? s.name))}${s.ok ? "" : " ✗"}</li>`).join("");
  const unseen = d.browser && !d.browser.ran ? `<p class="idea-small">${esc(t("No se pudo abrir en un navegador de prueba; se revisaron los archivos y el arranque."))}</p>` : "";
  return `<section><h4>${esc(t("Dónde está"))}</h4><p><code data-user-content>${esc(d.folder)}</code></p><p class="idea-small">${esc(t(how))}</p></section>
    <section><h4>${esc(t("Qué funciona"))}</h4>${d.works?.length ? `<ul class="idea-list">${d.works.map((w) => `<li data-user-content>${esc(w.criterion)}</li>`).join("")}</ul>` : `<p class="idea-small">${esc(t("Sin detalle."))}</p>`}</section>
    <section class="idea-risks"><h4>${esc(t("Qué queda pendiente"))}</h4>${d.pending?.length ? `<ul class="idea-list">${d.pending.map((x) => `<li data-user-content>${esc(x)}</li>`).join("")}</ul>` : `<p class="idea-small">${esc(t("Nada anotado."))}</p>`}</section>
    <section><h4>${esc(t("Guía para usarla"))}</h4><div class="delivery-guide" data-user-content>${guide ? guideHtml(guide) : `<p class="idea-small">${esc(t("Cargando la guía…"))}</p>`}</div></section>
    <details><summary>${esc(t("Cómo se comprobó"))}</summary><ul class="idea-list">${checked}</ul>${d.checks?.total ? `<p class="idea-small">${esc(t("Pruebas automáticas del proyecto"))}: ${d.checks.passed}/${d.checks.total}</p>` : ""}${unseen}<p class="idea-small">${esc(t("Que las pruebas pasen no garantiza calidad comercial."))}</p></details>`;
}
async function openDelivery(runId) {
  const d = state.runs.find((r) => r.id === runId)?.delivery;
  if (!d) return;
  $("#deliveryTitle").textContent = d.name;
  $("#deliveryContent").innerHTML = deliveryHtml(d, "");
  showDialog("#deliveryDialog");
  let guide;
  try { guide = (await api("delivery", { method: "POST", body: { runId, action: "guide" } })).text; } catch (error) { guide = error.message; }
  if ($("#deliveryDialog").open) {
    $("#deliveryContent").innerHTML = deliveryHtml(d, guide);
    i18n.translateDom($("#deliveryContent"));
  }
}
function renderGitBar() {
  const items = pendingGit(), offers = pendingRuns(), app = state.app, bar = $("#gitBar"), delivered = deliveries();
  bar.hidden = !items.length && !offers.length && !app && !delivered.length;
  if (bar.hidden) {
    $("#gitItems").innerHTML = "";
    return;
  }
  // The header says what the bar is about: decisions for the director's proposals, or the finished app.
  const onlyDelivery = delivered.length && !items.length && !offers.length && !app;
  $("#gitBarTitle").textContent = t(onlyDelivery ? "Entrega" : "El director propone");
  $("#gitBarNote").textContent = t(onlyDelivery ? "Tu aplicación, lista para usar." : "Tú decides si se ejecuta.");
  const output = $("#gitItems .app-output"), pinned = !output || output.scrollHeight - output.scrollTop - output.clientHeight < 30;
  $("#gitItems").innerHTML = delivered.map(deliveryRow).join("") + (app ? appRow(app) : "") + offers.map(runOfferRow).join("") + items.map((item) => {
    const uncertain = item.status === "uncertain", failed = item.status === "failed";
    const text = failed ? `⚠ ${t("No se pudo guardar")} · ${item.error ?? ""}` : uncertain ? `⚠ ${t("Resultado incierto")} · ${gitText(item)}` : gitText(item);
    // Unsaved changes at the end of the work: save them, or decide to leave them (never both silently).
    const labels = item.gate ? [failed || uncertain ? "Reintentar" : "Guardar", "Dejar sin guardar"] : [uncertain ? "Repetir" : "Aprobar", uncertain ? "Descartar" : "Rechazar"];
    return `<div class="git-item${uncertain || failed ? " uncertain" : ""}" data-run="${esc(item.runId)}" data-git="${esc(item.id)}"><span class="git-kind">${esc(t(gitKinds[item.kind] ?? "GIT"))}</span><span class="git-text" data-user-content title="${esc(uncertain ? `${text}. ${t(item.error ?? "")}` : text)}">${esc(text)}</span><span class="git-actions"><button type="button" class="button small primary" data-decision="approve">${t(labels[0])}</button><button type="button" class="button small quiet" data-decision="reject">${t(labels[1])}</button></span></div>`;
  }).join("");
  const next = $("#gitItems .app-output");
  if (next) next.scrollTop = pinned ? next.scrollHeight : output.scrollTop;
}
$("#gitItems").addEventListener("click", async (event) => {
  const deliveryButton = event.target.closest("[data-delivery]");
  if (deliveryButton) {
    const action = deliveryButton.dataset.delivery, runId = deliveryButton.closest(".git-item").dataset.run;
    if (action === "details") return void openDelivery(runId);
    deliveryButton.disabled = true;
    try {
      const result = await api("delivery", { method: "POST", body: { runId, action } });
      if (result.opened === "url") window.open(result.url, "_blank", "noopener");
      state = await api("state");
      render();
      toast(action === "folder" ? "Abriendo la carpeta." : "Abriendo la aplicación en tu navegador.");
    } catch (error) {
      toast(error.message);
    }
    deliveryButton.disabled = false;
    return;
  }
  const appButton = event.target.closest("[data-app]");
  if (appButton) {
    const action = appButton.dataset.app, row = appButton.closest(".git-item");
    if (action === "output") {
      appOutputOpen = !appOutputOpen;
      renderGitBar();
      i18n.translateDom($("#gitBar"));
      return;
    }
    if (action === "open") {
      window.open(state.app?.url, "_blank", "noopener");
      return;
    }
    const buttons = row.querySelectorAll("button");
    buttons.forEach((b) => b.disabled = true);
    try {
      if (action === "approve" || action === "reject") {
        await api("app", { method: "POST", body: { runId: row.dataset.run, offerId: row.dataset.offer, decision: action } });
        if (action === "approve") appOutputOpen = true;
      } else await api("app", { method: "POST", body: { action } });
      state = await api("state");
      render();
      toast(action === "approve" ? "Corriendo la app." : action === "reject" ? "De acuerdo, no se corre por ahora." : action === "stop" ? "App detenida." : "Panel de la app cerrado.");
    } catch (error) {
      toast(error.message);
      buttons.forEach((b) => b.disabled = false);
    }
    return;
  }
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
  return `<article class="activity-entry ${esc(e.kind)}"><div class="activity-meta"><span class="tiny-line"></span><span class="entry-kind">${t(kindNames[e.kind] ?? "ACTIVIDAD")}</span>${e.agent ? `<span class="entry-agent">${esc(e.agent)}</span>` : ""}<time>${time}</time></div>${e.kind === "report" ? `<pre>${esc(e.text)}</pre>` : `<p>${esc(["phase", "start", "pause", "stop", "check", "success", "warning", "complete", "runoffer", "wait", "session", "plan", "error"].includes(e.kind) ? t(e.text) : e.text)}</p>`}${e.offer ? `<pre data-user-content>$ ${esc(e.offer.command)}${e.offer.note ? "\n" + esc(e.offer.note) : ""}</pre>` : ""}${review ? `${review.findings.map((f) => `<div class="finding"><strong>${esc(f.severity.toUpperCase())} · ${esc(f.file)}</strong>${esc(f.description)}<br>${esc(f.evidence)}</div>`).join("")}<div class="criteria-list">${review.criteria.map((c) => `<div class="criterion ${c.met ? "met" : ""}">${icon(c.met ? "check" : "shield")}<span>${esc(c.criterion)}<br><small>${esc(c.evidence)}</small></span></div>`).join("")}</div>` : ""}</article>`;
}
function chatEntry(m, role) {
  // A casual message is answered by Automata itself, shown in the panel it was sent to.
  const a = m.answers?.find((a2) => a2.role === role) ?? (m.casual ? m.answers?.[0] : null);
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
// ───────── What each agent is doing right now: working, watching, paused… ─────────
const shortPath = (file) => String(file ?? "").split(/[\\/]/).filter(Boolean).slice(-2).join("/");
function describeActivity(e) {
  if (!e) return null;
  if (e.kind === "tool" && e.tool) {
    const tool = e.tool;
    if (tool.name === "Bash") return { verb: tool.git ? "Git" : "Ejecutando", what: tool.command };
    if (tool.name === "Edit" || tool.name === "MultiEdit") return { verb: "Editando", what: shortPath(tool.path) };
    if (tool.name === "Write") return { verb: "Escribiendo", what: shortPath(tool.path) };
    if (tool.name === "Read") return { verb: "Leyendo", what: shortPath(tool.path) };
    if (tool.name === "Glob" || tool.name === "Grep") return { verb: "Buscando", what: tool.pattern };
    if (tool.name === "TodoWrite") return { verb: "Organizando sus tareas", what: "" };
    return { verb: "Usando", what: tool.name };
  }
  if (e.kind === "message") return { verb: "Pensando", what: "" };
  if (e.kind === "check") return { verb: "Verificando", what: e.text.replace(/^Verificando · /, "") };
  return null;
}
// tone: work (busy), watch (following the coder), pause, wait (its turn will come), done, alert, idle.
function agentState(role, r, replying) {
  const events = state.events.filter((e) => e.projectId === selected);
  const last = (test) => events.findLast(test);
  const since = (e) => e?.at ?? null;
  if (replying) {
    const latest = last((e) => e.role === role && e.kind !== "toolresult" && e.at >= (replying.startedAt ?? ""));
    return { tone: "work", label: replying.kind === "task" ? "Trabajando" : "Respondiendo", activity: describeActivity(latest) ?? { verb: replying.kind === "task" ? "Trabajando en tu petición" : "Preparando la respuesta", what: "" }, since: replying.startedAt };
  }
  if (!r) return { tone: "idle", label: "En espera" };
  const mine = role === "coder" ? r.stage === "code" : ["plan", "review"].includes(r.stage);
  const start = last((e) => e.runId === r.id && e.kind === "phase" && e.role === role);
  const latest = last((e) => e.runId === r.id && e.role === role && e.kind !== "toolresult" && e.kind !== "phase");
  const current = latest && (!start || latest.at >= start.at) ? describeActivity(latest) : null;
  if (r.status === "running" || r.status === "pausing") {
    const pausing = r.status === "pausing";
    if (mine) return { tone: pausing ? "pause" : "work", label: pausing ? "Pausando" : "Trabajando", activity: pausing ? { verb: "Termina lo actual y se pausa", what: "" } : current ?? { verb: role === "coder" ? "Empezando la tarea" : r.stage === "plan" ? "Planificando la primera tarea" : "Revisando lo que hizo Claude", what: "" }, since: since(start) };
    if (r.stage === "checks" && role === "coder") return { tone: pausing ? "pause" : "work", label: "Verificando", activity: describeActivity(last((e) => e.runId === r.id && e.kind === "check")) ?? { verb: "Corriendo las verificaciones", what: "" }, since: since(last((e) => e.runId === r.id && e.kind === "check")) };
    if (role === "auditor") return { tone: pausing ? "pause" : "watch", label: pausing ? "Pausa pedida" : "Observando", activity: pausing ? { verb: "Se pausa cuando Claude termine", what: "" } : { verb: "Sigue a Claude", what: r.watched ? `${r.watched} ${t("acciones registradas")}` : "" }, title: "El director sigue lo que hace Claude y lo revisará sin releer todo el proyecto." };
    return { tone: pausing ? "pause" : "wait", label: pausing ? "Pausa pedida" : "Esperando", activity: { verb: "Espera la tarea del director", what: "" } };
  }
  if (r.status === "paused") return { tone: "pause", label: "En pausa", activity: { verb: "Pulsa Continuar para seguir", what: "" } };
  if (r.status === "waiting") {
    const w = r.waiting ?? {};
    if (w.role === role) return { tone: "pause", label: "En espera", activity: { verb: waitText(w), what: "" }, title: w.reason ?? "" };
    return { tone: "wait", label: "Esperando", activity: { verb: `${t("Espera a que")} ${w.role === "coder" ? "Claude" : "Codex"} ${t("pueda continuar")}`, what: "" } };
  }
  if (r.status === "complete") return { tone: "done", label: "Completado" };
  if (r.status === "blocked") return role === "auditor" ? { tone: "alert", label: "Necesita tu decisión", activity: { verb: "Lee su revisión y responde en el chat", what: "" } } : { tone: "idle", label: "En espera" };
  if (r.status === "error") return { tone: "alert", label: "Error", activity: { verb: "Revisa el error y pulsa Continuar", what: "" } };
  if (r.status === "limit") return { tone: "pause", label: "Límite de rondas", activity: { verb: "Sube el límite y pulsa Continuar", what: "" } };
  if (r.status === "interrupted") return { tone: "pause", label: "Interrumpido", activity: { verb: "Pulsa Continuar para retomar", what: "" } };
  if (r.status === "stopped") return { tone: "idle", label: "Detenido" };
  return { tone: "idle", label: "En espera" };
}
const defaultSubtitles = { coder: "Convierte la siguiente tarea en código.", auditor: "La dirección correcta. La evidencia primero." };
const elapsed = (from) => {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(from).getTime()) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
function renderAgentState(role, s) {
  const chip = $("#" + role + "Status");
  chip.innerHTML = `<i></i>${esc(t(s.label))}${s.since && s.tone === "work" ? ` <span class="agent-clock" data-since="${esc(s.since)}">${elapsed(s.since)}</span>` : ""}`;
  chip.className = "agent-status tone-" + s.tone + (["work", "watch"].includes(s.tone) ? " active" : "");
  chip.title = s.title ? t(s.title) : "";
  chip.closest(".agent-panel")?.setAttribute("data-tone", s.tone);
  const subtitle = $("#" + role + "Subtitle");
  subtitle.classList.toggle("live", !!s.activity);
  subtitle.innerHTML = s.activity ? `<span class="live-verb">${esc(t(s.activity.verb))}</span>${s.activity.what ? ` <code data-user-content title="${esc(s.activity.what)}">${esc(s.activity.what)}</code>` : ""}${["work", "watch"].includes(s.tone) ? '<span class="live-dots" aria-hidden="true"><i></i><i></i><i></i></span>' : ""}` : esc(t(defaultSubtitles[role]));
}
// The clocks tick on their own; the rest of the page only redraws when something changes.
setInterval(() => document.querySelectorAll(".agent-clock[data-since]").forEach((el) => el.textContent = elapsed(el.dataset.since)), 1000);
// What is being built and what is left, in plain words.
function buildingText() {
  const plan = state.plans?.[selected];
  if (!plan?.current) return t("Tu equipo está trabajando. Puedes dejarle un mensaje.");
  const left = plan.active - plan.done;
  return `${t("Construyendo")}: «${plan.current.title}» · ${left === 1 ? t("falta 1 tarea") : `${t("faltan")} ${left} ${t("tareas")}`} ${t("de")} ${plan.active}`;
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
  const active = !!r && ["running", "pausing"].includes(r.status), waiting = r?.status === "waiting", resumable = !!r && ["paused", "interrupted", "error", "blocked", "limit", "stopped", "waiting"].includes(r.status);
  $("#startButton span").textContent = waiting ? "Continuar ahora" : resumable ? "Continuar" : r?.status === "complete" ? "Nuevo trabajo" : "Iniciar trabajo";
  $("#startButton").disabled = !connection?.token || state.busy && !active || active;
  // Pause and Stop win over any retry: both stay available while Automata waits.
  $("#pauseButton").disabled = !(active && r.status !== "pausing") && !waiting;
  $("#stopButton").disabled = !state.busy && (!r || !["running", "pausing", "paused", "interrupted", "error", "blocked", "limit", "waiting"].includes(r.status));
  for (const role of ["coder", "auditor"]) {
    const replying = state.messages.find(message => message.projectId === selected && message.status === "processing" && message.activeRole === role);
    renderAgentState(role, agentState(role, r, replying));
    {
      const source = r && ["running", "pausing", "paused"].includes(r.status) ? r.settings : state.settings;
      $("#" + role + "ModelLabel").textContent = modelName(role, source[role + "Model"]) + teamSuffix(source, role);
    }
  }
  const stages = { plan: 1, code: 2, checks: 3, review: 4, complete: 4 };
  document.querySelectorAll(".workflow-line>span").forEach((el, i) => el.classList.toggle("current", i === (stages[r?.stage] ?? 0)));
  $("#roundCount").textContent = r ? `RONDA ${String(r.round).padStart(2, "0")} / ${r.settings.maxRounds}` : "RONDA —";
  const planStats = state.plans?.[selected];
  $("#planCount").textContent = planStats?.active ? `PLAN ${planStats.done}/${planStats.active}` : "PLAN —";
  $("#tokenCount").textContent = r?.tokens ? `TOKENS ${Intl.NumberFormat(i18n.language, { notation: "compact" }).format(r.tokens)}` : "TOKENS —";
  const replying = state.messages.find(message => message.projectId === selected && message.status === "processing");
  $("#bottomStatus").textContent = state.demo && !waiting ? "Demostración local · no llama a las AI ni consume créditos." : replying ? `${replying.activeRole === "coder" ? "Claude" : "Codex"} está ${replying.kind === "task" ? "trabajando en tu petición" : "respondiendo a tu consulta"}…` : waiting ? `${waitText(r.waiting ?? {})} · ${t("Puedes continuar ahora, pausar o detener.")} ${t("Motivo:")} ${String(r.waiting?.reason ?? "").slice(0, 160)}` : r?.error ?? (active ? buildingText() : r?.status === "complete" ? "Objetivo completado. Revisa la evidencia en el panel del auditor." : "Tu siguiente proyecto empieza aquí.");
  $("#bottomStatus").title = waiting ? String(r.waiting?.reason ?? "") : "";
  renderFeed("coder");
  renderFeed("auditor");
  renderGitBar();
  if ($("#ideaDialog").open) renderIdea();
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
    applyModelCatalog();
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
// ───────── From an idea: the director proposes, the person approves once ─────────
let ideaId = null;
const ideaProposal = () => (state.proposals ?? []).find((p) => p.id === ideaId) ?? null;
function openIdea() {
  // The latest proposal still waiting for a decision is shown again; otherwise a fresh box.
  const open = (state.proposals ?? []).filter((p) => ["drafting", "ready", "error", "accepting"].includes(p.status)).at(-1);
  ideaId = open?.id ?? null;
  $("#ideaError").textContent = "";
  renderIdea();
  showDialog("#ideaDialog");
  if (!ideaId) $("#ideaText").focus();
}
const list = (items) => `<ul class="idea-list">${items.map((item) => `<li data-user-content>${esc(item)}</li>`).join("")}</ul>`;
function renderIdea() {
  const p = ideaProposal(), d = p?.draft;
  $("#ideaForm").hidden = !!p && p.status !== "error";
  $("#ideaWorking").hidden = p?.status !== "drafting";
  $("#ideaCard").hidden = !d || p.status === "drafting";
  $("#ideaActions").hidden = !d || !["ready", "accepting"].includes(p.status);
  if (p?.status === "error") $("#ideaError").textContent = t(p.error ?? "No se pudo preparar la propuesta.");
  if (p && p.status === "error" && !$("#ideaText").value) $("#ideaText").value = p.idea;
  if (!d || p.status === "drafting") return;
  const byIndex = d.plan.map((task) => task.title);
  $("#ideaCard").innerHTML = `<div class="idea-head"><h3 data-user-content>${esc(d.name)}</h3><p data-user-content>${esc(d.summary)}</p></div>
    <section><h4>${esc(t("Lo que hará"))}</h4>${list(d.features)}</section>
    <section><h4>${esc(t("Cómo sabremos que funciona"))}</h4>${list(d.criteria)}<p class="idea-small">${esc(t("Automata lo comprobará con pruebas automáticas y una revisión independiente. Que las pruebas pasen no garantiza calidad comercial."))}</p></section>
    <section><h4>${esc(t("Dónde se usará"))}</h4><p data-user-content>${esc(d.platform)}</p>${p.delivery?.note ? `<p class="idea-small" data-user-content>${esc(p.delivery.note)}</p>` : ""}${p.delivery && !p.delivery.verified && p.delivery.missing?.length ? `<p class="idea-small" data-user-content>${esc(t("En esta PC falta:"))} ${esc(p.delivery.missing.join(" "))}</p>` : ""}</section>
    <section><h4>${esc(t("Pasos del plan"))}</h4><ol class="idea-plan">${d.plan.map((task) => `<li><span data-user-content>${esc(task.title)}</span>${task.dependsOn.length ? `<small>${esc(t("después de"))} ${task.dependsOn.map((ref) => `«${esc(byIndex[Number(ref.slice(1)) - 1] ?? ref)}»`).join(", ")}</small>` : ""}</li>`).join("")}</ol></section>
    ${d.risks.length ? `<section class="idea-risks"><h4>${esc(t("Ten en cuenta"))}</h4>${list(d.risks)}</section>` : ""}
    ${d.questions.length ? `<section class="idea-questions"><h4>${esc(t("Preguntas del director"))}</h4>${list(d.questions)}<p class="idea-small">${esc(t("Respóndelas con Ajustar, o crea el proyecto con lo que propuso."))}</p></section>` : ""}
    <section><h4>${esc(t("Dónde se guardará"))}</h4><p><code data-user-content>${esc(p.folder ?? "")}</code></p><p class="idea-small">${esc(t("Una carpeta nueva solo para este proyecto. Tu equipo no puede tocar otras carpetas desde aquí."))}</p></section>
    <details><summary>${esc(t("Detalles técnicos"))}</summary><p class="idea-small">${esc(t("Verificaciones que ejecutará Automata:"))}</p><pre data-user-content>${esc(d.checks.join("\n"))}</pre></details>
    <p class="idea-approval">${esc(t("Crear y empezar es la única aprobación que necesitas. Publicar, comprar, subir a GitHub o fusionar ramas siempre te lo preguntará aparte."))}</p>`;
  $("#ideaAccept").disabled = p.status === "accepting";
}
$("#newIdeaTop").addEventListener("click", () => state.demo ? toast("La demostración usa un proyecto aislado. Reinicia sin --demo para crear proyectos desde una idea.") : openIdea());
$("#ideaManual").addEventListener("click", () => { $("#ideaDialog").close(); newProject(); });
$("#ideaForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#ideaError").textContent = "";
  try {
    const proposal = await api("ideas", { method: "POST", body: { action: "propose", idea: $("#ideaText").value } });
    ideaId = proposal.id;
    state.proposals = [...(state.proposals ?? []).filter((p) => p.id !== proposal.id), proposal];
    renderIdea();
  } catch (error) { $("#ideaError").textContent = t(error.message); }
});
$("#ideaAdjustForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const proposal = await api("ideas", { method: "POST", body: { action: "adjust", id: ideaId, adjustments: $("#ideaAdjust").value } });
    $("#ideaAdjust").value = "";
    $("#ideaAdjustForm").hidden = true;
    state.proposals = [...(state.proposals ?? []).filter((p) => p.id !== proposal.id), proposal];
    renderIdea();
  } catch (error) { $("#ideaError").textContent = t(error.message); }
});
$("#ideaAdjustOpen").addEventListener("click", () => { $("#ideaAdjustForm").hidden = false; $("#ideaAdjust").focus(); });
$("#ideaDiscard").addEventListener("click", async () => {
  try {
    await api("ideas", { method: "POST", body: { action: "discard", id: ideaId } });
    ideaId = null;
    $("#ideaText").value = "";
    $("#ideaDialog").close();
    toast("Propuesta descartada.");
  } catch (error) { $("#ideaError").textContent = t(error.message); }
});
$("#ideaAccept").addEventListener("click", async () => {
  $("#ideaAccept").disabled = true;
  $("#ideaAccept span").textContent = t("Creando el proyecto…");
  try {
    if (!await ensureAccounts()) return;
    const result = await api("ideas", { method: "POST", body: { action: "accept", id: ideaId } });
    selected = result.project.id;
    localStorage.setItem("automata.project", selected);
    ideaId = null;
    $("#ideaText").value = "";
    $("#ideaDialog").close();
    toast("Proyecto creado. Tu equipo ya empezó a trabajar.");
    state = await api("state");
    render();
  } catch (error) {
    $("#ideaError").textContent = t(error.message);
  } finally {
    $("#ideaAccept").disabled = false;
    $("#ideaAccept span").textContent = t("Crear y empezar");
  }
});
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
// ---- Project memory: what Claude and Codex remember between sessions ----
const memoryKinds = { decision: "Decisiones", env: "Entorno", gotcha: "Trampas conocidas", pending: "Pendientes", progress: "Avances", note: "Notas", recovery: "Recuperaciones" };
const memorySources = { director: "Codex", coder: "Claude", user: "Tú", automata: "Automata" };
const errorStates = { open: "Abierto", resolved: "Resuelto", retired: "Retirado" };
let memoryTimer;
const memoryCall = (body) => api("memory", { method: "POST", body: { projectId: project()?.id, ...body } });
const shortDate = (iso) => iso ? new Date(iso).toLocaleDateString(i18n.language, { day: "numeric", month: "short" }) : "";
function memoryFactHtml(f) {
  const meta = [`#${f.id}`, t(memorySources[f.source] ?? f.source), f.round != null ? `${t("Ronda")} ${f.round}` : "", shortDate(f.updated_at)].filter(Boolean);
  const action = f.status === "retired" ? `<button type="button" class="button quiet compact" data-restore="${f.id}">${esc(t("Restaurar"))}</button>` : `<button type="button" class="button quiet compact" data-edit="${f.id}">${esc(t("Corregir"))}</button><button type="button" class="button quiet compact" data-retire="${f.id}">${esc(t("Retirar"))}</button>`;
  // Files the fact mentions that are gone: shown as a hint, never retired on its own.
  const stale = f.stale?.length ? `<span class="memory-stale" data-user-content title="${esc(f.stale.join(", "))}">⚠ ${esc(t("Menciona archivos que ya no existen:"))} ${esc(f.stale.join(", "))}</span>` : "";
  return `<article class="memory-item${f.status === "retired" ? " retired" : ""}" data-fact="${f.id}"><div class="memory-text" data-user-content>${esc(f.text)}</div><div class="memory-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}${f.status === "retired" && f.retired_reason ? `<span data-user-content>${esc(f.retired_reason)}</span>` : ""}${stale}</div><div class="memory-actions">${action}</div></article>`;
}
function memoryErrorHtml(e) {
  const s = e.solutions?.[0];
  const solution = s ? `<p class="memory-solution" data-user-content>${esc(`${t("Se resolvió en la ronda")} ${s.round ?? "?"}${s.files.length ? ` · ${s.files.join(", ")}` : ""}${s.summary ? ` · ${s.summary}` : ""}`)}</p>` : "";
  const action = e.status === "retired" ? `<button type="button" class="button quiet compact" data-error="${e.id}" data-status="${e.solutions?.length ? "resolved" : "open"}">${esc(t("Restaurar"))}</button>` : `<button type="button" class="button quiet compact" data-error="${e.id}" data-status="retired">${esc(t("Retirar"))}</button>`;
  return `<article class="memory-item error-item${e.status === "retired" ? " retired" : ""}"><div class="memory-meta"><span class="memory-state ${esc(e.status)}">${esc(t(errorStates[e.status] ?? e.status))}</span><span>E${e.id}</span><span>${esc(t(e.origin === "check" ? "Verificación" : "Comando"))}</span><span>${e.occurrences}×</span><span>${esc(shortDate(e.last_seen_at))}</span></div><code class="memory-command" data-user-content>${esc(e.command)}</code><p class="memory-text" data-user-content>${esc(e.excerpt)}</p>${solution}<div class="memory-actions">${action}</div></article>`;
}
function renderMemory({ facts, errors, stats }) {
  const status = $("#memoryStatus").value;
  $("#memoryStats").innerHTML = [[stats.facts, "recuerdos activos"], [stats.resolved, "errores resueltos"], [stats.open, "errores abiertos"], [stats.retired, "retirados"]].map(([n, label]) => `<span><strong>${n}</strong> ${esc(t(label))}</span>`).join("");
  const groups = Object.keys(memoryKinds).map((kind) => [kind, facts.filter((f) => f.kind === kind)]).filter(([, list]) => list.length);
  const shownErrors = errors.filter((e) => status === "all" || (status === "retired" ? e.status === "retired" : e.status !== "retired"));
  $("#memoryContent").innerHTML = groups.map(([kind, list]) => `<h4>${esc(t(memoryKinds[kind]))}</h4>${list.map(memoryFactHtml).join("")}`).join("")
    + (shownErrors.length ? `<h4>${esc(t("Errores y soluciones"))}</h4>${shownErrors.map(memoryErrorHtml).join("")}` : "")
    || `<div class="list-empty">${esc(t($("#memorySearch").value.trim() ? "Nada coincide con tu búsqueda." : "Todavía no hay recuerdos. Se llenan solos con cada ronda, o agrega uno abajo."))}</div>`;
}
async function loadMemory() {
  if (!project()) return;
  try {
    renderMemory(await memoryCall({ action: "list", status: $("#memoryStatus").value, q: $("#memorySearch").value.trim() }));
  } catch (e) {
    $("#memoryContent").innerHTML = `<div class="list-empty form-error">${esc(t(e.message))}</div>`;
  }
}
async function memoryUpdate(body, done) {
  try {
    await memoryCall(body);
    if (done) toast(done);
    await loadMemory();
  } catch (e) { toast(e.message); }
}
function openMemory() {
  const p = project();
  if (!p) return toast("Selecciona un proyecto.");
  $("#memoryTitle").textContent = p.name;
  $("#memorySearch").value = "";
  $("#memoryContent").innerHTML = "";
  showDialog("#memoryDialog");
  void loadMemory();
}
$("#memoryButton").addEventListener("click", openMemory);
// ───────── Plan: the director's tasks, with the user's own additions ─────────
const taskStates = { todo: "Pendiente", doing: "En curso", review: "Por confirmar", done: "Hecha", blocked: "Bloqueada", dropped: "Descartada" };
const taskGroups = [["doing", "En curso"], ["review", "Por confirmar"], ["todo", "Pendientes"], ["blocked", "Bloqueadas"], ["done", "Hechas"], ["dropped", "Descartadas"]];
let planCurrent = null;
const planCall = (body) => api("plan", { method: "POST", body: { projectId: project()?.id, ...body } });
function planTaskHtml(task, index, total) {
  const current = task.id === planCurrent;
  const meta = [`T${task.id}`, t(memorySources[task.source] ?? task.source), task.criterion ? `${t("Criterio")}: ${task.criterion}` : t("Libre"), task.dependsOn.length ? `${t("Depende de")} ${task.dependsOn.map((id) => "T" + id).join(", ")}` : "", task.closed_round != null ? `${t("Ronda")} ${task.closed_round}` : ""].filter(Boolean);
  const actions = task.status === "dropped"
    ? `<button type="button" class="button quiet compact" data-task-restore="${task.id}">${esc(t("Restaurar"))}</button>`
    : `<button type="button" class="button quiet compact" data-task-up="${task.id}" ${index === 0 ? "disabled" : ""} title="${esc(t("Subir"))}">↑</button><button type="button" class="button quiet compact" data-task-down="${task.id}" ${index === total - 1 ? "disabled" : ""} title="${esc(t("Bajar"))}">↓</button><button type="button" class="button quiet compact" data-task-edit="${task.id}">${esc(t("Corregir"))}</button>${task.status === "review" ? `<button type="button" class="button primary compact" data-task-confirm="${task.id}" title="${esc(t("Revisé el resultado y está bien"))}">${esc(t("Confirmar"))}</button><button type="button" class="button quiet compact" data-task-reopen="${task.id}">${esc(t("Revisar de nuevo"))}</button>` : ""}${task.status === "done" ? "" : `<button type="button" class="button quiet compact" data-task-drop="${task.id}">${esc(t("Descartar"))}</button>`}`;
  return `<article class="memory-item plan-item${task.status === "dropped" ? " retired" : ""}${current ? " current" : ""}" data-task="${task.id}"><div class="memory-text" data-user-content><span class="memory-state task-${esc(task.status)}">${esc(t(taskStates[task.status] ?? task.status))}</span>${current ? `<span class="memory-state task-current">${esc(t("Claude ahora"))}</span>` : ""} ${esc(task.title)}${task.detail ? `<small class="task-detail">${esc(task.detail)}</small>` : ""}${task.evidence ? `<small class="task-evidence">${esc(t("Evidencia"))}: ${esc(task.evidence)}</small>` : ""}${task.note ? `<small class="task-note">${esc(task.note)}</small>` : ""}</div><div class="memory-meta">${meta.map((m) => `<span data-user-content>${esc(m)}</span>`).join("")}</div><div class="memory-actions">${actions}</div></article>`;
}
function renderPlan({ tasks, stats, currentTaskId }) {
  planCurrent = currentTaskId ?? null;
  $("#planStats").innerHTML = [[stats.done, "hechas"], [stats.doing + stats.review, "en curso"], [stats.todo, "pendientes"], [stats.blocked, "bloqueadas"], [stats.dropped, "descartadas"]].map(([n, label]) => `<span><strong>${n}</strong> ${esc(t(label))}</span>`).join("") + (stats.byCriterion?.length ? `<span>${esc(t("Criterios cubiertos"))}: <strong>${stats.byCriterion.filter((c) => c.covered).length}/${stats.byCriterion.length}</strong></span>` : "");
  const groups = taskGroups.map(([status, label]) => [label, tasks.filter((task) => task.status === status)]).filter(([, list]) => list.length);
  const ordered = tasks.filter((task) => task.status !== "dropped");
  $("#planContent").innerHTML = groups.map(([label, list]) => `<h4>${esc(t(label))}</h4>${list.map((task) => planTaskHtml(task, ordered.indexOf(task), ordered.length)).join("")}`).join("") || `<div class="list-empty">${esc(t("Todavía no hay tareas. El director las creará al planificar, o agrega una abajo."))}</div>`;
}
async function loadPlan() {
  if (!project()) return;
  try {
    renderPlan(await planCall({ action: "list" }));
  } catch (e) {
    $("#planContent").innerHTML = `<div class="list-empty form-error">${esc(t(e.message))}</div>`;
  }
}
async function planUpdate(body, done) {
  try {
    await planCall(body);
    if (done) toast(done);
    await loadPlan();
  } catch (e) { toast(e.message); }
}
function openPlan() {
  const p = project();
  if (!p) return toast("Selecciona un proyecto.");
  $("#planTitle").textContent = p.name;
  const select = $("#planForm").elements.criterion;
  select.innerHTML = `<option value="">${esc(t("Sin criterio (libre)"))}</option>` + p.criteria.map((c) => `<option value="${esc(c)}">${esc(c.length > 70 ? c.slice(0, 69) + "…" : c)}</option>`).join("");
  $("#planContent").innerHTML = "";
  showDialog("#planDialog");
  void loadPlan();
}
$("#planButton").addEventListener("click", openPlan);
$("#planForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    await planCall({ action: "add", title: data.title, criterion: data.criterion });
    e.target.reset();
    toast("Tarea agregada al plan.");
    await loadPlan();
  } catch (error) { toast(error.message); }
});
$("#planContent").addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const item = button.closest("[data-task]"), id = Number(item?.dataset.task);
  if (button.dataset.taskDrop) {
    const note = prompt(t("¿Por qué se descarta esta tarea?"), "");
    if (note === null) return;
    return void planUpdate({ action: "drop", id, note: note || t("Descartada por el usuario") }, "Tarea descartada. Sigue en el historial.");
  }
  if (button.dataset.taskRestore) return void planUpdate({ action: "restore", id }, "Tarea restaurada.");
  if (button.dataset.taskConfirm) return void planUpdate({ action: "confirm", id }, "Tarea confirmada como hecha.");
  if (button.dataset.taskReopen) return void planUpdate({ action: "reopen", id }, "La tarea vuelve al plan para el director.");
  if (button.dataset.taskUp || button.dataset.taskDown) {
    const ids = [...$("#planContent").querySelectorAll(".plan-item:not(.retired)")].map((el) => Number(el.dataset.task));
    const at = ids.indexOf(id), to = button.dataset.taskUp ? at - 1 : at + 1;
    if (to < 0 || to >= ids.length) return;
    [ids[at], ids[to]] = [ids[to], ids[at]];
    return void planUpdate({ action: "reorder", ids });
  }
  if (button.dataset.taskEdit) {
    const text = item.querySelector(".memory-text");
    const title = [...text.childNodes].find((node) => node.nodeType === 3 && node.textContent.trim())?.textContent.trim() ?? "";
    text.innerHTML = `<input type="text" value="${esc(title)}" maxlength="140" aria-label="${esc(t("Tarea"))}">`;
    item.querySelector(".memory-actions").innerHTML = `<button type="button" class="button primary compact" data-task-save="${id}">${esc(t("Guardar"))}</button><button type="button" class="button quiet compact" data-task-cancel="${id}">${esc(t("Cancelar"))}</button>`;
    text.querySelector("input").focus();
    return;
  }
  if (button.dataset.taskSave) return void planUpdate({ action: "update", id, title: item.querySelector("input").value }, "Tarea corregida.");
  if (button.dataset.taskCancel) return void loadPlan();
});
// A fresh conversation with the selected agent: its next message starts from zero (the summary of the last exchanges travels with it).
$("#chatReset").addEventListener("click", async () => {
  if (!project()) return toast("Selecciona un proyecto para conversar.");
  const target = $("#chatTarget").value;
  try {
    await api("chat", { method: "POST", body: { action: "reset", projectId: selected, target: target === "both" ? null : target } });
    toast(target === "coder" ? "Conversación con Claude reiniciada." : target === "auditor" ? "Conversación con Codex reiniciada." : "Conversación reiniciada para ambos agentes.");
  } catch (e) { toast(e.message); }
});
$("#memoryStatus").addEventListener("change", () => void loadMemory());
$("#memorySearch").addEventListener("input", () => {
  clearTimeout(memoryTimer);
  memoryTimer = setTimeout(() => void loadMemory(), 250);
});
$("#memoryForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    await memoryCall({ action: "add", kind: data.kind, text: data.text });
    e.target.reset();
    toast("Recuerdo guardado.");
    await loadMemory();
  } catch (error) { toast(error.message); }
});
$("#memoryContent").addEventListener("click", (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.dataset.retire) return void memoryUpdate({ action: "retire", id: Number(button.dataset.retire) }, "Recuerdo retirado. Ya no se enviará a los agentes.");
  if (button.dataset.restore) return void memoryUpdate({ action: "restore", id: Number(button.dataset.restore) }, "Recuerdo restaurado.");
  if (button.dataset.error) return void memoryUpdate({ action: "errorStatus", id: Number(button.dataset.error), status: button.dataset.status });
  if (button.dataset.save) {
    const item = button.closest("[data-fact]");
    return void memoryUpdate({ action: "update", id: Number(button.dataset.save), text: item.querySelector("input").value }, "Recuerdo corregido.");
  }
  if (button.dataset.cancel) return void loadMemory();
  if (button.dataset.edit) {
    const item = button.closest("[data-fact]"), text = item.querySelector(".memory-text").textContent;
    item.querySelector(".memory-text").innerHTML = `<input maxlength="400" aria-label="${esc(t("Corregir recuerdo"))}" value="${esc(text)}">`;
    item.querySelector(".memory-actions").innerHTML = `<button type="button" class="button primary compact" data-save="${button.dataset.edit}">${esc(t("Guardar"))}</button><button type="button" class="button quiet compact" data-cancel="1">${esc(t("Cancelar"))}</button>`;
    item.querySelector("input").focus();
  }
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
  f.elements.autoResume.checked = state.settings.autoResume !== false;
  f.elements.autoStart.checked = state.settings.autoStart === true;
  $("#autoStartRow").hidden = !capabilities?.features?.loginItem;
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
  changes.autoResume = e.target.elements.autoResume.checked;
  changes.autoStart = e.target.elements.autoStart.checked;
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
const planNames = { max: "Max", pro: "Pro", team: "Team", enterprise: "Enterprise" };
function accountWho(role, provider) {
  if (!provider?.connected) return "";
  if (role === "github") return provider.account ? "@" + provider.account : "";
  if (role === "coder") {
    if (provider.method === "api_key") return `${t("Clave de API")} · ${provider.keySource ?? ""}`;
    return [provider.plan ? `${t("Plan")} ${planNames[provider.plan] ?? provider.plan}` : t("Cuenta de Claude"), provider.account].filter(Boolean).join(" · ");
  }
  return provider.method === "chatgpt" ? t("Plan de ChatGPT") : provider.method === "api_key" ? t("Clave de API") : "";
}
// The model pickers in the cards mirror the ones under each panel, including "custom model".
function syncAccountModel(role) {
  const source = $("#" + role + "Model"), target = $("#" + role + "AccountModel");
  target.innerHTML = source.innerHTML;
  target.value = source.value;
}
for (const role of ["coder", "auditor"]) $("#" + role + "AccountModel").addEventListener("change", (event) => {
  const source = $("#" + role + "Model");
  source.value = event.target.value;
  source.dispatchEvent(new Event("change"));
});
function renderPlanOnly() {
  const found = [...accounts?.apiKeys?.coder ?? [], ...accounts?.apiKeys?.auditor ?? []];
  $("#planOnly").checked = state.settings.planOnly !== false;
  $("#planOnly").disabled = state.demo || state.busy;
  $("#planOnlyNote").textContent = t(state.settings.planOnly === false ? "Si hay una clave de API en Windows, Claude o Codex la usarán y se cobrará por uso, aparte de tu plan." : "Claude y Codex trabajan con tu plan, como en la terminal. Automata nunca usa claves de API, que cobran por uso.") + (found.length ? ` ${t("Claves encontradas en Windows")}: ${found.join(", ")}${state.settings.planOnly === false ? "" : " — " + t("no se usan")}.` : "");
}
$("#planOnly").addEventListener("change", async (event) => {
  await saveSettings({ planOnly: event.target.checked });
  await loadAccounts(true);
});
function renderAccounts() {
  renderPlanOnly();
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
    // Who is signed in, and the options to switch account or sign out once connected.
    const who = accountWho(role, provider);
    $("#" + role + "AccountWho").textContent = who;
    $("#" + role + "AccountWho").hidden = !who;
    const manage = $("#" + role + "AccountManage");
    manage.hidden = !provider.connected || !accounts?.canLogin;
    manage.querySelectorAll("button").forEach((b) => b.disabled = state.busy);
    if (role !== "github") syncAccountModel(role);
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
const accountNames = { coder: "Claude Code", auditor: "Codex", github: "GitHub" };
document.querySelectorAll("[data-relogin]").forEach(button => button.addEventListener("click", () => void accountAction({ action: "login", role: button.dataset.relogin, method: "browser" })));
document.querySelectorAll("[data-logout]").forEach(button => button.addEventListener("click", () => {
  const role = button.dataset.logout;
  // The CLIs keep one session for the whole PC: signing out here also signs out the terminal.
  if (!confirm(`${t("¿Cerrar la sesión de")} ${accountNames[role]}? ${t("También se cerrará en la terminal de esta PC.")}`)) return;
  void accountAction({ action: "logout", role });
}));
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
