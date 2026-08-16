import { useCallback, useEffect, useState } from "react";
import { Library, Wand2 } from "lucide-react";
import type { DJSet, Folder, Track } from "./types";
import { api } from "./api";
import Sidebar from "./components/Sidebar";
import LibraryTable from "./components/LibraryTable";
import SetGenerator from "./components/SetGenerator";
import DualDeck from "./components/DualDeck";
import RecommendationsPanel from "./components/RecommendationsPanel";
import SettingsModal from "./components/SettingsModal";

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

  const refresh = useCallback(async () => {
    // Reintento por si el backend aún está arrancando (carrera de inicio)
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const [f, s] = await Promise.all([api.listFolders(), api.listSets()]);
        setFolders(f);
        setSets(s);
        return;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }, []);

  useEffect(() => {
    void refresh().catch(console.error);
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
    <div className="flex h-full flex-col bg-panel text-slate-200">
      {/* BLOQUE SUPERIOR: reproductor compacto (20%) con elevación profunda */}
      <div className="relative z-10 h-1/5 min-h-48 shrink-0 shadow-[0_18px_44px_rgba(0,0,0,0.6)]">
        <DualDeck
          deckATrack={deckATrack}
          deckBTrack={deckBTrack}
          onDropTrack={(name, t) => loadToDeck(name, t)}
          onActivateDeck={setActiveDeck}
          activeDeck={activeDeck}
        />
      </div>

      {/* BLOQUE INFERIOR: biblioteca & smart sets (80%) */}
      <div className="flex min-h-0 flex-1 border-t border-slate-800">
        <Sidebar
          folders={folders}
          sets={sets}
          activeSetId={activeSetId}
          selectedFolderId={selectedFolderId}
          onFoldersChanged={refresh}
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
                  ? "border-b-2 border-fuchsia-500 bg-panel-2 text-fuchsia-300"
                  : "text-slate-500 hover:text-slate-300"
              }`}
            >
              <Wand2 size={14} /> Smart Set Generator
            </button>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
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
              />
            )}
          </div>
        </main>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
