const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld(
  "otter",
  Object.freeze({
    pickFolder: () => ipcRenderer.invoke("otter:pick-folder"),
    pickCodex: () => ipcRenderer.invoke("otter:pick-codex"),
    backupRecords: () => ipcRenderer.invoke("otter:backup-records"),
    openEditor: (input) => ipcRenderer.invoke("otter:open-editor", input),
  }),
);
