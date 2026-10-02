import { useEffect, useRef, type FC } from "react";
import { audioEngine } from "../../../lib/audio";
import { useMixiStore } from "../../store/mixiStore";
import type { DeckId, WaveformPoint } from "../../types";

/**
 * Doble forma de onda alineada (estilo Rekordbox / Traktor): Deck A arriba,
 * Deck B abajo. Playhead EXACTAMENTE en el centro (50%):
 *   · izquierda  = ya sonó, en color activo brillante (cian A / morado B)
 *   · derecha    = por sonar, atenuado con un overlay oscuro
 * Beatgrid visible: línea tenue por tiempo y línea blanca gruesa cada 4
 * tiempos (1 compás). Clic/arrastre para buscar.
 *
 * Interacción de búsqueda (seek):
 *   · La conversión cursor → tiempo es la INVERSA EXACTA del mapeo de dibujo
 *     (mismo clientWidth, mismas constantes), sin redondeos extra.
 *   · El salto se CUANTIZA a la línea de beatgrid más cercana, de modo que la
 *     aguja central cae exactamente sobre el tiempo marcado por la rejilla.
 *     Como el salto es un número entero de beats, la fase entre ambos decks
 *     se conserva: las rejillas de A y B siguen alineadas entre sí (sinc).
 *   · Tras el seek se redibuja síncrono en el mismo frame: actualización
 *     visual instantánea en el punto exacto del clic.
 *
 * Rendimiento (60 FPS estables):
 *   · Onda MULTIBANDA y BEATGRID horneados UNA vez por track en un lienzo
 *     fuera de pantalla: por frame solo se hace 1 clearRect + 1 drawImage +
 *     1 overlay — cero bucles de stroke/fillText por frame.
 *   · Listener global de pointermove SOLO mientras se arrastra (se suelta al
 *     soltar el puntero), nunca permanente.
 *   · El ancho del canvas se cachea con ResizeObserver (sin lecturas de
 *     layout por frame) y el bucle se pausa con la pestaña oculta.
 */

const POINTS_PER_SECOND = 100;
const WINDOW_SEC = 12;
const PLAYHEAD_FRAC = 0.5;

/** #rrggbb → rgba(r,g,b,a) para el degradado brillante de la onda. */
function withAlpha(hex: string, a: number): string {
  if (!hex.startsWith("#") || hex.length < 7) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

interface LaneProps {
  deckId: DeckId;
  color: string;
  height: number;
}

interface BakedWave {
  /** Lienzo fuera de pantalla con la onda COMPLETA + beatgrid horneados. */
  canvas: HTMLCanvasElement;
  /** Identidad de los datos horneados (se re-hornea al cambiar de track,
   *  de BPM, de downbeat, de color o de altura). */
  key: string;
  data: WaveformPoint[] | null;
  /** Columna hasta la que se ha horneado (horneo progresivo por frames). */
  baked: number;
  /** Beatgrid ya dibujado sobre el lienzo (se pinta al completar la onda). */
  gridDrawn: boolean;
  /** Altura real del lienzo (px CSS). */
  h: number;
  /** Puntos de origen por columna horneada (≥1: re-muestreo de pistas largas). */
  step: number;
  /** Número total de columnas horneadas. */
  width: number;
  /** DPR con el que se horneó (escala interna del lienzo). */
  dpr: number;
}

/** Columnas horneadas por frame: el horneado de un track largo se reparte en
 *  varios frames para no congelar la UI al cargar. */
const BAKE_CHUNK = 8000;
/** Ancho máximo del lienzo horneado (límites de canvas del navegador): las
 *  pistas más largas se re-muestrean tomando el pico de cada grupo. */
const MAX_BAKE_W = 32768;

/** Hornea la rejilla de beats completa sobre el lienzo (una sola vez por
 *  track; las líneas quedan pegadas al contenido de audio y cruzan el
 *  playhead exactamente sobre los beats audibles). */
function bakeGrid(
  o: CanvasRenderingContext2D,
  width: number,
  height: number,
  gridBpm: number,
  firstBeatOffset: number,
  durationSec: number,
  step: number,
): void {
  if (gridBpm <= 0) return;
  const beat = 60 / gridBpm;
  const k0 = Math.ceil((0 - firstBeatOffset) / beat);
  const k1 = Math.floor((durationSec - firstBeatOffset) / beat);
  for (let k = k0; k <= k1; k++) {
    const x = ((firstBeatOffset + k * beat) * POINTS_PER_SECOND) / step;
    if (x < -2 || x > width + 2) continue;
    const isBar = ((k % 4) + 4) % 4 === 0;
    o.strokeStyle = isBar ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.18)";
    o.lineWidth = isBar ? 2 : 1;
    o.beginPath();
    o.moveTo(x, 0);
    o.lineTo(x, height);
    o.stroke();
    if (isBar) {
      o.fillStyle = "rgba(255,255,255,0.85)";
      o.font = "bold 9px ui-monospace, monospace";
      o.textAlign = "left";
      o.fillText(String(Math.floor(k / 4) + 1), x + 2, 10);
    }
  }
}

