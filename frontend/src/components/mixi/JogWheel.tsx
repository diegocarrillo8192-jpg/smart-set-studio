import { useCallback, useEffect, useRef, type FC } from "react";
import { audioEngine } from "../../lib/audio";

/**
 * Jog wheel estilo MIXI (adaptado de components/deck/JogWheel.tsx +
 * PremiumJogWheel, github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 *
 * - Girar con el deck en pausa = scratch (seek sobre la posición).
 * - Girar con el deck sonando = bend temporal del playbackRate.
 * - La rotación visual sigue la posición real del audio (currentTime).
 */

/** Segundos por revolución del plato (velocidad de giro visual). */
const SEC_PER_REV = 1.8;
const RATE_PER_DEG = 0.004;

interface Props {
  name: "A" | "B";
  el: HTMLAudioElement | null;
  playing: boolean;
  color: string;
  size?: number;
}

export const JogWheel: FC<Props> = ({ name, el, playing, color, size = 96 }) => {
  const platterRef = useRef<HTMLDivElement>(null);
  const lastAngle = useRef(0);
  const baseRate = useRef(1);
  const jogRate = useRef(1);
  const dragging = useRef(false);
  const rafRef = useRef(0);

  // Rotación visual continua desde currentTime (refleja scratch y seek).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (platterRef.current && el) {
        const deg = ((el.currentTime / SEC_PER_REV) * 360) % 360;
        platterRef.current.style.transform = `rotate(${deg}deg)`;
      }
    };
    raf = requestAnimationFrame(tick);
    rafRef.current = raf;
    return () => cancelAnimationFrame(raf);
  }, [el]);

  const angleOf = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return (Math.atan2(e.clientY - cy, e.clientX - cx) * 180) / Math.PI;
  };

  const onDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!el) return;
      e.preventDefault();
      dragging.current = true;
      lastAngle.current = angleOf(e);
      baseRate.current = el.playbackRate || 1;
      jogRate.current = baseRate.current;
      audioEngine.beginJog(name);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [el, name]
  );

  const onMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current || !el) return;
      const angle = angleOf(e);
      let delta = angle - lastAngle.current;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      lastAngle.current = angle;

      if (el.paused) {
        audioEngine.scratchSeek(name, delta * (SEC_PER_REV / 360));
      } else {
        jogRate.current = Math.max(0.1, Math.min(4, jogRate.current + delta * RATE_PER_DEG));
        audioEngine.setJogRate(name, jogRate.current);
      }
    },
    [el, name]
  );

  const onUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      audioEngine.endJog(name);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ok */
      }
    },
    [name]
  );

  return (
    <div
      className="relative shrink-0 rounded-full border-2"
      style={{
        width: size,
        height: size,
        borderColor: `${color}55`,
        background: "radial-gradient(circle at 40% 35%, #2a2a2a, #111 70%)",
      }}
    >
      <div
        ref={platterRef}
        className="absolute inset-1.5 cursor-grab touch-none rounded-full active:cursor-grabbing"
        style={{ background: "radial-gradient(circle at 45% 40%, #222, #0a0a0a)" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div className="absolute inset-3 rounded-full border border-zinc-800/50" />
        <div className="absolute inset-6 rounded-full border border-zinc-800/40" />
        <div
          className="absolute rounded-full"
          style={{
            width: size * 0.22,
            height: size * 0.22,
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            background: `radial-gradient(circle, ${color}33, #111)`,
            border: `1px solid ${color}55`,
          }}
        />
        <div
          className="absolute rounded-full bg-white/70"
          style={{ width: 3, height: 3, top: 6, left: "50%", transform: "translateX(-50%)" }}
        />
      </div>
      {playing && (
        <div
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ boxShadow: `0 0 15px ${color}44, inset 0 0 15px ${color}22` }}
        />
      )}
    </div>
  );
};
