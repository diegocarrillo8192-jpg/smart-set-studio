import { useEffect, useRef, type FC } from "react";
import { audioEngine } from "../../lib/audio";

/**
 * VU meter estilo MIXI (adaptado de components/mixer/VuMeter.tsx,
 * github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 * Lee el nivel RMS real del motor con balística de ataque/relajación.
 */

const SEGMENTS = 14;

interface Props {
  name: "A" | "B";
  height?: number;
  /** Si true, mide el bus master en vez del canal. */
  master?: boolean;
}

export const VuMeter: FC<Props> = ({ name, height = 150, master = false }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = (canvas.width = 12);
    const h = (canvas.height = height);
    const segH = h / SEGMENTS - 1;

    let display = 0;
    let peak = 0;
    let peakAt = 0;
    let raf = 0;
    let last = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 33) return;
      last = now;

      const raw = master ? audioEngine.getMasterLevel() : audioEngine.getLevel(name);
      display = raw > display ? raw : display * 0.88;
      if (raw > peak) {
        peak = raw;
        peakAt = now;
      } else if (now - peakAt > 900) {
        peak *= 0.88;
      }
      if (display < 0.005) display = 0;
      if (peak < 0.005) peak = 0;

      const lit = Math.round(display * SEGMENTS);
      const peakSeg = Math.min(SEGMENTS - 1, Math.round(peak * SEGMENTS) - 1);

      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < SEGMENTS; i++) {
        const y = h - (i + 1) * (segH + 1);
        const on = i < lit || i === peakSeg;
        ctx.fillStyle = on ? (i >= 11 ? "#ef4444" : i >= 9 ? "#f59e0b" : "#22c55e") : "#1c1c22";
        ctx.fillRect(0, y, w, segH);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [name, height, master]);

  return (
    <div className="flex flex-col items-center gap-0.5">
      <canvas ref={canvasRef} style={{ width: 12, height }} className="rounded-sm" />
      <span className="text-[8px] font-bold tracking-widest text-slate-500">{master ? "MST" : name}</span>
    </div>
  );
};
