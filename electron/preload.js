const { contextBridge, ipcRenderer } = require("electron");

// Secreto de bucle local inyectado por el proceso principal (additionalArguments)
// para autenticar las peticiones al backend 127.0.0.1:8765.
function readToken() {
  const arg = process.argv.find((a) => a.startsWith("--smart-set-token="));
  return arg ? arg.slice("--smart-set-token=".length) : null;
}

contextBridge.exposeInMainWorld("smartSet", {
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder", "import"),
  selectFolderForExport: () => ipcRenderer.invoke("dialog:selectFolder", "export"),
  selectAudioFiles: () => ipcRenderer.invoke("dialog:selectAudioFiles"),
  isDesktop: true,
  token: readToken(),
});
