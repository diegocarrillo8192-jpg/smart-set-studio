/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 *
 * This file is part of MIXI.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 * You may not use this file for commercial purposes without explicit permission.
 * For commercial licensing, contact: fabrizio.salmi@gmail.com
 */

// ─────────────────────────────────────────────────────────────
// Mixi – Universal Drag Hook
//
// Shared drag-interaction logic for Knob and Fader components.
// Uses pointer capture for reliable tracking + rAF batching
// so the audio engine and React store are updated at most once
// per frame, regardless of how many pointermove events fire.
//
// During drag a full-viewport shield element disables
// pointer-events on everything else, preventing hover
// reflows and stale-CSS recalculations.
// ─────────────────────────────────────────────────────────────

import { useCallback, useRef, useEffect, useState } from 'react';
import { useMixiStore } from '../store/mixiStore';

export interface UseDragOptions {
  /** Called on every move with the pixel delta from the start point. */
  onDrag: (deltaX: number, deltaY: number) => void;
  /** Called once when the drag ends. */
  onDragEnd?: () => void;
}

// ── Shared drag shield ───────────────────────────────────────
// A full-screen transparent overlay that captures all pointer
// events during drag, preventing hover recalculations on every
// element the cursor crosses.

let _shield: HTMLDivElement | null = null;
let _shieldUsers = 0;

function acquireShield() {
  _shieldUsers++;
  if (_shield) return;
  _shield = document.createElement('div');
  _shield.style.cssText =
    'position:fixed;inset:0;z-index:99999;cursor:grabbing;touch-action:none;';
  document.body.appendChild(_shield);
}

function releaseShield() {
  _shieldUsers = Math.max(0, _shieldUsers - 1);
  if (_shieldUsers === 0 && _shield) {
    _shield.remove();
    _shield = null;
  }
}

/**
 * Returns an `onPointerDown` handler to attach to the draggable element.
 * Internally manages global move/up listeners for reliable tracking.
 *
 * Performance guarantees:
 *   - Pointer events are coalesced via rAF (at most 1 update/frame).
 *   - A full-viewport shield suppresses hover effects during drag.
 *   - Pointer capture keeps tracking even when the cursor leaves.
 */
