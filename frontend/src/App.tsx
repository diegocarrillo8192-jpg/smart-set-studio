import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Library, Wand2 } from "lucide-react";
import type { DJSet, Folder, Track } from "./types";
import { api, subscribeWebTracks } from "./api";
import SplashScreen from "./components/SplashScreen";
import Sidebar from "./components/Sidebar";
import LibraryTable from "./components/LibraryTable";
import SetGenerator from "./components/SetGenerator";
import DualDeck from "./components/DualDeck";
import RecommendationsPanel from "./components/RecommendationsPanel";
import SettingsModal from "./components/SettingsModal";
import PortraitLock from "./components/PortraitLock";

type Tab = "library" | "generator";

export default function App() {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [sets, setSets] = useState<DJSet[]>([]);
  const [tab, setTab] = useState<Tab>("library");
  const [deckATrack, setDeckATrack] = useState<Track | null>(null);
  const [deckBTrack, setDeckBTrack] = useState<Track | null>(null);
  const [compatibleWith, setCompatibleWith] = useState<Track | null>(null);
  const [activeSetId, setActiveSetId] = useState<number | null>(null);
  const [generatedSet, setGeneratedSet] = useState<DJSet | null>(null);
  const [seedTrack, setSeedTrack] = useState<Track | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeDeck, setActiveDeck] = useState<"A" | "B">("A");
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [deckAPlaying, setDeckAPlaying] = useState(false);
  const [deckBPlaying, setDeckBPlaying] = useState(false);
  const [libraryVersion, setLibraryVersion] = useState(0);
  const [backendDown, setBackendDown] = useState(false);
  /** Escritorio: ID de la carpeta cuyo escaneo está en curso (null = ninguno).
   *  Mientras no sea null, la tabla recarga progresivamente (UX "Analizando…"). */
  const [analyzingFolderId, setAnalyzingFolderId] = useState<number | null>(null);
  const bootRef = useRef(false);
  /** True una vez que el backend respondió al menos una vez: permite que el
   *  sondeo de salud recargue la biblioteca en el reconectar sin duplicar la
   *  carga inicial del arranque. */
  const connectedRef = useRef(false);

  // Splash de marca: presentación del logo durante EXACTAMENTE 2s completos,
  // seguida de un desvanecido suave (700ms) hacia la vista principal. Es un
  // timer puro, desacoplado del backend: mientras el logo se muestra, Python
  // arranca en silencio por debajo (sin banners, sin errores rojos) y la
  // biblioteca aparece lista al terminar la transición.
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  useEffect(() => {
    const t1 = window.setTimeout(() => setSplashLeaving(true), 2000);
    const t2 = window.setTimeout(() => setSplashGone(true), 2700);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, []);

  /** IDs de los tracks que suenan ahora mismo en A y/o B (resaltado en tablas). */
  const playingTrackIds = useMemo(() => {
    const ids: number[] = [];
    if (deckAPlaying && deckATrack) ids.push(deckATrack.id);
    if (deckBPlaying && deckBTrack) ids.push(deckBTrack.id);
    return ids;
  }, [deckAPlaying, deckBPlaying, deckATrack, deckBTrack]);

  const refresh = useCallback(async () => {
    try {
      const [f, s] = await Promise.all([api.listFolders(), api.listSets()]);
      // Backend respondió: garantiza que la alerta roja NO se muestre (el
      // sondeo vuelve a disparar refresh en la primera reconexión).
      connectedRef.current = true;
      setBackendDown(false);
      // Los cambios de listas/versión de biblioteca se procesan como transición
      // (no urgentes): durante el análisis masivo (+1200 tracks) React puede
      // interrumpirlos para atender clics/navegación de pestañas sin congelarse.
      startTransition(() => {
        setFolders(f);
        setSets(s);
        setLibraryVersion((v) => v + 1);
      });
      return f;
    } catch (err) {
      // Si el error viene con status 409 (carpeta ya importada), igual lo
      // propagamos: quien lo llama decide (Sidebar muestra mensaje y fuerza
      // refresco); si es timeout/error genérico, lo consola.
      if ((err as Error & { status?: number }).status !== 409) {
        console.error("[App] error refrescando carpetas y sets:", err);
        // El banner de backend caído solo aplica en escritorio: en la web no
        // existe un backend local en 127.0.0.1 y la app opera en modo offline.
        // La alerta ROJA queda bloqueada por la gracia silenciosa de arranque:
        // mientras el motor Python levanta, jamás se muestra al usuario.
        if (window.smartSet?.isDesktop) setBackendDown(true);
      }
      throw err;
    }
  }, []);

  // Demo web: el análisis por lotes corre en segundo plano; al terminar cada
  // lote se refresca la biblioteca para mostrar el progreso en tiempo real.
  useEffect(() => subscribeWebTracks(() => void refresh()), [refresh]);

  // Escritorio: durante un escaneo de carpeta, recarga la tabla cada 2s para
  // ir mostrando las filas recién insertadas por el backend ("Analizando…"
  // hasta que cada track quede analizado) sin esperar al final del escaneo.
  useEffect(() => {
    if (!window.smartSet?.isDesktop || analyzingFolderId === null) return;
    const t = window.setInterval(() => setLibraryVersion((v) => v + 1), 2000);
    return () => window.clearInterval(t);
  }, [analyzingFolderId]);

  // Gracia SILENCIOSA del banner ROJO (90s): desde el arranque y hasta que se
  // agote este periodo, ESTÁ PROHIBIDO mostrar el error crítico, aunque la
  // conexión falle o el backend siga bloqueado levantando (PyInstaller +
  // numpy/librosa). Dentro de la gracia el cliente reintenta en silencio —
  // sin splash, sin banner de carga — y la app abre directo a la pantalla
  // principal en cuanto Python responde. Solo tras 90s reales de caída se
  // enciende la alerta roja (fallo de verdad, no arranque lento).
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!window.smartSet?.isDesktop) return;
    const t = window.setTimeout(() => setGraceOver(true), 90000);
    return () => window.clearTimeout(t);
  }, []);

  // Sondeo silencioso de salud: corre SIEMPRE en escritorio, en segundo plano.
  // En cuanto Python responde 200 OK se refresca la biblioteca (la primera vez
  // tras el arranque; en reconexiones posteriores solo limpia la alerta roja).
  // Nunca muestra banners por sí mismo: reintenta cada 1.2s sin ruido visual.
  useEffect(() => {
    if (!window.smartSet?.isDesktop) return;
    let alive = true;
    const poll = () => {
      if (!alive) return;
      api
        .health()
        .then((h) => {
          if (!alive) return;
          if (h && h.status === "ok") {
            if (!connectedRef.current) {
              connectedRef.current = true;
              void refresh().catch(() => undefined);
            } else {
              setBackendDown(false);
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (alive) window.setTimeout(poll, 1200);
        });
    };
    window.setTimeout(poll, 300);
    return () => {
      alive = false;
    };
  }, [refresh]);

  // Carga inicial: en escritorio reintenta varias veces al arrancar para que
  // la UI no quede vacía si el backend tarda unos segundos (PyInstaller +
  // numpy, librosa, etc.). Máx. 90s. En la web NO hay backend local: se hace
  // un único intento y se opera en modo offline/browser sin reintentos.
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    const isDesktop = !!window.smartSet?.isDesktop;
    const deadline = Date.now() + 90000;
    const boot = async () => {
      for (;;) {
        try {
          await refresh();
          return; // éxito: carpetas y sets cargados
        } catch (err) {
          if (!isDesktop || Date.now() > deadline) {
            if (!isDesktop) console.debug("[App] web: sin backend local, modo offline");
            else console.error("[App] No se pudieron cargar carpetas tras 90s:", err);
            return;
          }
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
    };
    void boot();
    return () => {
      // limpieza opcional si la app se cierra mientras boot
    };
  }, [refresh]);

  // Identificación de la app embebida en Electron: registra is_desktop=true
  // una sola vez para que el backend sepa que puede etiquetar ID3 (escritorio).
  useEffect(() => {
    if (!window.smartSet?.isDesktop) return;
    api
      .getSettings()
      .then((s) => {
        if (!s.is_desktop) {
          return api
            .updateSettings({ ...s, is_desktop: true })
            .catch(console.error);
        }
      })
      .catch(console.error);
  }, []);

  const playPreview = (track: Track) => {
    setActiveDeck("A");
    setDeckATrack(track);
  };

  const loadToDeck = (name: "A" | "B", track: Track) => {
    setActiveDeck(name);
    if (name === "A") setDeckATrack(track);
    else setDeckBTrack(track);
  };

  /** Doble clic en la biblioteca: carga en el deck activo (último usado). */
  const loadToActiveDeck = (track: Track) => loadToDeck(activeDeck, track);

  const loadSetToDecks = (set: DJSet) => {
    if (set.items.length === 0) return;
    const first = set.items[0].track;
    const second = set.items[1]?.track ?? first;
    setActiveDeck("A");
    setDeckATrack(first);
    setDeckBTrack(second);
    setActiveSetId(set.id);
  };

  const selectSet = (set: DJSet) => {
    setActiveSetId(set.id);
    setTab("generator");
    setGeneratedSet(set);
  };

  /** Simetría de navegación con `selectSet`: al hacer clic en una carpeta
   *  (desde cualquier pantalla) se despliega la pestaña "Biblioteca General"
   *  filtrada por esa carpeta. null = "Todos los tracks" (sin filtro). */
  const selectFolder = (id: number | null) => {
    setSelectedFolderId(id);
    setTab("library");
  };

  /** Elimina un set de forma OPTIMISTA: la pestaña desaparece de la vista al
   *  instante (0ms percibidos) actualizando el estado local, y la eliminación
   *  física en BD/almacenamiento corre en segundo plano sin bloquear el render
   *  ni esperar confirmación. Si la petición falla, se re-sincroniza el estado. */
  const deleteSet = (set: DJSet) => {
    setSets((prev) => prev.filter((s) => s.id !== set.id));
    if (set.id === activeSetId) {
      setActiveSetId(null);
      setGeneratedSet(null);
    }
    void api.deleteSet(set.id).catch((err) => {
      console.error("[App] error eliminando set:", err);
      void refresh().catch(console.error);
    });
  };

  /** Quita una carpeta y deselecciona el filtro si apuntaba a ella. */
  const removeFolder = async (id: number) => {
    await api.removeFolder(id);
    await refresh().catch(console.error);
    if (selectedFolderId === id) setSelectedFolderId(null);
  };

  return (
    <>
      <PortraitLock />
      <div className="app-shell flex h-full flex-col overflow-y-auto bg-panel text-slate-200">
        {/* BLOQUE SUPERIOR: reproductor compacto (20%) con elevación profunda.
          En móvil se apila en una sola columna: Deck A → Crossfader → Deck B. */}
      <div className="relative z-10 shrink-0 md:h-1/5 md:min-h-48 md:shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
        <DualDeck
          deckATrack={deckATrack}
          deckBTrack={deckBTrack}
          onDropTrack={(name, t) => loadToDeck(name, t)}
          onActivateDeck={setActiveDeck}
          activeDeck={activeDeck}
          onDeckPlayingChange={(name, playing) =>
            name === "A" ? setDeckAPlaying(playing) : setDeckBPlaying(playing)
          }
        />
      </div>

      {/* BLOQUE INFERIOR: biblioteca & smart sets (80%). En móvil el contenido
          fluye en una sola columna (sidebar arriba, contenido debajo). */}
      <div className="flex flex-col md:min-h-0 md:flex-1 md:flex-row md:border-t md:border-slate-800">
        <Sidebar
          folders={folders}
          sets={sets}
          activeSetId={activeSetId}
          selectedFolderId={selectedFolderId}
          onFoldersChanged={refresh}
          onScanActive={setAnalyzingFolderId}
          onSelectFolder={selectFolder}
          onSelectSet={selectSet}
          onDeleteSet={deleteSet}
          onRemoveFolder={removeFolder}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <main className="flex min-w-0 flex-1 flex-col">
          {/* Tabs */}
          <div className="flex shrink-0 items-center gap-1 border-b border-slate-800 bg-panel px-3 pt-2">
            <button
              onClick={() => setTab("library")}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition ${
                tab === "library"
                  ? "border-b-2 border-violet-500 bg-panel-2 text-violet-300"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Library size={14} /> Biblioteca General
            </button>
            <button
              onClick={() => setTab("generator")}
              className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition ${
                tab === "generator"
                  ? "border-b-2 border-cyan-400 bg-panel-2 text-cyan-300"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Wand2 size={14} /> Smart Set Generator
            </button>
          </div>

          {/* Aviso de backend caído (SOLO escritorio, SOLO tras la gracia
              silenciosa de 90s): el error crítico real. Durante el arranque
              jamás se muestra — el cliente espera en silencio. Contenedor
              independiente en flujo normal, justo encima de la barra de
              búsqueda y debajo de las tabs, con margin-bottom — nunca tapa
              las pestañas. */}
          {backendDown && graceOver && window.smartSet?.isDesktop && (
            <div className="mb-2 mt-1 shrink-0 px-3">
              <div className="flex items-center gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[11px] font-semibold text-red-300">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
                Servidor backend no responde. Reintentando conexión… Verifica que el servicio
                Python (ssa-backend) esté corriendo en 127.0.0.1:8765.
              </div>
            </div>
          )}

<div className="flex min-h-0 flex-1 flex-col px-3 md:px-0">
        {tab === "library" ? (
              <>
                <RecommendationsPanel
                  seed={deckATrack}
                  onLoadToDeckB={(t) => loadToDeck("B", t)}
                />
                <LibraryTable
                  folders={folders}
                  folderId={selectedFolderId}
                  onFolderIdChange={setSelectedFolderId}
                  onPlayPreview={playPreview}
                  onLoadToDeckA={(t) => loadToDeck("A", t)}
                  onLoadToDeckB={(t) => loadToDeck("B", t)}
                  onLoadToActiveDeck={loadToActiveDeck}
                  compatibleWith={compatibleWith}
                  onSetCompatibleWith={setCompatibleWith}
                  playingTrackIds={playingTrackIds}
                  refreshKey={libraryVersion}
                  analyzingFolderId={analyzingFolderId}
                />
              </>
            ) : (
              <SetGenerator
                folders={folders}
                result={generatedSet}
                onResult={(s) => {
                  setGeneratedSet(s);
                  if (s) setActiveSetId(s.id);
                  else setActiveSetId(null);
                  void refresh();
                }}
                onPlayPreview={playPreview}
                onLoadTrackToDeckA={(t) => loadToDeck("A", t)}
                onLoadTrackToDeckB={(t) => loadToDeck("B", t)}
                onLoadToActiveDeck={loadToActiveDeck}
                onLoadSetToDecks={loadSetToDecks}
                seedTrack={seedTrack}
                onClearSeed={() => setSeedTrack(null)}
                playingTrackIds={playingTrackIds}
              />
            )}
          </div>
        </main>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {!splashGone && <SplashScreen leaving={splashLeaving} />}
      </div>
    </>
  );
}
