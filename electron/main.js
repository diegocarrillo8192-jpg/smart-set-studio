const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");

const BACKEND_PORT = 8765;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const DEV_URL = "http://localhost:5173";
const isDev = !app.isPackaged;

let backendProc = null;
let mainWindow = null;

function waitForUrl(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode >= 200 && res.statusCode < 500) resolve(true);
        else retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
      function retry() {
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(check, 500);
      }
    };
    check();
  });
}

const waitForBackend = () => waitForUrl(`${BACKEND_URL}/api/health`);

async function startBackend() {
  if (await waitForBackend(1500)) {
    console.log("[smart-set] Backend ya estaba corriendo");
    return;
  }
  const fs = require("fs");
  let cmd;
  let args;
  let cwd;
  if (app.isPackaged) {
    // Runtime embebido (PyInstaller onedir dentro de extraResources)
    cmd = path.join(process.resourcesPath, "backend", "ssa-backend.exe");
    args = [];
    cwd = path.join(process.resourcesPath, "backend");
    if (!fs.existsSync(cmd)) {
      console.error(`[smart-set] Backend empaquetado no encontrado: ${cmd}`);
      return;
    }
  } else {
    const root = path.join(__dirname, "..");
    const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
    cmd = fs.existsSync(venvPython) ? venvPython : "python";
    args = ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)];
    cwd = path.join(root, "backend");
  }
  backendProc = spawn(cmd, args, {
    cwd,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendProc.stdout.on("data", (d) => process.stdout.write(`[backend] ${d}`));
  backendProc.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  backendProc.on("exit", (code) => console.log(`[smart-set] Backend terminó (${code})`));
  const ok = await waitForBackend();
  console.log(ok ? "[smart-set] Backend listo" : "[smart-set] No se pudo iniciar el backend");
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1200,
    minHeight: 720,
    backgroundColor: "#0a0c12",
    title: "AI Smart Set Architect",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Diagnóstico: volcar la consola del renderer al stdout del proceso
  mainWindow.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  // DevTools abiertas por defecto en modo desarrollo
  if (isDev) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    });
  }

  // Reintenta cargar si el servidor aún no estaba listo (dev: Vite se reinicia a menudo)
  let loadAttempts = 0;
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (loadAttempts >= 20) return;
    loadAttempts += 1;
    console.log(`[smart-set] Carga falló (${code} ${desc}) — reintento ${loadAttempts}/20 en 1s`);
    setTimeout(() => mainWindow.loadURL(url), 1000);
  });

  loadApp();
}

async function loadApp() {
  if (isDev) {
    const ok = await waitForUrl(DEV_URL, 45000);
    console.log(ok ? "[smart-set] Vite listo, cargando UI" : "[smart-set] Vite no respondió, intentando cargar igualmente");
    mainWindow.loadURL(DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "frontend", "dist", "index.html"));
  }
}

ipcMain.handle("dialog:selectFolder", async (_event, purpose) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: purpose === "export" ? "Selecciona la carpeta de destino (USB)" : "Selecciona una carpeta de música",
    properties: ["openDirectory", "createDirectory"],
    // Filtros informativos: formatos de audio soportados (MP3, WAV, AIFF,
    // FLAC, M4A/AAC, OGG y OPUS). Los diálogos de carpeta de Windows no
    // filtran por extensión, pero documentan la compatibilidad del catálogo.
    filters: [
      {
        name: "Audio (MP3 · WAV · AIFF · FLAC · M4A/AAC · OGG · OPUS)",
        extensions: ["mp3", "wav", "aiff", "aif", "flac", "m4a", "aac", "ogg", "opus"],
      },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(async () => {
  await startBackend();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (backendProc) {
    backendProc.kill();
    backendProc = null;
  }
});
