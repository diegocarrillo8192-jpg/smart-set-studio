import { useCallback, useEffect, useRef, useState } from "react";
import type { Track } from "../types";
import type { DeckHandle } from "../lib/audio";
import { audioEngine, DEFAULT_PITCH_RANGE } from "../lib/audio";
import { fmtBpm, fmtTime } from "../lib/format";
import { hexRgba } from "../lib/color";
import Artwork from "./Artwork";
import DeckControls from "./DeckControls";
import Waveform from "./Waveform";
import { JogWheel } from "./mixi/JogWheel";
import { PerformancePads } from "./mixi/PerformancePads";
import { useDeckLoopControls } from "./useDeckLoopControls";

interface Props {
  name: "A" | "B";
  track: Track | null;
  handle: DeckHandle | null;
  accent: string;
  /** Deck maestro para el SYNC (el opuesto cargado). null = sin maestro. */
  masterDeck?: "A" | "B" | null;
  /** BPM del deck maestro: objetivo de tempo/fase del SYNC. */
  masterBpm?: number | null;
  /** Destacado neón al ser el deck activo (micro-interacción de cambio de deck). */
  active?: boolean;
  onActivate?: () => void;
  disabled?: boolean;
  /** Notifica arriba (App) si este deck está reproduciendo o se pausó. */
  onPlayingChange?: (playing: boolean) => void;
}

interface DeckTrackChipsProps {
  track: Track;
  effectiveBpm: number;
}

/** Key (Camelot) + BPM efectivo, alineados a la derecha del título. */
function DeckTrackChips({ track, effectiveBpm }: DeckTrackChipsProps) {
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <span
        className={`rounded-md border px-1.5 py-0.5 font-mono text-[11px] font-black tracking-wider shadow-sm ${
          track.camelot_key?.endsWith("B")
            ? "border-violet-400/40 bg-gradient-to-br from-violet-500/40 to-violet-500/5 text-violet-200 shadow-violet-500/20"
            : "border-cyan-400/40 bg-gradient-to-br from-cyan-500/40 to-cyan-500/5 text-cyan-200 shadow-cyan-500/20"
        }`}
      >
        {track.camelot_key ?? "-"}
      </span>
      <span className="rounded-md border border-slate-700/60 bg-slate-800/80 px-1.5 py-0.5 font-mono text-[11px] font-black tracking-wider text-cyan-300">
        {fmtBpm(effectiveBpm > 0 ? effectiveBpm : track.bpm)}
      </span>
    </div>
  );
}

interface DeckInfoHeaderProps {
  name: "A" | "B";
  track: Track | null;
  accent: string;
  effectiveBpm: number;
}

/** Info del track: Deck A = carátula a la izquierda del título,
 *  Deck B = carátula a la derecha (alta fidelidad, marco con glow). */
function DeckInfoHeader({ name, track, accent, effectiveBpm }: DeckInfoHeaderProps) {
  return (
    <div className="flex items-center gap-2.5">
      {name === "A" && (
        <Artwork track={track} accent={accent} size={58} remountKey={track?.id ?? "empty"} />
      )}
      <div key={`info-${track?.id ?? "empty"}`} className="animate-fade-in min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className="mt-0.5 rounded px-1.5 py-0.5 text-[9px] font-black tracking-widest text-black"
            style={{ background: accent, boxShadow: `0 0 12px ${hexRgba(accent, 0.5)}` }}
          >
            {name}
          </span>
          {track ? (
            <p className="truncate text-sm font-bold leading-tight tracking-tight text-zinc-100">
              {track.title}
            </p>
          ) : (
            <p className="truncate text-[11px] font-medium text-slate-500">
              Arrastra un track aquí
            </p>
          )}
        </div>
        {track && (
          <p className="truncate text-[11px] font-medium leading-tight text-slate-400">
            {track.artist}
          </p>
        )}
      </div>
      {track && <DeckTrackChips track={track} effectiveBpm={effectiveBpm} />}
      {name === "B" && (
        <Artwork track={track} accent={accent} size={58} remountKey={track?.id ?? "empty"} />
      )}
    </div>
  );
}

