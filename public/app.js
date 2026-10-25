const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const effortNames = { default: "Predeterminado", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Extra alto", max: "Máximo", ultra: "Ultra" };
const stateNames = { running: "Trabajando", pausing: "Pausando", paused: "En pausa", stopped: "Detenido", complete: "Completado", blocked: "Necesita tu atención", error: "Error de ejecución", interrupted: "Sesión interrumpida", limit: "Límite de rondas" };
const kindNames = { phase: "TAREA", report: "REPORTE", review: "AUDITORÍA", tool: "ACTIVIDAD", session: "SESIÓN", message: "MENSAJE", warning: "ATENCIÓN", error: "ERROR", check: "VERIFICACIÓN", success: "VERIFICADO", start: "INICIO", pause: "PAUSA", stop: "DETENIDO", complete: "COMPLETADO" };
let state = { projects: [], settings: { mode: "small", coderModel: "sonnet", auditorModel: "gpt-6.1-sol", coderEffort: "default", auditorEffort: "high", maxRounds: 6, timeoutMinutes: 30 }, runs: [], events: [], messages: [], busy: false };
let selected = localStorage.getItem("automata.project"), capabilities = null, connection = null, streamAbort = null, toastTimer, reconnectTimer, renderTimer;
const project = () => state.projects.find((p) => p.id === selected);
const run = () => state.runs.find((r) => r.projectId === selected);
function toast(text) {
  $("#toast").textContent = text;
  $("#toast").classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 5e3);
}
function connected(ok, text) {
  $("#connection").classList.toggle("offline", !ok);
  $("#connection").lastElementChild.textContent = text;
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
  $(selector).showModal();
}
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
document.querySelectorAll("dialog").forEach((d) => d.addEventListener("click", (e) => {
  if (e.target === d) {
    const r = d.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
  }
}));
function modelName(role, id) {
  return capabilities?.models?.[role]?.find((m) => m.id === id)?.label ?? ({ sonnet: "Sonnet", haiku: "Haiku", opus: "Opus", fable: "Fable", "gpt-6.1-sol": "Sol", "gpt-6-luna": "Luna", "gpt-6-astra": "Astra" }[id] ?? id);
}
function populateEffort(role, model, value) {
  const values = role === "coder" ? ["default", "low", "medium", "high", "xhigh", "max"] : ["default", "low", "medium", "high", "xhigh", "max", .../luna/.test(model) ? [] : ["ultra"]];
  $("#" + role + "Effort").innerHTML = values.map((v) => `<option value="${v}">${effortNames[v]}</option>`).join("");
  $("#" + role + "Effort").value = values.includes(value) ? value : "default";
}
function syncSettings() {
  for (const role of ["coder", "auditor"]) {
    const model = state.settings[role + "Model"], el = $("#" + role + "Model");
    if (![...el.options].some((o) => o.value === model)) el.add(new Option(model, model), el.options[el.options.length - 1]);
    el.value = model;
    populateEffort(role, model, state.settings[role + "Effort"]);
    $("#" + role + "ModelLabel").textContent = modelName(role, model);
  }
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.settings.mode));
}
async function saveSettings(changes) {
  try {
    state.settings = await api("settings", { method: "PUT", body: { ...state.settings, ...changes } });
    syncSettings();
    toast(run() && ["running", "paused", "pausing"].includes(run().status) ? "Preferencias guardadas para el siguiente trabajo." : "Preferencias guardadas.");
  } catch (e) {
    toast(e.message);
    syncSettings();
  }
}
function emptyCoder() {
  return `<div class="empty-intro"><span class="tiny-line"></span>EL COMIENZO DE ALGO BUENO</div><h3 class="welcome-title">De una idea<br>a algo que <em>funciona.</em></h3><p class="welcome-description">Una tarea clara, código con intención y un reporte de lo que realmente cambió. Así empieza cada ronda.</p><div class="terminal-preview"><div class="terminal-top"><i></i><i></i><i></i><span>EL FLUJO DE TRABAJO</span></div><pre><b>01</b>  Recibir la tarea del director
<b>02</b>  Construir y documentar los cambios
<b>03</b>  Entregar el resultado <span>→ auditoría</span></pre></div><div class="welcome-steps"><div class="welcome-step"><span>ENFOQUE</span><p>Un paso a la vez</p></div><div class="welcome-step"><span>CONTEXTO</span><p>Tu proyecto primero</p></div><div class="welcome-step"><span>ENTREGA</span><p>Código + evidencia</p></div></div>`;
}
function emptyAuditor() {
  const p = project();
  return `<div class="empty-intro"><span class="tiny-line"></span>LA PERSPECTIVA COMPLETA</div><h3 class="welcome-title">Un buen siguiente paso.<br>Una <em>segunda mirada.</em></h3><p class="welcome-description">${p ? esc(p.objective) : "Define lo que quieres conseguir. El director convierte tu objetivo en tareas y revisa cada entrega con criterio propio."}</p>${p ? `<div class="criteria-list">${p.criteria.map((c) => `<div class="criterion">${icon("shield")}<span>${esc(c)}</span></div>`).join("")}</div>` : `<div class="first-step"><span class="step-number">01</span><div><strong>Define el destino</strong><p>Un objetivo, una carpeta y criterios claros.</p></div></div><div class="first-step"><span class="step-number">02</span><div><strong>Deja que tu equipo avance</strong><p>El director planifica. El codificador construye.</p></div></div><div class="first-step"><span class="step-number">03</span><div><strong>Cierra con evidencia</strong><p>Las pruebas y la auditoría deciden el resultado.</p></div></div>`}<div class="auditor-note">${icon("shield")}Auditoría independiente · acceso de solo lectura</div>`;
}
function entry(e) {
  const time = new Date(e.at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const review = e.review;
  return `<article class="activity-entry ${esc(e.kind)}"><div class="activity-meta"><span class="tiny-line"></span><span class="entry-kind">${kindNames[e.kind] ?? "ACTIVIDAD"}</span><time>${time}</time></div>${e.kind === "report" ? `<pre>${esc(e.text)}</pre>` : `<p>${esc(e.text)}</p>`}${review ? `${review.findings.map((f) => `<div class="finding"><strong>${esc(f.severity.toUpperCase())} · ${esc(f.file)}</strong>${esc(f.description)}<br>${esc(f.evidence)}</div>`).join("")}<div class="criteria-list">${review.criteria.map((c) => `<div class="criterion ${c.met ? "met" : ""}">${icon(c.met ? "check" : "shield")}<span>${esc(c.criterion)}<br><small>${esc(c.evidence)}</small></span></div>`).join("")}</div>` : ""}</article>`;
}
function chatEntry(m, role) {
  const a = m.answers?.find((a2) => a2.role === role);
  return `<article class="activity-entry user"><div class="activity-meta">TÚ · ${m.kind === "instruction" ? "INSTRUCCIÓN" : "CONSULTA"}<time>${new Date(m.at).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}</time></div><p>${esc(m.text)}</p>${a ? `<p class="chat-answer">${esc(a.text)}</p>` : m.answer ? `<p class="chat-answer">${esc(m.answer)}</p>` : m.error ? `<p class="chat-answer">${esc(m.error)}</p>` : `<p class="chat-answer pending-msg">En cola · se entrega al terminar la operación actual.</p>`}</article>`;
}
function renderFeed(role) {
  const el = $("#" + role + "Feed"), atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 55;
  const events = state.events.filter((e) => e.projectId === selected && (e.role === role || e.role === "system"));
  const messages = state.messages.filter((m) => m.projectId === selected && (m.target === role || m.target === "both" || m.kind === "instruction" && role === "auditor"));
  const items = [...events.map((e) => ({ at: e.at, html: entry(e) })), ...messages.map((m) => ({ at: m.at, html: chatEntry(m, role) }))].sort((a, b) => a.at.localeCompare(b.at));
  el.innerHTML = items.length ? items.slice(-100).map((i) => i.html).join("") : role === "coder" ? emptyCoder() : emptyAuditor();
  if (atBottom && items.length) el.scrollTop = el.scrollHeight;
}
function render() {
  if (!selected && state.projects.length) selected = state.projects[0].id;
  const p = project(), r = run();
  $("#projectName").textContent = p?.name ?? "Selecciona tu próximo proyecto";
  $("#projectPath").textContent = p?.directory ?? "Un objetivo claro es el primer paso.";
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
    const working = active && (role === "coder" ? r.stage === "code" : ["plan", "review"].includes(r.stage));
    $("#" + role + "Status").innerHTML = `<i></i>${working ? "Trabajando" : r?.status === "complete" ? "Completado" : "En espera"}`;
    $("#" + role + "Status").classList.toggle("active", working);
    $("#" + role + "ModelLabel").textContent = modelName(role, (r && ["running", "pausing", "paused"].includes(r.status) ? r.settings : state.settings)[role + "Model"]);
  }
  const stages = { plan: 1, code: 2, checks: 3, review: 4, complete: 4 };
  document.querySelectorAll(".workflow-line>span").forEach((el, i) => el.classList.toggle("current", i === (stages[r?.stage] ?? 0)));
  $("#roundCount").textContent = r ? `RONDA ${String(r.round).padStart(2, "0")} / ${r.settings.maxRounds}` : "RONDA —";
  $("#tokenCount").textContent = r?.tokens ? `TOKENS ${Intl.NumberFormat("es", { notation: "compact" }).format(r.tokens)}` : "TOKENS —";
  $("#bottomStatus").textContent = state.demo ? "Demostración local · no llama a las AI ni consume créditos." : r?.error ?? (active ? "Tu equipo está trabajando. Puedes dejarle un mensaje." : r?.status === "complete" ? "Objetivo completado. Revisa la evidencia en el panel del auditor." : "Tu siguiente proyecto empieza aquí.");
  renderFeed("coder");
  renderFeed("auditor");
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
    syncSettings();
    render();
    connected(true, "Conectado a tu PC");
    void listen();
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
  showDialog("#projectDialog");
}
$("#newProjectTop").addEventListener("click", newProject);
$("#projectForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    const p = await api("projects", { method: "POST", body: Object.fromEntries(new FormData(e.target)) });
    selected = p.id;
    localStorage.setItem("automata.project", selected);
    $("#projectDialog").close();
    e.target.reset();
    state = await api("state");
    render();
    toast("Proyecto creado. Tu equipo está listo.");
  } catch (err) {
    $("#projectError").textContent = err.message;
  } finally {
    button.disabled = false;
  }
});
$("#browseButton").addEventListener("click", async () => {
  if (window.automata?.chooseDirectory) {
    const directory = await window.automata.chooseDirectory();
    if (directory) $("#projectForm [name=directory]").value = directory;
  } else toast("Escribe la ruta de la carpeta en la PC que ejecuta Automata.");
});
function projectList() {
  $("#listTitle").textContent = "Tus proyectos";
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
  $("#listContent").innerHTML = `<div class="note">${esc(p.objective)}</div><div class="criteria-list">${p.criteria.map((c) => `<div class="criterion">${icon("shield")}<span>${esc(c)}</span></div>`).join("")}</div><h4>Verificaciones</h4><div class="pairing-code">${esc(p.checks.join("\n") || "Sin comandos configurados.")}</div><h4>Restricciones</h4><p class="note">${esc(p.constraints || "Conservar los cambios existentes.")}</p>`;
  showDialog("#listDialog");
});
$("#historyButton").addEventListener("click", () => {
  $("#listTitle").textContent = "Cada paso cuenta.";
  $("#listContent").innerHTML = state.runs.map((r) => `<article class="run-item"><strong>${esc(r.project.name)} · ${esc(stateNames[r.status])}</strong><p>${new Date(r.createdAt).toLocaleString("es")} · ${r.round} rondas · ${esc(modelName("coder", r.settings.coderModel))} + ${esc(modelName("auditor", r.settings.auditorModel))}</p><p>${esc(r.review?.summary ?? r.error ?? "Pendiente de auditoría.")}</p></article>`).join("") || '<div class="list-empty">Tu historial aparecerá aquí después del primer trabajo.</div>';
  showDialog("#listDialog");
});
document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => void saveSettings({ mode: b.dataset.mode })));
for (const role of ["coder", "auditor"]) {
  $("#" + role + "Model").addEventListener("change", async (e) => {
    if (e.target.value === "custom") {
      $("#listTitle").textContent = "Elige tu modelo";
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
    if (!project()) return newProject();
    const r = run();
    const resumable = r && ["paused", "interrupted", "error", "blocked", "limit", "stopped"].includes(r.status);
    await api(resumable ? "control" : "start", { method: "POST", body: resumable ? { action: "resume" } : { projectId: selected } });
  } catch (e) {
    toast(e.message);
  }
});
for (const action of ["pause", "stop"]) $("#" + action + "Button").addEventListener("click", async () => {
  try {
    await api("control", { method: "POST", body: { action } });
  } catch (e) {
    toast(e.message);
  }
});
$("#settingsButton").addEventListener("click", () => {
  const f = $("#settingsForm");
  f.elements.maxRounds.value = state.settings.maxRounds;
  f.elements.timeoutMinutes.value = state.settings.timeoutMinutes;
  showDialog("#settingsDialog");
});
$("#settingsForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  await saveSettings(Object.fromEntries(new FormData(e.target)));
  $("#settingsDialog").close();
});
$("#mobileSettings").addEventListener("click", () => $("#settingsButton").click());
$("#mobileHistory").addEventListener("click", () => $("#historyButton").click());
$("#chatForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (!project()) return toast("Selecciona un proyecto para conversar.");
    await api("chat", { method: "POST", body: { projectId: selected, target: $("#chatTarget").value, kind: $("#chatKind").value, text: $("#chatText").value } });
    $("#chatText").value = "";
    $("#chatText").style.height = "auto";
    toast(state.busy ? "Mensaje en cola. Se entregará en un punto seguro." : "Mensaje enviado.");
  } catch (err) {
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
window.addEventListener("beforeunload", () => {
  streamAbort?.abort();
  clearTimeout(reconnectTimer);
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
  syncSettings();
  render();
  if (connection) await connect();
  else {
    connected(false, "Conectar PC");
    $("#bottomStatus").textContent = "Conecta tu PC para empezar. Pulsa el indicador de conexión.";
  }
}
void init();
