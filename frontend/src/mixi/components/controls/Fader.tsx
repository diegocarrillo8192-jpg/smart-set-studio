/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 *
 * This file is part of MIXI.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 * You may not use this file for commercial purposes without explicit permission.
 * For commercial licensing, contact: fabrizio.salmi@gmail.com
 */

// ─────────────────────────────────────────────────────────────
// Mixi – Fader Control (Vertical & Horizontal)
//
// Custom fader built with divs + pointer-drag.
// Used for channel volume, pitch, and crossfader.
//
// Interaction:
//   Vertical   → drag UP to increase
//   Horizontal → drag RIGHT to increase
//   Global pointer capture so fast movements never "escape".
//
// Visual:
//   A recessed dark track with a metallic fader cap that slides
//   along it. White centre-line on the cap for precision.
// ─────────────────────────────────────────────────────────────

import { useCallback, useRef, useState, useEffect, type FC } from 'react';
import { useDrag } from '../../hooks/useDrag';
import { useMidiStore } from '../../store/midiStore';

// ── Types ────────────────────────────────────────────────────

export interface FaderProps {
  /** Current value. */
  value: number;
  /** Range minimum. */
  min: number;
  /** Range maximum. */
  max: number;
  /** Fires on drag with new value. */
  onChange: (value: number) => void;
  /** 'vertical' for volume/pitch, 'horizontal' for crossfader. */
  orientation?: 'vertical' | 'horizontal';
  /** Track length in px (the slider travel distance). */
  length?: number;
  /** Accent colour for the cap glow. */
  color?: string;
  /** Label shown below/beside the fader. */
  label?: string;
  /** Ghost mode: when true, glow turns purple (AI is controlling). */
  ghost?: boolean;
  /** Override cap dimensions [length, thickness] in px. */
  capSize?: [number, number];
  midiAction?: any;
}

// ── Dimensions ───────────────────────────────────────────────
const TRACK_THICKNESS = 6; // px – the recessed groove width
const CAP_LENGTH = 28; // px along travel axis
const CAP_THICKNESS = 20; // px perpendicular to travel
// Inset of the track from the container edges. Guarantees the cap never
// sits flush against (or gets clipped by) the top/bottom of its container,
// keeping the thumb 100% visible at both 0% and 100%.
const TRACK_PAD = 8;

// ── Component ────────────────────────────────────────────────

/** Ghost color — electric purple (AI is in control). */
const COLOR_GHOST = 'var(--clr-master)';

// ── Style helpers ────────────────────────────────────────────

function buildTrackStyle(isVertical: boolean, length: number): React.CSSProperties {
  return isVertical
    ? { width: TRACK_THICKNESS, height: length - TRACK_PAD * 2 }
    : { width: length - TRACK_PAD * 2, height: TRACK_THICKNESS };
}

function buildCapStyle(
  isVertical: boolean,
  capThk: number,
  capLen: number,
  offset: number,
): React.CSSProperties {
  return isVertical
    ? {
        width: capThk,
        height: capLen,
        top: offset,
        left: '50%',
        transform: 'translateX(-50%)',
      }
    : {
        width: capLen,
        height: capThk,
        left: offset,
        top: '50%',
        transform: 'translateY(-50%)',
      };
}

function buildContainerStyle(
  isVertical: boolean,
  capThk: number,
  length: number,
): React.CSSProperties {
  return isVertical
    ? { width: capThk + 12, height: length }
    : { width: length, height: capThk + 12 };
}

function faderAriaLabel(label: string | undefined, isVertical: boolean): string {
  return label || (isVertical ? 'Volume fader' : 'Crossfader');
}

// ── Subcomponents ────────────────────────────────────────────

interface FaderTrackProps {
  isVertical: boolean;
  length: number;
  norm: number;
  glowColor: string;
}

