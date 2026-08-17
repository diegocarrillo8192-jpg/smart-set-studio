import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioLines, Disc2, Disc3, Music2, Play, Search, SlidersHorizontal } from "lucide-react";
import type { Track } from "../types";
import { api, prefetchArtworks } from "../api";
import { fmtBpm } from "../lib/format";
import { CoverThumb } from "./Artwork";

interface Props {
  folders: { id: number; name: string }[];
  folderId: number | null;
  onFolderIdChange: (id: number | null) => void;
  onPlayPreview: (track: Track) => void;
  onLoadToDeckA: (track: Track) => void;
  onLoadToDeckB: (track: Track) => void;
  onLoadToActiveDeck: (track: Track) => void;
  compatibleWith: Track | null;
  onSetCompatibleWith: (t: Track | null) => void;
  /** IDs de los tracks que suenan ahora en Deck A/B (resaltado en la tabla). */
  playingTrackIds: number[];
  /** Cada vez que cambia este número (desde App.tsx via libraryVersion),
   *  la tabla recarga la lista de canciones automáticamente. */
  refreshKey: number;
}

const CAMELOT_CODES = Array.from({ length: 12 }, (_, i) => [`${i + 1}A`, `${i + 1}B`]).flat();

function fmtDur(sec: number | null): string {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function EnergyDots({ value }: { value: number | null }) {
  if (!value) return <span className="text-slate-600">-</span>;
  return (
    <div className="flex items-center gap-0.5" title={`Energía ${value}/10`}>
      {Array.from({ length: 10 }, (_, i) => (
        <span
          key={i}
          className="h-2 w-1 rounded-sm"
          style={{
            background: i < value ? (value >= 7 ? "#f87171" : value >= 4 ? "#fbbf24" : "#34d399") : "#243046",
          }}
        />
      ))}
    </div>
  );
}

export default function LibraryTable({
  folders,
  folderId,
  onFolderIdChange,
  onPlayPreview,
  onLoadToDeckA,
  onLoadToDeckB,
  onLoadToActiveDeck,
  compatibleWith,
  onSetCompatibleWith,
  playingTrackIds,
  refreshKey,
}: Props) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [camelot, setCamelot] = useState("");
  const [minBpm, setMinBpm] = useState("");
  const [maxBpm, setMaxBpm] = useState("");
  const [minEnergy, setMinEnergy] = useState("");
  const [maxEnergy, setMaxEnergy] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const load = useCallback(async (attempt = 0) => {
    setLoading(true);
    try {
      const result = await api.listTracks({
        q: q || undefined,
        folder_id: folderId ?? undefined,
        camelot: camelot || undefined,
        min_bpm: minBpm || undefined,
        max_bpm: maxBpm || undefined,
        min_energy: minEnergy || undefined,
        max_energy: maxEnergy || undefined,
        compatible_with: compatibleWith?.camelot_key ?? undefined,
        sort: "artist",
        limit: 1000,
      });
      setTracks(result);
    } catch (e) {
      // El backend puede tardar más que el renderer en arrancar (ventana
      // instantánea + backend en paralelo): reintentar con margen amplio.
      if (attempt < 8) {
        setTimeout(() => void load(attempt + 1), 1200);
      } else {
        console.error(e);
      }
    } finally {
      setLoading(false);
    }
  }, [q, folderId, camelot, minBpm, maxBpm, minEnergy, maxEnergy, compatibleWith, refreshKey]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  // Precarga lazy de covers al cargar el listado (clic en carpeta/filtros):
  // los N primeros tracks piden su carátula por el endpoint CORS del backend
  // y se insertan en el estado/UI sin bloquear el render del resto.
  useEffect(() => {
    if (tracks.length === 0) return;
    prefetchArtworks(tracks, 24);
  }, [tracks]);

  const filtersActive = useMemo(
    () => !!(folderId !== null || camelot || minBpm || maxBpm || minEnergy || maxEnergy || compatibleWith),
    [folderId, camelot, minBpm, maxBpm, minEnergy, maxEnergy, compatibleWith]
  );

  const resetFilters = () => {
    onFolderIdChange(null);
    setCamelot("");
    setMinBpm("");
    setMaxBpm("");
    setMinEnergy("");
    setMaxEnergy("");
    onSetCompatibleWith(null);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Barra de herramientas */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-panel p-3">
        <div className="relative min-w-56 flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar por título, artista, key, folder..."
            className="w-full rounded-lg border border-slate-700 bg-panel-2 py-1.5 pl-8 pr-3 text-sm text-slate-200 placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
          />
        </div>
        <button
          onClick={() => setShowFilters((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition ${
            filtersActive || showFilters
              ? "border-violet-400/50 bg-violet-500/20 text-violet-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_12px_rgba(139,92,246,0.2)]"
              : "border-slate-700 text-slate-400 hover:text-white hover:shadow-[0_0_10px_rgba(139,92,246,0.35)]"
          }`}
        >
          <SlidersHorizontal size={13} /> Filtros {filtersActive && <span className="rounded-full bg-violet-500 px-1 text-[9px] text-white">ON</span>}
        </button>
      </div>

      {/* Filtros */}
      {showFilters && (
        <div className="flex flex-wrap items-end gap-3 border-b border-slate-800 bg-panel-2 px-3 py-2.5 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-slate-500">Carpeta</span>
            <select
              value={folderId ?? ""}
              onChange={(e) => onFolderIdChange(e.target.value ? Number(e.target.value) : null)}
              className="rounded border border-slate-700 bg-panel-3 px-2 py-1 text-slate-200"
            >
              <option value="">Todos los tracks</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-slate-500">Camelot</span>
            <select
              value={camelot}
              onChange={(e) => setCamelot(e.target.value)}
              className="rounded border border-slate-700 bg-panel-3 px-2 py-1 text-slate-200"
            >
              <option value="">Todas</option>
              {CAMELOT_CODES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-slate-500">BPM desde</span>
            <input
              type="number"
              value={minBpm}
              onChange={(e) => setMinBpm(e.target.value)}
              placeholder="90"
              className="w-20 rounded border border-slate-700 bg-panel-3 px-2 py-1 text-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-slate-500">BPM hasta</span>
            <input
              type="number"
              value={maxBpm}
              onChange={(e) => setMaxBpm(e.target.value)}
              placeholder="140"
              className="w-20 rounded border border-slate-700 bg-panel-3 px-2 py-1 text-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-slate-500">Energía mín</span>
            <input
              type="number"
              min={1}
              max={10}
              value={minEnergy}
              onChange={(e) => setMinEnergy(e.target.value)}
              placeholder="1"
              className="w-16 rounded border border-slate-700 bg-panel-3 px-2 py-1 text-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase text-slate-500">Energía máx</span>
            <input
              type="number"
              min={1}
              max={10}
              value={maxEnergy}
              onChange={(e) => setMaxEnergy(e.target.value)}
              placeholder="10"
              className="w-16 rounded border border-slate-700 bg-panel-3 px-2 py-1 text-slate-200"
            />
          </label>
          {compatibleWith && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-emerald-300">
              <Music2 size={12} />
              Compatibles con <b>{compatibleWith.camelot_key}</b> ({compatibleWith.title.slice(0, 18)})
              <button onClick={() => onSetCompatibleWith(null)} className="ml-1 font-bold text-emerald-400 hover:text-white">×</button>
            </div>
          )}
          {filtersActive && (
            <button onClick={resetFilters} className="ml-auto rounded border border-slate-600 px-2 py-1 text-slate-300 hover:text-white">
              Limpiar filtros
            </button>
          )}
        </div>
      )}

      {/* Tabla */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="w-24 px-2 py-2"></th>
              <th className="px-2 py-2">Título</th>
              <th className="px-2 py-2">Artista</th>
              <th className="px-2 py-2 text-right">BPM</th>
              <th className="px-2 py-2 text-center">Key</th>
              <th className="px-2 py-2">Energía</th>
              <th className="px-2 py-2">Carpeta</th>
              <th className="px-2 py-2 text-right">Duración</th>
            </tr>
          </thead>
          <tbody>
            {tracks.map((t) => (
              <tr
                key={t.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/json", JSON.stringify(t));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => onLoadToActiveDeck(t)}
                className={`group cursor-default border-t border-slate-800/60 transition hover:bg-panel-2 ${
                  compatibleWith?.id === t.id ? "bg-emerald-500/10" : ""
                } ${
                  playingTrackIds.includes(t.id)
                    ? "bg-emerald-500/15 shadow-[inset_3px_0_0_4px_rgba(52,211,153,0.55)]"
                    : ""
                }`}
                title="Doble clic: cargar en el deck activo · arrastra a un Deck"
              >
                <td className="whitespace-nowrap px-2 py-1.5" onDoubleClick={(e) => e.stopPropagation()}>
                  <div className="flex items-center gap-1 opacity-0 transition group-hover:opacity-100">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPlayPreview(t);
                      }}
                      className="grid h-6 w-6 place-items-center rounded-full bg-panel-3 text-slate-300 transition hover:bg-violet-600 hover:text-white hover:shadow-[0_0_12px_rgba(139,92,246,0.7)]"
                      title="Pre-escuchar (carga en Deck A y mueve el fader)"
                    >
                      <Play size={11} className="ml-0.5" />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onLoadToDeckA(t);
                      }}
                      className="grid h-6 w-6 place-items-center rounded-full text-slate-300 transition hover:bg-cyan-500 hover:text-black hover:shadow-[0_0_12px_rgba(34,211,238,0.7)]"
                      title="Cargar en Deck A"
                    >
                      <Disc3 size={13} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onLoadToDeckB(t);
                      }}
                      className="grid h-6 w-6 place-items-center rounded-full text-slate-300 transition hover:bg-violet-500 hover:text-black hover:shadow-[0_0_12px_rgba(167,139,250,0.7)]"
                      title="Cargar en Deck B"
                    >
                      <Disc2 size={13} />
                    </button>
                  </div>
                </td>
                <td className="max-w-56 truncate px-2 py-1.5 font-medium text-slate-100">
                  <div className="flex items-center gap-2">
                    <CoverThumb track={t} size={26} />
                    <span className="min-w-0 flex-1 truncate">
                      {t.title}
                      {t.has_error && <span className="ml-1.5 text-[9px] text-red-400" title={t.error_message ?? ""}>⚠</span>}
                    </span>
                    {playingTrackIds.includes(t.id) && (
                      <AudioLines size={12} className="shrink-0 animate-pulse text-emerald-400" />
                    )}
                  </div>
                </td>
                <td className="max-w-40 truncate px-2 py-1.5 text-slate-400">{t.artist}</td>
                <td className="px-2 py-1.5 text-right font-mono text-cyan-300">{fmtBpm(t.bpm)}</td>
                <td className="px-2 py-1.5 text-center">
                  <span
                    className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-black tracking-wider shadow-sm ${
                      t.camelot_key?.endsWith("B")
                        ? "border-violet-400/40 bg-gradient-to-br from-violet-500/35 to-violet-500/5 text-violet-200 shadow-violet-500/20"
                        : "border-cyan-400/40 bg-gradient-to-br from-cyan-500/35 to-cyan-500/5 text-cyan-200 shadow-cyan-500/20"
                    }`}
                  >
                    {t.camelot_key ?? "-"}
                  </span>
                </td>
                <td className="px-2 py-1.5"><EnergyDots value={t.energy} /></td>
                <td className="max-w-28 truncate px-2 py-1.5 text-slate-500">{t.folder_name}</td>
                <td className="px-2 py-1.5 text-right font-mono text-slate-400">{fmtDur(t.duration_sec)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {loading && <p className="p-4 text-center text-xs text-slate-500">Cargando...</p>}
        {!loading && tracks.length === 0 && (
          <div className="grid h-full place-items-center p-8">
            <div className="max-w-sm text-center">
              <div className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-panel-2">
                <Music2 size={24} className="text-slate-600" />
              </div>
              {folders.length === 0 ? (
                <>
                  <p className="text-sm font-semibold text-slate-300">No hay carpetas agregadas</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Haz clic en <b className="text-violet-400">"Agregar Carpeta"</b> en la barra lateral
                    para importar tu música y comenzar a analizarla.
                  </p>
                </>
              ) : filtersActive ? (
                <>
                  <p className="text-sm font-semibold text-slate-300">Sin resultados para los filtros actuales</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Ajusta o limpia los filtros para ver más tracks.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm font-semibold text-slate-300">Tu biblioteca está vacía</p>
                  <p className="mt-1 text-xs text-slate-500">
                    Usa el botón <b className="text-cyan-400">Escanear / Re-analizar</b> de tus carpetas
                    para analizar BPM, tonalidad y energía.
                  </p>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
