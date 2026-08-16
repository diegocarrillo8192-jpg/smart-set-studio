import { useEffect, useMemo, useState } from "react";
import {
  Clock,
  Disc2,
  Disc3,
  Download,
  FolderTree,
  LayoutList,
  Loader2,
  Play,
  Sparkles,
  Usb,
  Wand2,
} from "lucide-react";
import type { DJSet, EnergyProfile, Folder, SetItem, Track } from "../types";
import { ENERGY_PROFILES } from "../types";
import { api } from "../api";
import { fmtBpm } from "../lib/format";

interface Props {
  folders: Folder[];
  result: DJSet | null;
  onResult: (set: DJSet | null) => void;
  onPlayPreview: (t: Track) => void;
  onLoadTrackToDeckA: (t: Track) => void;
  onLoadTrackToDeckB: (t: Track) => void;
  onLoadToActiveDeck: (t: Track) => void;
  onLoadSetToDecks: (set: DJSet) => void;
  seedTrack: Track | null;
  onClearSeed: () => void;
}

const DURATIONS = [30, 60, 120, 180];
const PROFILES: EnergyProfile[] = ["warmup", "peak_hour", "storytelling", "energy_boost"];

const FILE_TYPES: Record<string, string> = {
  mp3: "MP3", wav: "WAV", flac: "FLAC", aiff: "AIFF", aif: "AIFF",
  ogg: "OGG", m4a: "M4A", opus: "OPUS",
};

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeFileName(name: string): string {
  const clean = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return clean || "SmartSet_Playlist";
}

function fmtTotalTime(sec: number | null): string {
  const s = Math.max(0, Math.floor(sec ?? 0));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function fileTypeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPES[ext] ?? ext.toUpperCase();
}

/** Construye el string XML Rekordbox 1.0.0 directamente en el cliente:
 *  cabecera XML + <COLLECTION> + <PLAYLISTS>, sin peticiones al backend. */
function buildRekordboxXml(set: DJSet): string {
  const items = [...set.items].sort((a, b) => a.position - b.position);
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<DJ_PLAYLISTS Version="1.0.0">');
  lines.push('  <PRODUCT Name="rekordbox" Version="6.0.0" Company="Pioneer DJ"/>');
  lines.push(`  <COLLECTION Entries="${items.length}">`);
  for (const item of items) {
    const t = item.track;
    const attrs: Record<string, string> = {
      Name: t.title ?? "",
      Artist: t.artist ?? "",
      Album: t.album ?? "",
      Genre: "",
      Year: "",
      Comment: "",
      Label: "",
      Remixer: "",
      Tonality: t.musical_key ?? "",
      Key: t.camelot_key ?? "",
      Bpm: t.bpm ? t.bpm.toFixed(1) : "0.0",
      AverageBpm: t.bpm ? t.bpm.toFixed(1) : "0.0",
      TimeSig: "4/4",
      Rating: "0",
      PlayCount: "0",
      Autoload: "0",
      BitRate: "320",
      SampleRate: "44100",
      TotalTime: fmtTotalTime(t.duration_sec),
      Duration: `${Math.floor((t.duration_sec ?? 0) * 1000)}`,
      Size: "0",
      Volume: "0",
      TrackNumber: "0",
      DiscNumber: "0",
      FileType: fileTypeOf(t.file_path),
      DateAdded: "2024-01-01",
      ModificationTime: "2024-01-01",
      Mix: "",
    };
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
      .join(" ");
    lines.push(`    <TRACK ${attrStr}>`);
    lines.push(`      <LOCATION><PATH>${xmlEscape(t.file_path || t.title || "")}</PATH></LOCATION>`);
    lines.push("      <TEMPO/>");
    lines.push("    </TRACK>");
  }
  lines.push("  </COLLECTION>");
  lines.push("  <PLAYLISTS>");
  lines.push('    <NODE Name="Root" Type="0">');
  lines.push(`      <NODE Name="${xmlEscape(set.name)}" Type="1">`);
  for (const item of items) {
    lines.push(`        <TRACK Num="${item.position}" Key="${xmlEscape(item.track.camelot_key ?? "")}"/>`);
  }
  lines.push("      </NODE>");
  lines.push("    </NODE>");
  lines.push("  </PLAYLISTS>");
  lines.push("</DJ_PLAYLISTS>");
  return lines.join("\n");
}

