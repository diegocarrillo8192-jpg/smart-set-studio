import { useEffect, useRef, useState } from "react";
import { AudioWaveform } from "lucide-react";

interface Props {
  position: number; // 0..1 (0 = 100% Deck A, 1 = 100% Deck B)
  onChange: (pos: number) => void;
}

/**
 * Crossfader de física fluida: el thumb se mueve por estilo directo (ref,
 * sin pasar por React state) durante el drag, con throttle rAF para notificar
 * al motor de audio. El estado local solo alimenta los indicadores visuales.
 */
export default function Crossfader({ position, onChange }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const posRef = useRef(position);
  const dragRef = useRef(false);
  const rafRef = useRef(0);
  const [pos, setPos] = useState(position);

  useEffect(() => {
    posRef.current = position;
    setPos(position);
    if (thumbRef.current) thumbRef.current.style.left = `${position * 100}%`;
  }, [position]);

  const applyPos = (p: number) => {
    posRef.current = p;
    if (thumbRef.current) thumbRef.current.style.left = `${p * 100}%`;
    setPos(p);
    if (rafRef.current === 0) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        onChange(posRef.current);
      });
    }
  };

  const compute = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    applyPos(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)));
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = true;
    compute(e.clientX);
  };

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current) compute(e.clientX);
  };

  const onUp = () => {
    if (dragRef.current) {
      dragRef.current = false;
      onChange(posRef.current);
    }
  };

  const nearA = pos < 0.5;
  const label =
    pos < 0.005 ? "Solo A" : pos > 0.995 ? "Solo B" : `${Math.round(pos * 100)}% B`;

  return (
    <div className="flex w-full flex-col items-center gap-1.5 px-1">
      <div className="flex w-full items-center gap-3">
        {/* Indicador A (celeste luminoso) */}
        <span
          className="shrink-0 text-sm font-black tracking-widest text-cyan-300"
          style={{ textShadow: "0 0 10px rgba(34,211,238,0.9)" }}
        >
          A
        </span>

        {/* Carril amplio de recorrido */}
        <div
          ref={trackRef}
          className={`relative h-10 flex-1 touch-none rounded-full bg-panel-3 ring-1 ring-inset ring-slate-800/60 shadow-inner ${
            dragRef.current ? "cursor-grabbing" : "cursor-pointer"
          }`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          {/* Pista con gradiente A→B */}
          <div className="absolute inset-y-1.5 left-2 right-2 rounded-full bg-gradient-to-r from-cyan-500/50 via-slate-600/40 to-violet-500/50" />

          {/* Marca central */}
          <div className="absolute left-1/2 top-1 h-2 w-px -translate-x-1/2 bg-slate-600" />

          {/* Capuchón (thumb) con glow según el lado */}
          <div
            ref={thumbRef}
            className="absolute top-1/2 h-11 w-7 -translate-x-1/2 -translate-y-1/2 rounded-lg border-2 bg-gradient-to-b from-slate-100 via-slate-300 to-slate-500 transition-[border-color,box-shadow] duration-150 will-change-[left]"
            style={{
              left: `${pos * 100}%`,
              borderColor: nearA ? "#22d3ee" : "#a78bfa",
              boxShadow: nearA
                ? "0 0 14px rgba(34,211,238,0.85), 0 3px 10px rgba(0,0,0,0.6)"
                : "0 0 14px rgba(167,139,250,0.85), 0 3px 10px rgba(0,0,0,0.6)",
            }}
          >
            <div className="absolute inset-x-1 top-1/2 h-px -translate-y-1/2 bg-slate-500" />
          </div>
        </div>

        {/* Indicador B (púrpura luminoso) */}
        <span
          className="shrink-0 text-sm font-black tracking-widest text-violet-300"
          style={{ textShadow: "0 0 10px rgba(167,139,250,0.9)" }}
        >
          B
        </span>
      </div>

      <span className="font-mono text-[9px] text-slate-400">{label}</span>
    </div>
  );
}

export function CrossfaderHeader({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-slate-300">
      <AudioWaveform size={12} className="text-cyan-400" style={{ filter: "drop-shadow(0 0 6px rgba(34,211,238,0.7))" }} />
      {label ?? "Crossfader"}
    </div>
  );
}
