const { app, BrowserWindow, ipcMain, dialog, shell, protocol } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
let service, win, quitting = false, relaunching = false;
app.setName("Automata");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("in-process-gpu");
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
protocol.registerSchemesAsPrivileged([{ scheme: "automata", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
if (process.env.AUTOMATA_USER_DATA) {
  fs.mkdirSync(process.env.AUTOMATA_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.AUTOMATA_USER_DATA);
}
const runtimeConfigPath = path.join(app.getPath("userData"), "desktop-runtime.json");
let savedCompatibility = false;
try { savedCompatibility = JSON.parse(fs.readFileSync(runtimeConfigPath, "utf8")).compatibilityMode === true; } catch {}
const compatibilityMode = !process.argv.includes("--strict-renderer") && (process.argv.includes("--compatibility") || savedCompatibility);
const log = (message) => {
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.appendFileSync(path.join(app.getPath("userData"), "boot.log"), new Date().toISOString() + " " + message + "\n");
  } catch (e) { console.error("Automata startup log:", e.message); }
};
log(`main loaded · ${app.getVersion()} · ${process.execPath} · compatibility=${compatibilityMode}`);
app.on("child-process-gone", (_event, details) => log(`child process ${details.type}: ${details.reason} (${details.exitCode})`));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    log("app ready");
    const { createServer } = await import(pathToFileURL(path.join(__dirname, "../server/index.mjs")).href);
    const demo = process.argv.includes("--demo");
    const portAt = process.argv.indexOf("--port");
    const options = { port: portAt >= 0 ? Number(process.argv[portAt + 1]) : 4780, lan: process.argv.includes("--lan"), demo, dataDir: path.join(app.getPath("userData"), demo ? "demo" : "workspace") };
    try {
      service = await createServer(options);
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
      service = await createServer({ ...options, port: 0 });
    }
    log("coordinator listening");
    const publicRoot = path.resolve(__dirname, "../public");
    const index = "automata://app/index.html";
    const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
    protocol.handle("automata", request => {
      try {
        const url = new URL(request.url);
        const file = path.resolve(publicRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
        if (url.hostname !== "app" || !file.startsWith(publicRoot + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return new Response("Archivo no encontrado", { status: 404 });
        return new Response(fs.readFileSync(file), { headers: { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
      } catch (e) { log("asset error: " + e.message); return new Response("No se pudo cargar la interfaz", { status: 500 }); }
    });
    const validateSender = (event) => {
      if (!win || event.sender !== win.webContents || event.senderFrame?.url !== index) throw new Error("Origen de IPC no permitido.");
    };
    ipcMain.handle("automata:connection", (event) => {
      validateSender(event);
      return { origin: service.origin, token: service.token, compatibilityMode };
    });
    ipcMain.handle("automata:request", async (event, route, options2 = {}) => {
      validateSender(event);
      if (typeof route !== "string" || !["state", "capabilities", "pairing", "auth", "projects", "settings", "start", "control", "chat", "git", "memory", "plan", "ideas"].includes(route)) throw new Error("Ruta no permitida.");
      const method = options2.method ?? "GET";
      if (!["GET", "POST", "PUT"].includes(method)) throw new Error("Método no permitido.");
      const response = await fetch(service.origin + "/api/" + route, { method, headers: { Authorization: "Bearer " + service.token, "Content-Type": "application/json" }, body: options2.body ? JSON.stringify(options2.body) : void 0 });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      return data;
    });
    ipcMain.handle("automata:choose-directory", async (event) => {
      validateSender(event);
      const result = await dialog.showOpenDialog(win, { title: "Selecciona la carpeta del proyecto", properties: ["openDirectory"] });
      return result.canceled ? null : result.filePaths[0];
    });
    win = new BrowserWindow({ width: 1540, height: 1040, minWidth: 760, minHeight: 740, show: !process.env.AUTOMATA_SMOKE || process.env.AUTOMATA_SHOW === "1", title: "Automata", backgroundColor: "#f4f3ef", autoHideMenuBar: true, icon: path.join(__dirname, "../public/icon.png"), webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: !compatibilityMode, backgroundThrottling: false } });
    log("window created");
    win.webContents.on("dom-ready", () => log("DOM ready"));
    win.webContents.on("did-fail-load", (_event, code, description) => log(`load failed ${code}: ${description}`));
    win.webContents.on("preload-error", (_event, _file, error) => log("preload error: " + error.message));
    win.webContents.on("render-process-gone", (_event, details) => {
      log(`renderer exited: ${details.reason} (${details.exitCode})`);
      if (details.reason === "launch-failed" && details.exitCode === 49 && !compatibilityMode && !process.argv.includes("--strict-renderer")) {
        if (!relaunching && !process.env.AUTOMATA_SMOKE) {
          relaunching = true;
          fs.writeFileSync(runtimeConfigPath, JSON.stringify({ compatibilityMode: true, reason: "Windows refused restricted renderer token (49)" }));
          log("relaunching with Windows compatibility renderer; context isolation and Node restrictions stay enabled");
          app.relaunch({ args: [...process.argv.slice(1), "--compatibility"] });
          app.quit();
        }
        return;
      }
      if (!quitting && !process.env.AUTOMATA_SMOKE) dialog.showErrorBox("Automata no pudo iniciar la interfaz", `El proceso de la interfaz terminó (${details.reason}, ${details.exitCode}).\nRegistro: ${path.join(app.getPath("userData"), "boot.log")}`);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      // https anywhere, or the local address of an app the user chose to run.
      if (/^https:\/\//.test(url) || /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (url !== index) e.preventDefault();
    });
    // "Open with Windows" is the user's own setting: applied only when they turn it on, in the packaged
    // app (a dev run would register electron.exe), and removed as soon as they turn it off.
    let loginItem = null;
    const applyLoginItem = (enabled) => {
      if (!app.isPackaged || process.platform !== "win32" || enabled === loginItem) return;
      loginItem = enabled;
      try {
        app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: [] });
        log(`login item ${enabled ? "registered" : "removed"}`);
      } catch (e) { log("login item: " + e.message); }
    };
    applyLoginItem(service.coordinator.settings.autoStart === true);
    service.coordinator.on("state", (data) => {
      applyLoginItem(data.settings?.autoStart === true);
      if (!win.isDestroyed()) win.webContents.send("automata:state", data);
    });
    service.coordinator.on("event", (data) => {
      if (!win.isDestroyed()) win.webContents.send("automata:activity", data);
    });
    await win.loadURL(index);
    log("interface loaded");
    if (process.argv.includes("--devtools")) win.webContents.openDevTools({ mode: "detach" });
  }).catch((e) => {
    log(e.stack ?? e.message);
    if (relaunching) return;
    if (!process.env.AUTOMATA_SMOKE) dialog.showErrorBox("Automata", e.message);
    else console.error(e);
    app.quit();
  });
  app.on("before-quit", (e) => {
    if (service && !quitting) {
      e.preventDefault();
      quitting = true;
      const shutdown = service.close().catch(error => log("shutdown: " + error.message));
      const timer = setTimeout(() => app.exit(0), 5000);
      timer.unref();
      void shutdown.finally(() => { clearTimeout(timer); app.quit(); });
    }
  });
  app.on("window-all-closed", () => app.quit());
}
