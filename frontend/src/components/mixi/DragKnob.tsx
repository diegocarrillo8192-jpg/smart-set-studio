import { useCallback, useId, useRef, type FC } from "react";

/**
 * Knob rotatorio estilo MIXI (adaptado de components/controls/Knob.tsx,
 * github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 *
 * Arrastrar verticalmente cambia el valor (200 px = recorrido completo),
 * doble clic = reset. Modo `bipolar` ilumina el arco desde el centro (EQ).
 */

const ARC_DEGREES = 270;
const HALF_ARC = ARC_DEGREES / 2;
const DRAG_SENSITIVITY = 180;
const SIZE = 46;
const CX = SIZE / 2;
const CY = SIZE / 2;
const RADIUS = 17;

export interface DragKnobProps {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label?: string;
  bipolar?: boolean;
  center?: number;
  color?: string;
  defaultValue?: number;
  size?: number;
  unit?: string;
  showValue?: boolean;
}

function polar(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeArc(cx: number, cy: number, r: number, a0: number, a1: number) {
  const start = polar(cx, cy, r, a0);
  const end = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${large} 1 ${end.x} ${end.y}`;
}

function normCentred(value: number, min: number, max: number, centre: number) {
  if (value <= centre) return centre === min ? 0.5 : (0.5 * (value - min)) / (centre - min);
  return centre === max ? 0.5 : 0.5 + (0.5 * (value - centre)) / (max - centre);
}

export const DragKnob: FC<DragKnobProps> = ({
  value,
  min,
  max,
  onChange,
  label,
  bipolar = false,
  center: centerProp,
  color = "#22d3ee",
  defaultValue,
  size = SIZE,
  unit = "",
  showValue = false,
}) => {
  const centre = centerProp ?? (min + max) / 2;
  const startY = useRef(0);
  const startVal = useRef(value);
  const dragging = useRef(false);
  const gradId = useId();

  const down = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      e.preventDefault();
      startY.current = e.clientY;
      startVal.current = value;
      dragging.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [value]
  );

  const move = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragging.current) return;
      const dy = e.clientY - startY.current;
      const range = max - min;
      let next = startVal.current + (-dy / DRAG_SENSITIVITY) * range;
      next = Math.min(max, Math.max(min, next));
      if (bipolar && Math.abs(next - centre) < range * 0.02) next = centre;
      onChange(next);
    },
    [max, min, onChange, bipolar, centre]
  );

  const up = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ok */
    }
  }, []);

  const reset = useCallback(() => {
    const rv = defaultValue ?? (bipolar ? centre : undefined);
    if (rv !== undefined) onChange(rv);
  }, [defaultValue, bipolar, centre, onChange]);

  const hasCentre = bipolar && centerProp !== undefined;
  const norm = hasCentre ? normCentred(value, min, max, centre) : (value - min) / (max - min);
  const angle = -HALF_ARC + norm * ARC_DEGREES;
  const ind0 = polar(CX, CY, 6, angle);
  const ind1 = polar(CX, CY, RADIUS - 1, angle);
  const arcPath = bipolar
    ? angle === 0
      ? ""
      : describeArc(CX, CY, RADIUS, 0, angle)
    : norm === 0
      ? ""
      : describeArc(CX, CY, RADIUS, -HALF_ARC, angle);
  const atCentre = bipolar && value === centre;

  return (
    <div className="flex flex-col items-center gap-0.5 select-none">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        role="slider"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-label={label}
        tabIndex={0}
        className="cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onDoubleClick={reset}
      >
        <circle cx={CX} cy={CY} r={RADIUS + 2} fill="none" stroke="#1f2937" strokeWidth={1} />
        <circle cx={CX} cy={CY} r={RADIUS} fill="#18181b" />
        <circle cx={CX} cy={CY} r={RADIUS} fill={`url(#${gradId})`} opacity={0.5} />
        <path
          d={describeArc(CX, CY, RADIUS, -HALF_ARC, HALF_ARC)}
          fill="none"
          stroke="#2b3340"
          strokeWidth={3.5}
          strokeLinecap="round"
        />
        {arcPath && (
          <path d={arcPath} fill="none" stroke={color} strokeWidth={7} strokeLinecap="round" opacity={0.25} style={{ filter: "blur(3px)" }} />
        )}
        {arcPath && (
          <path d={arcPath} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${color})` }} />
        )}
        <line
          x1={ind0.x}
          y1={ind0.y}
          x2={ind1.x}
          y2={ind1.y}
          stroke={atCentre ? "#ffffff" : "#e5e7eb"}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
        <defs>
          <radialGradient id={gradId} cx="38%" cy="30%" r="60%">
            <stop offset="0%" stopColor="#9ca3af" />
            <stop offset="50%" stopColor="#3f3f46" />
            <stop offset="100%" stopColor="#18181b" />
          </radialGradient>
        </defs>
      </svg>
      {label && (
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400">{label}</span>
      )}
      {showValue && (
        <span className="font-mono text-[8px] text-slate-400">
          {Math.round(value)}
          {unit}
        </span>
      )}
    </div>
  );
};