interface DeckWaveformProps {
  track: Track | null;
  analyser: AnalyserNode | null;
  el: HTMLAudioElement | null;
  color: string;
  onSeek: (t: number) => void;
}

/** Waveform limpia con clic/arrastre = buscar (con imán a las líneas de beat:
 *  Near-Line Click Snapping) ; re-monta con fade al cambiar track. */
function DeckWaveform({ track, analyser, el, color, onSeek }: DeckWaveformProps) {
  return (
    <div key={`wave-${track?.id ?? "empty"}`} className="animate-fade-in min-h-0">
      <Waveform
        analyser={analyser}
        el={el}
        bpm={track?.bpm ?? null}
        color={color}
        height={48}
        playheadFrac={0.5}
        grid={false}
        snapToGrid
        analysisPath={track?.file_path ?? null}
        onSeek={onSeek}
      />
    </div>
  );
}

interface DeckTimeCounterProps {
  time: number;
  duration: number;
}

/** Contadores fuera de la onda: transcurrido (izq) · restante/total (der). */
function DeckTimeCounter({ time, duration }: DeckTimeCounterProps) {
  return (
    <div className="flex items-end justify-between font-mono">
      <span className="text-[11px] font-bold tabular-nums tracking-tight text-slate-100">
        {fmtTime(time)}
      </span>
      <span className="text-[11px] tabular-nums tracking-tight text-slate-400">
        -{fmtTime(Math.max(0, duration - time))}
        <span className="mx-1 text-slate-600">/</span>
        <span className="text-slate-300">{fmtTime(duration)}</span>
      </span>
    </div>
  );
}

interface DeckScratchSectionProps {
  name: "A" | "B";
  el: HTMLAudioElement | null;
  playing: boolean;
  color: string;
  track: Track | null;
  onActivate?: () => void;
}

/** Jog wheel (scratch/bend) + pads de hot cue, estilo MIXI. */
function DeckScratchSection({
  name,
  el,
  playing,
  color,
  track,
  onActivate,
}: DeckScratchSectionProps) {
  return (
    <div className="mt-auto flex items-center gap-3">
      <JogWheel name={name} el={el} playing={playing} color={color} size={78} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-[9px] font-bold uppercase tracking-widest text-slate-500">
          Hot Cues
        </span>
        <PerformancePads name={name} el={el} trackId={track?.id ?? null} onActive={onActivate} />
      </div>
    </div>
  );
}

/**
 * Deck estilo Rekordbox: título, artista, key, BPM, PLAY/PAUSE, CUE (flash/hold),
 * SYNC (BPM exacto 1:1 del maestro + snap cuántico de fase en un solo disparo),
 * FILTER (Low Kill), fader de PITCH/TEMPO y waveform con clic/arrastre imantado
 * a las líneas de beat (Near-Line Click Snapping).
 */
