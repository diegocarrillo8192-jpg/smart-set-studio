import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { AnalysisBar, HotCue, TrackAnalysis } from "../types";

interface Props {
  analyser: AnalyserNode | null;
  el: HTMLAudioElement | null;
  bpm: number | null;
  gridOffsetSec?: number;
  color?: string;
  height?: number;
  onSeek?: (t: number) => void;
  cues?: { t: number; color: string; label?: string }[];
  /** Fracción del ancho donde vive el playhead (0.5 = centro). */
  playheadFrac?: number;
  /** Muestra el contador de compases en vez del tiempo. */
  display?: "time" | "bars";
  /** false = waveform limpia (sin beatgrid, frases ni contador de compases). */
  grid?: boolean;
  /** Ruta del archivo para el análisis estructural (onda RGB, frases, cues, vocales). */
  analysisPath?: string | null;
}

/** Media ventana a cada lado del playhead (segundos). */
const HALF_WINDOW = 8;

interface Sample {
  t: number;
  lo: number;
  mid: number;
  hi: number;
}

/** Caché de análisis por ruta (compartida entre todos los Waveform). */
const analysisCache = new Map<string, TrackAnalysis>();

function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function hexA(hex: string, a: number): string {
  if (hex.startsWith("#")) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return hex;
}

/** Barra de pico con capuchón redondo (arriba) — evita rectángulos duros. */
function peakBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius = 1.5
): void {
  const r = Math.min(radius, w / 2, h / 2);
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, [r, r, r, r]);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

/** Colores de la onda RGB (estilo Rekordbox): graves / medios / agudos. */
const RGB_COLORS = ["#ff5252", "#4ade80", "#38bdf8"];

const PHRASE_COLORS: Record<string, string> = {
  Intro: "#38bdf8",
  "Chorus/Drop": "#f59e0b",
  Bridge: "#10b981",
  Break: "#f43f5e",
  Outro: "#94a3b8",
};

const CUE_COLORS: Record<string, string> = {
  intro: "#38bdf8",
  drop: "#f59e0b",
  break: "#10b981",
  outro: "#94a3b8",
};

/**
 * Waveform con playhead fijo (ventana deslizante) y beatgrid 1-2-3-4.
 *
 * Con `analysisPath` renderiza la onda ESTÁTICA RGB por frecuencia (graves
 * rojo, medios verde, agudos azul — Rekordbox 7), la estructura de frases
 * (Intro / Chorus/Drop / Bridge / Outro alineadas a 8 compases), los 4 hot
 * cues automáticos y las zonas vocales ("Vocal Zone" con micrófono). Sin
 * análisis conserva la onda time-domain neón en vivo. Clic/arrastre = seek.
 */
