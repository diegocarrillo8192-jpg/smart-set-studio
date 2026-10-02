import type { CSSProperties } from "react";
import { Filter, Link2, Pause, Play, RotateCcw, Timer } from "lucide-react";
import type { Track } from "../types";
import { fmtBpm, fmtTime } from "../lib/format";

/** Glow neón del botón PLAY según el deck (constante: no se recrea por render). */
const GLOW_PLAY: Record<"A" | "B", string> = {
  A: "hover:shadow-[0_0_18px_rgba(34,211,238,0.55)] active:shadow-[0_0_26px_rgba(34,211,238,0.8)]",
  B: "hover:shadow-[0_0_18px_rgba(167,139,250,0.55)] active:shadow-[0_0_26px_rgba(167,139,250,0.8)]",
};

/** Longitudes de Auto Loop (beats) y saltos de Beat Jump del deck. */
const AUTO_LOOPS = [
  { beats: 0.5, label: "1/2" },
  { beats: 1, label: "1" },
  { beats: 2, label: "2" },
  { beats: 4, label: "4" },
  { beats: 8, label: "8" },
  { beats: 16, label: "16" },
  { beats: 32, label: "32" },
] as const;

const BEAT_JUMPS = [
  { beats: -8, label: "-8" },
  { beats: -4, label: "-4" },
  { beats: 4, label: "+4" },
  { beats: 8, label: "+8" },
] as const;

interface Props {
  name: "A" | "B";
  accent: string;
  el: HTMLAudioElement | null;
  track: Track | null;
  masterBpm?: number | null;
  playing: boolean;
  cue: number | null;
  sync: boolean;
  lowKill: boolean;
  time: number;
  /** Pitch actual del fader en porcentaje. */
  pitch: number;
  /** Rango simétrico del fader de pitch (± %). */
  pitchRange: number;
  /** BPM efectivo del deck (source BPM × playbackRate). */
  effectiveBpm: number;
  /** Beats del loop activo (null = sin loop). */
  loopBeats: number | null;
  /** LOOP IN pendiente (punto fijado, sin OUT todavía). */
  loopInPending: boolean;
  onToggle: () => void;
  onCueDown: () => void;
  onCueUp: () => void;
  onCueReset: () => void;
  onToggleSync: () => void;
  onToggleFilter: () => void;
  onPitchChange: (value: number) => void;
  onPitchReset: () => void;
  onAutoLoop: (beats: number) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onExitLoop: () => void;
  onBeatJump: (beats: number) => void;
}

interface PlayButtonProps {
  name: "A" | "B";
  accent: string;
  playing: boolean;
  disabled: boolean;
  onToggle: () => void;
}

/** PLAY/PAUSE: botón circular con el glow neón del deck.
 *  onPointerDown = disparo en el milisegundo exacto del gesto (sin esperar
 *  el ciclo completo de click del navegador). */