export default function Deck({
  name,
  track,
  handle,
  accent,
  masterDeck,
  masterBpm,
  active,
  onActivate,
  disabled,
  onPlayingChange,
}: Props) {
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [cue, setCue] = useState<number | null>(null);
  const [sync, setSync] = useState(false);
  const [lowKill, setLowKill] = useState(false);
  const [pitch, setPitchState] = useState(0);
  const [effectiveBpm, setEffectiveBpm] = useState(0);
  const cueHoldRef = useRef(false);
  const onPlayingChangeRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  }, [onPlayingChange]);

  const el = handle?.el;
  const audioEl = el ?? null;
  const pitchRange = handle?.range ?? DEFAULT_PITCH_RANGE;

  // Estado play/pause vía eventos + tiempo/BPM efectivo muestreados a 60fps.
  useEffect(() => {
    if (!el) return;
    const report = (playing: boolean) => onPlayingChangeRef.current?.(playing);
    const onPlay = () => {
      setPlaying(true);
      report(true);
    };
    const onPause = () => {
      setPlaying(false);
      report(false);
    };
    const onEnded = () => setPlaying(false);
    // ÚLTIMA acción tras cargar un track nuevo: forzar el icono a "Play".
    const onMetadataLoaded = () => setPlaying(false);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("loadedmetadata", onMetadataLoaded);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setTime(el.currentTime);
      setEffectiveBpm(audioEngine.getEffectiveBpm(name));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("loadedmetadata", onMetadataLoaded);
      report(false);
    };
  }, [el, name]);

  // Al cambiar de track: reset del CUE, del SYNC y del PITCH (rate vuelve a
  // 1); el FILTER (Low Kill) se conserva, como un interruptor de hardware.
  // El reset del LOOP vive en useDeckLoopControls (keyed por track?.id).
  const [prevTrackId, setPrevTrackId] = useState(track?.id);
  if (prevTrackId !== track?.id) {
    setPrevTrackId(track?.id);
    setCue(null);
    setSync(false);
    setPlaying(false);
    setPitchState(0);
  }
  // El side-effect del motor (playbackRate → 1, SYNC fuera, loop liberado)
  // va aparte en un efecto keyed por la prop que lo dispara.
  useEffect(() => {
    audioEngine.setPitch(name, 0);
    audioEngine.exitLoop(name);
  }, [track?.id, name]);

  const toggle = useCallback(() => {
    if (!el) return;
    onActivate?.();
    // Reanudar el contexto en el gesto del usuario: en navegador el AudioContext
    // nace suspendido (autoplay policy) y sin resume() el sonido no llega.
    audioEngine.ensureContext();
    // Vía el motor: si hay un SYNC armado en pausa, se aplica (rate + fase)
    // justo en este gesto, nunca antes.
    if (el.paused) audioEngine.play(name);
    else audioEngine.pause(name);
  }, [el, name, onActivate]);

  /** SYNC: Hard Lock de un solo disparo — clava el BPM exacto del maestro
   *  (1:1, rate FIJO sin variaciones) y da el Absolute Beatgrid Snap de la
   *  aguja a la línea de beat más cercana de su rejilla. Suene o esté en
   *  pausa, el motor aplica rate + fase YA MISMO y los deja ESTÁTICOS:
   *  sin watchdog ni micro-correcciones (cero oscilación de grilla). */
  const toggleSync = useCallback(() => {
    if (!el || !track?.bpm || !masterBpm || !masterDeck) return;
    onActivate?.();
    const next = !sync;
    setSync(next);
    if (next) {
      audioEngine.ensureContext();
      audioEngine.syncTo(name, masterDeck);
      setPitchState(audioEngine.getPitch(name));
    } else {
      audioEngine.clearSync(name);
      setPitchState(audioEngine.getPitch(name));
    }
  }, [el, track?.bpm, masterBpm, masterDeck, sync, name, onActivate]);

  // Re-sincronización DINÁMICA: si el BPM del deck maestro cambia (se carga un
  // track nuevo o se mueve su pitch) mientras el SYNC está activo, se reaplica
  // el BPM exacto 1:1 y el snap cuántico para no perder la alineación.
  useEffect(() => {
    if (sync && track?.bpm && masterBpm && masterDeck) {
      audioEngine.syncTo(name, masterDeck);
      setPitchState(audioEngine.getPitch(name));
    }
  }, [masterBpm, sync, track?.bpm, masterDeck, name]);

  /** FILTER (Low Kill): switch que corta/activa los graves con un pasa-altos. */
  const toggleFilter = useCallback(() => {
    if (!el) return;
    onActivate?.();
    const next = !lowKill;
    setLowKill(next);
    audioEngine.setLowKill(name, next);
  }, [el, lowKill, name, onActivate]);

  // Loops / Beat Jump: estado y motor en useDeckLoopControls (cuantización
  // exacta a la grilla, fase continua, SYNC conservado).
  const { loopBeats, loopInPending, handleAutoLoop, handleLoopIn, handleLoopOut, handleExitLoop, handleBeatJump } =
    useDeckLoopControls(name, el ?? null, track?.bpm ?? null, onActivate, track?.id ?? null);

  /** PITCH/TEMPO: fader directo sobre playbackRate (cancela el SYNC). */
  const changePitch = useCallback(
    (value: number) => {
      if (!el) return;
      onActivate?.();
      if (sync) setSync(false);
      setPitchState(value);
      audioEngine.setPitch(name, value);
    },
    [el, sync, name, onActivate]
  );

  const resetPitch = useCallback(() => {
    if (!el) return;
    if (sync) setSync(false);
    setPitchState(0);
    audioEngine.setPitch(name, 0);
  }, [el, sync, name]);

  // CUE Flash/Hold (pre-listener estándar DJ): al presionar salta al punto CUE
  // y reproduce mientras se mantiene; al soltar pausa y vuelve al CUE.
  const onCueDown = useCallback(() => {
    if (!el || !track) return;
    onActivate?.();
    audioEngine.ensureContext();
    if (cue === null) setCue(el.currentTime);
    const target = cue ?? el.currentTime;
    // Salto inmediato sin seek redundante: si ya estamos en el CUE (primer
    // disparo o re-trigger), play() arranca en el MISMO milisegundo, sin
    // esperar a una operación de seeking del elemento de audio.
    if (Math.abs(el.currentTime - target) > 0.001) el.currentTime = target;
    cueHoldRef.current = true;
    if (el.paused) void el.play().catch(() => {});
  }, [el, track, cue, onActivate]);

  const onCueUp = useCallback(() => {
    if (!el || !cueHoldRef.current) return;
    cueHoldRef.current = false;
    if (cue !== null && !el.paused) {
      el.pause();
      el.currentTime = cue;
    }
  }, [el, cue]);

  /** Seek sobre el elemento de audio (waveform): referencia estable. */
  const handleSeek = useCallback(
    (t: number) => {
      if (el) el.currentTime = t;
    },
    [el]
  );

  const duration = track?.duration_sec ?? el?.duration ?? 0;

  return (
    <div
      className={`flex h-full min-h-0 flex-col gap-2.5 rounded-2xl border p-3 backdrop-blur-xl transition duration-700 ease-out ${
        disabled ? "opacity-50" : ""
      } ${
        active
          ? "border-slate-700/80 bg-gradient-to-b from-white/[0.06] to-white/[0.015] shadow-[0_16px_48px_rgba(0,0,0,0.55)]"
          : "border-slate-800/50 bg-gradient-to-b from-white/[0.045] to-white/[0.008] shadow-[0_12px_36px_rgba(0,0,0,0.5)]"
      }`}
      style={
        active
          ? {
              boxShadow: `0 16px 48px rgba(0,0,0,0.55), 0 0 24px ${hexRgba(
                accent,
                0.22
              )}, inset 0 0 0 1px ${hexRgba(accent, 0.35)}`,
            }
          : undefined
      }
    >
      <DeckInfoHeader name={name} track={track} accent={accent} effectiveBpm={effectiveBpm} />

      {/* Controles directos: PLAY/CUE/SYNC/FILTER + PITCH/TEMPO + reloj */}
      <DeckControls
        name={name}
        accent={accent}
        el={audioEl}
        track={track}
        masterBpm={masterBpm}
        playing={playing}
        cue={cue}
        sync={sync}
        lowKill={lowKill}
        time={time}
        pitch={pitch}
        pitchRange={pitchRange}
        effectiveBpm={effectiveBpm}
        loopBeats={loopBeats}
        loopInPending={loopInPending}
        onToggle={toggle}
        onCueDown={onCueDown}
        onCueUp={onCueUp}
        onCueReset={() => {
          if (el) setCue(el.currentTime);
        }}
        onToggleSync={toggleSync}
        onToggleFilter={toggleFilter}
        onPitchChange={changePitch}
        onPitchReset={resetPitch}
        onAutoLoop={handleAutoLoop}
        onLoopIn={handleLoopIn}
        onLoopOut={handleLoopOut}
        onExitLoop={handleExitLoop}
        onBeatJump={handleBeatJump}
      />

      <DeckWaveform
        track={track}
        analyser={handle?.analyser ?? null}
        el={audioEl}
        color={accent}
        onSeek={handleSeek}
      />
      <DeckTimeCounter time={time} duration={duration} />
      <DeckScratchSection
        name={name}
        el={audioEl}
        playing={playing}
        color={accent}
        track={track}
        onActivate={onActivate}
      />
    </div>
  );
}
