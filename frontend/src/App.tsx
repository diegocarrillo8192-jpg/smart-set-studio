import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Library, Wand2 } from "lucide-react";
import type { DJSet, Folder, Track } from "./types";
import { api, subscribeWebTracks } from "./api";
import SplashScreen from "./components/SplashScreen";
import Sidebar from "./components/Sidebar";
import LibraryTable from "./components/LibraryTable";
import SetGenerator from "./components/SetGenerator";
import DjConsole from "./components/DjConsole";
import RecommendationsPanel from "./components/RecommendationsPanel";
import SettingsModal from "./components/SettingsModal";
import PortraitLock from "./components/PortraitLock";

type Tab = "library" | "generator";

interface ConsoleBlockProps {
  deckATrack: Track | null;
  deckBTrack: Track | null;
  onDropTrack: (name: "A" | "B", track: Track) => void;
  onDeckPlayingChange: (name: "A" | "B", playing: boolean) => void;
}

/** BLOQUE SUPERIOR: consola DJ profesional NATIVA. Recibe los tracks de la
 *  biblioteca (doble clic / drag & drop) y monta el motor de audio MIXI
 *  (Decks A/B + crossfader + SYNC de BPM exacto 1:1 y snap cuántico en un
 *  solo disparo).
 *  Altura efectiva
 *  min(58vh, 840px) = el diseño compactado de la consola; si el viewport es
 *  muy alto (58vh > 840) la consola se topa a su tamaño natural y la
 *  biblioteca inferior ocupa el resto sin dejar espacio flotante. */
function ConsoleBlock({
  deckATrack,
  deckBTrack,
  onDropTrack,
  onDeckPlayingChange,
}: ConsoleBlockProps) {
  return (
    <div className="relative z-10 h-[58vh] max-h-[840px] min-h-0 shrink-0 overflow-hidden shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
      <DjConsole
        deckATrack={deckATrack}
        deckBTrack={deckBTrack}
        onDropTrack={onDropTrack}
        onDeckPlayingChange={onDeckPlayingChange}
      />
    </div>
  );
}

interface AppTabsProps {
  tab: Tab;
  onSelect: (tab: Tab) => void;
}

/** Tabs de la biblioteca: "Biblioteca General" / "Smart Set Generator". */
function AppTabs({ tab, onSelect }: AppTabsProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-slate-800 bg-panel px-3 pt-2">
      <button
        onClick={() => onSelect("library")}
        className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition ${
          tab === "library"
            ? "border-b-2 border-violet-500 bg-panel-2 text-violet-300"
            : "text-slate-500 hover:text-slate-300"
        }`}
      >
        <Library size={14} /> Biblioteca General
      </button>
      <button
        onClick={() => onSelect("generator")}
        className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-xs font-bold uppercase tracking-wider transition ${
          tab === "generator"
            ? "border-b-2 border-cyan-400 bg-panel-2 text-cyan-300"
            : "text-slate-500 hover:text-slate-300"
        }`}
      >
        <Wand2 size={14} /> Smart Set Generator
      </button>
    </div>
  );
}

/** Aviso de backend caído (SOLO escritorio, SOLO tras la gracia silenciosa de
 *  90s): el error crítico real. Durante el arranque jamás se muestra — el
 *  cliente espera en silencio. Contenedor independiente en flujo normal,
 *  justo encima de la barra de búsqueda y debajo de las tabs, con
 *  margin-bottom — nunca tapa las pestañas. */
function BackendDownBanner() {
  return (
    <div className="mb-2 mt-1 shrink-0 px-3">
      <div className="flex items-center gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[11px] font-semibold text-red-300">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
        Servidor backend no responde. Reintentando conexión… Verifica que el servicio
        Python (ssa-backend) esté corriendo en 127.0.0.1:8765.
      </div>
    </div>
  );
}

interface ContentPaneProps {
  tab: Tab;
  folders: Folder[];
  selectedFolderId: number | null;
  onFolderIdChange: (id: number | null) => void;
  deckATrack: Track | null;
  compatibleWith: Track | null;
  onSetCompatibleWith: (t: Track | null) => void;
  playingTrackIds: number[];
  libraryVersion: number;
  analyzingFolderId: number | null;
  generatedSet: DJSet | null;
  seedTrack: Track | null;
  onPlayPreview: (t: Track) => void;
  onLoadToDeckA: (t: Track) => void;
  onLoadToDeckB: (t: Track) => void;
  onLoadToActiveDeck: (t: Track) => void;
  onLoadSetToDecks: (set: DJSet) => void;
  onResult: (s: DJSet | null) => void;
  onClearSeed: () => void;
}

/** Contenido de la pestaña activa: biblioteca (recomendaciones + tabla) o
 *  generador de smart sets. */