function PlayButton({ name, accent, playing, disabled, onToggle }: PlayButtonProps) {
  return (
    <button
      onPointerDown={(e) => {
        if (e.button === 0) onToggle();
      }}
      disabled={disabled}
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-black transition hover:scale-105 disabled:opacity-30 ${GLOW_PLAY[name]}`}
      style={{ background: accent }}
      title={playing ? "Pausar" : "Reproducir"}
    >
      {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
    </button>
  );
}

interface CueButtonProps {
  accent: string;
  cue: number | null;
  disabled: boolean;
  onCueDown: () => void;
  onCueUp: () => void;
  onCueReset: () => void;
}

/** CUE Flash/Hold */
function CueButton({ accent, cue, disabled, onCueDown, onCueUp, onCueReset }: CueButtonProps) {
  return (
    <button
      onPointerDown={onCueDown}
      onPointerUp={onCueUp}
      onPointerLeave={onCueUp}
      onPointerCancel={onCueUp}
      onContextMenu={(e) => {
        e.preventDefault();
        onCueReset();
      }}
      disabled={disabled}
      className={`relative h-9 shrink-0 rounded-md border px-3 text-[10px] font-black tracking-widest transition disabled:opacity-30 active:scale-95 hover:shadow-[0_0_14px_rgba(255,255,255,0.35)] ${
        cue !== null ? "shadow-[0_0_12px_rgba(255,255,255,0.4)]" : ""
      }`}
      style={{
        background: cue !== null ? accent : "transparent",
        borderColor: cue !== null ? "#ffffff" : "#475569",
        color: cue !== null ? "#000000" : "#cbd5e1",
      }}
      title={
        cue !== null
          ? `CUE en ${fmtTime(cue)} — mantener: pre-escucha (flash) · clic derecho: re-fijar`
          : "Fijar CUE en la posición actual"
      }
    >
      CUE
      {cue !== null && (
        <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]" />
      )}
    </button>
  );
}

interface SyncButtonProps {
  sync: boolean;
  masterBpm?: number | null;
  trackBpm?: number | null;
  disabled: boolean;
  onToggleSync: () => void;
}

/** SYNC: Hard Lock — clava el BPM EXACTO del deck maestro (1:1, rate fijo) y
 *  da un Absolute Beatgrid Snap de la aguja a la línea de beat más cercana.
 *  Sin correcciones dinámicas: las grillas quedan superpuestas y ESTÁTICAS. */
function SyncButton({ sync, masterBpm, trackBpm, disabled, onToggleSync }: SyncButtonProps) {
  return (
    <button
      onPointerDown={(e) => {
        if (e.button === 0) onToggleSync();
      }}
      disabled={disabled || !masterBpm || !trackBpm}
      title={
        sync
          ? "Sincronizado (Hard Lock: BPM y grilla clavados y estáticos) — clic para volver al tempo original"
          : masterBpm
            ? `SYNC: clavar BPM exacto (${fmtBpm(masterBpm)}) y saltar a la línea de beat más cercana`
            : "Carga un track en el deck maestro para usar SYNC"
      }
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[10px] font-black tracking-widest transition active:scale-95 disabled:opacity-30 ${
        sync
          ? "border-emerald-400/70 bg-emerald-500/15 text-emerald-300 shadow-[0_0_14px_rgba(16,185,129,0.4)]"
          : "border-slate-700 text-slate-400 hover:border-emerald-400/40 hover:text-emerald-300 hover:shadow-[0_0_10px_rgba(16,185,129,0.2)]"
      }`}
    >
      <Link2
        size={12}
        className={sync ? "text-emerald-400 drop-shadow-[0_0_4px_rgba(16,185,129,0.9)]" : ""}
      />
      SYNC
    </button>
  );
}

interface FilterButtonProps {
  lowKill: boolean;
  disabled: boolean;
  onToggleFilter: () => void;
}

