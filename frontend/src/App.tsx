import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Library, Loader2, Wand2 } from "lucide-react";
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
  /** Período de gracia al arrancar la app de escritorio (8s): durante este
   *  tiempo no se muestra la alerta roja de desconexión, solo el indicador
   *  "Iniciando motor de audio…". En la web NO aplica (modo offline). */
  const [startingUp, setStartingUp] = useState(() => !!window.smartSet?.isDesktop);
  const bootRef = useRef(false);
  /** Ref espejo para lecturas estables dentro de `refresh` (useCallback []). */
  const startingUpRef = useRef(startingUp);
  const connectedRef = useRef(false);

  // Splash screen enlazado al BACKEND: no se cierra con un timer fijo — se
  // mantiene (animación en loop) mientras la conexión a Python esté pendiente
  // o fallando sus primeros intentos, y solo se desvanece cuando la API
  // responde 200 OK. En la web (sin backend) se cierra igualmente al primer
  // refresh exitoso del almacén volátil.
  const [splashLeaving, setSplashLeaving] = useState(false);
  const [splashGone, setSplashGone] = useState(false);
  const [backendReady, setBackendReady] = useState(false);
  const splashStartRef = useRef(Date.now());
  useEffect(() => {
    if (!backendReady) return; // sigue en el Splash: aún no hay sistema 100%
    const delay = Math.max(0, 900 - (Date.now() - splashStartRef.current));
    const t1 = window.setTimeout(() => setSplashLeaving(true), delay);
    const t2 = window.setTimeout(() => setSplashGone(true), delay + 600);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [backendReady]);

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
      setFolders(f);
      setSets(s);
      setLibraryVersion((v) => v + 1);
      // Backend respondió: se termina el arranque (oculta el indicador) y se
      // garantiza que la alerta roja NO se muestre aunque el 8s aún corra.
      connectedRef.current = true;
      setStartingUp(false);
      setBackendDown(false);
      setBackendReady(true); // Python respondió 200: el Splash inicia el fade-out
      return f;
    } catch (err) {
      // Si el error viene con status 409 (carpeta ya importada), igual lo
      // propagamos: quien lo llama decide (Sidebar muestra mensaje y fuerza
      // refresco); si es timeout/error genérico, lo consola.
      if ((err as Error & { status?: number }).status !== 409) {
        console.error("[App] error refrescando carpetas y sets:", err);
        // El banner de backend caído solo aplica en escritorio: en la web no
        // existe un backend local en 127.0.0.1 y la app opera en modo offline.
        // Durante la gracia de arranque (8s) NO se enciende la alerta roja.
        if (window.smartSet?.isDesktop && !startingUpRef.current) setBackendDown(true);
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

  // Timeout de seguridad (15s): si Python no levanta, se cierra el Splash
  // igualmente y la alerta roja indica un fallo REAL del sistema (el Splash ya
  // enmascaró el arranque normal, nunca se ve la alerta mientras bootea).
  useEffect(() => {
    if (!window.smartSet?.isDesktop || backendReady) return;
    const t = window.setTimeout(() => {
      setBackendReady(true);
      setStartingUp(false);
      if (!connectedRef.current) setBackendDown(true);
    }, 15000);
    return () => window.clearTimeout(t);
  }, [backendReady]);

  // Gracia de 30s para el banner ROJO: desde el arranque de la app y hasta que
  // se agote este periodo, ESTÁ PROHIBIDO mostrar el error crítico, aunque la
  // conexión falle o el backend siga bloqueado procesando la base de datos
  // local. Dentro de la gracia se muestra el banner NEUTRO de sincronización.
  const [graceOver, setGraceOver] = useState(false);
  useEffect(() => {
    if (!window.smartSet?.isDesktop) return;
    const t = window.setTimeout(() => setGraceOver(true), 30000);
    return () => window.clearTimeout(t);
  }, []);

  // Sondeo ligero de salud: en cuanto Python responde 200 OK se libera la UI
  // (el refresh pesado de carpetas corre después, en segundo plano).
  useEffect(() => {
    if (!window.smartSet?.isDesktop || backendReady) return;
    let alive = true;
    const poll = () => {
      if (!alive) return;
      api
        .health()
        .then((h) => {
          if (!alive) return;
          if (h && h.status === "ok") {
            connectedRef.current = true;
            setBackendReady(true);
            setStartingUp(false);
            void refresh().catch(() => undefined);
          } else {
            window.setTimeout(poll, 1200);
          }
        })
        .catch(() => {
          if (alive) window.setTimeout(poll, 1200);
        });
    };
    window.setTimeout(poll, 300);
    return () => {
      alive = false;
    };
  }, [backendReady, refresh]);

  // Mantiene el ref espejo sincronizado con el estado de arranque.
  useEffect(() => {
    startingUpRef.current = startingUp;
  }, [startingUp]);

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

  /** Elimina un set y, si era el que estaba desplegado, limpia la vista. */
  const deleteSet = async (set: DJSet) => {
    await api.deleteSet(set.id);
    await refresh().catch(console.error);
    if (set.id === activeSetId) {
      setActiveSetId(null);
      setGeneratedSet(null);
    }
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
          onSelectFolder={setSelectedFolderId}
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

          {/* Indicador de arranque (SOLO escritorio, durante la gracia de 8s):
              estado amigable mientras el backend Python levanta (PyInstaller +
              numpy/librosa). Desaparece al responder o al agotarse la gracia. */}
          {startingUp && !backendDown && window.smartSet?.isDesktop && (
            <div className="mb-2 mt-1 shrink-0 px-3">
              <div className="flex items-center gap-2 rounded-lg border border-violet-800/50 bg-violet-950/30 px-3 py-2 text-[11px] font-semibold text-violet-300">
                <Loader2 size={12} className="animate-spin" />
                Iniciando motor de audio… conectando con el servicio local
              </div>
            </div>
          )}

          {/* Banner NEUTRO de carga (SOLO escritorio, dentro de la gracia de
              30s): reemplaza al rojo mientras el backend sincroniza la base
              de datos de audio local tras el Splash. */}
          {backendDown && !graceOver && window.smartSet?.isDesktop && (
            <div className="mb-2 mt-1 shrink-0 px-3">
              <div className="flex items-center gap-2 rounded-lg border border-slate-700/70 bg-slate-800/60 px-3 py-2 text-[11px] font-semibold text-slate-300">
                <Loader2 size={12} className="animate-spin text-sky-400" />
                🎧 Sincronizando motor de audio y biblioteca… por favor espera
              </div>
            </div>
          )}

          {/* Aviso de backend caído (SOLO escritorio, SOLO tras la gracia de
              30s): el error crítico real. Contenedor independiente en flujo
              normal, justo encima de la barra de búsqueda y debajo de las
              tabs, con margin-bottom — nunca tapa las pestañas. */}
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
