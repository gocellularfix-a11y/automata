const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
let service, win, quitting = false;
app.setName("Automata");
app.disableHardwareAcceleration();
if (process.env.AUTOMATA_USER_DATA) {
  fs.mkdirSync(process.env.AUTOMATA_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.AUTOMATA_USER_DATA);
}
const log = (message) => {
  if (process.env.AUTOMATA_SMOKE) fs.appendFileSync(path.join(app.getPath("userData"), "boot.log"), (/* @__PURE__ */ new Date()).toISOString() + " " + message + "\n");
};
log("main loaded");
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
    const index = pathToFileURL(path.join(__dirname, "../public/index.html")).href;
    const validateSender = (event) => {
      if (!win || event.sender !== win.webContents || event.senderFrame?.url !== index) throw new Error("Origen de IPC no permitido.");
    };
    ipcMain.handle("automata:connection", (event) => {
      validateSender(event);
      return { origin: service.origin, token: service.token };
    });
    ipcMain.handle("automata:request", async (event, route, options2 = {}) => {
      validateSender(event);
      if (typeof route !== "string" || !["state", "capabilities", "pairing", "projects", "settings", "start", "control", "chat"].includes(route)) throw new Error("Ruta no permitida.");
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
    win = new BrowserWindow({ width: 1540, height: 1040, minWidth: 760, minHeight: 740, show: !process.env.AUTOMATA_SMOKE, title: "Automata", backgroundColor: "#f4f3ef", autoHideMenuBar: true, icon: path.join(__dirname, "../public/icon.png"), webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    log("window created");
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https:\/\//.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (e, url) => {
      if (url !== index) e.preventDefault();
    });
    service.coordinator.on("state", (data) => {
      if (!win.isDestroyed()) win.webContents.send("automata:state", data);
    });
    service.coordinator.on("event", (data) => {
      if (!win.isDestroyed()) win.webContents.send("automata:activity", data);
    });
    await win.loadFile(path.join(__dirname, "../public/index.html"));
    log("interface loaded");
    if (process.argv.includes("--devtools")) win.webContents.openDevTools({ mode: "detach" });
  }).catch((e) => {
    log(e.stack ?? e.message);
    if (!process.env.AUTOMATA_SMOKE) dialog.showErrorBox("Automata", e.message);
    else console.error(e);
    app.quit();
  });
  app.on("before-quit", (e) => {
    if (service && !quitting) {
      e.preventDefault();
      quitting = true;
      void service.close().then(() => app.quit());
    }
  });
  app.on("window-all-closed", () => app.quit());
}
