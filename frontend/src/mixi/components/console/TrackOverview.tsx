import { useEffect, useRef, type FC } from "react";
import { audioEngine } from "../../../lib/audio";
import { useMixiStore } from "../../store/mixiStore";
import type { DeckId, WaveformPoint } from "../../types";

/**
 * Onda completa del track (Overview / Full Waveform): muestra la estructura
 * de principio a fin. La parte reproducida va brillante y la restante atenuada;
 * clic en cualquier punto para saltar (seek).
 */

interface OverviewLaneProps {
  deckId: DeckId;
  color: string;
  height: number;
}

/** #rrggbb → rgba(r,g,b,a). */
function withAlpha(hex: string, a: number): string {
  if (!hex.startsWith("#") || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

const OverviewLane: FC<OverviewLaneProps> = ({ deckId, color, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    /** Onda completa horneada fuera de pantalla (1 columna por punto, con
     *  re-muestreo por pico en pistas largas): el frame solo hace un drawImage
     *  GPU en vez del bucle por píxel con sombra que saturaba el hilo
     *  principal con SYNC activo. */
    interface Bake {
      canvas: HTMLCanvasElement;
      data: WaveformPoint[] | null;
      color: string;
    }
    let bake: Bake | null = null;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = height;
      if (w === 0) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const deck = useMixiStore.getState().decks[deckId];
      const data = deck.waveformData;
      const el = audioEngine.getElement(deckId);
      const duration = deck.duration || (el && Number.isFinite(el.duration) ? el.duration : 0);
      const tCur = el && Number.isFinite(el.currentTime) ? el.currentTime : 0;

      // Fondo
      ctx.fillStyle = "#0b0f18";
      ctx.fillRect(0, 0, w, h);

      if (!data || data.length === 0 || duration <= 0) {
        ctx.fillStyle = "rgba(148,163,184,0.25)";
        ctx.fillRect(0, h / 2 - 0.5, w, 1);
        return;
      }

      const playX = Math.max(0, Math.min(w, (tCur / duration) * w));

      // Hornea la onda completa una sola vez por track (glow + gradiente).
      if (!bake || bake.data !== data || bake.color !== color) {
        const step = Math.max(1, Math.ceil(data.length / 32768));
        const bw = Math.max(1, Math.ceil(data.length / step));
        const off = document.createElement("canvas");
        off.width = bw;
        off.height = Math.max(1, Math.round(h));
        const o = off.getContext("2d");
        if (o) {
          const yc = h / 2;
          const maxHalf = h * 0.46;
          const grad = o.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, withAlpha(color, 0.35));
          grad.addColorStop(0.5, color);
          grad.addColorStop(1, withAlpha(color, 0.35));
          o.fillStyle = grad;
          o.shadowColor = withAlpha(color, 0.5);
          o.shadowBlur = 2;
          for (let x = 0; x < bw; x++) {
            const s0 = x * step;
            const s1 = Math.min(data.length, s0 + step);
            let amp = 0;
            for (let i = s0; i < s1; i++) {
              const p = data[i];
              const a = Math.min(1, p.low + p.mid + p.high);
              if (a > amp) amp = a;
            }
            const half = Math.max(0.5, amp * maxHalf);
            o.fillRect(x, yc - half, 1, half * 2);
          }
        }
        bake = { canvas: off, data, color };
      }

      // Copia GPU escalada a todo el ancho del lane.
      if (bake && bake.canvas.width > 0) {
        ctx.drawImage(bake.canvas, 0, 0, bake.canvas.width, h, 0, 0, w, h);
      }

      // Parte por sonar: velo oscuro a la derecha del playhead.
      if (playX < w) {
        ctx.fillStyle = "rgba(2,6,23,0.62)";
        ctx.fillRect(playX, 0, w - playX, h);
      }

      // Playhead
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, h);
      ctx.stroke();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [deckId, color, height]);

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const deck = useMixiStore.getState().decks[deckId];
    const el = audioEngine.getElement(deckId);
    const duration = deck.duration || (el && Number.isFinite(el.duration) ? el.duration : 0);
    if (!duration) return;
    audioEngine.ensureContext();
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audioEngine.seek(deckId, frac * duration);
  };

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={onDown}
      style={{ width: "100%", height, display: "block" }}
      className="cursor-pointer touch-none"
    />
  );
};

interface Props {
  colorA: string;
  colorB: string;
  height?: number;
}

/** Fila superior: overview de Deck A (izquierda) y Deck B (derecha). */
export const TrackOverview: FC<Props> = ({ colorA, colorB, height = 34 }) => (
  <div className="flex w-full gap-2">
    <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-slate-700/40">
      <div className="flex items-center gap-1 bg-black/40 px-2">
        <span className="text-[9px] font-medium tracking-widest" style={{ color: colorA }}>
          A
        </span>
        <div className="min-w-0 flex-1">
          <OverviewLane deckId="A" color={colorA} height={height} />
        </div>
      </div>
    </div>
    <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-slate-700/40">
      <div className="flex items-center gap-1 bg-black/40 px-2">
        <span className="text-[9px] font-medium tracking-widest" style={{ color: colorB }}>
          B
        </span>
        <div className="min-w-0 flex-1">
          <OverviewLane deckId="B" color={colorB} height={height} />
        </div>
      </div>
    </div>
  </div>
);