/** FILTER (Low Kill): pasa-altos que corta los graves, con LED al activarse */
function FilterButton({ lowKill, disabled, onToggleFilter }: FilterButtonProps) {
  return (
    <button
      onPointerDown={(e) => {
        if (e.button === 0) onToggleFilter();
      }}
      disabled={disabled}
      title={
        lowKill
          ? "Low Kill activado — clic para restaurar los graves"
          : "Low Kill: corta los graves de golpe (pasa-altos)"
      }
      className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[10px] font-black tracking-widest transition active:scale-95 disabled:opacity-30 ${
        lowKill
          ? "border-violet-400/70 bg-violet-500/15 text-violet-300 shadow-[0_0_14px_rgba(167,139,250,0.4)]"
          : "border-slate-700 text-slate-400 hover:border-violet-400/40 hover:text-violet-300 hover:shadow-[0_0_10px_rgba(167,139,250,0.2)]"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full transition ${
          lowKill
            ? "bg-violet-400 shadow-[0_0_7px_rgba(167,139,250,0.95)]"
            : "bg-slate-700"
        }`}
      />
      <Filter
        size={12}
        className={lowKill ? "text-violet-400 drop-shadow-[0_0_4px_rgba(167,139,250,0.9)]" : ""}
      />
      FILTER
    </button>
  );
}

interface PitchRowProps {
  accent: string;
  pitch: number;
  pitchRange: number;
  pitchLabel: string;
  effectiveBpm: number;
  disabled: boolean;
  onPitchChange: (value: number) => void;
  onPitchReset: () => void;
}

/** PITCH / TEMPO: fader continuo + RESET + BPM efectivo */
function PitchRow({
  accent,
  pitch,
  pitchRange,
  pitchLabel,
  effectiveBpm,
  disabled,
  onPitchChange,
  onPitchReset,
}: PitchRowProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex shrink-0 items-center gap-1 text-[9px] font-black tracking-widest text-slate-400">
        <Timer size={11} style={{ color: accent }} />
        PITCH
      </span>
      <input
        type="range"
        min={-pitchRange}
        max={pitchRange}
        step={0.1}
        value={pitch}
        disabled={disabled}
        onChange={(e) => onPitchChange(Number(e.target.value))}
        onDoubleClick={onPitchReset}
        className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700 accent-slate-300 disabled:opacity-30"
        style={{ accentColor: accent }}
        title="Pitch / Tempo (arrastra) · doble clic: RESET"
      />
      <span
        className={`w-12 shrink-0 text-right font-mono text-[10px] font-bold tabular-nums ${
          pitch === 0 ? "text-slate-400" : "text-amber-300"
        }`}
      >
        {pitchLabel}
      </span>
      <button
        onClick={onPitchReset}
        disabled={disabled}
        title="Reset de pitch (0%)"
        className="grid h-6 w-6 shrink-0 place-items-center rounded border border-slate-700 text-slate-400 transition hover:border-slate-500 hover:text-slate-200 disabled:opacity-30"
      >
        <RotateCcw size={11} />
      </button>
      <span className="w-16 shrink-0 rounded border border-slate-700/60 bg-slate-800/60 px-1.5 py-0.5 text-right font-mono text-[10px] font-bold tracking-wide text-cyan-300">
        {effectiveBpm > 0 ? fmtBpm(effectiveBpm) : "-"} BPM
      </span>
    </div>
  );
}

interface LoopRowProps {
  accent: string;
  loopBeats: number | null;
  loopInPending: boolean;
  disabled: boolean;
  onAutoLoop: (beats: number) => void;
  onLoopIn: () => void;
  onLoopOut: () => void;
  onExitLoop: () => void;
  onBeatJump: (beats: number) => void;
}

/** LOOP (Auto Loop cuantizado + In/Out + Exit) + BEAT JUMP (±8/±4).
 *  Los pads de loop se iluminan con el acento del deck cuando están activos;
 *  el disparo es onPointerDown (milisegundo exacto del gesto). */
function LoopRow({
  accent,
  loopBeats,
  loopInPending,
  disabled,
  onAutoLoop,
  onLoopIn,
  onLoopOut,
  onExitLoop,
  onBeatJump,
}: LoopRowProps) {
  const pad = (active: boolean) =>
    `h-7 rounded-md border px-2 text-[9px] font-black tracking-widest transition active:scale-95 disabled:opacity-30 ${
      active ? "" : "text-slate-400 hover:text-slate-200"
    }`;
  const padStyle = (active: boolean): CSSProperties =>
    active
      ? { background: accent, borderColor: "#ffffff", color: "#000", boxShadow: `0 0 12px ${accent}99` }
      : { background: "transparent", borderColor: "#475569" };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="flex shrink-0 items-center gap-1 text-[9px] font-black tracking-widest text-slate-400">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: loopBeats !== null ? accent : "#334155" }} />
        LOOP
      </span>
      {AUTO_LOOPS.map((l) => {
        const active = loopBeats === l.beats;
        return (
          <button
            key={l.label}
            onPointerDown={(e) => {
              if (e.button === 0) onAutoLoop(l.beats);
            }}
            disabled={disabled}
            className={pad(active)}
            style={padStyle(active)}
            title={`Auto Loop ${l.beats} beats (cuantizado a la grilla)${active ? " — clic para salir" : ""}`}
          >
            {l.label}
          </button>
        );
      })}
      <button
        onPointerDown={(e) => {
          if (e.button === 0) onLoopIn();
        }}
        disabled={disabled}
        className={pad(loopInPending)}
        style={padStyle(loopInPending)}
        title="LOOP IN: fija el inicio del loop en el beat actual"
      >
        IN
      </button>
      <button
        onPointerDown={(e) => {
          if (e.button === 0) onLoopOut();
        }}
        disabled={disabled || !loopInPending}
        className={pad(false)}
        style={padStyle(false)}
        title="LOOP OUT: cierra el loop en el beat actual"
      >
        OUT
      </button>
      <button
        onPointerDown={(e) => {
          if (e.button === 0) onExitLoop();
        }}
        disabled={disabled || loopBeats === null}
        className={`${pad(loopBeats !== null)} ${loopBeats !== null ? "" : "opacity-40"}`}
        style={padStyle(loopBeats !== null)}
        title="EXIT: libera el loop sin desfasar el track"
      >
        EXIT
      </button>

      <span className="ml-2 flex shrink-0 items-center gap-1 text-[9px] font-black tracking-widest text-slate-400">
        JUMP
      </span>
      {BEAT_JUMPS.map((j) => (
        <button
          key={j.label}
          onPointerDown={(e) => {
            if (e.button === 0) onBeatJump(j.beats);
          }}
          disabled={disabled}
          className={pad(false)}
          style={padStyle(false)}
          title={`Beat Jump ${j.label} (salto cuantizado sobre la grilla, sin perder el SYNC)`}
        >
          {j.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Controles directos del deck: PLAY/PAUSE, CUE (flash/hold), SYNC, FILTER
 * (Low Kill), LOOP (auto/in/out/exit), BEAT JUMP, reloj y fader de
 * PITCH/TEMPO con RESET. Presentacional puro: todo el estado vive en el
 * Deck padre.
 */
export default function DeckControls({
  name,
  accent,
  el,
  track,
  masterBpm,
  playing,
  cue,
  sync,
  lowKill,
  time,
  pitch,
  pitchRange,
  effectiveBpm,
  loopBeats,
  loopInPending,
  onToggle,
  onCueDown,
  onCueUp,
  onCueReset,
  onToggleSync,
  onToggleFilter,
  onPitchChange,
  onPitchReset,
  onAutoLoop,
  onLoopIn,
  onLoopOut,
  onExitLoop,
  onBeatJump,
}: Props) {
  const loaded = !!el && !!track;
  const pitchLabel = `${pitch >= 0 ? "+" : ""}${pitch.toFixed(1)}%`;
  const disabled = !loaded;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <PlayButton
          name={name}
          accent={accent}
          playing={playing}
          disabled={disabled}
          onToggle={onToggle}
        />
        <CueButton
          accent={accent}
          cue={cue}
          disabled={disabled}
          onCueDown={onCueDown}
          onCueUp={onCueUp}
          onCueReset={onCueReset}
        />
        <SyncButton
          sync={sync}
          masterBpm={masterBpm}
          trackBpm={track?.bpm}
          disabled={disabled}
          onToggleSync={onToggleSync}
        />
        <FilterButton lowKill={lowKill} disabled={disabled} onToggleFilter={onToggleFilter} />
        <div className="ml-auto font-mono text-[10px] text-slate-400">{fmtTime(time)}</div>
      </div>
      <LoopRow
        accent={accent}
        loopBeats={loopBeats}
        loopInPending={loopInPending}
        disabled={disabled}
        onAutoLoop={onAutoLoop}
        onLoopIn={onLoopIn}
        onLoopOut={onLoopOut}
        onExitLoop={onExitLoop}
        onBeatJump={onBeatJump}
      />
      <PitchRow
        accent={accent}
        pitch={pitch}
        pitchRange={pitchRange}
        pitchLabel={pitchLabel}
        effectiveBpm={effectiveBpm}
        disabled={disabled}
        onPitchChange={onPitchChange}
        onPitchReset={onPitchReset}
      />
    </div>
  );
}
