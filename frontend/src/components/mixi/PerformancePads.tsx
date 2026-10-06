import { useCallback, useState, type FC } from "react";
import { audioEngine, type DeckElement } from "../../lib/audio";
import { CUE_PAD_COLORS } from "./theme";

/**
 * Pads de hot cue estilo MIXI (adaptado de components/deck/PerformancePads.tsx,
 * github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 * Clic = fijar/saltar al cue · clic derecho = borrar.
 */

const PAD_COUNT = 8;
/** IDs estables de pad (la cuadrícula es fija: 8 pads, nunca reordena). */
const PAD_IDS = [0, 1, 2, 3, 4, 5, 6, 7];

interface Props {
  name: "A" | "B";
  el: DeckElement | null;
  trackId?: number | null;
  onActive?: () => void;
}

export const PerformancePads: FC<Props> = ({ name, el, trackId, onActive }) => {
  const [cues, setCues] = useState<(number | null)[]>(() => new Array(PAD_COUNT).fill(null));
  const [lastTrack, setLastTrack] = useState<number | null | undefined>(trackId);

  // Track nuevo → limpiar pads.
  if (lastTrack !== trackId) {
    setLastTrack(trackId);
    setCues(new Array(PAD_COUNT).fill(null));
  }

  const onPad = useCallback(
    (i: number) => {
      if (!el) return;
      onActive?.();
      audioEngine.ensureContext();
      const c = cues[i];
      if (c == null) {
        // Primer disparo: fija el cue en la posición actual (sin seek).
        setCues((prev) => {
          const next = [...prev];
          if (next[i] == null) next[i] = el.currentTime;
          return next;
        });
        return;
      }
      // Salto instantáneo al cue + reproducción inmediata si estaba en pausa
      // (estilo Rekordbox: el pad dispara el audio en el mismo milisegundo).
      audioEngine.seek(name, c);
      if (el.paused) audioEngine.play(name);
    },
    [el, name, onActive, cues]
  );

  const clearPad = useCallback((i: number) => {
    setCues((prev) => {
      const next = [...prev];
      next[i] = null;
      return next;
    });
  }, []);

  return (
    <div className="grid grid-cols-4 gap-1">
      {PAD_IDS.map((i) => {
        const c = cues[i];
        const set = c != null;
        const color = CUE_PAD_COLORS[i];
        return (
          <button
            key={`pad-${i}`}
            onPointerDown={(e) => {
              if (e.button === 0) onPad(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              clearPad(i);
            }}
            disabled={!el}
            title={set ? `Hot cue ${i + 1} (clic derecho: borrar)` : `Fijar hot cue ${i + 1}`}
            className="h-5 rounded-sm border text-[8px] font-black transition active:scale-95 disabled:opacity-30"
            style={{
              borderColor: set ? color : "#334155",
              background: set ? `${color}44` : "transparent",
              color: set ? "#fff" : "#64748b",
              boxShadow: set ? `0 0 8px ${color}66` : "none",
            }}
          >
            {i + 1}
          </button>
        );
      })}
    </div>
  );
};
