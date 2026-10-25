const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, callback) => {
  const handler = (_event, data) => callback(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};
contextBridge.exposeInMainWorld("automata", { connection: () => ipcRenderer.invoke("automata:connection"), chooseDirectory: () => ipcRenderer.invoke("automata:choose-directory"), request: (route, options) => ipcRenderer.invoke("automata:request", route, options), onState: (callback) => subscribe("automata:state", callback), onActivity: (callback) => subscribe("automata:activity", callback) });