export default function Waveform({
  analyser,
  el,
  bpm,
  gridOffsetSec = 0,
  color = "#7c3aed",
  height = 64,
  onSeek,
  cues = [],
  playheadFrac = 0.4,
  display = "time",
  grid = true,
  analysisPath,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const samplesRef = useRef<Sample[]>([]);
  const lastTRef = useRef(-1);

  const [analysis, setAnalysis] = useState<TrackAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  // Pico máximo de cada banda (graves/medios/agudos) del análisis completo:
  // la envolvente se normaliza contra él para reflejar la AMPLITUD REAL del
  // archivo (drops = altura máxima, breaks ≈ vacíos) en vez de una forma plana.
  const bandMax = useMemo(() => {
    const m: [number, number, number] = [1e-6, 1e-6, 1e-6];
    if (analysis?.bars) {
      for (const b of analysis.bars) {
        if (b.lo > m[0]) m[0] = b.lo;
        if (b.mid > m[1]) m[1] = b.mid;
        if (b.hi > m[2]) m[2] = b.hi;
      }
    }
    return m;
  }, [analysis]);

  // Carga lazy del análisis estructural (con caché en memoria por pista)
  useEffect(() => {
    if (!analysisPath) {
      setAnalysis(null);
      setAnalysisLoading(false);
      return;
    }
    const cached = analysisCache.get(analysisPath);
    if (cached) {
      setAnalysis(cached);
      setAnalysisLoading(false);
      return;
    }
    let cancelled = false;
    setAnalysisLoading(true);
    api
      .getAnalysis(analysisPath)
      .then((a) => {
        if (cancelled) return;
        analysisCache.set(analysisPath, a);
        setAnalysis(a);
      })
      .catch(() => {
        if (!cancelled) setAnalysis(null);
      })
      .finally(() => {
        if (!cancelled) setAnalysisLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [analysisPath]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const freq = new Uint8Array(analyser?.frequencyBinCount ?? 1024);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = canvas.width;
      const h = canvas.height;
      const tCur = el && isFinite(el.currentTime) ? el.currentTime : 0;
      const rate = el?.playbackRate && el.playbackRate > 0 ? el.playbackRate : 1;
      const beat = bpm && bpm > 0 ? 60 / (bpm * rate) : null;

      // Muestrear el espectro en vivo al buffer de la ventana (solo sin análisis):
      // bandas graves/kick (rojo), medios (verde) y agudos/hi-hats (azul).
      if (!analysis && el && !el.paused && analyser) {
        analyser.getByteFrequencyData(freq);
        const n = freq.length;
        const hiStart = Math.min(n - 1, Math.floor(n * 0.12));
        const midStart = Math.min(hiStart - 1, Math.floor(n * 0.03));
        let lo = 0, mid = 0, hi = 0;
        for (let i = 1; i < midStart; i++) lo += freq[i];
        for (let i = midStart; i < hiStart; i++) mid += freq[i];
        for (let i = hiStart; i < n; i++) hi += freq[i];
        const v = (t: number, c: number) => Math.min(1, (c / (t * 255)) * 1.6);
        const sample = {
          t: tCur,
          lo: v(Math.max(1, midStart - 1), lo),
          mid: v(hiStart - midStart, mid),
          hi: v(n - hiStart, hi),
        };
        if (lastTRef.current >= 0 && Math.abs(tCur - lastTRef.current) > 0.5) {
          samplesRef.current = []; // seek abrupto: descartar muestra obsoleta
        }
        samplesRef.current.push(sample);
        lastTRef.current = tCur;
        const cut = tCur - HALF_WINDOW;
        while (samplesRef.current.length && samplesRef.current[0].t < cut) {
          samplesRef.current.shift();
        }
      }

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, w, h);

      const cx = w * playheadFrac;
      const pxPerSec = (w * Math.min(playheadFrac, 1 - playheadFrac)) / HALF_WINDOW;
      const t0 = tCur - HALF_WINDOW;
      const t1 = tCur + HALF_WINDOW;
      const xOf = (t: number) => cx + (t - tCur) * pxPerSec;

      // Subdivisión por segundo
      ctx.strokeStyle = "rgba(148,163,184,0.08)";
      ctx.lineWidth = 1;
      for (let t = Math.ceil(t0); t <= t1; t++) {
        const x = xOf(t);
        if (x < 0 || x > w) continue;
        ctx.beginPath();
        ctx.moveTo(x, 4);
        ctx.lineTo(x, h - 4);
        ctx.stroke();
      }

      // ---------------- ONDA RGB ESTÁTICA (análisis estructural) ----------------
      if (analysis) {
        // Frases: franja de fondo + etiqueta con la estructura (8 compases)
        for (const p of analysis.phrases) {
          if (p.end < t0 || p.start > t1) continue;
          const x0 = Math.max(0, xOf(p.start));
          const x1 = Math.min(w, xOf(p.end));
          if (x1 - x0 < 6) continue;
          const base = PHRASE_COLORS[p.label] ?? "#64748b";
          ctx.fillStyle = hexA(base, 0.1);
          ctx.fillRect(x0, 4, x1 - x0, h - 8);
          if (x1 - x0 > 34) {
            ctx.fillStyle = hexA(base, 0.95);
            ctx.font = "bold 8px ui-monospace, monospace";
            ctx.textAlign = "left";
            ctx.fillText(
              p.label === "Chorus/Drop" ? "DROP" : p.label.toUpperCase(),
              x0 + 3,
              11
            );
          }
        }

        // Zonas vocales: patrón diagonal + badge de micrófono
        for (const z of analysis.vocal_zones) {
          if (z.end < t0 || z.start > t1) continue;
          const x0 = Math.max(0, xOf(z.start));
          const x1 = Math.min(w, xOf(z.end));
          if (x1 - x0 < 8) continue;
          ctx.fillStyle = "rgba(244,63,94,0.07)";
          ctx.fillRect(x0, 4, x1 - x0, h - 8);
          ctx.strokeStyle = "rgba(244,63,94,0.25)";
          ctx.lineWidth = 1;
          const y0 = 4;
          const y1 = h - 8;
          for (let yy = y0 - (x1 - x0); yy < y1; yy += 6) {
            ctx.beginPath();
            ctx.moveTo(x0, yy);
            ctx.lineTo(x0 + (yy - y0) + (x1 - x0), y0);
            ctx.stroke();
          }
          if (x1 - x0 > 60) {
            ctx.fillStyle = "rgba(244,63,94,0.95)";
            ctx.font = "700 7px ui-monospace, monospace";
            ctx.textAlign = "center";
            ctx.fillText("\uD83C\uDFA4 VOCAL ZONE", (x0 + x1) / 2, h - 6);
          }
        }

        // Onzas RGB reales de las frecuencias del archivo: envolventes
        // suaves (graves/medios/agudos con sus picos, caídas y zonas de
        // volumen) en lugar de bloques rectangulares sólidos.
        const nCols = Math.min(Math.max(1, Math.floor(w / 4)), 320);
        const dtCol = (t1 - t0) / nCols;
        const sumBars = (bars: AnalysisBar[], ta: number, tb: number) => {
          let lo = 0, mid = 0, hi = 0, n = 0;
          for (const b of bars) {
            if (b.t >= ta && b.t < tb) {
              lo += b.lo;
              mid += b.mid;
              hi += b.hi;
              n++;
            }
          }
          if (n === 0) {
            // interpolar con la barra más cercana
            let best: AnalysisBar | null = null;
            let bd = Infinity;
            for (const b of bars) {
              const d = Math.abs(b.t - (ta + tb) / 2);
              if (d < bd) {
                bd = d;
                best = b;
              }
            }
            if (!best) return null;
            return { lo: best.lo, mid: best.mid, hi: best.hi };
          }
          return { lo: lo / n, mid: mid / n, hi: hi / n };
        };
        // Barras RGB apiladas estilo Rekordbox 7: graves (rojo/kick) en la base,
        // medios (verde) encima y agudos (azul/hi-hats) en la punta. La altura
        // de cada banda se escala contra su PICO REAL en el archivo → drops
        // como columnas altas y breaks como vacíos pronunciados.
        const maxHalf = h * 0.3;
        const yc = h / 2;
        const unit = maxHalf / 3;
        for (let i = 0; i < nCols; i++) {
          const ta = t0 + i * dtCol;
          const s = sumBars(analysis.bars, ta, ta + dtCol);
          if (!s) continue;
          const x = cx + (ta + dtCol / 2 - tCur) * pxPerSec;
          if (x < -3 || x > w + 3) continue;
          const norm: [number, number, number] = [
            s.lo / bandMax[0],
            s.mid / bandMax[1],
            s.hi / bandMax[2],
          ];
          const energy = norm[0] + norm[1] + norm[2];
          if (energy < 0.06) continue; // silencio/break → columna vacía
          let cum = 0;
          for (let b = 0; b < 3; b++) {
            const n = Math.min(1, norm[b]);
            if (n < 0.02) continue;
            const seg = n * unit;
            ctx.fillStyle = RGB_COLORS[b];
            ctx.globalAlpha = 0.5 + 0.5 * n;
            peakBar(ctx, x, yc - cum - seg, 2.5, seg * 2, 1);
            ctx.globalAlpha = 1;
            cum += seg;
          }
        }

        // Hot cues automáticos del análisis (Intro, Drop, Break, Outro)
        const cs: HotCue[] = analysis.cues ?? [];
        for (const cueTag of cues) {
          ctx.strokeStyle = hexA(cueTag.color, 0.85);
          ctx.lineWidth = 1.2;
          const x = xOf(cueTag.t);
          if (x >= -20 && x <= w + 20) {
            ctx.beginPath();
            ctx.moveTo(x, 3);
            ctx.lineTo(x, h - 3);
            ctx.stroke();
          }
        }
        for (const c of cs) {
          const x = xOf(c.t);
          if (x < -24 || x > w + 24) continue;
          const cc = CUE_COLORS[c.type] ?? "#f59e0b";
          ctx.strokeStyle = hexA(cc, 0.9);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x, 3);
          ctx.lineTo(x, h - 3);
          ctx.stroke();
          ctx.fillStyle = cc;
          ctx.beginPath();
          ctx.moveTo(x - 4, 3);
          ctx.lineTo(x + 6, 3);
          ctx.lineTo(x, 11);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#0f172a";
          ctx.font = "bold 6px ui-monospace, monospace";
          ctx.textAlign = "left";
          ctx.fillText(c.label, x + 6, 11);
        }
      } else {
        // ---------------- ONDA TIME-DOMAIN NEÓN EN VIVO (sin análisis) ----------------

        // Beatgrid 1-2-3-4 alineado al BPM efectivo + frases de 32 beats
        if (grid && beat) {
          const start = gridOffsetSec + Math.floor((t0 - gridOffsetSec) / beat) * beat;
          for (let t = start; t <= t1; t += beat) {
            const x = xOf(t);
            if (x < -30 || x > w + 30) continue;
            const idx = Math.round((t - gridOffsetSec) / beat);
            const num = ((idx % 4) + 4) % 4 + 1;
            const isPhrase = idx % 32 === 0;
            const isOne = num === 1 && !isPhrase;
            ctx.strokeStyle = isPhrase
              ? "rgba(255,255,255,0.95)"
              : isOne
                ? "rgba(255,255,255,0.5)"
                : hexA(color, 0.8);
            ctx.lineWidth = isPhrase ? 2 : isOne ? 1.6 : 1;
            ctx.beginPath();
            ctx.moveTo(x, isPhrase || isOne ? 3 : h * 0.16);
            ctx.lineTo(x, h - 3);
            ctx.stroke();
            ctx.textAlign = "center";
            if (isPhrase) {
              ctx.fillStyle = "rgba(255,255,255,0.9)";
              ctx.font = "bold 8px ui-monospace, monospace";
              ctx.fillText(`FR${Math.floor(idx / 32) + 1}`, x, 10);
            } else if (isOne) {
              ctx.fillStyle = "rgba(255,255,255,0.9)";
              ctx.font = "bold 8px ui-monospace, monospace";
              ctx.fillText("1", x, 10);
            } else {
              ctx.fillStyle = hexA(color, 0.75);
              ctx.font = "7px ui-monospace, monospace";
              ctx.fillText(String(num), x, 9);
            }
          }
        }

        const samples = samplesRef.current;
        // Barras RGB en vivo: mismas 3 frecuencias (rojo bajos, verde medios,
        // azul agudos) apiladas, con el pasado más brillante que el futuro.
        const maxHalf = h * 0.3;
        const yc = h / 2;
        const unit = maxHalf / 3;
        for (const s of samples) {
          const x = xOf(s.t);
          if (x < -3 || x > w + 3) continue;
          const norm = [Math.min(1, s.lo), Math.min(1, s.mid), Math.min(1, s.hi)];
          const energy = norm[0] + norm[1] + norm[2];
          if (energy < 0.06) continue;
          const past = s.t < tCur;
          let cum = 0;
          for (let b = 0; b < 3; b++) {
            const n = norm[b];
            if (n < 0.02) continue;
            const seg = n * unit;
            ctx.fillStyle = RGB_COLORS[b];
            ctx.globalAlpha = (past ? 0.95 : 0.45) * (0.5 + 0.5 * n);
            peakBar(ctx, x, yc - cum - seg, 2, seg * 2, 1);
            ctx.globalAlpha = 1;
            cum += seg;
          }
        }

        // Hot Cues del DJ (prop)
        for (const c of cues) {
          const x = xOf(c.t);
          if (x < -24 || x > w + 24) continue;
          ctx.strokeStyle = hexA(c.color, 0.85);
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.moveTo(x, 3);
          ctx.lineTo(x, h - 3);
          ctx.stroke();
          ctx.fillStyle = c.color;
          ctx.beginPath();
          ctx.moveTo(x - 4, 3);
          ctx.lineTo(x + 6, 3);
          ctx.lineTo(x, 11);
          ctx.closePath();
          ctx.fill();
          if (c.label) {
            ctx.fillStyle = "#0f172a";
            ctx.font = "bold 6px ui-monospace, monospace";
            ctx.textAlign = "left";
            ctx.fillText(c.label, x + 6, 11);
          }
        }
      }

      // Halo de brillo a lo largo de la línea de tiempo
      if (analysis) {
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, "rgba(255,255,255,0.05)");
        grad.addColorStop(1, "rgba(255,255,255,0.02)");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 4, w, h - 8);
      } else {
        const halo = ctx.createLinearGradient(0, 0, 0, h);
        halo.addColorStop(0, hexA(color, 0.22));
        halo.addColorStop(0.5, hexA(color, 0.12));
        halo.addColorStop(1, hexA(color, 0.05));
        ctx.fillStyle = halo;
        ctx.fillRect(0, 4, w, h - 8);
      }

      // Playhead con glow, limpio (sin rectángulo lateral)
      ctx.shadowColor = "rgba(255,255,255,0.9)";
      ctx.shadowBlur = 6;
      ctx.fillStyle = "rgba(255,255,255,0.95)";
      ctx.fillRect(cx - 0.75, 0, 1.5, h);
      ctx.shadowBlur = 0;

      // Indicador de análisis en curso
      if (analysisLoading) {
        ctx.fillStyle = "rgba(255,255,255,0.75)";
        ctx.font = "bold 8px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText("ANALIZANDO ESTRUCTURA (RGB · FRASES · CUES)…", cx, h / 2 - 4);
      }

      // Tiempo / compases transcurridos (solo en vistas con grid)
      if (grid && (display === "bars" || (analysis && analysis.bpm))) {
        ctx.textAlign = "left";
        if (display === "bars" && beat) {
          const barDur = beat * 4;
          const bars = (tCur - gridOffsetSec) / barDur;
          const totalBars = (el?.duration && isFinite(el.duration) ? el.duration : tCur) / barDur;
          ctx.fillStyle = "rgba(255,255,255,0.75)";
          ctx.font = "bold 10px ui-monospace, monospace";
          ctx.fillText(`${bars.toFixed(1)} BARS`, 5, 11);
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.font = "8px ui-monospace, monospace";
          ctx.fillText(`de ${totalBars.toFixed(0)} · ${fmt(tCur)}`, 5, 22);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.6)";
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillText(fmt(tCur), 5, 10);
        }
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [analyser, el, bpm, color, gridOffsetSec, cues, playheadFrac, display, analysis, analysisLoading]);

  const draggingRef = useRef(false);

  /** Clic o arrastre = salto instantáneo a esa posición exacta de la canción. */
  const seekAt = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!el || !onSeek) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const cx = rect.width * playheadFrac;
    const pxPerSec = (rect.width * Math.min(playheadFrac, 1 - playheadFrac)) / HALF_WINDOW;
    const t = el.currentTime + (x - cx) / pxPerSec;
    onSeek(Math.max(0, t));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!el || !onSeek) return;
    draggingRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    seekAt(e);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRef.current) seekAt(e);
  };

  const endDrag = () => {
    draggingRef.current = false;
  };

  return (
    <div
      className="relative w-full cursor-crosshair touch-none select-none"
      style={{ height: height + 8 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <canvas
        ref={canvasRef}
        width={520}
        height={height}
        className="absolute inset-x-0 top-1/2 w-full -translate-y-1/2"
        style={{ height }}
      />
    </div>
  );
}