function relationBadge(item: SetItem): { text: string; cls: string } | null {
  if (item.position === 1) {
    return { text: `Intro · ${item.track.camelot_key}`, cls: "text-slate-400" };
  }
  switch (item.transition_relation) {
    case "same":
      return { text: item.transition_label ?? "Perfect Match", cls: "text-emerald-400" };
    case "mode":
      return { text: item.transition_label ?? "Cambio de Modo", cls: "text-sky-400" };
    case "neighbor":
      return { text: item.transition_label ?? "Vecino Armónico", cls: "text-violet-400" };
    case "boost":
      return { text: item.transition_label ?? "Energy Boost +2", cls: "text-amber-400" };
    case "fallback":
      return { text: item.transition_label ?? "Cruce de Respaldo", cls: "text-rose-400" };
    default:
      return null;
  }
}

export default function SetGenerator({
  folders,
  result,
  onResult,
  onPlayPreview,
  onLoadTrackToDeckA,
  onLoadTrackToDeckB,
  onLoadToActiveDeck,
  onLoadSetToDecks,
  seedTrack,
  onClearSeed,
}: Props) {
  const [duration, setDuration] = useState(60);
  const [customDuration, setCustomDuration] = useState("");
  const [selectedFolders, setSelectedFolders] = useState<Set<number>>(new Set());
  const [profile, setProfile] = useState<EnergyProfile>("storytelling");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (folders.length > 0 && selectedFolders.size === 0) {
      setSelectedFolders(new Set(folders.map((f) => f.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders]);

  const effectiveDuration = useMemo(() => {
    if (duration === 0) {
      const v = parseFloat(customDuration);
      return Number.isFinite(v) && v > 0 ? v : null;
    }
    return duration;
  }, [duration, customDuration]);

  const generate = async () => {
    setError("");
    setNotice("");
    if (!effectiveDuration) {
      setError("Indica una duración válida (o usa los presets).");
      return;
    }
    if (selectedFolders.size === 0) {
      setError("Selecciona al menos una carpeta fuente.");
      return;
    }
    setGenerating(true);
    try {
      const set = await api.generateSet({
        duration_min: effectiveDuration,
        folder_ids: [...selectedFolders],
        energy_profile: profile,
        seed_track_id: seedTrack?.id,
        name: null,
      });
      onResult(set);
      setNotice(`Set generado: ${set.items.length} tracks · ${Math.round(set.total_sec / 60)} min`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  const exportUsb = async () => {
    if (!result) return;
    const dest = await (window.smartSet?.selectFolderForExport ? window.smartSet.selectFolderForExport() : Promise.resolve(prompt("Ruta USB de destino (ej: E:\\)")));
    if (!dest) return;
    setExporting("usb");
    try {
      const res = await api.exportUsb(result.id, dest);
      setNotice(`USB: ${res.copied}/${res.total} archivos copiados a ${res.destination}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  };

  const exportXml = async () => {
    if (!result) return;
    setExporting("xml");
    setError("");
    setNotice("");
    try {
      // XML generado 100% en el cliente: sin navegación, sin HTML.
      const xmlString = buildRekordboxXml(result);
      const filename = `${safeFileName(result.name)}.xml`;
      const blob = new Blob([xmlString], { type: "text/xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename; // extensión .xml forzada
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setNotice(`XML exportado con éxito (${filename})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(null);
    }
  };

  const prevKey = (item: SetItem) => (item.position > 1 ? result?.items[item.position - 2]?.track.camelot_key : null);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Panel de parámetros */}
      <div className="shrink-0 border-b border-slate-800 bg-panel p-4">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Duración */}
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
              <Clock size={12} /> Duración
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => setDuration(d)}
                  className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                    duration === d
                      ? "bg-violet-600 text-white"
                      : "bg-panel-2 text-slate-300 hover:bg-panel-3"
                  }`}
                >
                  {d < 60 ? `${d} min` : `${d / 60}h`}
                </button>
              ))}
              <button
                onClick={() => setDuration(0)}
                className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${
                  duration === 0 ? "bg-violet-600 text-white" : "bg-panel-2 text-slate-300 hover:bg-panel-3"
                }`}
              >
                Custom
              </button>
            </div>
            {duration === 0 && (
              <input
                type="number"
                min={1}
                value={customDuration}
                onChange={(e) => setCustomDuration(e.target.value)}
                placeholder="Minutos (ej: 45)"
                className="mt-2 w-full rounded-lg border border-slate-700 bg-panel-2 px-2.5 py-1.5 text-sm text-slate-200 placeholder:text-slate-500 focus:border-violet-500 focus:outline-none"
              />
            )}
          </div>

          {/* Fuentes */}
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
              <FolderTree size={12} /> Fuentes
            </h3>
            <div className="flex flex-wrap gap-2">
              {folders.length === 0 && (
                <p className="w-full rounded-lg border border-dashed border-slate-700 p-2.5 text-center text-[11px] text-slate-400">
                  No hay carpetas importadas. Agrega una carpeta en la barra lateral para poder generar sets.
                </p>
              )}
              {folders.map((f) => (
                <label
                  key={f.id}
                  className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                    selectedFolders.has(f.id)
                      ? "border-violet-500 bg-violet-500/15 text-violet-200"
                      : "border-slate-700 text-slate-400 hover:text-white"
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedFolders.has(f.id)}
                    onChange={() =>
                      setSelectedFolders((prev) => {
                        const next = new Set(prev);
                        if (next.has(f.id)) next.delete(f.id);
                        else next.add(f.id);
                        return next;
                      })
                    }
                    className="h-3 w-3"
                  />
                  {f.name} <span className="text-[9px] text-slate-500">{f.track_count}</span>
                </label>
              ))}
            </div>
            {seedTrack && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                <Sparkles size={12} /> Track semilla: <b className="truncate">{seedTrack.title}</b> ({seedTrack.camelot_key})
                <button onClick={onClearSeed} className="ml-auto font-bold hover:text-white">×</button>
              </div>
            )}
          </div>

          {/* Perfil */}
          <div>
            <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
              <LayoutList size={12} /> Perfil de Curva de Energía
            </h3>
            <div className="space-y-1.5">
              {PROFILES.map((p) => (
                <button
                  key={p}
                  onClick={() => setProfile(p)}
                  className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
                    profile === p
                      ? "border-violet-500 bg-violet-500/15"
                      : "border-slate-700 bg-panel-2 hover:border-slate-500"
                  }`}
                >
                  <span className={`h-6 w-1.5 shrink-0 rounded-full bg-gradient-to-b ${ENERGY_PROFILES[p].color}`} />
                  <span>
                    <span className={`block text-xs font-semibold ${profile === p ? "text-violet-200" : "text-slate-200"}`}>
                      {ENERGY_PROFILES[p].label}
                    </span>
                    <span className="block text-[10px] text-slate-500">{ENERGY_PROFILES[p].description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <button
          onClick={generate}
          disabled={generating || folders.length === 0}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-violet-600 to-fuchsia-600 py-3 text-sm font-black uppercase tracking-widest text-white shadow-lg shadow-violet-900/40 transition hover:brightness-110 disabled:opacity-40"
          title={folders.length === 0 ? "Importa una carpeta primero" : undefined}
        >
          {generating ? <Loader2 size={18} className="animate-spin" /> : <Wand2 size={18} />}
          Generar Set Inteligente
        </button>

        {error && <p className="mt-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</p>}
        {notice && <p className="mt-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400">{notice}</p>}
      </div>

      {/* Resultado */}
      <div className="flex-1 overflow-y-auto p-4">
        {!result ? (
          <div className="grid h-full place-items-center text-center">
            <div className="max-w-sm">
              <Wand2 size={40} className="mx-auto mb-3 text-slate-700" />
              <p className="text-sm font-semibold text-slate-400">Tu set inteligente aparecerá aquí</p>
              <p className="mt-1 text-xs text-slate-600">
                El motor curaduría combinará la Rueda Camelot (±1, cambio de modo, +2 boost), tolerancia de BPM (±2.5%)
                y tu perfil de energía para construir la mezcla perfecta.
              </p>
            </div>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-bold text-white">{result.name}</h2>
              <span className="rounded bg-panel-3 px-2 py-0.5 text-[10px] text-slate-400">
                {result.items.length} tracks · {Math.round(result.total_sec / 60)} min
              </span>
              <button
                onClick={() => onLoadSetToDecks(result)}
                className="rounded-lg border border-cyan-500/50 bg-cyan-500/10 px-2.5 py-1 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-500/20"
              >
                Cargar en Dual Deck
              </button>
              <div className="ml-auto flex gap-2">
                <button
                  onClick={exportXml}
                  disabled={exporting !== null}
                  className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-emerald-500 disabled:opacity-40"
                >
                  {exporting === "xml" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  XML Rekordbox / Serato
                </button>
                <button
                  onClick={exportUsb}
                  disabled={exporting !== null}
                  className="flex items-center gap-1.5 rounded-lg bg-sky-600 px-2.5 py-1.5 text-xs font-bold text-white transition hover:bg-sky-500 disabled:opacity-40"
                >
                  {exporting === "usb" ? <Loader2 size={13} className="animate-spin" /> : <Usb size={13} />}
                  Copiar a USB
                </button>
              </div>
            </div>

            <div className="space-y-1">
              {result.items.map((item) => {
                const badge = relationBadge(item);
                const prev = prevKey(item);
                return (
                  <div key={item.id}>
                    {badge && (
                      <div className="flex items-center gap-2 py-1 pl-10">
                        <span className="h-px flex-1 bg-slate-800" />
                        {prev && (
                          <span className="font-mono text-[9px] text-slate-600">{prev} ➔</span>
                        )}
                        <span className={`rounded-full bg-panel-3 px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                          {badge.text}
                        </span>
                        <span className="h-px flex-1 bg-slate-800" />
                      </div>
                    )}
                    <div
                      className="group flex items-center gap-2 rounded-lg bg-panel-2 px-2.5 py-1.5 transition hover:bg-panel-3"
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData("application/json", JSON.stringify(item.track));
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDoubleClick={() => onLoadToActiveDeck(item.track)}
                      title="Doble clic: cargar en el deck activo · arrastra a un Deck"
                    >
                      <span className="w-6 text-right font-mono text-[10px] text-slate-500">
                        {String(item.position).padStart(2, "0")}
                      </span>
                      <button
                        onDoubleClick={(e) => e.stopPropagation()}
                        onClick={() => onPlayPreview(item.track)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-panel-3 text-slate-300 transition hover:bg-violet-600 hover:text-white"
                        title="Pre-escuchar (carga en Deck A y mueve el fader)"
                      >
                        <Play size={10} className="ml-0.5" />
                      </button>
                      <button
                        onDoubleClick={(e) => e.stopPropagation()}
                        onClick={() => onLoadTrackToDeckA(item.track)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-slate-300 transition hover:bg-cyan-500 hover:text-black"
                        title="Cargar en Deck A"
                      >
                        <Disc3 size={12} />
                      </button>
                      <button
                        onDoubleClick={(e) => e.stopPropagation()}
                        onClick={() => onLoadTrackToDeckB(item.track)}
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-slate-300 transition hover:bg-violet-500 hover:text-black"
                        title="Cargar en Deck B"
                      >
                        <Disc2 size={12} />
                      </button>
                      <div className="min-w-0 flex-1 text-left">
                        <p className="truncate text-xs font-medium text-slate-100">{item.track.title}</p>
                        <p className="truncate text-[10px] text-slate-500">{item.track.artist}</p>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${item.track.camelot_key?.endsWith("B") ? "bg-violet-500/20 text-violet-300" : "bg-cyan-500/20 text-cyan-300"}`}>
                        {item.track.camelot_key}
                      </span>
                      <span className="w-10 text-right font-mono text-[10px] text-slate-400">{fmtBpm(item.track.bpm)}</span>
                      <span className="w-8 text-right font-mono text-[10px] text-slate-500">E{item.track.energy}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
