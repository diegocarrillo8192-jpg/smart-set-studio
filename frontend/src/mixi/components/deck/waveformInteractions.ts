/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 *
 * This file is part of MIXI.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 * You may not use this file for commercial purposes without explicit permission.
 * For commercial licensing, contact: fabrizio.salmi@gmail.com
 */

// ─────────────────────────────────────────────────────────────
// Mixi – Waveform Interaction Logic (pure functions)
//
// Extracted from WaveformDisplay for testability.
// All functions are pure — no React, no DOM, no side effects.
// ─────────────────────────────────────────────────────────────

import { BAR_STEP, BASE_PIXELS_PER_SECOND } from './waveformConstants';
export { BAR_STEP, BASE_PIXELS_PER_SECOND };

// ── Coordinate conversion ───────────────────────────────────

/** Convert a screen X offset (pixels from canvas left) to a time in seconds.
 *  `startTime` is the audio time at the left edge of the canvas (seconds);
 *  `zoom` is the zoom factor applied to BASE_PIXELS_PER_SECOND. */
export function screenXToTime(
  clickX: number,
  startTime: number,
  zoom: number,
): number {
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom;
  return Math.max(0, startTime + clickX / pixelsPerSecond);
}

/** Convert a time (seconds) to a screen X offset (pixels from canvas left).
 *  Pure linear mapping: x = (time - startTime) * pixelsPerSecond. */
export function timeToScreenX(
  time: number,
  startTime: number,
  zoom: number,
): number {
  const pixelsPerSecond = BASE_PIXELS_PER_SECOND * zoom;
  return (time - startTime) * pixelsPerSecond;
}

// ── Snap to beat ────────────────────────────────────────────

/**
 * Snap a time to the nearest beat on the grid.
 * Returns the original time if:
 *   - bpm <= 0
 *   - quantize is off AND forceSnap is false
 *   - the nearest beat is more than 40% of a beat period away
 */
export function snapToBeat(
  time: number,
  bpm: number,
  firstBeatOffset: number,
  quantize: boolean,
  forceSnap: boolean,
): number {
  if (bpm <= 0 || (!quantize && !forceSnap)) return time;
  const beatPeriod = 60 / bpm;
  const beatNum = Math.round((time - firstBeatOffset) / beatPeriod);
  const snapped = firstBeatOffset + beatNum * beatPeriod;
  if (Math.abs(time - snapped) < beatPeriod * 0.4) return snapped;
  return time;
}

// ── Hit testing ─────────────────────────────────────────────

export const HIT_RADIUS = 8; // pixels

export interface HitResult {
  type: 'cue' | 'loop-start' | 'loop-end' | 'none';
  index: number; // cue index (0-7), or -1 for loop/none
}

/**
 * Test whether a click at screenX hits a hot cue marker or loop border.
 * Returns the first hit found (cues checked first, then loop borders).
 */
export function hitTest(
  clickX: number,
  hotCues: (number | null)[],
  loop: { start: number; end: number } | null,
  startIndex: number,
  zoom: number,
): HitResult {
  // Check hot cues
  for (let i = 0; i < hotCues.length; i++) {
    const cueTime = hotCues[i];
    if (cueTime === null) continue;
    const cx = timeToScreenX(cueTime, startIndex, zoom);
    if (Math.abs(clickX - cx) < HIT_RADIUS) {
      return { type: 'cue', index: i };
    }
  }

  // Check loop borders
  if (loop) {
    const lxStart = timeToScreenX(loop.start, startIndex, zoom);
    const lxEnd = timeToScreenX(loop.end, startIndex, zoom);
    if (Math.abs(clickX - lxStart) < HIT_RADIUS) {
      return { type: 'loop-start', index: -1 };
    }
    if (Math.abs(clickX - lxEnd) < HIT_RADIUS) {
      return { type: 'loop-end', index: -1 };
    }
  }

  return { type: 'none', index: -1 };
}

// ── Zoom on mouse ───────────────────────────────────────────

/**
 * Compute the new startTime after zooming, keeping the time under the
 * mouse cursor fixed on screen.
 *
 * @param mouseX        Mouse X position in canvas pixels
 * @param oldStartTime  Current startTime (seconds at left edge)
 * @param oldZoom       Current zoom level
 * @param newZoom       New zoom level after scroll
 * @returns             New startTime (seconds)
 */
export function zoomAtPoint(
  mouseX: number,
  oldStartTime: number,
  oldZoom: number,
  newZoom: number,
): number {
  const oldPixelsPerSecond = BASE_PIXELS_PER_SECOND * oldZoom;
  const newPixelsPerSecond = BASE_PIXELS_PER_SECOND * newZoom;
  const timeUnderMouse = oldStartTime + mouseX / oldPixelsPerSecond;
  return timeUnderMouse - mouseX / newPixelsPerSecond;
}

// ── Loop resize validation ──────────────────────────────────

/**
 * Compute new loop boundaries when dragging a border.
 * Returns null if the drag would make the loop too short (< 50ms).
 */
export function resizeLoop(
  side: 'start' | 'end',
  newTime: number,
  currentStart: number,
  currentEnd: number,
): { start: number; end: number } | null {
  const MIN_LOOP = 0.05; // 50ms minimum
  if (side === 'start') {
    if (newTime >= currentEnd - MIN_LOOP) return null;
    return { start: newTime, end: currentEnd };
  } else {
    if (newTime <= currentStart + MIN_LOOP) return null;
    return { start: currentStart, end: newTime };
  }
}

// ── Context menu position clamping ──────────────────────────

/**
 * Clamp context menu position so it stays within the canvas bounds.
 */
export function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } {
  return {
    x: Math.min(x, canvasWidth - menuWidth),
    y: Math.min(y, canvasHeight - menuHeight),
  };
}