/** Crea el lienzo de horneado (onda + rejilla) para un track. */
function createBaked(
  data: WaveformPoint[],
  h: number,
  dpr: number,
  key: string,
): BakedWave {
  const step = Math.max(1, Math.ceil(data.length / MAX_BAKE_W));
  const width = Math.max(1, Math.ceil(data.length / step));
  const baked: BakedWave = {
    canvas: document.createElement("canvas"),
    data,
    key,
    baked: 0,
    gridDrawn: false,
    h,
    step,
    width,
    dpr,
  };
  baked.canvas.width = Math.max(1, Math.round(width * dpr));
  baked.canvas.height = Math.max(1, Math.round(h * dpr));
  return baked;
}

const Lane: FC<LaneProps> = ({ deckId, color, height }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef(false);
  const bakedRef = useRef<BakedWave | null>(null);
  const widthRef = useRef(0);
  const hiddenRef = useRef(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;

    // Ancho cacheado por ResizeObserver: cero lecturas de layout por frame.
    const measure = () => {
      widthRef.current = canvas.clientWidth;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);

    // Pausa del bucle con la ventana oculta (60 FPS solo cuando se ve).
    const onVis = () => {
      hiddenRef.current = document.hidden;
    };
    document.addEventListener("visibilitychange", onVis);

    const render = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = widthRef.current;
      const h = height;
      if (!w) return;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const deck = useMixiStore.getState().decks[deckId];
      const el = audioEngine.getElement(deckId);
      const tCur = el && Number.isFinite(el.currentTime) ? el.currentTime : 0;
      const cx = w * PLAYHEAD_FRAC;
      const pxPerSec = w / WINDOW_SEC;
      const t0 = tCur - PLAYHEAD_FRAC * WINDOW_SEC;

      // Fondo
      ctx.fillStyle = "#0b0f18";
      ctx.fillRect(0, 0, w, h);

      // ── Onda multibanda + beatgrid: horneadas UNA vez por track ──
      const data = deck.waveformData;
      const gridBpm = deck.originalBpm > 0 ? deck.originalBpm : deck.bpm;
      const firstBeatOffset = deck.firstBeatOffset;
      if (data && data.length) {
        const key = `${deckId}|${gridBpm.toFixed(6)}|${firstBeatOffset.toFixed(6)}|${color}|${h}|${dpr}`;
        let baked = bakedRef.current;
        if (!baked || baked.data !== data || baked.key !== key) {
          baked = createBaked(data, h, dpr, key);
          bakedRef.current = baked;
        }
        const o = baked.canvas.getContext("2d");
        if (o) {
          if (baked.baked < baked.width) {
            // Horneo progresivo de columnas: un trozo por frame (sin picos).
            o.setTransform(baked.dpr, 0, 0, baked.dpr, 0, 0);
            const maxHalf = h * 0.46;
            o.shadowColor = withAlpha(color, 0.55);
            o.shadowBlur = 3;
            const shades = [withAlpha(color, 0.4), color, withAlpha("#ffffff", 0.7)];
            const step = baked.step;
            const end = Math.min(baked.width, baked.baked + BAKE_CHUNK);
            for (let x = baked.baked; x < end; x++) {
              const s0 = x * step;
              const s1 = Math.min(data.length, s0 + step);
              let lo = 0;
              let mid = 0;
              let hi = 0;
              for (let i = s0; i < s1; i++) {
                const p = data[i];
                if (p.low > lo) lo = p.low;
                if (p.mid > mid) mid = p.mid;
                if (p.high > hi) hi = p.high;
              }
              const bands = [lo, mid, hi];
              let cum = 0;
              for (let b = 0; b < 3; b++) {
                const seg = bands[b] * maxHalf;
                if (seg < 0.3) continue;
                o.fillStyle = shades[b];
                o.fillRect(x, h / 2 - cum - seg, 1, seg);
                o.fillRect(x, h / 2 + cum, 1, seg);
                cum += seg;
              }
            }
            baked.baked = end;
          }
          if (baked.baked >= baked.width && !baked.gridDrawn) {
            // La rejilla se pinta UNA vez, al completar la onda (encima de
            // las columnas, para que las líneas queden nítidas).
            o.setTransform(baked.dpr, 0, 0, baked.dpr, 0, 0);
            bakeGrid(o, baked.width, h, gridBpm, firstBeatOffset, data.length / POINTS_PER_SECOND, baked.step);
            baked.gridDrawn = true;
          }
        }
        if (baked.baked > 0) {
          // Copia GPU de la ventana visible (sub-píxel: scroll suave).
          const srcX = ((t0 * POINTS_PER_SECOND) / baked.step) * baked.dpr;
          const srcW = ((WINDOW_SEC * POINTS_PER_SECOND) / baked.step) * baked.dpr;
          const maxSrcX = baked.canvas.width;
          if (srcX < maxSrcX && srcX + srcW > 0) {
            ctx.drawImage(baked.canvas, srcX, 0, srcW, baked.canvas.height, 0, 0, w, h);
          }
        }
      } else {
        if (bakedRef.current) bakedRef.current = null;
        // Sin onda todavía: rejilla directa (caso raro y barato).
        if (gridBpm > 0) {
          const beat = 60 / gridBpm;
          const t1 = t0 + WINDOW_SEC;
          const xOf = (t: number) => cx + (t - tCur) * pxPerSec;
          const k0 = Math.ceil((t0 - firstBeatOffset) / beat);
          const k1 = Math.floor((t1 - firstBeatOffset) / beat);
          for (let k = k0; k <= k1; k++) {
            const x = xOf(firstBeatOffset + k * beat);
            if (x < -2 || x > w + 2) continue;
            const isBar = ((k % 4) + 4) % 4 === 0;
            ctx.strokeStyle = isBar ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.18)";
            ctx.lineWidth = isBar ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
            if (isBar) {
              ctx.fillStyle = "rgba(255,255,255,0.85)";
              ctx.font = "bold 9px ui-monospace, monospace";
              ctx.textAlign = "left";
              ctx.fillText(String(Math.floor(k / 4) + 1), x + 2, 10);
            }
          }
        }
      }

      // Overlay oscuro sobre lo que falta por sonar (derecha)
      ctx.fillStyle = "rgba(2,6,23,0.62)";
      ctx.fillRect(cx, 0, w - cx, h);

      // El playhead (línea blanca) NO se dibuja por lane: se superpone una
      // única línea compartida en TopWaveforms para que ambas ondas queden
      // centradas y alineadas en el mismo punto exacto.
    };

    /** Salto a la línea de beatgrid más cercana (las que se dibujan sobre la
     *  onda). Sin BPM el tiempo es el exacto del cursor. Usa el mismo periodo
     *  de fuente que el dibujo para que la aguja caiga sobre la línea visible. */
    const snapToGrid = (t: number): number => {
      const deck = useMixiStore.getState().decks[deckId];
      const gridBpm = deck.originalBpm > 0 ? deck.originalBpm : deck.bpm;
      if (gridBpm <= 0) return Math.max(0, t);
      const beat = 60 / gridBpm;
      const k = Math.round((t - deck.firstBeatOffset) / beat);
      return Math.max(0, deck.firstBeatOffset + k * beat);
    };

    /** Cursor → tiempo (inversa EXACTA del dibujo) → cuantizado a la rejilla
     *  → seek + redibujo síncrono. */
    const seekAt = (clientX: number) => {
      const el = audioEngine.getElement(deckId);
      if (!el || !Number.isFinite(el.currentTime)) return;
      const w = widthRef.current;
      if (!w) return;
      const cx = w * PLAYHEAD_FRAC;
      const pxPerSec = w / WINDOW_SEC;
      const raw = el.currentTime + (clientX - canvas.getBoundingClientRect().left - cx) / pxPerSec;
      audioEngine.seek(deckId, snapToGrid(Math.max(0, raw)));
      render(); // mismo frame: la aguja cae al instante sobre el clic
    };

    const loop = () => {
      if (!hiddenRef.current) render();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    // Listener GLOBAL solo mientras se arrastra: el pointermove se suscribe
    // en el pointerdown y se suelta en el pointerup (nunca permanente).
    const onMove = (e: PointerEvent) => {
      if (dragging.current) seekAt(e.clientX);
    };
    const onUp = () => {
      dragging.current = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    const onDown = (e: PointerEvent) => {
      dragging.current = true;
      audioEngine.ensureContext();
      seekAt(e.clientX);
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };
    canvas.addEventListener("pointerdown", onDown);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [deckId, color, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height, display: "block" }}
      className="cursor-crosshair touch-none"
    />
  );
};

interface Props {
  colorA: string;
  colorB: string;
  height?: number;
}

export const TopWaveforms: FC<Props> = ({ colorA, colorB, height = 58 }) => (
  <div className="relative flex w-full flex-col gap-px overflow-hidden rounded-md border border-slate-700/40 bg-black">
    <Lane deckId="A" color={colorA} height={height} />
    <div className="h-px w-full bg-slate-700/50" />
    <Lane deckId="B" color={colorB} height={height} />
    {/* Línea de reproducción ÚNICA y compartida: ambas ondas comparten el
        mismo centro exacto (Deck A arriba, Deck B abajo). */}
    <div
      className="pointer-events-none absolute inset-y-0 left-1/2 z-10 w-[2px] -translate-x-1/2 bg-white/95 shadow-[0_0_4px_rgba(255,255,255,0.7)]"
      aria-hidden
    />
  </div>
);
