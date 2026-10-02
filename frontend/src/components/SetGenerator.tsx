import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  AudioLines,
  ChevronDown,
  Clock,
  Disc2,
  Disc3,
  Download,
  Eraser,
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
import { CoverThumb } from "./Artwork";
import EnergyBar from "./EnergyBar";

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
  /** IDs de los tracks que suenan ahora en Deck A/B (resaltado en la lista). */
  playingTrackIds: number[];
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

function formatDuration(sec: number | null): string {
  if (!sec) return "--:--";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fileTypeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return FILE_TYPES[ext] ?? ext.toUpperCase();
}

/** Convierte la ruta local en el URI estricto de Rekordbox:
 *  `file://localhost/C:/Users/.../Track.mp3` — barras invertidas → diagonales
 *  y codificación percent (RFC 3986, UTF-8) de espacios y caracteres
 *  reservados (`%20`, `%23`, `%26`...). Rutas web (blob:/http) sin tocar. */
function rekordboxLocation(path: string): string {
  if (!path) return "";
  if (/^(blob:|https?:|file:)/i.test(path)) return path;
  const norm = path.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(norm)) return norm;
  // encodeURIComponent codifica todo menos A-Za-z0-9-_.!~*'() → cada segmento
  // de la ruta se codifica y se rearma con "/" (y "C:" de la unidad se deja).
  return "file://localhost/" + norm
    .split("/")
    .map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg)))
    .join("/");
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
  items.forEach((item, index) => {
    const t = item.track;
    const fileType = fileTypeOf(t.file_path);
    const location = rekordboxLocation(t.file_path);
    // TrackID = posición dentro de la COLLECTION (1..N); la playlist cuelga
    // de él con <TRACK Key="ID"/> — la referencia que Rekordbox necesita.
    const trackId = index + 1;
    const attrs: Record<string, string> = {
      Name: t.title ?? "",
      Artist: t.artist ?? "",
      Album: t.album ?? "",
      Genre: t.genre ?? "",
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
      FileType: fileType,
      Kind: `${fileType} File`,
      Rate: "0",
      DateAdded: "2024-01-01",
      ModificationTime: "2024-01-01",
      Mix: "",
      Location: location,
      TrackID: String(trackId),
    };
    const attrStr = Object.entries(attrs)
      .map(([k, v]) => `${k}="${xmlEscape(v)}"`)
      .join(" ");
    lines.push(`    <TRACK ${attrStr}>`);
    lines.push(`      <LOCATION><PATH>${xmlEscape(location)}</PATH></LOCATION>`);
    lines.push("      <TEMPO/>");
    lines.push("    </TRACK>");
  });
  lines.push("  </COLLECTION>");
  lines.push("  <PLAYLISTS>");
  lines.push('    <NODE Name="Root" Type="0">');
  lines.push(`      <NODE Entries="${items.length}" KeyType="0" Name="${xmlEscape(set.name)}" Type="1">`);
  items.forEach((item, index) => {
    lines.push(`        <TRACK Num="${item.position}" Key="${String(index + 1)}"/>`);
  });
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

/** Unidad del valor custom: minutos u horas (las horas se convierten a min). */
export type DurationUnit = "min" | "h";

/** Duración efectiva: el preset (30/60/120/180) o el valor custom validado.
 *  Si la unidad es Horas, el valor se convierte a minutos (ej: 6 h → 360 min)
 *  ANTES de entrar en el motor de curaduría. */
function computeEffectiveDuration(duration: number, customDuration: string, unit: DurationUnit): number | null {
  if (duration === 0) {
    const v = parseFloat(customDuration);
    if (!Number.isFinite(v) || v <= 0) return null;
    return unit === "h" ? v * 60 : v;
  }
  return duration;
}

/** Toggle de carpeta fuente: devuelve un nuevo Set (estado inmutable). */
function toggleFolderInSet(prev: Set<number>, id: number): Set<number> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

