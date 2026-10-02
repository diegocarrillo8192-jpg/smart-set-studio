/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

import { useEffect, type RefObject } from 'react';
import { useMixiStore } from '../../store/mixiStore';
import { MixiEngine } from '../../audio/MixiEngine';
import {
  CLR_A,
  CLR_B,
  CLR_GREEN,
  DISC_MAX,
  DISC_MIN,
  HALF_TRACK,
  MAX_DELTA_MS,
  METER_W,
  phaseDeltaMs,
  phaseZone,
  updateLock,
  zoneColors,
  zoneLabelColor,
} from './phaseMeterCore';

interface PhaseMeterRefs {
  containerRef: RefObject<HTMLDivElement | null>;
  discARef: RefObject<HTMLDivElement | null>;
  discBRef: RefObject<HTMLDivElement | null>;
  labelRef: RefObject<HTMLSpanElement | null>;
}

/**
 * Bucle de animación del medidor de fase (rAF + mutación directa del DOM,
 * cero re-renders de React):
 *   · Fase calculada en TIEMPO DE FUENTE con los periodos ORIGINALES de cada
 *     deck (sin el vaivén aparente del BPM efectivo escalado por el pitch).
 *   · Histéresis de enganche: a 0 ms el indicador queda VERDE FIJO y continuo
 *     (sin parpadear) hasta que la fase se abra de verdad (más de UNLOCK_MS).
 */
