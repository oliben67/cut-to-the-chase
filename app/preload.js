"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cttc", {
  pickFiles: () => ipcRenderer.invoke("pick-files"),
  saveFile: (defaultName) => ipcRenderer.invoke("save-file", defaultName),
});
