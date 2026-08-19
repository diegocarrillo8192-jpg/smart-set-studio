const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn, execSync } = require("child_process");
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
    quitting = true;
    killBackend();
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    quitting = true;
    killBackend();
  });

  // Doble seguro de cierre limpio: asegura que el binario Python (ssa-backend)
  // no quede huérfano si el usuario sale con la app (will-quit es lo último).
  process.on("exit", () => {
    if (backendProc && backendProc.pid) {
      try {
        backendProc.kill();
      } catch {}
      try {
        execSync(`taskkill /PID ${backendProc.pid} /F /T`, { windowsHide: true, stdio: "ignore" });
      } catch {}
    }
  });
}

function waitForUrl(url, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        // Solo un 2xx (el /health devuelve 200 OK) cuenta como backend listo.
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[smart-set] Healthcheck OK: ${url} -> ${res.statusCode}`);
          resolve(true);
        } else retry();
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

/** Limpieza de puerto: mata agresivamente cualquier proceso que esté ocupando
 *  "port" (zombies de sesiones anteriores de ssa-backend que dejan
 *  127.0.0.1:8765 tomado y provocan la alerta roja de desconexión del motor). */
function killPortProcesses(port) {
  if (process.platform !== "win32") return;
  try {
    const netstat = execSync("netstat -ano -p tcp", { encoding: "utf8", windowsHide: true });
    const pids = new Set();
    for (const line of netstat.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+\S+\s+(\d+)$/i);
      if (m && Number(m[2]) === port) pids.add(m[3]);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { windowsHide: true, stdio: "ignore" });
        console.log(`[smart-set] Puerto ${port} liberado: proceso zombie PID ${pid} terminado`);
      } catch (err) {
        console.warn(`[smart-set] No se pudo terminar el PID ${pid} (${err.message})`);
      }
    }
  } catch (err) {
    console.warn(`[smart-set] No se pudo inspeccionar el puerto ${port}: ${err.message}`);
  }
}

/** Terminación FORZADA del backend: mata el árbol completo de procesos (no
 *  solo el hijo directo) para que ningún binario Python quede huérfano. */
function killBackend() {
  const proc = backendProc;
  backendProc = null;
  if (!proc || proc.killed || !proc.pid) return;
  try {
    proc.kill();
  } catch {}
  try {
    execSync(`taskkill /PID ${proc.pid} /F /T`, { windowsHide: true, stdio: "ignore" });
  } catch {}
  console.log(`[smart-set] Backend terminado por la fuerza (PID ${proc.pid})`);
}

// Estado del backend para saber si una salida del proceso es una caída real
// (reiniciar) o un apagado normal de la app (no reiniciar).
let backendReady = false;
let backendRestarts = 0;
const MAX_BACKEND_RESTARTS = 2;
/** true cuando la app está saliendo: el 'exit' del backend por kill() propio
 *  no debe programar un reinicio (la app ya no existe en 800ms). */
let quitting = false;

async function startBackend() {
  // Limpieza de zombies ANTES de spawnear (solo en el instalador; en dev el
  // backend lo lanza `npm run dev`): si una sesión anterior dejó un proceso
  // huérfano en 8765, el healthcheck inicial lo daría por "vivo" y el nuevo
  // spawn fallaría al bindear el puerto (alerta roja permanente).
  if (app.isPackaged) {
    killPortProcesses(BACKEND_PORT);
    // Margen para que Windows libere el socket tras el taskkill.
    await new Promise((r) => setTimeout(r, 400));
  }

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
          // Arranque en frío de PyInstaller (numpy/librosa): hasta 45s.
          timeout: 45000,
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
      // shell:false → NUNCA pasamos comandos a cmd.exe: las rutas con espacios
      // (p. ej. "Smart Set Architect") se pasan como argumentos directos,
      // correctamente citados por Node sin usar comillas en la línea.
      shell: false,
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
      // Caída real del backend mientras la app sigue abierta → reintento una
      // vez (máx. 2 veces totales): el healthcheck lo confirma antes de usar.
      // Si la app está saliendo (before-quit ya mató el proceso), no se
      // reinicia nada.
      if (backendReady && !quitting && backendRestarts < MAX_BACKEND_RESTARTS) {
        backendReady = false;
        backendRestarts += 1;
        const proc = backendProc;
        backendProc = null;
        setTimeout(() => {
          if (proc && proc.killed) return;
          console.log(`[smart-set] Reintentando backend (restart ${backendRestarts}/${MAX_BACKEND_RESTARTS})`);
          void startBackend();
        }, 800);
      }
    });

    const ok = await waitForBackend(attempt.timeout);
    if (ok) {
      started = true;
      backendReady = true; // el backend está vivo: si cae, se reintenta
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
