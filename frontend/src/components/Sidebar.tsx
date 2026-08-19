import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import {
  ChevronDown,
  Disc3,
  FolderPlus,
  FolderSearch,
  Library,
  ListMusic,
  MoreVertical,
  Music2,
  Pencil,
  RefreshCw,
  Settings,
  Trash2,
} from "lucide-react";
import type { DJSet, Folder, ScanJob } from "../types";
import { api, isWeb, pickMusicFolder, webRegisterFolder } from "../api";

interface Props {
  folders: Folder[];
  sets: DJSet[];
  activeSetId: number | null;
  selectedFolderId: number | null;
  onFoldersChanged: () => void;
  /** Escritorio: avisa a App cuando una carpeta entra/sale de escaneo para que
   *  la tabla recargue progresivamente (UX "Analizando…"). */
  onScanActive: (id: number | null) => void;
  onSelectFolder: (id: number | null) => void;
  onSelectSet: (set: DJSet) => void;
  onDeleteSet: (set: DJSet) => void;
  onRemoveFolder: (id: number) => void;
  onOpenSettings: () => void;
}

/** Selector de ARCHIVOS de audio sueltos (no carpeta): <input multiple>.
 *  Los tracks se registran en la carpeta virtual "Archivos locales". */
function useAudioFilesPicker(): {
  pickAudioFiles: () => Promise<string | null>;
  audioInput: ReactElement;
} {
  const inputRef = useRef<HTMLInputElement>(null);

  const pickAudioFiles = (): Promise<string | null> =>
    new Promise((resolve) => {
      const input = inputRef.current;
      if (!input) return resolve(null);
      input.value = "";
      input.onchange = () => {
        const files = input.files ? Array.from(input.files) : [];
        input.value = "";
        if (files.length === 0) return resolve(null);
        void webRegisterFolder(files, { rootName: "Archivos locales" }).then((root) => resolve(root));
      };
      input.click();
    });

  const audioInput = (
    <input
      id="web-audio-files-input"
      ref={inputRef}
      type="file"
      className="hidden"
      multiple
      accept=".mp3,.wav,.m4a,.aiff,.aif,.flac,.m4a,.aac,.ogg,.opus,audio/*"
    />
  );

  return { pickAudioFiles, audioInput };
}

function useFolderPicker(): {
  pickFolder: () => Promise<string | null>;
  hiddenInput: ReactElement;
} {
  const inputRef = useRef<HTMLInputElement>(null);

  const pickFolder = async (): Promise<string | null> => {
    // Escritorio (Electron): diálogo nativo de carpeta vía preload.
    if (window.smartSet?.selectFolder) {
      return window.smartSet.selectFolder();
    }
    // Navegador: File System Access API (Chrome/Edge) si está disponible;
    // registra la carpeta COMPLETA con análisis de etiquetas en cliente.
    if (typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function") {
      return pickMusicFolder(); // null = cancelado o sin archivos: no reabrir
    }
    // Fallback: <input webkitdirectory> (Firefox/Safari/iOS/Android).
    // Se limpia su valor en cada intento para que el diálogo pueda reabrirse
    // tantas veces como sea necesario (si no, re-seleccionar la misma carpeta
    // no dispara onChange).
    return new Promise((resolve) => {
      const input = inputRef.current;
      if (!input) return resolve(null);
      input.value = "";
      input.onchange = () => {
        const files = input.files ? Array.from(input.files) : [];
        input.value = "";
        if (files.length === 0) return resolve(null);
        // Registra todos los archivos de audio (nombre/ruta/Blob URL/formato)
        // en el almacén del navegador: listTracks los devuelve al instante.
        void webRegisterFolder(files).then((root) => resolve(root));
      };
      input.click();
    });
  };

  const hiddenInput = (
    <input
      id="web-folder-input"
      ref={inputRef}
      type="file"
      className="hidden"
      accept=".mp3,.wav,.aiff,.aif,.flac,.m4a,.aac,.ogg,.opus,audio/*"
      onClick={(e) => {
        // Limpieza previa a CADA apertura del diálogo (fiable en repetición).
        e.currentTarget.value = "";
      }}
      {...({ webkitdirectory: "", directory: "", multiple: true } as Record<string, unknown>)}
    />
  );

  return { pickFolder, hiddenInput };
}

