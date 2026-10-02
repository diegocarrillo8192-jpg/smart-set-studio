/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

import { type FC, type RefObject } from 'react';
import { CLR_A, CLR_B, DISC_MAX, DISC_MIN, HALF_TRACK, METER_W } from './phaseMeterCore';

interface PhaseIndicatorProps {
  containerRef: RefObject<HTMLDivElement | null>;
  discARef: RefObject<HTMLDivElement | null>;
  discBRef: RefObject<HTMLDivElement | null>;
  labelRef: RefObject<HTMLSpanElement | null>;
}

/** Vista estática del medidor de fase (Dual-Disc): pista central, discos A/B
 *  y etiqueta de delta. Todo el movimiento y los colores se aplican por rAF
 *  con mutación directa del DOM (cero re-renders de React): este componente
 *  solo monta los nodos y expone sus refs al bucle de animación. */
export const PhaseIndicator: FC<PhaseIndicatorProps> = ({
  containerRef,
  discARef,
  discBRef,
  labelRef,
}) => (
  <div
    ref={containerRef}
    className="relative flex items-center justify-center shrink-0"
    style={{ width: METER_W, height: DISC_MAX + 8, opacity: 0.3 }}
  >
    {/* Track line */}
    <div
      className="absolute"
      style={{
        width: METER_W - 16,
        height: 1,
        left: 8,
        top: '50%',
        background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.06) 20%, rgba(255,255,255,0.06) 80%, transparent)',
      }}
    />

    {/* Center tick */}
    <div
      className="absolute"
      style={{
        width: 1,
        height: DISC_MAX + 4,
        left: HALF_TRACK,
        top: '50%',
        transform: 'translateY(-50%)',
        background: 'rgba(255,255,255,0.08)',
      }}
    />

    {/* Disc A (cyan, comes from left) */}
    <div
      ref={discARef}
      className="absolute rounded-full"
      style={{
        width: DISC_MIN,
        height: DISC_MIN,
        left: 8,
        top: '50%',
        transform: 'translateY(-50%)',
        background: CLR_A,
        opacity: 0.3,
      }}
    />

    {/* Disc B (orange, comes from right) */}
    <div
      ref={discBRef}
      className="absolute rounded-full"
      style={{
        width: DISC_MIN,
        height: DISC_MIN,
        left: METER_W - DISC_MIN - 8,
        top: '50%',
        transform: 'translateY(-50%)',
        background: CLR_B,
        opacity: 0.3,
      }}
    />

    {/* Deck labels */}
    <span
      className="absolute text-[6px] font-mono font-bold"
      style={{ left: 0, bottom: -1, color: CLR_A, opacity: 0.4 }}
    >
      A
    </span>
    <span
      className="absolute text-[6px] font-mono font-bold"
      style={{ right: 0, bottom: -1, color: CLR_B, opacity: 0.4 }}
    >
      B
    </span>

    {/* Delta label */}
    <span
      ref={labelRef}
      className="absolute text-[7px] font-mono font-bold tabular-nums"
      style={{
        bottom: -2,
        left: '50%',
        transform: 'translateX(-50%)',
        color: 'transparent',
        whiteSpace: 'nowrap',
      }}
    />
  </div>
);