interface DurationSelectorProps {
  duration: number;
  onDurationChange: (value: number) => void;
  customDuration: string;
  onCustomDurationChange: (value: string) => void;
  durationUnit: DurationUnit;
  onDurationUnitChange: (unit: DurationUnit) => void;
}

/** Selector de duración: presets + opción Custom con input manual y unidad
 *  (Minutos | Horas). Las horas se convierten a minutos internamente. */
function DurationSelector({
  duration,
  onDurationChange,
  customDuration,
  onCustomDurationChange,
  durationUnit,
  onDurationUnitChange,
}: DurationSelectorProps) {
  return (
    <div className="min-w-0 shrink-0">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
        <Clock size={12} /> Duración
      </h3>
      <div className="flex h-[42px] flex-wrap gap-1.5">
        {DURATIONS.map((d) => (
          <button
            key={d}
            onClick={() => onDurationChange(d)}
            className={`h-full rounded-lg border px-2.5 text-xs font-semibold transition ${
              duration === d
                ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_12px_rgba(34,211,238,0.25)]"
                : "border-slate-800 bg-panel-2 text-slate-300 hover:border-cyan-400/30 hover:bg-panel-3 hover:text-cyan-100 hover:shadow-[0_0_10px_rgba(34,211,238,0.15)]"
            }`}
          >
            {d < 60 ? `${d} min` : `${d / 60}h`}
          </button>
        ))}
        <button
          onClick={() => onDurationChange(0)}
          className={`h-full rounded-lg border px-2.5 text-xs font-semibold transition ${
            duration === 0
              ? "border-cyan-400/50 bg-cyan-500/20 text-cyan-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_0_12px_rgba(34,211,238,0.25)]"
              : "border-slate-800 bg-panel-2 text-slate-300 hover:border-cyan-400/30 hover:bg-panel-3 hover:text-cyan-100 hover:shadow-[0_0_10px_rgba(34,211,238,0.15)]"
          }`}
        >
          Custom
        </button>
      </div>
      {duration === 0 && (
        <div className="mt-1 flex items-stretch gap-1">
          <input
            type="number"
            min={1}
            step="any"
            aria-label={`Duración personalizada en ${durationUnit === "h" ? "horas" : "minutos"}`}
            value={customDuration}
            onChange={(e) => onCustomDurationChange(e.target.value)}
            placeholder={durationUnit === "h" ? "Horas (ej: 6)" : "Minutos (ej: 45)"}
            className="w-28 rounded-lg border border-slate-700 bg-panel-2 px-2.5 py-1 text-sm text-slate-200 placeholder:text-slate-500 focus:border-cyan-500 focus:outline-none"
          />
          <div className="flex rounded-lg border border-slate-700 bg-panel-2 p-0.5">
            {(["min", "h"] as const).map((unit) => (
              <button
                key={unit}
                onClick={() => onDurationUnitChange(unit)}
                aria-pressed={durationUnit === unit}
                className={`rounded-md px-2 py-0.5 text-[11px] font-bold transition ${
                  durationUnit === unit
                    ? "bg-cyan-500/20 text-cyan-200 shadow-[0_0_8px_rgba(34,211,238,0.25)]"
                    : "text-slate-500 hover:text-slate-300"
                }`}
              >
                {unit === "min" ? "Minutos" : "Horas"}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SourcesSelectorProps {
  folders: Folder[];
  selectedFolders: Set<number>;
  onToggleFolder: (id: number) => void;
  onSelectAllFolders: () => void;
  onSelectNoFolders: () => void;
  sourcesOpen: boolean;
  onToggleSourcesOpen: () => void;
  sourcesRef: RefObject<HTMLDivElement | null>;
  seedTrack: Track | null;
  onClearSeed: () => void;
}

/** Selector de carpetas fuente con dropdown de checkboxes y track semilla. */
function SourcesSelector({
  folders,
  selectedFolders,
  onToggleFolder,
  onSelectAllFolders,
  onSelectNoFolders,
  sourcesOpen,
  onToggleSourcesOpen,
  sourcesRef,
  seedTrack,
  onClearSeed,
}: SourcesSelectorProps) {
  return (
    <div className="min-w-[190px] flex-1">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
        <FolderTree size={12} /> Fuentes
      </h3>
      <div ref={sourcesRef} className="relative h-[42px]">
        {folders.length === 0 ? (
          <p className="rounded-lg border border-dashed border-slate-700 p-2.5 text-center text-[11px] text-slate-400">
            No hay carpetas importadas. Agrega una carpeta en la barra lateral para poder generar sets.
          </p>
        ) : (
          <>
            <button
              onClick={onToggleSourcesOpen}
              className={`flex h-full w-full items-center gap-2 rounded-lg border px-2.5 text-xs font-semibold transition ${
                sourcesOpen
                  ? "border-violet-500 bg-violet-500/15 text-violet-200"
                  : "border-slate-700 bg-panel-2 text-slate-200 hover:border-slate-500"
              }`}
            >
              <FolderTree size={13} />
              <span className="min-w-0 flex-1 truncate text-left">
                {selectedFolders.size === 0
                  ? "Ninguna carpeta"
                  : selectedFolders.size === folders.length
                    ? "Todas las carpetas"
                    : `${selectedFolders.size} de ${folders.length} carpetas`}
              </span>
              <ChevronDown size={13} className={`shrink-0 transition-transform ${sourcesOpen ? "rotate-180" : ""}`} />
            </button>
            {sourcesOpen && (
              <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-slate-700 bg-panel-2 shadow-xl shadow-black/50">
                <div className="max-h-48 overflow-y-auto p-1.5">
                  {folders.map((f) => (
                    <label
                      key={f.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-slate-300 transition hover:bg-panel-3"
                    >
                      <input
                        type="checkbox"
                        checked={selectedFolders.has(f.id)}
                        onChange={() => onToggleFolder(f.id)}
                        className="h-3 w-3 accent-violet-500"
                      />
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className="text-[9px] text-slate-500">{f.track_count}</span>
                    </label>
                  ))}
                </div>
                <div className="flex gap-2 border-t border-slate-700/70 p-1.5">
                  <button
                    onClick={onSelectAllFolders}
                    className="flex-1 rounded-md bg-panel-3 py-1 text-[10px] font-semibold text-slate-300 transition hover:text-white"
                  >
                    Todas
                  </button>
                  <button
                    onClick={onSelectNoFolders}
                    className="flex-1 rounded-md bg-panel-3 py-1 text-[10px] font-semibold text-slate-500 transition hover:text-rose-300"
                  >
                    Ninguna
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {seedTrack && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
          <Sparkles size={12} /> Track semilla: <b className="truncate">{seedTrack.title}</b> ({seedTrack.camelot_key})
          <button onClick={onClearSeed} aria-label="Quitar track semilla" className="ml-auto font-bold hover:text-white">×</button>
        </div>
      )}
    </div>
  );
}

interface ProfileSelectorProps {
  profile: EnergyProfile;
  onProfileChange: (profile: EnergyProfile) => void;
  profileOpen: boolean;
  onToggleProfileOpen: () => void;
  profileRef: RefObject<HTMLDivElement | null>;
}

/** Selector del perfil de curva de energía con dropdown. */
function ProfileSelector({ profile, onProfileChange, profileOpen, onToggleProfileOpen, profileRef }: ProfileSelectorProps) {
  return (
    <div className="min-w-[200px] flex-1">
      <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-slate-400">
        <LayoutList size={12} /> Perfil de Curva de Energía
      </h3>
      <div ref={profileRef} className="relative h-[42px]">
        <button
          onClick={onToggleProfileOpen}
          className={`flex h-full w-full items-center gap-2 rounded-lg border px-2.5 text-left transition ${
            profileOpen
              ? "border-violet-500 bg-violet-500/15"
              : "border-slate-700 bg-panel-2 hover:border-slate-500"
          }`}
        >
          <span
            className={`h-6 w-1.5 shrink-0 rounded-full bg-gradient-to-b ${ENERGY_PROFILES[profile].color}`}
            title={ENERGY_PROFILES[profile].label}
          />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-100">
            {ENERGY_PROFILES[profile].label}
          </span>
          <ChevronDown
            size={13}
            className={`shrink-0 text-slate-400 transition-transform ${profileOpen ? "rotate-180" : ""}`}
          />
        </button>
        {profileOpen && (
          <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-slate-700 bg-panel-2 shadow-xl shadow-black/50">
            {PROFILES.map((p) => {
              const active = profile === p;
              return (
                <button
                  key={p}
                  onClick={() => onProfileChange(p)}
                  className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition ${
                    active ? "bg-violet-500/10" : "hover:bg-panel-3"
                  }`}
                >
                  <span
                    className={`h-6 w-1.5 shrink-0 rounded-full bg-gradient-to-b ${ENERGY_PROFILES[p].color}`}
                    title={ENERGY_PROFILES[p].label}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className={`font-semibold ${active ? "text-violet-200" : "text-slate-200"}`}>
                      {ENERGY_PROFILES[p].label}
                    </span>
                    <span className="text-slate-500"> — {ENERGY_PROFILES[p].description}</span>
                  </span>
                  {active && (
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-violet-400 shadow-[0_0_6px_rgba(167,139,250,0.9)]" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface GenerateButtonProps {
  generating: boolean;
  disabled: boolean;
  title: string | undefined;
  onGenerate: () => void;
}

/** Botón principal de generación con borde/brillo animado. */
function GenerateButton({ generating, disabled, title, onGenerate }: GenerateButtonProps) {
  return (
    <button
      onClick={onGenerate}
      disabled={disabled}
      className="group relative flex h-[42px] min-w-[240px] flex-1 items-center justify-center gap-2 overflow-hidden rounded-xl border border-cyan-300/50 bg-cyan-500/15 px-4 text-sm font-black uppercase tracking-widest text-cyan-50 shadow-[0_0_18px_rgba(6,182,212,0.22)] backdrop-blur-md transition duration-300 hover:border-cyan-200/80 hover:bg-cyan-400/25 hover:shadow-[0_0_30px_rgba(6,182,212,0.5)] hover:brightness-110 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:brightness-100"
      title={title}
    >
      {/* Borde/brillo animado */}
      <span className="pointer-events-none absolute inset-0 rounded-xl ring-1 ring-inset ring-white/25" />
      <span className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/30 to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full" />
      <span className="relative z-10 flex items-center gap-2">
        {generating ? <Loader2 size={18} className="animate-spin" /> : <Wand2 size={18} />}
        Generar Set Inteligente
      </span>
    </button>
  );
}

interface GeneratorControlsProps {
  duration: number;
  onDurationChange: (value: number) => void;
  customDuration: string;
  onCustomDurationChange: (value: string) => void;
  durationUnit: DurationUnit;
  onDurationUnitChange: (unit: DurationUnit) => void;
  folders: Folder[];
  selectedFolders: Set<number>;
  onToggleFolder: (id: number) => void;
  onSelectAllFolders: () => void;
  onSelectNoFolders: () => void;
  sourcesOpen: boolean;
  onToggleSourcesOpen: () => void;
  sourcesRef: RefObject<HTMLDivElement | null>;
  seedTrack: Track | null;
  onClearSeed: () => void;
  profile: EnergyProfile;
  onProfileChange: (profile: EnergyProfile) => void;
  profileOpen: boolean;
  onToggleProfileOpen: () => void;
  profileRef: RefObject<HTMLDivElement | null>;
  generating: boolean;
  onGenerate: () => void;
  generateDisabled: boolean;
  generateTitle: string | undefined;
  error: string;
  notice: string;
}

/** Panel de parámetros: duración, fuentes, perfil, botón generar y avisos. */
function GeneratorControls({
  duration,
  onDurationChange,
  customDuration,
  onCustomDurationChange,
  durationUnit,
  onDurationUnitChange,
  folders,
  selectedFolders,
  onToggleFolder,
  onSelectAllFolders,
  onSelectNoFolders,
  sourcesOpen,
  onToggleSourcesOpen,
  sourcesRef,
  seedTrack,
  onClearSeed,
  profile,
  onProfileChange,
  profileOpen,
  onToggleProfileOpen,
  profileRef,
  generating,
  onGenerate,
  generateDisabled,
  generateTitle,
  error,
  notice,
}: GeneratorControlsProps) {
  return (
    <div className="shrink-0 border-b border-slate-800 bg-panel px-4 py-3">
      <div className="flex flex-wrap items-end gap-3">
        {/* Duración */}
        <DurationSelector
          duration={duration}
          onDurationChange={onDurationChange}
          customDuration={customDuration}
          onCustomDurationChange={onCustomDurationChange}
          durationUnit={durationUnit}
          onDurationUnitChange={onDurationUnitChange}
        />

        {/* Fuentes */}
        <SourcesSelector
          folders={folders}
          selectedFolders={selectedFolders}
          onToggleFolder={onToggleFolder}
          onSelectAllFolders={onSelectAllFolders}
          onSelectNoFolders={onSelectNoFolders}
          sourcesOpen={sourcesOpen}
          onToggleSourcesOpen={onToggleSourcesOpen}
          sourcesRef={sourcesRef}
          seedTrack={seedTrack}
          onClearSeed={onClearSeed}
        />

        {/* Perfil */}
        <ProfileSelector
          profile={profile}
          onProfileChange={onProfileChange}
          profileOpen={profileOpen}
          onToggleProfileOpen={onToggleProfileOpen}
          profileRef={profileRef}
        />
        <GenerateButton
          generating={generating}
          disabled={generateDisabled}
          title={generateTitle}
          onGenerate={onGenerate}
        />
      </div>
      {(error || notice) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {error && <p className="rounded-lg bg-red-500/10 px-3 py-1 text-xs text-red-400">{error}</p>}
          {notice && <p className="rounded-lg bg-emerald-500/10 px-3 py-1 text-xs text-emerald-400">{notice}</p>}
        </div>
      )}
    </div>
  );
}

interface SetItemRowProps {
  item: SetItem;
  prevKey: string | null;
  playing: boolean;
  onPlayPreview: (track: Track) => void;
  onLoadToDeckA: (track: Track) => void;
  onLoadToDeckB: (track: Track) => void;
  onLoadToActiveDeck: (track: Track) => void;
}

/** Fila del set generado (badge de relación + fila del track). */
function SetItemRow({
  item,
  prevKey,
  playing,
  onPlayPreview,
  onLoadToDeckA,
  onLoadToDeckB,
  onLoadToActiveDeck,
}: SetItemRowProps) {
  const badge = relationBadge(item);
  return (
    <>
      {badge && (
        <tr className="border-t border-slate-800/60">
          <td colSpan={7} className="px-2 py-1">
            <div className="flex items-center gap-2 pl-10">
              <span className="h-px flex-1 bg-slate-800" />
              {prevKey && (
                <span className="font-mono text-[9px] text-slate-600">{prevKey} ➔</span>
              )}
              <span className={`rounded-full bg-panel-3 px-2 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                {badge.text}
              </span>
              <span className="h-px flex-1 bg-slate-800" />
            </div>
          </td>
        </tr>
      )}
      <tr
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/json", JSON.stringify(item.track));
          e.dataTransfer.effectAllowed = "copy";
        }}
        onDoubleClick={() => onLoadToActiveDeck(item.track)}
        className={`group cursor-grab border-t border-slate-800/60 transition hover:bg-panel-2 active:cursor-grabbing ${
          playing
            ? "bg-emerald-500/15 shadow-[inset_3px_0_0_4px_rgba(52,211,153,0.55)]"
            : ""
        }`}
        title="Doble clic: cargar en el deck activo · arrastra a un Deck"
      >
        <td className="whitespace-nowrap px-2 py-1.5" onDoubleClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            <span className="w-6 text-right font-mono text-[10px] text-slate-500">
              {String(item.position).padStart(2, "0")}
            </span>
            <button
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => onPlayPreview(item.track)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-panel-3 text-slate-300 transition hover:bg-violet-600 hover:text-white"
              aria-label="Pre-escuchar"
              title="Pre-escuchar (carga en Deck A y mueve el fader)"
            >
              <Play size={10} className="ml-0.5" />
            </button>
            <button
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => onLoadToDeckA(item.track)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-slate-300 transition hover:bg-cyan-500 hover:text-black"
              aria-label="Cargar en Deck A"
              title="Cargar en Deck A"
            >
              <Disc3 size={12} />
            </button>
            <button
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={() => onLoadToDeckB(item.track)}
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-slate-300 transition hover:bg-violet-500 hover:text-black"
              aria-label="Cargar en Deck B"
              title="Cargar en Deck B"
            >
              <Disc2 size={12} />
            </button>
          </div>
        </td>
        <td className="w-full px-2 py-1.5 font-medium text-slate-100">
          <div className="flex items-center gap-2">
            <CoverThumb track={item.track} size={20} />
            <span className="min-w-0 flex-1 truncate">{item.track.title}</span>
            {playing && (
              <AudioLines size={11} className="shrink-0 animate-pulse text-emerald-400" />
            )}
          </div>
          <div className="truncate pl-7 text-[10px] text-slate-500">{item.track.artist}</div>
        </td>
        <td className="whitespace-nowrap px-2 py-1.5 text-right font-mono text-cyan-300">{fmtBpm(item.track.bpm)}</td>
        <td className="px-2 py-1.5 text-center">
          <span
            className={`rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-black tracking-wider shadow-sm ${
              item.track.camelot_key?.endsWith("B")
                ? "border-violet-400/40 bg-gradient-to-br from-violet-500/35 to-violet-500/5 text-violet-200 shadow-violet-500/20"
                : "border-cyan-400/40 bg-gradient-to-br from-cyan-500/35 to-cyan-500/5 text-cyan-200 shadow-cyan-500/20"
            }`}
          >
            {item.track.camelot_key ?? "-"}
          </span>
        </td>
        <td className="px-2 py-1.5"><EnergyBar value={item.track.energy} /></td>
        <td className="hidden max-w-32 truncate px-2 py-1.5 text-right text-slate-400 sm:table-cell">{item.track.genre ?? "Desconocido"}</td>
        <td className="hidden whitespace-nowrap px-2 py-1.5 text-right font-mono text-slate-400 sm:table-cell">{formatDuration(item.track.duration_sec)}</td>
      </tr>
    </>
  );
}

interface SetResultProps {
  result: DJSet | null;
  playingIds: Set<number>;
  exporting: string | null;
  onExportXml: () => void;
  onExportUsb: () => void;
  onLoadSetToDecks: (set: DJSet) => void;
  onRequestClear: () => void;
  onPlayPreview: (track: Track) => void;
  onLoadTrackToDeckA: (track: Track) => void;
  onLoadTrackToDeckB: (track: Track) => void;
  onLoadToActiveDeck: (track: Track) => void;
}

/** Resultado del generador: vacío o tabla del set con acciones de export. */
function SetResult({
  result,
  playingIds,
  exporting,
  onExportXml,
  onExportUsb,
  onLoadSetToDecks,
  onRequestClear,
  onPlayPreview,
  onLoadTrackToDeckA,
  onLoadTrackToDeckB,
  onLoadToActiveDeck,
}: SetResultProps) {
  if (!result) {
    return (
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
    );
  }
  const prevKey = (item: SetItem) => (item.position > 1 ? result.items[item.position - 2]?.track.camelot_key : null);
  return (
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
        <button
          onClick={onRequestClear}
          title="Limpiar / Nuevo Set"
          className="flex items-center gap-1.5 rounded-lg border border-slate-600 px-2.5 py-1 text-xs font-semibold text-slate-300 transition hover:border-rose-400 hover:text-rose-300"
        >
          <Eraser size={13} /> Limpiar / Nuevo Set
        </button>
        <div className="ml-auto flex gap-2">
          <button
            onClick={onExportXml}
            disabled={exporting !== null}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-emerald-400/50 hover:bg-emerald-500/10 hover:text-emerald-300 hover:shadow-[0_0_10px_rgba(16,185,129,0.25)] disabled:opacity-40"
          >
            {exporting === "xml" ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            XML Rekordbox / Serato
          </button>
          <button
            onClick={onExportUsb}
            disabled={exporting !== null}
            className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-cyan-400/50 hover:bg-cyan-500/10 hover:text-cyan-300 hover:shadow-[0_0_10px_rgba(34,211,238,0.25)] disabled:opacity-40"
          >
            {exporting === "usb" ? <Loader2 size={13} className="animate-spin" /> : <Usb size={13} />}
            Copiar a USB
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-panel text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-2 py-2"></th>
              <th className="w-full px-2 py-2">Título</th>
              <th className="w-14 px-2 py-2 text-right">BPM</th>
              <th className="w-16 px-2 py-2 text-center">Key</th>
              <th className="w-24 px-2 py-2">Energía</th>
              <th className="hidden w-28 px-2 py-2 text-right sm:table-cell">Género</th>
              <th className="hidden w-16 px-2 py-2 text-right sm:table-cell">Duración</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((item) => (
              <SetItemRow
                key={item.id}
                item={item}
                prevKey={prevKey(item)}
                playing={playingIds.has(item.track.id)}
                onPlayPreview={onPlayPreview}
                onLoadToDeckA={onLoadTrackToDeckA}
                onLoadToDeckB={onLoadTrackToDeckB}
                onLoadToActiveDeck={onLoadToActiveDeck}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ClearSetDialogProps {
  onCancel: () => void;
  onConfirm: () => void;
}

/** Diálogo sutil de confirmación: limpiar set (sin window.confirm). */
function ClearSetDialog({ onCancel, onConfirm }: ClearSetDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <button
        type="button"
        onClick={onCancel}
        aria-label="Cancelar"
        className="absolute inset-0 cursor-default"
      />
      <div className="relative w-80 rounded-xl border border-slate-700 bg-[#141a2b] p-4 shadow-2xl shadow-black/70">
        <h3 className="text-sm font-bold text-slate-100">Limpiar set</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
          ¿Limpiar y empezar un nuevo set? La lista actual se vaciará.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-panel-2"
          >
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            className="flex items-center gap-1.5 rounded-lg bg-red-500/90 px-3 py-1.5 text-xs font-bold text-white transition hover:bg-red-500"
          >
            <Eraser size={12} /> Limpiar
          </button>
        </div>
      </div>
    </div>
  );
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
  playingTrackIds,
}: Props) {
  const [duration, setDuration] = useState(60);
  const [customDuration, setCustomDuration] = useState("");
  const [durationUnit, setDurationUnit] = useState<DurationUnit>("min");
  const [selectedFolders, setSelectedFolders] = useState<Set<number>>(new Set());
  const [profile, setProfile] = useState<EnergyProfile>("storytelling");
  const [generating, setGenerating] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const sourcesRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);

  /** Lookup O(1) de los IDs en reproducción para evitar `Array.includes` O(n)
   *  dentro del map de cada item del set. */
  const playingIds = useMemo(() => new Set(playingTrackIds), [playingTrackIds]);

  // Cierra los dropdowns (fuentes / perfil) al hacer clic fuera
  useEffect(() => {
    if (!sourcesOpen && !profileOpen) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node;
      if (sourcesOpen && sourcesRef.current && !sourcesRef.current.contains(target)) {
        setSourcesOpen(false);
      }
      if (profileOpen && profileRef.current && !profileRef.current.contains(target)) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sourcesOpen, profileOpen]);

  // Selección por defecto: al llegar carpetas nuevas sin selección activa se
  // marcan todas. Ajuste de estado por cambio de prop en render (marcador de
  // prop previa que converge en el mismo pase) en vez de en un efecto.
  const [prevFolders, setPrevFolders] = useState(folders);
  if (prevFolders !== folders) {
    setPrevFolders(folders);
    if (folders.length > 0 && selectedFolders.size === 0) {
      setSelectedFolders(new Set(folders.map((f) => f.id)));
    }
  }

  const effectiveDuration = useMemo(
    () => computeEffectiveDuration(duration, customDuration, durationUnit),
    [duration, customDuration, durationUnit]
  );

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
      const blob = new Blob([xmlString], { type: "application/xml;charset=utf-8" });
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

  const toggleFolder = (id: number) => setSelectedFolders((prev) => toggleFolderInSet(prev, id));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Panel de parámetros — TODO en una sola fila horizontal */}
      <GeneratorControls
        duration={duration}
        onDurationChange={setDuration}
        customDuration={customDuration}
        onCustomDurationChange={setCustomDuration}
        durationUnit={durationUnit}
        onDurationUnitChange={setDurationUnit}
        folders={folders}
        selectedFolders={selectedFolders}
        onToggleFolder={toggleFolder}
        onSelectAllFolders={() => setSelectedFolders(new Set(folders.map((f) => f.id)))}
        onSelectNoFolders={() => setSelectedFolders(new Set())}
        sourcesOpen={sourcesOpen}
        onToggleSourcesOpen={() => setSourcesOpen((o) => !o)}
        sourcesRef={sourcesRef}
        seedTrack={seedTrack}
        onClearSeed={onClearSeed}
        profile={profile}
        onProfileChange={(p) => {
          setProfile(p);
          setProfileOpen(false);
        }}
        profileOpen={profileOpen}
        onToggleProfileOpen={() => setProfileOpen((o) => !o)}
        profileRef={profileRef}
        generating={generating}
        onGenerate={() => void generate()}
        generateDisabled={generating || folders.length === 0}
        generateTitle={folders.length === 0 ? "Importa una carpeta primero" : undefined}
        error={error}
        notice={notice}
      />

      {/* Resultado */}
      <div className="flex-1 overflow-y-auto p-4">
        <SetResult
          result={result}
          playingIds={playingIds}
          exporting={exporting}
          onExportXml={() => void exportXml()}
          onExportUsb={() => void exportUsb()}
          onLoadSetToDecks={onLoadSetToDecks}
          onRequestClear={() => setConfirmClear(true)}
          onPlayPreview={onPlayPreview}
          onLoadTrackToDeckA={onLoadTrackToDeckA}
          onLoadTrackToDeckB={onLoadTrackToDeckB}
          onLoadToActiveDeck={onLoadToActiveDeck}
        />
      </div>

      {/* Diálogo sutil de confirmación: limpiar set (sin window.confirm) */}
      {confirmClear && (
        <ClearSetDialog
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => {
            setConfirmClear(false);
            onResult(null);
          }}
        />
      )}
    </div>
  );
}