type MenuTarget = { kind: "folder" | "set"; id: number; x: number; y: number } | null;

type RenameTarget = { kind: "folder" | "set"; id: number } | null;

type DeleteTarget = { kind: "folder" | "set"; id: number; name: string } | null;

export default function Sidebar({
  folders,
  sets,
  activeSetId,
  selectedFolderId,
  onFoldersChanged,
  onScanActive,
  onSelectFolder,
  onSelectSet,
  onDeleteSet,
  onRemoveFolder,
  onOpenSettings,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [scanningIds, setScanningIds] = useState<Set<number>>(new Set());
  const [progress, setProgress] = useState<Record<number, ScanJob>>({});
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<MenuTarget>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);
  const { pickFolder, hiddenInput } = useFolderPicker();
  const { pickAudioFiles, audioInput } = useAudioFilesPicker();
  const pollRef = useRef<Record<number, number>>({});
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [setsOpen, setSetsOpen] = useState(false);

  useEffect(() => {
    return () => {
      Object.values(pollRef.current).forEach(clearInterval);
    };
  }, []);

  // Cierra el menú contextual al hacer clic fuera
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menu]);

  const totalTracks = folders.reduce((acc, f) => acc + f.track_count, 0);

  const addFolder = async () => {
    setAdding(true);
    setError("");
    try {
      const path = await pickFolder();
      if (path) {
        if (window.smartSet?.selectFolder) {
          // Escritorio: `addFolder` registra TODOS los archivos de la carpeta
          // de golpe (analyzed=false, SIN procesar audio) — la tabla los
          // renderiza al instante con "Analizando…". El escaneo arranca SOLO
          // y el backend va hidratando cada fila con datos reales (BPM/Key)
          // desde su hilo silencioso, sin bloquear la interfaz.
          const folder = await api.addFolder(path);
          void scanFolder(folder);
        }
        // Web: la carpeta ya quedó registrada en el almacén del navegador
        // (dentro de pickFolder); refrescar hace que aparezca al instante.
        onFoldersChanged();
      }
    } catch (e) {
      // Si el backend respondió 409 ("La carpeta ya está importada"), forzar
      // refresco inmediato de carpetas + lista de canciones para que la UI se
      // actualice sin necesidad de volver a hacer clic.
      const err = e as Error & { status?: number };
      if (err.status === 409) {
        setError(err.message);
        onFoldersChanged();
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setAdding(false);
    }
  };

  /** Web: carga archivos de audio sueltos (sin seleccionar una carpeta). */
  const addAudioFiles = async () => {
    setAdding(true);
    setError("");
    try {
      const root = await pickAudioFiles();
      if (root) {
        // El análisis de etiquetas ya corrió en el navegador (webRegisterFolder);
        // refrescar hace que carpetas y tracks aparezcan al instante.
        onFoldersChanged();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const scanFolder = async (folder: Folder, force = false) => {
    setError("");
    await api.scanFolder(folder.id, force);
    setScanningIds((prev) => new Set(prev).add(folder.id));
    // Progresivo: mientras escanea, App recarga la tabla por su cuenta para
    // mostrar las filas recién insertadas con "Analizando…" (igual que web).
    onScanActive(folder.id);
    pollRef.current[folder.id] = window.setInterval(async () => {
      try {
        const status = await api.scanStatus(folder.id);
        if (status) {
          setProgress((prev) => ({ ...prev, [folder.id]: status }));
          if (status.status === "done" || status.status === "error") {
            clearInterval(pollRef.current[folder.id]);
            setScanningIds((prev) => {
              const next = new Set(prev);
              next.delete(folder.id);
              return next;
            });
            onScanActive(null);
            onFoldersChanged();
          }
        }
      } catch {
        clearInterval(pollRef.current[folder.id]);
        onScanActive(null);
      }
    }, 1500);
  };

  /** Abre el renombrado EN LÍNEA: input enfocado con el nombre actual
   *  seleccionado; Enter guarda (backend o almacén web) y Escape/blur cancela. */
  const openRename = (kind: "folder" | "set", id: number, currentName: string) => {
    setRenameTarget({ kind, id });
    setRenameValue(currentName);
    window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  };

  const saveRename = async () => {
    const target = renameTarget;
    if (!target) return;
    const name = renameValue.trim();
    setRenameTarget(null);
    if (!name) return;
    try {
      if (target.kind === "folder") await api.renameFolder(target.id, name);
      else await api.renameSet(target.id, name);
      // Refresco global (App.refresh): carpetas + sets quedan actualizados en
      // estado y persistencia (backend o localStorage web) al instante.
      await onFoldersChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancelRename = () => setRenameTarget(null);

  /** Abre el diálogo sutil de confirmación (sin window.confirm). */
  const requestDelete = (kind: "folder" | "set", id: number, name: string) => {
    setDeleteTarget({ kind, id, name });
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleteTarget(null);
    try {
      if (target.kind === "folder") await onRemoveFolder(target.id);
      else {
        const set = sets.find((s) => s.id === target.id);
        if (set) await onDeleteSet(set);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const cancelDelete = () => setDeleteTarget(null);

  const isScanning = (id: number) => scanningIds.has(id);
  const jobFor = (id: number) => progress[id];

  const folderRowActive = (id: number) => selectedFolderId === id;

  /** Abre el menú de opciones junto al botón que lo dispara (posición fija). */
  const openMenu = (kind: "folder" | "set", id: number, e: ReactMouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    setMenu((m) => (m?.kind === kind && m.id === id ? null : { kind, id, x: r.right - 176, y: r.bottom + 4 }));
  };

  return (
    <aside className="flex w-full shrink-0 flex-col overflow-y-auto border-r border-slate-800 bg-panel md:w-64 md:overflow-y-auto">
      {hiddenInput}
      {audioInput}
      <div className="flex items-center gap-2 border-b border-slate-800 px-4 py-3">
        <Disc3 size={18} className="text-violet-400" />
        <div className="min-w-0">
          <h1 className="text-sm font-black tracking-tight text-white">Smart Set Studio</h1>
          <p className="text-[10px] leading-tight text-slate-500">AI Set Architect &amp; DJ Library</p>
          {isWeb() && (
            <span
              className="mt-1.5 block w-full rounded-md border border-cyan-700/60 bg-cyan-500/10 px-2 py-1 text-center text-[9px] font-bold uppercase tracking-widest text-cyan-300"
              title="Demo web: sesión volátil en memoria del navegador, sin base de datos ni motor local"
            >
              Demo web · volátil
            </span>
          )}
        </div>
      </div>

      {/* Mi Biblioteca */}
      <section className="px-3 py-3">
        <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
          <Library size={12} /> Mi Biblioteca
          <button
            onClick={() => setLibraryOpen((o) => !o)}
            className="rounded-full p-1 text-xs font-semibold text-slate-400 transition hover:text-violet-300"
            title={libraryOpen ? "Colapsar sección" : "Expandir sección"}
          >
            <ChevronDown size={12} className="shrink-0" />
          </button>
        </h2>
        <button
          onClick={addFolder}
          disabled={adding}
          className="mb-2 flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-panel-2 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-violet-500 hover:text-violet-300 disabled:opacity-50"
        >
          <FolderPlus size={14} /> Agregar Carpeta
        </button>
        {isWeb() && (
          <button
            onClick={() => void addAudioFiles()}
            disabled={adding}
            className="mb-2 flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-panel-2 px-2.5 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-cyan-500 hover:text-cyan-300 disabled:opacity-50"
            title="Selecciona archivos de audio sueltos (MP3/WAV/M4A…)"
          >
            <Music2 size={14} /> Cargar Audio
          </button>
        )}

        <div className="space-y-1.5">
          {/* Vista global: colección completa */}
          <button
            onClick={() => onSelectFolder(null)}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition ${
              selectedFolderId === null
                ? "bg-violet-500/20 ring-1 ring-violet-500/40"
                : "bg-panel-2 hover:bg-panel-3"
            }`}
            title="Ver todos los tracks de la biblioteca"
          >
            <Library size={13} className="shrink-0 text-violet-400" />
            <span className={`min-w-0 flex-1 truncate text-xs font-semibold ${selectedFolderId === null ? "text-white" : "text-slate-200"}`}>
              Todos los tracks
            </span>
            <span className="rounded bg-panel-3 px-1.5 py-0.5 text-[9px] text-slate-400">{totalTracks}</span>
          </button>

          {folders.length === 0 && (
            <div className="rounded-lg border border-dashed border-slate-700 p-3 text-center">
              <p className="text-[11px] leading-relaxed text-slate-400">
                No hay carpetas agregadas.
                <br />
                Haz clic en <b className="text-violet-400">"Agregar Carpeta"</b> para comenzar.
              </p>
            </div>
          )}
          {libraryOpen && folders.map((folder) => {
            const scanning = isScanning(folder.id);
            const job = jobFor(folder.id);
            const active = folderRowActive(folder.id);
            return (
              <div key={folder.id} className="space-y-1">
                <div
                  onClick={() => onSelectFolder(folder.id)}
                  className={`group flex h-11 w-full cursor-pointer flex-row items-center justify-between gap-2 rounded-lg p-2.5 transition ${
                    active ? "bg-violet-500/20 ring-1 ring-violet-500/40" : "bg-panel-2 hover:bg-panel-3"
                  }`}
                  title="Clic para filtrar la biblioteca por esta carpeta"
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
                    <FolderSearch size={13} className={`shrink-0 ${active ? "text-violet-300" : "text-slate-400"}`} />
                    <div className="min-w-0 flex-1">
                      {renameTarget?.kind === "folder" && renameTarget.id === folder.id ? (
                        <input
                          ref={renameInputRef}
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === "Enter") void saveRename();
                            else if (e.key === "Escape") cancelRename();
                          }}
                          onBlur={() => setRenameTarget(null)}
                          className="w-full rounded border border-violet-500/60 bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white outline-none"
                          placeholder="Nombre de la carpeta"
                        />
                      ) : (
                        <p className={`truncate text-xs font-medium ${active ? "text-white" : "text-slate-200"}`}>{folder.name}</p>
                      )}
                      <p className="text-[10px] text-slate-500">
                        {scanning && job
                          ? `${job.processed_files}/${job.total_files} analizando...`
                          : `${folder.track_count} tracks`}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        void scanFolder(folder);
                      }}
                      title="Escanear / Re-analizar"
                      className="rounded p-1 text-slate-500 opacity-0 transition hover:text-cyan-300 group-hover:opacity-100"
                    >
                      <RefreshCw size={13} className={scanning ? "animate-spin" : ""} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openMenu("folder", folder.id, e);
                      }}
                      title="Opciones"
                      className={`rounded p-1 transition ${menu && menu.kind === "folder" && menu.id === folder.id ? "text-violet-300 opacity-100" : "text-slate-500 opacity-0 group-hover:opacity-100 hover:text-violet-300"}`}
                    >
                      <MoreVertical size={13} />
                    </button>
                  </div>
                </div>
                {job && job.status === "error" && (
                  <p className="text-[10px] text-red-400">{job.message}</p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Playlists & Sets */}
      <section className="border-t border-slate-800 px-3 py-3">
<h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
          <ListMusic size={12} /> Playlists & Sets
          <button
            onClick={() => setSetsOpen((o) => !o)}
            className="rounded-full p-1 text-xs font-semibold text-slate-400 transition hover:text-violet-300"
            title={setsOpen ? "Colapsar sección" : "Expandir sección"}
          >
            <ChevronDown size={12} className="shrink-0" />
          </button>
        </h2>
        <div className="space-y-1">
          {sets.length === 0 && (
            <div className="animate-fade-in rounded-xl border border-slate-800/80 bg-white/[0.02] px-3 py-4">
              <div className="flex flex-col items-center gap-2 text-center">
                <span className="grid h-9 w-9 place-items-center rounded-full border border-slate-700/60 bg-panel-2/60">
                  <ListMusic size={15} className="text-slate-500" />
                </span>
                <p className="text-[11px] font-semibold text-slate-400">No hay playlists creadas</p>
                <p className="text-[10px] leading-relaxed text-slate-500">
                  Usa <b className="font-semibold text-cyan-300/80">Smart Set Generator</b> para crear tu primer set
                </p>
              </div>
            </div>
          )}
          {setsOpen && sets.map((set) => (
            <div
              key={set.id}
              onClick={() => onSelectSet(set)}
              className={`group relative cursor-pointer rounded-lg px-2.5 py-1.5 transition ${
                activeSetId === set.id ? "bg-violet-500/20 ring-1 ring-violet-500/40" : "bg-panel-2 hover:bg-panel-3"
              }`}
            >
              <div className="flex items-center gap-1">
                {renameTarget?.kind === "set" && renameTarget.id === set.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") void saveRename();
                      else if (e.key === "Escape") cancelRename();
                    }}
                    onBlur={() => setRenameTarget(null)}
                    className="w-full rounded border border-violet-500/60 bg-slate-900 px-1.5 py-0.5 text-xs font-medium text-white outline-none"
                    placeholder="Nombre del set"
                  />
                ) : (
                  <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-200">{set.name}</p>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    openMenu("set", set.id, e);
                  }}
                  title="Opciones del set"
                  className={`rounded p-1 transition ${menu && menu.kind === "set" && menu.id === set.id ? "text-violet-300 opacity-100" : "text-slate-500 opacity-0 group-hover:opacity-100 hover:text-violet-300"}`}
                >
                  <MoreVertical size={13} />
                </button>
              </div>
              <p className="text-[10px] text-slate-500">
                {set.items.length} tracks · {Math.round(set.total_sec / 60)} min
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Ajustes */}
      <section className="mt-auto border-t border-slate-800 px-3 py-3">
{/* Ajustes del Motor: misma UI que escritorio; en la demo web el motor
        Python no existe y el clic muestra un aviso en lugar del modal. */}
      <button
        onClick={() => {
          if (isWeb()) {
            window.alert("Función solo disponible en la versión de Escritorio");
            return;
          }
          onOpenSettings();
        }}
        className="mb-1.5 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold text-slate-300 transition hover:bg-panel-2 hover:text-white"
      >
        <Settings size={14} /> Ajustes del Motor
      </button>
        {error && (
          <p className="mt-2 flex items-center gap-1 rounded bg-red-500/10 px-2 py-1 text-[10px] text-red-400">
            <Trash2 size={10} /> {error}
          </p>
        )}
      </section>

      {/* Menú contextual (renombrar / eliminar) */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 w-44 overflow-hidden rounded-lg border border-slate-700 bg-[#141a2b] py-1 shadow-2xl shadow-black/60"
          style={{ left: menu.x, top: menu.y }}
        >
          <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
            {menu.kind === "folder" ? "Carpeta" : "Set"}
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const target =
                menu.kind === "folder"
                  ? folders.find((f) => f.id === menu.id)
                  : sets.find((s) => s.id === menu.id);
              const kind = menu.kind;
              const id = menu.id;
              setMenu(null); // cierra el menú al elegir acción
              if (target) openRename(kind, id, target.name);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-slate-200 transition hover:bg-violet-500/15 hover:text-violet-200"
          >
            <Pencil size={12} /> Renombrar
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const target =
                menu.kind === "folder"
                  ? folders.find((f) => f.id === menu.id)
                  : sets.find((s) => s.id === menu.id);
              const kind = menu.kind;
              const id = menu.id;
              setMenu(null); // cierra el menú al elegir acción
              if (target) requestDelete(kind, id, target.name);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-400 transition hover:bg-red-500/15"
          >
            <Trash2 size={12} /> Eliminar
          </button>
        </div>
      )}

      {/* Diálogo sutil de confirmación de eliminación */}
      {deleteTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onMouseDown={cancelDelete}
        >
          <div
            className="w-80 rounded-xl border border-slate-700 bg-[#141a2b] p-4 shadow-2xl shadow-black/70"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-bold text-slate-100">
              {deleteTarget.kind === "folder" ? "Quitar carpeta" : "Eliminar set"}
            </h3>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
              {deleteTarget.kind === "folder"
                ? `¿Quitar la carpeta "${deleteTarget.name}" y sus tracks de la biblioteca?`
                : `¿Eliminar el set "${deleteTarget.name}"? Esta acción no se puede deshacer.`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  cancelDelete();
                }}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-panel-2"
              >
                Cancelar
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  void confirmDelete();
                }}
                className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500"
              >
                <Trash2 size={12} /> Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}