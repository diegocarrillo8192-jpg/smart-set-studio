/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

// ── Phase Meter (Dual-Disc Convergence) ─────────────────────────────────────
// Two discs (A = cyan, B = orange) converge toward center.
// As they approach:
//   - They grow from small (edges) to full size (center)
//   - Colors transition through green when overlapping
//   - At perfect sync (0 ms), both lock steady green (hysteresis: no flicker)
//
// Edge cases handled:
//   - Wrap-around: beat phase normalized to ±0.5 range
//   - Sudden jumps: no CSS transitions on position (instant)
//   - Idle: discs dim and shrink when not both playing
//
// Structure (modular):
//   · phaseMeterCore.ts         → constantes + fase pura + histéresis + colores
//   · PhaseIndicator.tsx        → vista estática (nodos + refs)
//   · usePhaseMeterAnimation.ts → bucle rAF + mutación directa del DOM
//   · PhaseMeter.tsx            → composición (este archivo)
// Updates via rAF + direct DOM mutation (zero React re-renders).
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, type FC } from 'react';
import { PhaseIndicator } from './PhaseIndicator';
import { usePhaseMeterAnimation } from './usePhaseMeterAnimation';

export const PhaseMeter: FC = () => {
  const containerRef = useRef<HTMLDivElement>(null);
  const discARef = useRef<HTMLDivElement>(null);
  const discBRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);

  usePhaseMeterAnimation({ containerRef, discARef, discBRef, labelRef });

  return (
    <PhaseIndicator
      containerRef={containerRef}
      discARef={discARef}
      discBRef={discBRef}
      labelRef={labelRef}
    />
  );
};