/** Ranura empotrada del fader: pista, estela luminosa y marca central. */
const FaderTrack: FC<FaderTrackProps> = ({ isVertical, length, norm, glowColor }) => (
  <div
    className="absolute"
    style={{
      ...buildTrackStyle(isVertical, length),
      borderRadius: 2,
      background: 'var(--srf-deep, #080808)',
      border: '1px solid rgba(255,255,255,0.06)',
      boxShadow: isVertical
        ? 'inset 3px 0 6px var(--srf-deep, #000), inset -3px 0 6px var(--srf-deep, #000), inset 0 3px 6px rgba(0,0,0,0.9), inset 0 -1px 2px rgba(0,0,0,0.6)'
        : 'inset 0 3px 6px var(--srf-deep, #000), inset 0 -3px 6px var(--srf-deep, #000), inset 3px 0 6px rgba(0,0,0,0.9), inset -1px 0 2px rgba(0,0,0,0.6)',
      // Inset the track from the container edges (cap clearance)
      ...(isVertical
        ? { top: TRACK_PAD, left: '50%', transform: 'translateX(-50%)' }
        : { left: TRACK_PAD, top: '50%', transform: 'translateY(-50%)' }),
    }}
  >
    {/* Track glow — thin luminous trail, brighter near cap */}
    <div
      className="absolute rounded-full"
      style={
        isVertical
          ? {
              width: '70%',
              left: '15%',
              bottom: 0,
              height: `${norm * 100}%`,
              background: `linear-gradient(to top, transparent, ${glowColor}22, ${glowColor}33)`,
              filter: 'blur(1.5px)',
            }
          : {
              height: '70%',
              top: '15%',
              left: 0,
              width: `${norm * 100}%`,
              background: `linear-gradient(to right, transparent, ${glowColor}22, ${glowColor}33)`,
              filter: 'blur(1.5px)',
            }
      }
    />
    {/* Centre tick mark */}
    <div
      className="absolute bg-zinc-700"
      style={
        isVertical
          ? { width: '100%', height: 1, top: '50%' }
          : { height: '100%', width: 1, left: '50%' }
      }
    />
  </div>
);

interface FaderCapProps {
  isVertical: boolean;
  isDragging: boolean;
  glowColor: string;
  capLen: number;
  capThk: number;
  offset: number;
  onPointerDown: (e: React.PointerEvent) => void;
}

/** Tapa metálica del fader con línea indicadora incisa. */
const FaderCap: FC<FaderCapProps> = ({
  isVertical,
  isDragging,
  glowColor,
  capLen,
  capThk,
  offset,
  onPointerDown,
}) => (
  <div
    className="absolute cursor-grab active:cursor-grabbing"
    style={{
      ...buildCapStyle(isVertical, capThk, capLen, offset),
      borderRadius: 2,
      background: 'linear-gradient(to bottom, var(--txt-muted), var(--brd-subtle))',
      boxShadow: isDragging
        ? `0 2px 6px rgba(0,0,0,0.9), 0 0 12px ${glowColor}55, 0 0 4px ${glowColor}33, inset 0 1px 0 #666, inset 0 -1px 0 #111`
        : `0 2px 4px rgba(0,0,0,0.8), 0 0 6px ${glowColor}33, inset 0 1px 0 #666, inset 0 -1px 0 #111`,
    }}
    onPointerDown={onPointerDown}
  >
    {/* Incised white indicator line — shadow above, bright below */}
    <div
      className="absolute rounded-full"
      style={
        isVertical
          ? {
              width: '65%', height: 1, top: 'calc(50% - 1px)', left: '17.5%',
              background: 'rgba(0,0,0,0.4)',
            }
          : {
              height: '65%', width: 1, left: 'calc(50% - 1px)', top: '17.5%',
              background: 'rgba(0,0,0,0.4)',
            }
      }
    />
    <div
      className="absolute rounded-full"
      style={
        isVertical
          ? {
              width: '65%', height: 1, top: '50%', left: '17.5%',
              background: 'rgba(255,255,255,0.85)',
              boxShadow: '0 0 3px rgba(255,255,255,0.4)',
            }
          : {
              height: '65%', width: 1, left: '50%', top: '17.5%',
              background: 'rgba(255,255,255,0.85)',
              boxShadow: '0 0 3px rgba(255,255,255,0.4)',
            }
      }
    />
  </div>
);