function ContentPane({
  tab,
  folders,
  selectedFolderId,
  onFolderIdChange,
  deckATrack,
  compatibleWith,
  onSetCompatibleWith,
  playingTrackIds,
  libraryVersion,
  analyzingFolderId,
  generatedSet,
  seedTrack,
  onPlayPreview,
  onLoadToDeckA,
  onLoadToDeckB,
  onLoadToActiveDeck,
  onLoadSetToDecks,
  onResult,
  onClearSeed,
}: ContentPaneProps) {
  if (tab === "library") {
    return (
      <>
        <RecommendationsPanel seed={deckATrack} onLoadToDeckB={onLoadToDeckB} />
        <LibraryTable
          folders={folders}
          folderId={selectedFolderId}
          onFolderIdChange={onFolderIdChange}
          onPlayPreview={onPlayPreview}
          onLoadToDeckA={onLoadToDeckA}
          onLoadToDeckB={onLoadToDeckB}
          onLoadToActiveDeck={onLoadToActiveDeck}
          compatibleWith={compatibleWith}
          onSetCompatibleWith={onSetCompatibleWith}
          playingTrackIds={playingTrackIds}
          refreshKey={libraryVersion}
          analyzingFolderId={analyzingFolderId}
        />
      </>
    );
  }
  return (
    <SetGenerator
      folders={folders}
      result={generatedSet}
      onResult={onResult}
      onPlayPreview={onPlayPreview}
      onLoadTrackToDeckA={onLoadToDeckA}
      onLoadTrackToDeckB={onLoadToDeckB}
      onLoadToActiveDeck={onLoadToActiveDeck}
      onLoadSetToDecks={onLoadSetToDecks}
      seedTrack={seedTrack}
      onClearSeed={onClearSeed}
      playingTrackIds={playingTrackIds}
    />
  );
}

/** Splash de marca: presentación del logo durante EXACTAMENTE 2s completos,
 *  seguida de un desvanecido suave (700ms) hacia la vista principal. Es un
 *  timer puro, desacoplado del backend: mientras el logo se muestra, Python
 *  arranca en silencio por debajo (sin banners, sin errores rojos) y la
 *  biblioteca aparece lista al terminar la transición. */
function startSplashTimers(onLeaving: () => void, onGone: () => void): () => void {
  const t1 = window.setTimeout(onLeaving, 2000);
  const t2 = window.setTimeout(onGone, 2700);
  return () => {
    window.clearTimeout(t1);
    window.clearTimeout(t2);
  };
}

/** Carga carpetas y sets del backend y devuelve las carpetas. Los cambios de
 *  listas/versión de biblioteca se procesan como transición (no urgentes):
 *  durante el análisis masivo (+1200 tracks) React puede interrumpirlos para
 *  atender clics/navegación de pestañas sin congelarse. Si el backend
 *  responde, garantiza que la alerta roja NO se muestre (el sondeo vuelve a
 *  disparar el refresh en la primera reconexión). */