export function useDrag({ onDrag, onDragEnd }: UseDragOptions) {
  const startPos = useRef({ x: 0, y: 0 });
  /** Latest un-processed delta (written by pointermove, read by rAF). */
  const pendingDelta = useRef<{ dx: number; dy: number } | null>(null);
  const rafId = useRef(0);
  /** #48: Track the capture target for lostpointercapture cleanup. */
  const captureTarget = useRef<HTMLElement | null>(null);
  /** Handler exacto de lostpointercapture añadido al elemento capturado. */
  const lostCaptureHandlerRef = useRef<EventListener | null>(null);
  /** Drag en curso: activa el efecto que SUSCRIBE (y limpia) los listeners. */
  const [dragging, setDragging] = useState(false);

  const flushDeltaImpl = useRef<() => void>(undefined);
  const flushDelta = useCallback(() => {
    if (flushDeltaImpl.current) {
      const d = pendingDelta.current;
      if (d) {
        pendingDelta.current = null;
        onDrag(d.dx, d.dy);
      }
      rafId.current = requestAnimationFrame(flushDeltaImpl.current);
    }
  }, [onDrag]);
  useEffect(() => { flushDeltaImpl.current = flushDelta; }, [flushDelta]);

  const handleMove = useCallback(
    (e: PointerEvent) => {
      const dx = e.clientX - startPos.current.x;
      const dy = e.clientY - startPos.current.y;
      // Just stash the latest delta; the rAF loop will pick it up.
      pendingDelta.current = { dx, dy };
    },
    [],
  );

  // El shield se adquiere en pointerdown y se libera EXACTAMENTE una vez
  // (en el cleanup del efecto de suscripción o en el desmontaje): el guard
  // evita dobles release que descontarían el contador de otro drag activo
  // (multitouch) o de una instancia que ya liberó su shield.
  const shieldHeldRef = useRef(false);
  const releaseShieldIfHeld = useCallback(() => {
    if (shieldHeldRef.current) {
      shieldHeldRef.current = false;
      releaseShield();
    }
  }, []);

  // Finaliza el drag: flush del último delta, libera la captura y apaga la
  // suscripción (el cleanup del efecto de abajo quita listeners y shield).
  const endDrag = useCallback(
    (e: PointerEvent) => {
      // Flush any remaining delta synchronously
      const d = pendingDelta.current;
      if (d) {
        pendingDelta.current = null;
        onDrag(d.dx, d.dy);
      }

      // Release pointer capture
      try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ok */ }
      removeLostCaptureNet();
      onDragEnd?.();
      setDragging(false);
    },
    [onDrag, onDragEnd],
  );

  /** Quita el listener de lostpointercapture del elemento capturado. */
  const removeLostCaptureNet = useCallback(() => {
    if (captureTarget.current && lostCaptureHandlerRef.current) {
      captureTarget.current.removeEventListener('lostpointercapture', lostCaptureHandlerRef.current);
    }
    captureTarget.current = null;
    lostCaptureHandlerRef.current = null;
  }, []);

  // #48: Safety net — if pointer capture is lost unexpectedly,
  // clean up the drag state so controls don't stay stuck.
  const handleLostCapture = useCallback(
    () => {
      cancelAnimationFrame(rafId.current);
      pendingDelta.current = null;
      removeLostCaptureNet();
      onDragEnd?.();
      setDragging(false);
    },
    [onDragEnd, removeLostCaptureNet],
  );

  // Los callbacks pueden cambiar de identidad entre renders (p. ej. si el
  // consumidor pasa lambdas inline); el efecto de suscripción usa SIEMPRE las
  // versiones más recientes vía refs para no re-suscribirse a mitad del drag.
  const endDragRef = useRef(endDrag);
  useEffect(() => { endDragRef.current = endDrag; }, [endDrag]);
  const handleLostCaptureRef = useRef(handleLostCapture);
  useEffect(() => { handleLostCaptureRef.current = handleLostCapture; }, [handleLostCapture]);

  // Suscripción global de la ventana: vive en un efecto con CLEANUP, de modo
  // que los listeners de pointermove/pointerup se quitan SIEMPRE (fin de drag
  // y desmontaje del componente) — sin fugas si se desmonta a mitad del drag.
  useEffect(() => {
    if (!dragging) return;
    const onUp = (e: PointerEvent) => endDragRef.current(e);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', onUp);
    // Start the rAF flush loop.
    rafId.current = requestAnimationFrame(() => flushDeltaImpl.current?.());

    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', onUp);
      cancelAnimationFrame(rafId.current);
      pendingDelta.current = null;
      // El shield y la red de lostpointercapture se liberan aquí también:
      // cubre el desmontaje a mitad de drag (único punto de release).
      removeLostCaptureNet();
      releaseShieldIfHeld();
    };
  }, [dragging, handleMove, removeLostCaptureNet, releaseShieldIfHeld]);

  // Red de seguridad de desmontaje: si el componente se desmonta ANTES de que
  // el efecto de suscripción llegue a ejecutarse (pointerdown y desmontaje en
  // el mismo commit), el shield y la captura se liberan igualmente aquí.
  useEffect(() => {
    return () => {
      removeLostCaptureNet();
      releaseShieldIfHeld();
    };
  }, [removeLostCaptureNet, releaseShieldIfHeld]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      // Signal the AI that a human is touching a control.
      useMixiStore.getState().registerUserInteraction();
      startPos.current = { x: e.clientX, y: e.clientY };

      // Capture pointer so events keep flowing even outside window.
      const el = e.target as HTMLElement;
      try { el.setPointerCapture(e.pointerId); } catch { /* ok */ }
      captureTarget.current = el;
      acquireShield();
      shieldHeldRef.current = true;

      // #48: If pointer capture is lost (browser alert, OS dialog, etc.)
      // force-end the drag so the fader doesn't stay stuck.
      lostCaptureHandlerRef.current = handleLostCaptureRef.current as EventListener;
      el.addEventListener('lostpointercapture', lostCaptureHandlerRef.current, { once: true });

      // Activa la suscripción (y su cleanup) del efecto de arriba.
      setDragging(true);
    },
    [],
  );

  return { onPointerDown };
}
