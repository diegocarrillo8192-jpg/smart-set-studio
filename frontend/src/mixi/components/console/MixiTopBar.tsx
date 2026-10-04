import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import type { Track } from "../../../types";
import { audioEngine } from "../../../lib/audio";
import Artwork from "../../../components/Artwork";
import { useMixiStore } from "../../store/mixiStore";
import { fmtBpm } from "../../../lib/format";
import { Knob } from "../controls/Knob";
import { COLOR_DECK_A, COLOR_DECK_B, COLOR_MASTER } from "../../theme";

const LOGO_URL = `${import.meta.env.BASE_URL}logo.png`;

interface Props {
  deckATrack: Track | null;
  deckBTrack: Track | null;
}

/** Badge de tonalidad (deck + key). En módulo para identidad estable: si
 *  viviera dentro de MixiTopBar se re-crearía en cada render y React
 *  remontaría el subárbol entero. */
const KeyBadge: FC<{ label: string; keyName: string; color: string }> = ({ label, keyName, color }) => (
  <span className="flex h-10 shrink-0 items-center gap-1 self-center text-[15px] font-medium leading-none tracking-widest">
    <span style={{ color }}>{label}</span>
    <span
      className="rounded px-1 py-0.5 font-mono text-[15px] font-medium leading-none"
      style={{ background: `${color}22`, border: `1px solid ${color}66`, color: "#fff" }}
    >
      {keyName || "--"}
    </span>
  </span>
);

/** Chip de opción (Q-A/Q-B). En módulo por la misma razón: identidad estable. */
const Chip: FC<{ active: boolean; onClick: () => void; children: ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`rounded border px-1.5 py-0.5 text-[12px] font-normal tracking-widest transition ${
      active ? "border-cyan-400/60 bg-cyan-500/15 text-cyan-200" : "border-slate-700 text-slate-500 hover:text-slate-300"
    }`}
  >
    {children}
  </button>
);

// ── Valores derivados y lógica secundaria (fuera del render) ────────────

/** BPM del MASTER ACTIVO (función pura): si hay pareja de SYNC enganchada
 *  manda el deck con rol de MASTER (dinámico, nunca fijo por posición); sin
 *  SYNC, el deck que está sonando (o cualquiera cargado como referencia). */
function pickMasterBpm(
  roleA: "master" | "follower" | null,
  roleB: "master" | "follower" | null,
  bpmA: number,
  bpmB: number,
  playA: boolean,
  playB: boolean,
): number {
  if (roleA === "master") return bpmA;
  if (roleB === "master") return bpmB;
  if (playB && !playA) return bpmB;
  if (playA) return bpmA;
  return bpmA || bpmB;
}

/** Hook de SYNC: estado de la pareja + BPM del master activo. Mismas
 *  suscripciones al store que antes (la barra se re-renderiza igual). */
function useMasterSync(): { masterBpm: number; synced: boolean } {
  const bpmA = useMixiStore((s) => s.decks.A.bpm);
  const bpmB = useMixiStore((s) => s.decks.B.bpm);
  const playA = useMixiStore((s) => s.decks.A.isPlaying);
  const playB = useMixiStore((s) => s.decks.B.isPlaying);
  const synced = useMixiStore((s) => s.decks.B.isSynced || s.decks.A.isSynced);
  const roleA = useMixiStore((s) => s.decks.A.syncRole);
  const roleB = useMixiStore((s) => s.decks.B.syncRole);
  return { masterBpm: pickMasterBpm(roleA, roleB, bpmA, bpmB, playA, playB), synced };
}

/** Alterna el SYNC desde la barra superior (Deck B si ambos están cargados);
 *  lee el store en el instante del clic, igual que el callback original. */
function toggleMasterSync(): void {
  const store = useMixiStore.getState();
  const a = store.decks.A.isTrackLoaded;
  const b = store.decks.B.isTrackLoaded;
  if (a && b) {
    if (store.decks.B.isSynced) store.unsyncDeck("B");
    else store.syncDeck("B");
  } else if (b && !a) {
    if (store.decks.A.isSynced) store.unsyncDeck("A");
    else store.syncDeck("A");
  }
}