async function loadLibrary(deps: {
  setFolders: (f: Folder[]) => void;
  setSets: (s: DJSet[]) => void;
  setLibraryVersion: (fn: (v: number) => number) => void;
  setBackendDown: (v: boolean) => void;
  connectedRef: { current: boolean };
}): Promise<Folder[]> {
  try {
    const [f, s] = await Promise.all([api.listFolders(), api.listSets()]);
    deps.connectedRef.current = true;
    deps.setBackendDown(false);
    startTransition(() => {
      deps.setFolders(f);
      deps.setSets(s);
      deps.setLibraryVersion((v) => v + 1);
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
      if (window.smartSet?.isDesktop) deps.setBackendDown(true);
    }
    throw err;
  }
}

/** Carga inicial: en escritorio reintenta varias veces al arrancar para que
 *  la UI no quede vacía si el backend tarda unos segundos (PyInstaller +
 *  numpy, librosa, etc.). Máx. 90s. En la web NO hay backend local: se hace
 *  un único intento y se opera en modo offline/browser sin reintentos. */
function startBootLoop(refresh: () => Promise<unknown>): () => void {
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
}

/** Sondeo silencioso de salud: corre SIEMPRE en escritorio, en segundo plano.
 *  En cuanto Python responde 200 OK se refresca la biblioteca (la primera vez
 *  tras el arranque; en reconexiones posteriores solo limpia la alerta roja).
 *  Nunca muestra banners por sí mismo: reintenta cada 1.2s sin ruido visual. */
function startHealthPolling(deps: {
  refresh: () => Promise<unknown>;
  connectedRef: { current: boolean };
  setBackendDown: (v: boolean) => void;
}): () => void {
  let alive = true;
  const poll = () => {
    if (!alive) return;
    api
      .health()
      .then((h) => {
        if (!alive) return;
        if (h && h.status === "ok") {
          if (!deps.connectedRef.current) {
            deps.connectedRef.current = true;
            void deps.refresh().catch(() => undefined);
          } else {
            deps.setBackendDown(false);
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
}

/** Identificación de la app embebida en Electron: registra is_desktop=true
 *  una sola vez para que el backend sepa que puede etiquetar ID3 (escritorio). */
function markDesktopFlag(): void {
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
}

/** Escritorio: durante un escaneo de carpeta, recarga la tabla cada 2s para
 *  ir mostrando las filas recién insertadas por el backend ("Analizando…"
 *  hasta que cada track quede analizado) sin esperar al final del escaneo. */
function startScanPolling(
  analyzingFolderId: number | null,
  setLibraryVersion: (fn: (v: number) => number) => void
): (() => void) | undefined {
  if (!window.smartSet?.isDesktop || analyzingFolderId === null) return;
  const t = window.setInterval(() => setLibraryVersion((v) => v + 1), 2000);
  return () => window.clearInterval(t);
}

/** IDs de los tracks que suenan ahora mismo en A y/o B (resaltado en tablas). */
function collectPlayingTrackIds(
  deckAPlaying: boolean,
  deckATrack: Track | null,
  deckBPlaying: boolean,
  deckBTrack: Track | null
): number[] {
  const ids: number[] = [];
  if (deckAPlaying && deckATrack) ids.push(deckATrack.id);
  if (deckBPlaying && deckBTrack) ids.push(deckBTrack.id);
  return ids;
}

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
  /** Deck activo (último usado): solo se consulta en handlers al cargar un
   *  track, nunca en el render → ref, sin re-render por cada carga. */
  const activeDeckRef = useRef<"A" | "B">("A");
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

  const [splashLeaving, setSplashLeaving] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  useEffect(
    () => startSplashTimers(() => setSplashLeaving(true), () => setSplashGone(true)),
    []
  );

  const playingTrackIds = useMemo(
    () => collectPlayingTrackIds(deckAPlaying, deckATrack, deckBPlaying, deckBTrack),
    [deckAPlaying, deckBPlaying, deckATrack, deckBTrack]
  );

  const refresh = useCallback(
    () => loadLibrary({ setFolders, setSets, setLibraryVersion, setBackendDown, connectedRef }),
    []
  );

  // Demo web: el análisis por lotes corre en segundo plano; al terminar cada
  // lote se refresca la biblioteca para mostrar el progreso en tiempo real.
  useEffect(() => subscribeWebTracks(() => void refresh()), [refresh]);

  useEffect(() => startScanPolling(analyzingFolderId, setLibraryVersion), [analyzingFolderId]);

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

  useEffect(() => {
    if (!window.smartSet?.isDesktop) return;
    return startHealthPolling({ refresh, connectedRef, setBackendDown });
  }, [refresh]);

  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    return startBootLoop(refresh);
  }, [refresh]);

  useEffect(() => {
    markDesktopFlag();
  }, []);

  const playPreview = (track: Track) => {
    activeDeckRef.current = "A";
    setDeckATrack(track);
  };

  const loadToDeck = (name: "A" | "B", track: Track) => {
    activeDeckRef.current = name;
    if (name === "A") setDeckATrack(track);
    else setDeckBTrack(track);
  };

  /** Doble clic en la biblioteca: carga en el deck activo (último usado). */
  const loadToActiveDeck = (track: Track) => loadToDeck(activeDeckRef.current, track);

  const loadSetToDecks = (set: DJSet) => {
    if (set.items.length === 0) return;
    const first = set.items[0].track;
    const second = set.items[1]?.track ?? first;
    activeDeckRef.current = "A";
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
        <ConsoleBlock
          deckATrack={deckATrack}
          deckBTrack={deckBTrack}
          onDropTrack={(name, t) => loadToDeck(name, t)}
          onDeckPlayingChange={(name, playing) =>
            name === "A" ? setDeckAPlaying(playing) : setDeckBPlaying(playing)
          }
        />

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
            <AppTabs tab={tab} onSelect={setTab} />

            {backendDown && graceOver && window.smartSet?.isDesktop && <BackendDownBanner />}

            <div className="flex min-h-0 flex-1 flex-col px-3 md:px-0">
              <ContentPane
                tab={tab}
                folders={folders}
                selectedFolderId={selectedFolderId}
                onFolderIdChange={setSelectedFolderId}
                deckATrack={deckATrack}
                compatibleWith={compatibleWith}
                onSetCompatibleWith={setCompatibleWith}
                playingTrackIds={playingTrackIds}
                libraryVersion={libraryVersion}
                analyzingFolderId={analyzingFolderId}
                generatedSet={generatedSet}
                seedTrack={seedTrack}
                onPlayPreview={playPreview}
                onLoadToDeckA={(t) => loadToDeck("A", t)}
                onLoadToDeckB={(t) => loadToDeck("B", t)}
                onLoadToActiveDeck={loadToActiveDeck}
                onLoadSetToDecks={loadSetToDecks}
                onResult={(s) => {
                  setGeneratedSet(s);
                  if (s) setActiveSetId(s.id);
                  else setActiveSetId(null);
                  void refresh();
                }}
                onClearSeed={() => setSeedTrack(null)}
              />
            </div>
          </main>
        </div>

        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />

        {!splashGone && <SplashScreen leaving={splashLeaving} />}
      </div>
    </>
  );
}
