import { useEffect, useRef, useState } from "react";
import { Filter, Link2, Pause, Play } from "lucide-react";
import type { Track } from "../types";
import type { DeckHandle } from "../lib/audio";
import { audioEngine } from "../lib/audio";
import { fmtBpm } from "../lib/format";
import { hexRgba } from "../lib/color";
import Artwork from "./Artwork";
import Waveform from "./Waveform";

interface Props {
  name: "A" | "B";
  track: Track | null;
  handle: DeckHandle | null;
  accent: string;
  /** BPM del deck maestro (Deck A): objetivo de tempo/fase del SYNC. */
  masterBpm?: number | null;
  /** Destacado neón al ser el deck activo (micro-interacción de cambio de deck). */
  active?: boolean;
  onActivate?: () => void;
  disabled?: boolean;
  /** Notifica arriba (App) si este deck está reproduciendo o se pausó. */
  onPlayingChange?: (playing: boolean) => void;
}

function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Deck compacto estilo Rekordbox: título, artista, key, BPM, PLAY/PAUSE,
 * CUE (flash/hold), SYNC (iguala BPM con el deck opuesto vía playbackRate),
 * FILTER (Low Kill) y waveform limpia con clic/arrastre para buscar.
 * Sin jog ni pitch: control directo por plato.
 */