export const Fader: FC<FaderProps> = ({
  value,
  min,
  max,
  onChange,
  orientation = 'vertical',
  length = 120,
  color = 'var(--clr-a)',
  label,
  ghost = false,
  capSize,
  midiAction,
}) => {
  const glowColor = ghost ? COLOR_GHOST : color;
  const isVertical = orientation === 'vertical';
  const capLen = capSize ? capSize[0] : CAP_LENGTH;
  const capThk = capSize ? capSize[1] : CAP_THICKNESS;
  const valueAtDragStart = useRef(value);
  const [isDragging, setIsDragging] = useState(false);

  // ── Mouse-wheel fine control (crossfader, volume faders) ─────
  // Rueda arriba/abajo = ±1 paso; Shift = ajuste fino. passive:false para
  // frenar el scroll de la página mientras se ajusta el fader.
  const rootRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const range = max - min;
      const step = e.shiftKey ? range / 200 : range / 40;
      const dir = e.deltaY < 0 ? 1 : -1;
      const next = Math.min(max, Math.max(min, valueRef.current + dir * step));
      valueRef.current = next;
      onChange(next);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [min, max, onChange]);

  const onDrag = useCallback(
    (dx: number, dy: number) => {
      const range = max - min;
      const pixelDelta = isVertical ? -dy : dx;
      const travelPx = length - capLen - TRACK_PAD * 2;
      const delta = (pixelDelta / travelPx) * range;
      const raw = valueAtDragStart.current + delta;
      onChange(Math.min(max, Math.max(min, raw)));
    },
    [min, max, onChange, isVertical, length, capLen],
  );

  const { onPointerDown } = useDrag({
    onDrag,
    onDragEnd: () => setIsDragging(false),
  });

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (midiAction && (window as any).__MIXIMIDILEARN__ && useMidiStore.getState().isLearning) {
        e.preventDefault();
        e.stopPropagation();
        (window as any).__MIXIMIDILEARN__(midiAction);
        return;
      }
      valueAtDragStart.current = value;
      setIsDragging(true);
      onPointerDown(e);
    },
    [value, onPointerDown, midiAction],
  );

  // ── Position calculation ─────────────────────────────────

  const norm = (value - min) / (max - min); // 0–1
  const travelPx = length - capLen - TRACK_PAD * 2;
  // For vertical: 0 = bottom, 1 = top → invert for CSS top offset.
  // The cap travels inside the padded track so it never touches the edges.
  const offset = TRACK_PAD + (isVertical ? (1 - norm) * travelPx : norm * travelPx);

  // ── Render ───────────────────────────────────────────────

  return (
    <div
      ref={rootRef}
      className="flex flex-col items-center gap-1 select-none touch-none"
      role="slider"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value * 100) / 100}
      aria-label={faderAriaLabel(label, isVertical)}
      aria-orientation={isVertical ? 'vertical' : 'horizontal'}
      tabIndex={0}
    >
      {/* Fader container */}
      <div className="relative flex items-center justify-center" style={buildContainerStyle(isVertical, capThk, length)}>
        <FaderTrack isVertical={isVertical} length={length} norm={norm} glowColor={glowColor} />
        <FaderCap
          isVertical={isVertical}
          isDragging={isDragging}
          glowColor={glowColor}
          capLen={capLen}
          capThk={capThk}
          offset={offset}
          onPointerDown={handlePointerDown}
        />
      </div>

      {label && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-zinc-400">
          {label}
        </span>
      )}
    </div>
  );
};
