"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cttc", {
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  saveBinary: (defaultName, bytes) => ipcRenderer.invoke("save-binary", defaultName, bytes),
  readFile: (filePath) => ipcRenderer.invoke("read-file", filePath),
  saveJson: (defaultName, jsonText) => ipcRenderer.invoke("save-json", defaultName, jsonText),
  saveText: (defaultName, text) => ipcRenderer.invoke("save-text", defaultName, text),
  popout: (kind, id, view) => ipcRenderer.invoke("popout", kind, id, view),
  openHelp: (topic) => ipcRenderer.invoke("open-help", topic),
  onPopoutClosed: (cb) => ipcRenderer.on("popout-closed", (_e, msg) => cb(msg)),
  broadcastSync: (msg) => ipcRenderer.send("sync-broadcast", msg),
  onSync: (cb) => ipcRenderer.on("sync-broadcast", (_e, msg) => cb(msg)),
});