export default function Deck({
  name,
  track,
  handle,
  accent,
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
  const cueHoldRef = useRef(false);
  const onPlayingChangeRef = useRef(onPlayingChange);
  useEffect(() => {
    onPlayingChangeRef.current = onPlayingChange;
  });

  const el = handle?.el;

  // Estado play/pause vía eventos + tiempo muestreado a 60fps (rAF)
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
    // El reemplazo de un track que sonaba dispara pause()/load() internos que
    // pueden dejar el estado visual en "Pausa"; al completarse la carga de la
    // metadata (loadedmetadata) se garantiza el reset visual definitivo.
    const onMetadataLoaded = () => setPlaying(false);
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    el.addEventListener("loadedmetadata", onMetadataLoaded);
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setTime(el.currentTime);
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
  }, [el]);

  // Al cambiar de track: reset del CUE y del SYNC (rate vuelve a 1);
  // el FILTER (Low Kill) se conserva, como un interruptor de hardware.
  // El estado visual del botón se fuerza a "Play" (listo para reproducir):
  // el track nuevo arranca pausado, aunque el anterior hubiera quedado en
  // "Pause" por eventos del elemento de audio.
  useEffect(() => {
    setCue(null);
    setSync(false);
    setPlaying(false);
    if (name) audioEngine.clearSync(name);
  }, [track?.id, name]);

  const toggle = () => {
    if (!el) return;
    onActivate?.();
    // Reanudar el contexto en el gesto del usuario: en navegador el AudioContext
    // nace suspendido (autoplay policy) y sin resume() el sonido no llega.
    audioEngine.ensureContext();
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  };

  /** SYNC: iguala de inmediato el tempo (y alinea la fase de beat) de este
   *  deck con el deck maestro (Deck A). */
  const toggleSync = () => {
    if (!el || !track?.bpm || !masterBpm) return;
    onActivate?.();
    const next = !sync;
    setSync(next);
    if (next) {
      audioEngine.setSync(name, masterBpm / track.bpm);
      audioEngine.alignPhase(name, track.bpm, masterBpm);
    } else {
      audioEngine.clearSync(name);
    }
  };

  // Re-sincronización DINÁMICA: si el BPM del deck maestro (Deck A) cambia
  // (se carga un track nuevo) mientras el SYNC está activo, se reaplica el
  // tempo y la fase para no perder la alineación. Solo depende de `masterBpm`:
  // el cambio de track PROPIO ya resetea el SYNC en el efecto anterior y no
  // debe re-sincronizarse solo.
  useEffect(() => {
    if (sync && track?.bpm && masterBpm) {
      audioEngine.setSync(name, masterBpm / track.bpm);
      audioEngine.alignPhase(name, track.bpm, masterBpm);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [masterBpm]);

  /** FILTER (Low Kill): switch que corta/activa los graves con un pasa-altos. */
  const toggleFilter = () => {
    if (!el) return;
    onActivate?.();
    const next = !lowKill;
    setLowKill(next);
    audioEngine.setLowKill(name, next);
  };

  // CUE Flash/Hold (pre-listener estándar DJ): al presionar salta al punto CUE
  // y reproduce mientras se mantiene; al soltar pausa y vuelve al CUE.
  const onCueDown = () => {
    if (!el || !track) return;
    onActivate?.();
    audioEngine.ensureContext();
    if (cue === null) setCue(el.currentTime);
    el.currentTime = cue ?? el.currentTime;
    cueHoldRef.current = true;
    if (el.paused) void el.play().catch(() => {});
  };

  const onCueUp = () => {
    if (!el || !cueHoldRef.current) return;
    cueHoldRef.current = false;
    if (cue !== null && !el.paused) {
      el.pause();
      el.currentTime = cue;
    }
  };

  const duration = track?.duration_sec ?? el?.duration ?? 0;
  const glowPlay =
    name === "A"
      ? "hover:shadow-[0_0_18px_rgba(34,211,238,0.55)] active:shadow-[0_0_26px_rgba(34,211,238,0.8)]"
      : "hover:shadow-[0_0_18px_rgba(167,139,250,0.55)] active:shadow-[0_0_26px_rgba(167,139,250,0.8)]";

  return (
    <div
      className={`flex h-full min-h-0 flex-col gap-2.5 rounded-2xl border p-3 backdrop-blur-xl transition-all duration-700 ease-out ${
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
      {/* Info del track: Deck A = carátula a la izquierda del título,
          Deck B = carátula a la derecha (alta fidelidad, marco con glow) */}
      <div className="flex items-center gap-2.5">
        {name === "A" && (
          <Artwork track={track} accent={accent} size={58} remountKey={track?.id ?? "empty"} />
        )}
        <div
          key={`info-${track?.id ?? "empty"}`}
          className="animate-fade-in min-w-0 flex-1"
        >
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
        {track && (
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
              {fmtBpm(track.bpm)}
            </span>
          </div>
        )}
        {name === "B" && (
          <Artwork track={track} accent={accent} size={58} remountKey={track?.id ?? "empty"} />
        )}
      </div>

      {/* Controles directos: en pantallas estrechas los botones se reordenan en
          varias filas para que entren en el ancho del teléfono */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={toggle}
          disabled={!el || !track}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-black transition hover:scale-105 disabled:opacity-30 ${glowPlay}`}
          style={{ background: accent }}
          title={playing ? "Pausar" : "Reproducir"}
        >
          {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
        </button>

        {/* CUE Flash/Hold */}
        <button
          onPointerDown={onCueDown}
          onPointerUp={onCueUp}
          onPointerLeave={onCueUp}
          onPointerCancel={onCueUp}
          onContextMenu={(e) => {
            e.preventDefault();
            if (el) setCue(el.currentTime);
          }}
          disabled={!el || !track}
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
          {cue !== null && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.9)]" />}
        </button>

        {/* SYNC: iguala el BPM (y alinea la fase) con el deck maestro (A) */}
        <button
          onClick={toggleSync}
          disabled={!el || !track || !masterBpm || !track.bpm}
          title={
            sync
              ? "Sincronizado con Deck A (maestro) — clic para volver al tempo original"
              : masterBpm
                ? `SYNC: igualar BPM y fase con Deck A (maestro) (${fmtBpm(masterBpm)})`
                : "Carga un track en Deck A para usar SYNC"
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

        {/* FILTER (Low Kill): pasa-altos que corta los graves, con LED al activarse */}
        <button
          onClick={toggleFilter}
          disabled={!el || !track}
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
          <Filter size={12} className={lowKill ? "text-violet-400 drop-shadow-[0_0_4px_rgba(167,139,250,0.9)]" : ""} />
          FILTER
        </button>

        <div className="ml-auto font-mono text-[10px] text-slate-400">{fmtTime(time)}</div>
      </div>

      {/* Waveform limpia con clic/arrastre = buscar; re-monta con fade al cambiar track */}
      <div key={`wave-${track?.id ?? "empty"}`} className="animate-fade-in min-h-0">
        <Waveform
          analyser={handle?.analyser ?? null}
          el={el ?? null}
          bpm={track?.bpm ?? null}
          color={accent}
          height={48}
          playheadFrac={0.5}
          grid={false}
          analysisPath={track?.file_path ?? null}
          onSeek={(t) => {
            if (el) el.currentTime = t;
          }}
        />
      </div>
      {/* Contadores fuera de la onda: transcurrido (izq) · restante/total (der) */}
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
    </div>
  );
}
