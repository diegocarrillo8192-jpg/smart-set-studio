const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("smartSet", {
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder", "import"),
  selectFolderForExport: () => ipcRenderer.invoke("dialog:selectFolder", "export"),
  isDesktop: true,
});
