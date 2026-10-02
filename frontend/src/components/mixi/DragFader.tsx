import { useCallback, useRef, useState, type FC } from "react";

/**
 * Fader estilo MIXI (adaptado de components/controls/Fader.tsx,
 * github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 * Vertical (canal) u horizontal (crossfader), arrastre por puntero.
 */

const TRACK_THICKNESS = 6;
const CAP_LENGTH = 26;
const CAP_THICKNESS = 18;

export interface DragFaderProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  orientation?: "vertical" | "horizontal";
  length?: number;
  color?: string;
  label?: string;
  centerDetent?: boolean;
}

export const DragFader: FC<DragFaderProps> = ({
  value,
  min,
  max,
  onChange,
  orientation = "vertical",
  length = 120,
  color = "#22d3ee",
  label,
  centerDetent = false,
}) => {
  const isVertical = orientation === "vertical";
  const startPos = useRef(0);
  const startVal = useRef(value);
  const dragging = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  const travel = length - CAP_LENGTH;

  const down = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      startPos.current = isVertical ? e.clientY : e.clientX;
      startVal.current = value;
      dragging.current = true;
      setIsDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [value, isVertical]
  );

  const move = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const pos = isVertical ? e.clientY : e.clientX;
      const delta = isVertical ? startPos.current - pos : pos - startPos.current;
      const range = max - min;
      let next = startVal.current + (delta / travel) * range;
      next = Math.min(max, Math.max(min, next));
      if (centerDetent) {
        const mid = (min + max) / 2;
        if (Math.abs(next - mid) < range * 0.04) next = mid;
      }
      onChange(next);
    },
    [isVertical, max, min, onChange, travel, centerDetent]
  );

  const up = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragging.current = false;
    setIsDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ok */
    }
  }, []);

  const norm = (value - min) / (max - min);
  const offset = isVertical ? (1 - norm) * travel : norm * travel;

  const trackStyle: React.CSSProperties = isVertical
    ? { width: TRACK_THICKNESS, height: length }
    : { width: length, height: TRACK_THICKNESS };
  const capStyle: React.CSSProperties = isVertical
    ? { width: CAP_THICKNESS, height: CAP_LENGTH, top: offset, left: "50%", transform: "translateX(-50%)" }
    : { width: CAP_LENGTH, height: CAP_THICKNESS, left: offset, top: "50%", transform: "translateY(-50%)" };
  const containerStyle: React.CSSProperties = isVertical
    ? { width: CAP_THICKNESS + 10, height: length }
    : { width: length, height: CAP_THICKNESS + 10 };

  return (
    <div className="flex flex-col items-center gap-1 select-none">
      <div className="relative flex items-center justify-center" style={containerStyle}>
        <div
          className="absolute"
          style={{
            ...trackStyle,
            borderRadius: 2,
            background: "#0a0a0a",
            border: "1px solid rgba(255,255,255,0.06)",
            boxShadow: "inset 0 0 6px #000",
            ...(isVertical ? { left: "50%", transform: "translateX(-50%)" } : { top: "50%", transform: "translateY(-50%)" }),
          }}
        >
          <div
            className="absolute rounded-full"
            style={
              isVertical
                ? { width: "70%", left: "15%", bottom: 0, height: `${norm * 100}%`, background: `linear-gradient(to top, transparent, ${color}33)`, filter: "blur(1.5px)" }
                : { height: "70%", top: "15%", left: 0, width: `${norm * 100}%`, background: `linear-gradient(to right, transparent, ${color}33)`, filter: "blur(1.5px)" }
            }
          />
        </div>
        <div
          className="absolute cursor-grab touch-none active:cursor-grabbing"
          style={{
            ...capStyle,
            borderRadius: 2,
            background: "linear-gradient(to bottom, #9ca3af, #4b5563)",
            boxShadow: isDragging
              ? `0 2px 6px rgba(0,0,0,0.9), 0 0 12px ${color}88`
              : `0 2px 4px rgba(0,0,0,0.8), 0 0 6px ${color}44, inset 0 1px 0 #666`,
          }}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        >
          <div
            className="absolute rounded-full"
            style={
              isVertical
                ? { width: "65%", height: 1, top: "50%", left: "17.5%", background: "rgba(255,255,255,0.85)" }
                : { height: "65%", width: 1, left: "50%", top: "17.5%", background: "rgba(255,255,255,0.85)" }
            }
          />
        </div>
      </div>
      {label && <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>}
    </div>
  );
};
