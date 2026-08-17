const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");

const BACKEND_PORT = 8765;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const DEV_URL = "http://localhost:5173";
const isDev = !app.isPackaged;

let backendProc = null;
let mainWindow = null;

/** Volcado de stdout/stderr del backend a un archivo local (diagnóstico). */
function logBackendOutput(chunk) {
  try {
    const logPath = path.join(app.getPath("userData"), "backend-error.log");
    fs.appendFileSync(logPath, chunk);
  } catch (err) {
    console.error("[smart-set] No se pudo escribir el log del backend:", err);
  }
}

// Instancia única: si ya hay otra ventana abierta, enfocarla y salir.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    // APERTURA INSTANTÁNEA: la ventana (con su Splash animado) se crea y se
    // muestra de inmediato. El backend de Python (ssa-backend.exe) se inicia
    // después, en paralelo y totalmente asíncrono: la UI arranca con su
    // splash mientras inicializa, sin bloquear el doble clic.
    createWindow();
    void startBackend().catch((err) =>
      console.error("[smart-set] Error iniciando el backend:", err)
    );
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
}

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

  // Cola de intentos: primero los binarios preferidos, luego fallbacks con
  // python/python3. Cada intento espera su propio healthcheck; si ninguno
  // responde se muestra un diálogo con la ruta del log de diagnóstico.
  const attempts = [];

  if (app.isPackaged) {
    // Runtime embebido (PyInstaller onedir copiado por extraResources).
    // La ruta real puede variar entre builds: probamos candidatos dentro de
    // process.resourcesPath (backend/ → bin/ → raíz de resources).
    const resources = process.resourcesPath;
    for (const sub of ["backend", "bin", ""]) {
      const dir = sub ? path.join(resources, sub) : resources;
      const exe = path.join(dir, "ssa-backend.exe");
      if (fs.existsSync(exe)) {
        attempts.push({
          kind: `ssa-backend.exe (resources${sub ? `/${sub}` : ""})`,
          cmd: exe,
          args: [],
          cwd: dir,
          timeout: 30000,
        });
      }
    }
  } else {
    const root = path.join(__dirname, "..");
    const venvPython = path.join(root, ".venv", "Scripts", "python.exe");
    attempts.push({
      kind: "venv python + uvicorn",
      cmd: fs.existsSync(venvPython) ? venvPython : "python",
      args: ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
      cwd: path.join(root, "backend"),
      timeout: 30000,
    });
  }

  // Fallback: python / python3 corriendo run_server.py directamente (dev) o
  // uvicorn con un Python del sistema (packaged: solo si existe en PATH).
  const root = path.join(__dirname, "..");
  const runServerPy = path.join(root, "backend", "run_server.py");
  if (fs.existsSync(runServerPy)) {
    for (const py of ["python", "python3"]) {
      attempts.push({
        kind: `fallback ${py} run_server.py`,
        cmd: py,
        args: [runServerPy],
        cwd: path.dirname(runServerPy),
        timeout: 20000,
      });
    }
  }

  fs.writeFileSync(path.join(app.getPath("userData"), "backend-error.log"), ""); // limpiar log previo

  let started = false;
  for (const attempt of attempts) {
    // Pequeño retardo de arranque: deja que la ventana y el splash pinten antes
    // de lanzar el proceso pesado (PyInstaller + numpy/librosa tardan en cargar).
    await new Promise((r) => setTimeout(r, 600));
    console.log(`[smart-set] Iniciando backend: ${attempt.kind}`);
    logBackendOutput(`\n=== intento: ${attempt.kind} (${attempt.cmd} ${attempt.args.join(" ")}) ===\n`);
    backendProc = spawn(attempt.cmd, attempt.args, {
      cwd: attempt.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backendProc.stdout.on("data", (d) => {
      process.stdout.write(`[backend] ${d}`);
      logBackendOutput(d);
    });
    backendProc.stderr.on("data", (d) => {
      process.stderr.write(`[backend] ${d}`);
      logBackendOutput(d);
    });
    backendProc.on("error", (err) => {
      const msg = `[smart-set] No se pudo iniciar '${attempt.kind}': ${err.message}\n`;
      console.error(msg);
      logBackendOutput(msg);
    });
    backendProc.on("exit", (code) => {
      const msg = `[smart-set] Backend terminó (${attempt.kind}, exit=${code})\n`;
      console.log(msg);
      logBackendOutput(msg);
    });

    const ok = await waitForBackend(attempt.timeout);
    if (ok) {
      started = true;
      console.log(`[smart-set] Backend listo (${attempt.kind})`);
      break;
    }
    console.log(`[smart-set] Healthcheck sin respuesta para: ${attempt.kind}`);
    if (backendProc && !backendProc.killed) {
      backendProc.kill();
      backendProc = null;
    }
  }

  if (!started) {
    const msg =
      "No se pudo iniciar el servidor Python del backend (ssa-backend.exe o python). " +
      `Revisa el log de diagnóstico en: ${path.join(app.getPath("userData"), "backend-error.log")}`;
    console.error(`[smart-set] ${msg}`);
    dialog.showErrorBox("Backend no iniciado", msg);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1200,
    minHeight: 720,
    // ARRANQUE INSTANTÁNEO: la ventana se muestra nativamente de inmediato
    // (sin esperar DOM/React ni el backend). El backgroundColor pinta al
    // instante y el splash estático embebido en index.html da feedback
    // visual en <200ms; React lo reemplaza sin corte visual.
    backgroundColor: "#0f172a",
    title: "AI Smart Set Architect",
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Sin bloqueo por ready-to-show: la ventana ya es visible desde el t0.
  // El splash interno (index.html + SplashScreen) se encarga del feedback.

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
    // Carga inmediata: si Vite aún no está listo, el splash estático ya
    // cubre la pantalla y los reintentos de did-fail-load la completan.
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