export function usePhaseMeterAnimation(refs: PhaseMeterRefs): void {
  const { containerRef, discARef, discBRef, labelRef } = refs;

  useEffect(() => {
    // Cached store fields — BPM ORIGINAL (tiempo de fuente): la fase de la
    // rejilla se mide contra el periodo original de cada track, no contra el
    // BPM efectivo escalado por el pitch (eso introducía un vaivén aparente
    // incluso con los decks perfectamente alineados).
    let cachedPlayingA = false, cachedPlayingB = false;
    let cachedBpmA = 0, cachedBpmB = 0;
    let cachedOffsetA = 0, cachedOffsetB = 0;
    const syncCache = () => {
      const s = useMixiStore.getState();
      cachedPlayingA = s.decks.A.isPlaying; cachedPlayingB = s.decks.B.isPlaying;
      cachedBpmA = s.decks.A.originalBpm; cachedBpmB = s.decks.B.originalBpm;
      cachedOffsetA = s.decks.A.firstBeatOffset; cachedOffsetB = s.decks.B.firstBeatOffset;
    };
    syncCache();
    // Selector solo sobre `decks`: evita re-suscribir en cada mutación del
    // store (master / crossfader / UI / AI ticks incluidos).
    const unsub = useMixiStore.subscribe((s) => s.decks, syncCache);

    // Change guards
    let prevZone = -1;
    let prevDiscALeft = '';
    let prevDiscBLeft = '';
    let prevLabelText = '';
    let hidden = false;
    let locked = false;
    let rafId = 0;

    const onVis = () => {
      hidden = document.hidden;
      if (!hidden && !rafId) rafId = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVis);

    function tick() {
      if (hidden) {
        rafId = 0;
        return;
      }
      const discA = discARef.current;
      const discB = discBRef.current;
      const label = labelRef.current;
      const container = containerRef.current;
      if (!discA || !discB || !label || !container) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const bothPlaying = cachedPlayingA && cachedPlayingB && cachedBpmA > 0 && cachedBpmB > 0;

      // ── Idle state: discos en los bordes, atenuados y pequeños ──
      if (!bothPlaying) {
        if (prevZone !== 0) {
          prevZone = 0;
          container.style.opacity = '0.3';
          // A disc: left edge, small, dim cyan
          discA.style.left = '8px';
          discA.style.width = discA.style.height = `${DISC_MIN}px`;
          discA.style.background = CLR_A;
          discA.style.opacity = '0.3';
          discA.style.boxShadow = 'none';
          // B disc: right edge, small, dim orange
          discB.style.left = `${METER_W - DISC_MIN - 8}px`;
          discB.style.width = discB.style.height = `${DISC_MIN}px`;
          discB.style.background = CLR_B;
          discB.style.opacity = '0.3';
          discB.style.boxShadow = 'none';
          label.textContent = '';
          prevDiscALeft = ''; prevDiscBLeft = ''; prevLabelText = '';
        }
        rafId = requestAnimationFrame(tick);
        return;
      }

      // ── Fase estática en tiempo de fuente (periodos originales) ──
      const engine = MixiEngine.getInstance();
      if (!engine.isInitialized) { rafId = requestAnimationFrame(tick); return; }

      const timeA = engine.getOutputTime('A');
      const timeB = engine.getOutputTime('B');
      const deltaMs = phaseDeltaMs(timeA, timeB, cachedBpmA, cachedBpmB, cachedOffsetA, cachedOffsetB);
      const absDeltaRaw = Math.abs(deltaMs);

      // Histéresis de enganche: verde fijo a 0 ms, sin parpadeo por jitter.
      locked = updateLock(locked, absDeltaRaw);

      container.style.opacity = '1';

      // Clamp and normalize (clavado = 0 → discos fijos en el centro)
      const clampedDelta = Math.max(-MAX_DELTA_MS, Math.min(MAX_DELTA_MS, locked ? 0 : deltaMs));
      const normDelta = clampedDelta / MAX_DELTA_MS; // -1 to +1

      // ── Posición de los discos: convergen hacia el centro ──
      // A starts from left, B from right. Both converge to center.
      // normDelta > 0: A is ahead (B needs to catch up).
      const aOffset = normDelta * (HALF_TRACK - DISC_MAX);
      const aLeft = HALF_TRACK + aOffset - DISC_MAX / 2;
      const bLeft = HALF_TRACK - aOffset - DISC_MAX / 2;

      // ── Tamaño: más grandes cuanto más cerca del centro ──
      const absDelta = Math.abs(clampedDelta);
      const proximity = 1 - (absDelta / MAX_DELTA_MS); // 0=edge, 1=center
      const discSize = DISC_MIN + proximity * (DISC_MAX - DISC_MIN);
      const sizeStr = `${discSize | 0}px`;

      // ── Zona y colores (LOCKED = verde continuo) ──
      const zone = phaseZone(absDelta, locked);
      const colors = zoneColors(zone, absDelta);

      // ── Apply to DOM ──
      // Disc A
      const newALeft = `${aLeft | 0}px`;
      if (newALeft !== prevDiscALeft) { discA.style.left = newALeft; prevDiscALeft = newALeft; }
      discA.style.width = discA.style.height = sizeStr;
      discA.style.background = colors.colorA;
      discA.style.boxShadow = colors.glowA;
      discA.style.opacity = '1';

      // Disc B
      const newBLeft = `${bLeft | 0}px`;
      if (newBLeft !== prevDiscBLeft) { discB.style.left = newBLeft; prevDiscBLeft = newBLeft; }
      discB.style.width = discB.style.height = sizeStr;
      discB.style.background = colors.colorB;
      discB.style.boxShadow = colors.glowB;
      discB.style.opacity = '1';

      // Label
      if (zone === 1) {
        if (prevLabelText !== '') { label.textContent = ''; label.style.color = CLR_GREEN; prevLabelText = ''; }
      } else {
        const ms = Math.round(deltaMs);
        const txt = `${ms > 0 ? '+' : ''}${ms}ms`;
        if (txt !== prevLabelText) {
          label.textContent = txt;
          label.style.color = zoneLabelColor(zone);
          prevLabelText = txt;
        }
      }

      prevZone = zone;
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVis);
      unsub();
    };
  }, [containerRef, discARef, discBRef, labelRef]);
}