/** Hook de grabación: estado REC + contador mm:ss y sus efectos. */
function useRecorder(): { recording: boolean; mmss: string; onRec: () => void } {
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);

  const onRec = useCallback(() => {
    const on = audioEngine.toggleRecording();
    setRecording(on);
    if (on) setRecSec(0);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const t = window.setInterval(() => setRecSec((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [recording]);

  const mmss = `${String(Math.floor(recSec / 60)).padStart(2, "0")}:${String(recSec % 60).padStart(2, "0")}`;
  return { recording, mmss, onRec };
}

// ── Subcomponentes de render (módulo: identidad estable, sin remontajes) ─

/** Marca de la app (logo + wordmark). */
const BrandBlock: FC = () => (
  <div className="flex h-9 shrink-0 items-center gap-2">
    <img src={LOGO_URL} alt="Smart Set Architect" className="h-7 w-7 rounded" draggable={false} />
    <div className="leading-none">
      <div className="text-[15px] font-semibold tracking-[0.16em] text-slate-100">SMART SET</div>
      <div className="text-[10px] font-medium tracking-[0.3em] text-slate-400">ARCHITECT</div>
    </div>
  </div>
);

/** Lectura del BPM del MASTER (guiones si no hay valor). */
const MasterBpmReadout: FC<{ bpm: number }> = ({ bpm }) => (
  <div className="flex h-10 shrink-0 items-center gap-2 self-center rounded-lg border border-slate-600/60 bg-black/50 px-2.5">
    <span className="text-[11px] font-normal uppercase leading-none tracking-widest text-slate-400">BPM</span>
    <span className="font-mono text-[20px] font-medium leading-none tabular-nums text-slate-50">
      {bpm > 0 ? fmtBpm(bpm) : "-.--"}
    </span>
    <span className="text-[11px] font-normal uppercase leading-none tracking-widest text-cyan-300">MASTER</span>
  </div>
);

/** Botón SYNC de la barra superior (estado encendido/apagado). */
const TopBarSyncButton: FC<{ synced: boolean; onClick: () => void }> = ({ synced, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex h-9 shrink-0 items-center self-center rounded-full border px-3 text-[12px] font-medium leading-none tracking-widest transition active:scale-95 ${
      synced
        ? "border-emerald-400/70 bg-emerald-500/15 text-emerald-300 shadow-[0_0_14px_rgba(16,185,129,0.4)]"
        : "border-slate-500 text-slate-200 hover:border-emerald-400/50 hover:text-emerald-300"
    }`}
  >
    SYNC
  </button>
);

/** Botón REC con contador (encendido = grabando). */
const RecordButton: FC<{ recording: boolean; mmss: string; onClick: () => void }> = ({
  recording,
  mmss,
  onClick,
}) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium tracking-widest transition active:scale-95 ${
      recording
        ? "border-red-500 bg-red-600/25 text-red-200 shadow-[0_0_18px_rgba(239,68,68,0.65)]"
        : "border-red-600/80 text-red-300 hover:bg-red-600/15"
    }`}
    title="Grabar la sesión (master)"
  >
    <span className={`h-2 w-2 rounded-full ${recording ? "animate-pulse bg-red-500" : "bg-red-700"}`} />
    REC{recording && <span className="font-mono tabular-nums">{mmss}</span>}
  </button>
);

/** Portadas de los dos decks (Fragment: preserva el DOM del contenedor). */
const DeckArtworks: FC<{ a: Track | null; b: Track | null }> = ({ a, b }) => (
  <>
    <Artwork track={a} accent={COLOR_DECK_A} size={38} remountKey={a?.id ?? "a"} />
    <Artwork track={b} accent={COLOR_DECK_B} size={38} remountKey={b?.id ?? "b"} />
  </>
);

/** Barra superior global estilo MIXI (2 filas): transporte/estado + perillas master. */
export const MixiTopBar: FC<Props> = ({ deckATrack, deckBTrack }) => {
  const { masterBpm, synced } = useMasterSync();
  const { recording, mmss, onRec } = useRecorder();
  const keyA = useMixiStore((s) => s.decks.A.musicalKey);
  const keyB = useMixiStore((s) => s.decks.B.musicalKey);
  const qA = useMixiStore((s) => s.decks.A.quantize);
  const qB = useMixiStore((s) => s.decks.B.quantize);
  const master = useMixiStore((s) => s.master);
  const setMasterVolume = useMixiStore((s) => s.setMasterVolume);
  const setMasterEq = useMixiStore((s) => s.setMasterEq);
  const setMasterFilter = useMixiStore((s) => s.setMasterFilter);
  const setQuantize = useMixiStore((s) => s.setQuantize);

  return (
    <div className="mixi-topbar flex w-full shrink-0 flex-col justify-center border-b border-slate-800 px-3 py-3">
      {/* ── Fila 1: marca · BPM/sync/keys · covers + REC ── */}
      <div className="grid h-10 grid-cols-[1fr_auto_1fr] items-center gap-2.5">
        <div className="flex h-10 items-center gap-2.5">
          <BrandBlock />

          {/* Selectores de modo / estado */}
          <div className="flex h-10 shrink-0 items-center gap-1">
            <span className="rounded border border-slate-700 px-1.5 py-0.5 text-[12px] font-normal tracking-widest text-slate-400">
              MODE TRACK
            </span>
            <Chip active={qA} onClick={() => setQuantize("A", !qA)}>Q-A</Chip>
            <Chip active={qB} onClick={() => setQuantize("B", !qB)}>Q-B</Chip>
          </div>
        </div>

        <div className="flex h-10 items-center justify-center gap-3">
          <KeyBadge label="A" keyName={keyA} color={COLOR_DECK_A} />
          <MasterBpmReadout bpm={masterBpm} />
          <TopBarSyncButton synced={synced} onClick={toggleMasterSync} />
          <KeyBadge label="B" keyName={keyB} color={COLOR_DECK_B} />
        </div>

        <div className="flex h-10 items-center justify-end gap-2">
          <DeckArtworks a={deckATrack} b={deckBTrack} />
          <RecordButton recording={recording} mmss={mmss} onClick={onRec} />
        </div>
      </div>

      {/* ── Fila 2: perillas master (Gain + EQ global + Filtro) ── */}
      <div className="mt-0.5 grid h-20 grid-cols-[1fr_auto_1fr] items-center gap-2 rounded-lg border border-slate-800/70 bg-black/30 px-3">
        <div className="flex items-center justify-end">
          <span className="text-[11px] font-normal tracking-widest text-slate-400">MASTER</span>
        </div>
        <div className="flex items-center justify-center gap-4 pt-2">
          <Knob value={master.volume} min={0} max={1.2} defaultValue={0.9} onChange={setMasterVolume} color={COLOR_MASTER} scale={0.6} label="GAIN" showValue />
          <Knob value={master.eq.high} min={-26} max={6} center={0} bipolar onChange={(v) => setMasterEq("high", v)} color={COLOR_MASTER} scale={0.6} label="HI" showValue unit="dB" />
          <Knob value={master.eq.mid} min={-26} max={6} center={0} bipolar onChange={(v) => setMasterEq("mid", v)} color={COLOR_MASTER} scale={0.6} label="MID" showValue unit="dB" />
          <Knob value={master.eq.low} min={-26} max={6} center={0} bipolar onChange={(v) => setMasterEq("low", v)} color={COLOR_MASTER} scale={0.6} label="LOW" showValue unit="dB" />
          <Knob value={master.filter} min={-1} max={1} center={0} bipolar onChange={setMasterFilter} color={COLOR_MASTER} scale={0.6} label="FILTER" showValue />
        </div>
        <div />
      </div>
    </div>
  );
};
