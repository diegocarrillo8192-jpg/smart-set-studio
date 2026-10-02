/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

// ── Phase Meter: constantes y matemática pura de fase ──────────────────────
// Toda la lógica estática del medidor (fase en tiempo de fuente, histéresis
// de enganche y colores por zona) vive aquí, sin dependencias de React ni
// del DOM: funciones puras y testables.

export const METER_W = 240;          // wider track for more resolution
export const DISC_MAX = 16;          // disc diameter at center
export const DISC_MIN = 6;           // disc diameter at edges
export const MAX_DELTA_MS = 50;      // ±50ms display range
export const HALF_TRACK = METER_W / 2;

// Colors
export const CLR_A = '#06b6d4';      // cyan
export const CLR_B = '#a855f7';      // orange
export const CLR_GREEN = '#22c55e';  // locked (0 ms) / approaching

// Hysteresis de enganche: una vez clavado a 0 ms el indicador queda VERDE
// FIJO y continuo (sin parpadear) hasta que la fase se abra de verdad (más
// de UNLOCK_MS), no por el jitter de muestreo de currentTime.
export const LOCK_MS = 8;
export const UNLOCK_MS = 25;

/**
 * Diferencia de fase envuelta (ms) entre dos decks, medida en TIEMPO DE
 * FUENTE con los periodos ORIGINALES (60 / originalBpm): dos rejillas
 * alineadas leen 0 ms exactos y estables, sin el vaivén aparente del BPM
 * efectivo escalado por el pitch.
 */
export function phaseDeltaMs(
  timeA: number,
  timeB: number,
  originalBpmA: number,
  originalBpmB: number,
  offsetA: number,
  offsetB: number,
): number {
  if (originalBpmA <= 0 || originalBpmB <= 0) return 0;
  const periodA = 60 / originalBpmA;
  const periodB = 60 / originalBpmB;
  const beatA = (timeA - offsetA) / periodA;
  const beatB = (timeB - offsetB) / periodB;
  const fracA = ((beatA % 1) + 1) % 1;
  const fracB = ((beatB % 1) + 1) % 1;
  let delta = fracA - fracB;
  if (delta > 0.5) delta -= 1;
  if (delta < -0.5) delta += 1;
  return delta * periodA * 1000;
}

/** Histéresis de enganche: se clava con <= LOCK_MS y solo se suelta si la
 *  fase se abre más de UNLOCK_MS (ignora el jitter de muestreo). */
export function updateLock(locked: boolean, absDeltaMs: number): boolean {
  if (locked) return absDeltaMs <= UNLOCK_MS;
  return absDeltaMs <= LOCK_MS;
}

export type PhaseZone = 0 | 1 | 2 | 3 | 4;

/** Zona de convergencia: 1 = LOCKED (0 ms), 2 = NEAR, 3 = WARN, 4 = CRIT. */
export function phaseZone(absDeltaMs: number, locked: boolean): PhaseZone {
  if (locked || absDeltaMs < 2) return 1;
  if (absDeltaMs < 10) return 2;
  if (absDeltaMs < 30) return 3;
  return 4;
}

export interface ZoneColors {
  colorA: string;
  colorB: string;
  glowA: string;
  glowB: string;
}

/** Colores por zona: LOCKED = VERDE continuo y estable (sin parpadear);
 *  NEAR = verde con glow suave; WARN = mezcla nativo→verde; CRIT = nativo. */
export function zoneColors(zone: PhaseZone, absDeltaMs: number): ZoneColors {
  switch (zone) {
    case 1:
      return {
        colorA: CLR_GREEN,
        colorB: CLR_GREEN,
        glowA: '0 0 14px rgba(34,197,94,0.7), 0 0 6px rgba(34,197,94,0.4)',
        glowB: '0 0 14px rgba(34,197,94,0.7), 0 0 6px rgba(34,197,94,0.4)',
      };
    case 2:
      return {
        colorA: CLR_GREEN,
        colorB: CLR_GREEN,
        glowA: '0 0 8px rgba(34,197,94,0.5)',
        glowB: '0 0 8px rgba(34,197,94,0.5)',
      };
    case 3: {
      // t: 0 at 30ms (pure native), 1 at 10ms (pure green)
      const t = 1 - (absDeltaMs - 10) / 20; // 0..1
      const colorA = t > 0.5 ? CLR_GREEN : CLR_A;
      const colorB = t > 0.5 ? CLR_GREEN : CLR_B;
      return {
        colorA,
        colorB,
        glowA: `0 0 4px ${colorA}66`,
        glowB: `0 0 4px ${colorB}66`,
      };
    }
    default:
      return { colorA: CLR_A, colorB: CLR_B, glowA: 'none', glowB: 'none' };
  }
}

/** Color del texto del delta según la zona. */
export function zoneLabelColor(zone: PhaseZone): string {
  if (zone === 1 || zone === 2) return CLR_GREEN;
  if (zone === 3) return '#f59e0b';
  return '#ef4444';
}
