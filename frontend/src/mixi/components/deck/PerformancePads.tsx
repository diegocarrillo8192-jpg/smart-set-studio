/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 *
 * This file is part of MIXI.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 * You may not use this file for commercial purposes without explicit permission.
 * For commercial licensing, contact: fabrizio.salmi@gmail.com
 */

// ─────────────────────────────────────────────────────────────
// Mixi – Performance Pads (Pioneer Rekordbox style)
//
// Two modes, selectable via tab buttons:
//
//   HOT CUE  – 8 pads that save/recall cue points
//   AUTO LOOP – 8 pads with beat-based loop lengths
//
// Interaction:
//   HOT CUE mode:
//     Click empty pad   → saves current position (quantised)
//     Click filled pad  → jumps to that cue point
//     Shift+Click / Right-click → deletes the cue
//
//   AUTO LOOP mode:
//     Click pad          → engages a loop of that beat length
//     Click active pad   → exits the loop
//
// Visual:
//   Dark 4×2 grid, pads glow with assigned colours when active.
//   Hardware-inspired beveled look with Tailwind shadows.
// ─────────────────────────────────────────────────────────────

import { useState, useCallback, useEffect, useMemo, memo, type FC, type MouseEvent, type PointerEvent } from 'react';
import { useMixiStore } from '../../store/mixiStore';
import { MixiEngine } from '../../audio/MixiEngine';
import type { DeckId } from '../../types';
import { CUE_COLORS } from '../../theme';
import { fxUnitState } from './fxUnitState';

const QUANTIZE_VALUES = [
  { beats: 4,     label: '4' },
  { beats: 2,     label: '2' },
  { beats: 1,     label: '1' },
  { beats: 0.5,   label: '1/2' },
  { beats: 0.25,  label: '1/4' },
  { beats: 0.125, label: '1/8' },
  { beats: 0.0625, label: '1/16' },
] as const;

// ── Constants ────────────────────────────────────────────────

type PadMode = 'hotcue' | 'loop' | 'beatjump' | 'looproll';

/** Beat lengths for the auto-loop pads. */
const LOOP_BEATS = [1, 2, 4, 8, 16, 32, 0.5, 0.25] as const;

/** Display labels for loop pads. */
const LOOP_LABELS = ['1', '2', '4', '8', '16', '32', '1/2', '1/4'] as const;

/** Beat jump amounts — top row backward, bottom row forward. */
const JUMP_BEATS = [-32, -8, -4, -1, 1, 4, 8, 32] as const;
const JUMP_LABELS = ['<<32', '<<8', '<<4', '<<1', '>>1', '>>4', '>>8', '>>32'] as const;

// ── Component ────────────────────────────────────────────────

interface PerformancePadsProps {
  deckId: DeckId;
  color: string;
  /** Layout vertical compacto para el panel lateral del deck. */
  compact?: boolean;
}

const PerformancePadsBase: FC<PerformancePadsProps> = ({ deckId, color, compact = false }) => {
  const [mode, setMode] = useState<PadMode>('hotcue');
  const quantize = useMixiStore((s) => s.decks[deckId].quantize);
  const setQuantize = useMixiStore((s) => s.setQuantize);
  const [qValueIdx, setQValueIdx] = useState(2);

  const toggleQuantize = useCallback(
    () => setQuantize(deckId, !quantize),
    [deckId, quantize, setQuantize],
  );

  const cycleQValue = useCallback(() => {
    setQValueIdx((prev) => (prev + 1) % QUANTIZE_VALUES.length);
  }, []);

  const qVal = useMemo(() => QUANTIZE_VALUES[qValueIdx], [qValueIdx]);

  // ── Layout vertical compacto (panel lateral del deck) ──
  if (compact) {
    return (
      <div className="flex w-[150px] flex-col gap-1">
        <div className="grid grid-cols-2 gap-1">
          <ModeTab label="HOT CUE" active={mode === 'hotcue'} onClick={() => setMode('hotcue')} color={color} />
          <ModeTab label="AUTO LOOP" active={mode === 'loop'} onClick={() => setMode('loop')} color="var(--clr-b)" />
          <ModeTab label="BEAT JUMP" active={mode === 'beatjump'} onClick={() => setMode('beatjump')} color="var(--clr-master)" />
          <ModeTab label="LOOP ROLL" active={mode === 'looproll'} onClick={() => setMode('looproll')} color="#22d3ee" />
        </div>
        <PadGrid mode={mode} deckId={deckId} gridClass="grid grid-cols-2 gap-1 [&_button]:h-7" />
        {/* (base del deck despejada) */}
        <button
          type="button"
          onClick={toggleQuantize}
          className="rounded-md py-1 text-[11px] font-medium uppercase tracking-[0.15em] transition active:scale-95"
          style={{
            background: quantize ? 'rgba(168,85,247,0.2)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${quantize ? 'var(--clr-master)' : 'var(--brd-default)'}`,
            color: quantize ? 'var(--clr-master)' : 'rgba(148, 163, 184, 0.7)',
          }}
          title="Quantize: snap cues & loops to the beat grid"
        >
          Q · {qVal.label}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 w-full">
      {/* ── Header row: FX | mode tabs | QT ─────────────────── */}
      <div className="flex gap-1.5 items-end w-full">
        {/* FX label — same underline style as mode tabs but fixed gray */}
        <span className="text-[11px] font-medium tracking-[0.15em] text-center uppercase shrink-0 pb-[3px]"
          style={{ color: 'rgba(148, 163, 184, 0.7)', width: 48, borderBottom: '1px solid rgba(148,163,184,0.18)' }}>FX</span>

        {/* Mode tabs — compactas horizontalmente (ancho según su texto) */}
        <div className="flex gap-2 items-center flex-1 justify-start">
          <ModeTab label="HOT CUE" active={mode === 'hotcue'} onClick={() => setMode('hotcue')} color={color} />
          <ModeTab label="AUTO LOOP" active={mode === 'loop'} onClick={() => setMode('loop')} color="var(--clr-b)" />
          <ModeTab label="BEAT JUMP" active={mode === 'beatjump'} onClick={() => setMode('beatjump')} color="var(--clr-master)" />
          <ModeTab label="LOOP ROLL" active={mode === 'looproll'} onClick={() => setMode('looproll')} color="#22d3ee" />
        </div>

        {/* QT label — same underline style as mode tabs but fixed gray */}
        <span className="text-[11px] font-medium tracking-[0.15em] text-center uppercase shrink-0 pb-[3px]"
          style={{ color: 'rgba(148, 163, 184, 0.7)', width: 48, borderBottom: '1px solid rgba(148,163,184,0.18)' }}>QT</span>
      </div>

      {/* ── FX toggle + Pads + Quantize strip ──────────────── */}
      <div className="flex gap-1.5 w-full">
        {/* FX ON/OFF — left column */}
        <div className="flex flex-col gap-1.5 shrink-0" style={{ width: 48 }}>
          <FxToggleButton deckId={deckId} unitKey="fx1" color={color} />
          <FxToggleButton deckId={deckId} unitKey="fx2" color={color} />
        </div>

        {/* Pad grid — 2 filas × 4 columnas (2×4): etiquetas de loop legibles */}
        <PadGrid mode={mode} deckId={deckId} gridClass="grid grid-cols-4 gap-1.5 flex-1 min-w-0" />

        {/* Quantize — right column, aligned with pitch strip above */}
        <QuantizeColumn
          quantize={quantize}
          qLabel={qVal.label}
          onToggleQuantize={toggleQuantize}
          onCycleQValue={cycleQValue}
        />
      </div>
    </div>
  );
};

// Memoised so a parent re-render (panic flash / vfx / update banner) doesn't
// reconcile the whole pad grid when deckId/color are unchanged.
export const PerformancePads = memo(PerformancePadsBase);

// ── Pad grid por modo (4 variantes: hotcue / loop / beatjump / looproll) ──

const PadGrid: FC<{ mode: PadMode; deckId: DeckId; gridClass: string }> = ({ mode, deckId, gridClass }) => (
  <div className={gridClass}>
    {mode === 'hotcue'
      ? Array.from({ length: 8 }, (_, i) => <HotCuePad key={i} deckId={deckId} index={i} />)
      : mode === 'loop'
        ? Array.from({ length: 8 }, (_, i) => <LoopPad key={i} deckId={deckId} index={i} />)
        : mode === 'beatjump'
          ? Array.from({ length: 8 }, (_, i) => <BeatJumpPad key={i} deckId={deckId} index={i} />)
          : Array.from({ length: 8 }, (_, i) => <LoopRollPad key={i} deckId={deckId} index={i} />)}
  </div>
);

// ── Columna Quantize (Q on/off + resolución) ──────────────────

const QuantizeColumn: FC<{
  quantize: boolean;
  qLabel: string;
  onToggleQuantize: () => void;
  onCycleQValue: () => void;
}> = ({ quantize, qLabel, onToggleQuantize, onCycleQValue }) => (
  <div className="flex flex-col gap-1.5 shrink-0" style={{ width: 48 }}>
    <button
      type="button"
      onClick={onToggleQuantize}
      className="flex-1 rounded-md text-[11px] font-medium uppercase tracking-[0.15em] transition active:scale-95"
      style={{
        background: quantize ? 'rgba(168, 85, 247, 0.2)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${quantize ? 'var(--clr-master)' : 'var(--brd-default)'}`,
        color: quantize ? 'var(--clr-master)' : 'rgba(148, 163, 184, 0.7)',
        boxShadow: quantize ? '0 0 8px rgba(168,85,247,0.2)' : 'none',
      }}
      title="Quantize: snap cues & loops to the beat grid"
    >
      Q
    </button>
    <button
      type="button"
      onClick={onCycleQValue}
      className="flex-1 rounded-md text-[11px] font-medium font-mono tabular-nums transition active:scale-95"
      style={{
        background: quantize ? 'rgba(168, 85, 247, 0.08)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${quantize ? 'rgba(168,85,247,0.2)' : 'var(--brd-default)'}`,
        color: quantize ? 'var(--clr-master)' : 'rgba(148, 163, 184, 0.7)',
      }}
      title={`Quantize resolution: ${qLabel} beat`}
    >
      {qLabel}
    </button>
  </div>
);

// ── Mode tab button ──────────────────────────────────────────

const ModeTab: FC<{
  label: string;
  active: boolean;
  onClick: () => void;
  color: string;
}> = ({ label, active, onClick, color }) => (
  <button
    type="button"
    onClick={onClick}
    className="px-2 py-0.5 text-[11px] font-medium uppercase tracking-[0.15em] transition text-center whitespace-nowrap"
    style={{
      background: 'transparent',
      border: 'none',
      borderBottom: active ? `1px solid ${color}` : '1px solid transparent',
      color: active ? color : 'rgba(148, 163, 184, 0.7)',
      textShadow: active ? `0 0 8px ${color}44` : 'none',
    }}
  >
    {label}
  </button>
);

// ── Hot Cue Pad ──────────────────────────────────────────────

const HotCuePad: FC<{ deckId: DeckId; index: number }> = ({ deckId, index }) => {
  const cueTime = useMixiStore((s) => s.decks[deckId].hotCues[index]);
  const setHotCue = useMixiStore((s) => s.setHotCue);
  const triggerHotCue = useMixiStore((s) => s.triggerHotCue);
  const deleteHotCue = useMixiStore((s) => s.deleteHotCue);

  const isFilled = cueTime !== null;
  const padColor = CUE_COLORS[index];

  // onPointerDown = disparo instantáneo del hot cue (sin esperar al ciclo
  // click del navegador); Shift = delete; botón derecho = delete.
  const handlePress = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return;
      if (e.shiftKey && isFilled) {
        deleteHotCue(deckId, index);
        return;
      }

      if (isFilled) {
        // Jump to this cue point.
        triggerHotCue(deckId, index);
      } else {
        // Save current position as a new cue.
        const engine = MixiEngine.getInstance();
        if (!engine.isInitialized) return;
        const currentTime = engine.getCurrentTime(deckId);
        setHotCue(deckId, index, currentTime);
      }
    },
    [deckId, index, isFilled, setHotCue, triggerHotCue, deleteHotCue],
  );

  const handleContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      if (isFilled) {
        deleteHotCue(deckId, index);
      }
    },
    [deckId, index, isFilled, deleteHotCue],
  );

  return (
    <button
      type="button"
      onPointerDown={handlePress}
      onContextMenu={handleContextMenu}
      className="mixi-pad relative flex items-center justify-center rounded-[6px] h-9 text-[11px] font-medium uppercase transition select-none"
      style={{
        background: isFilled
          ? `${padColor}08`
          : 'var(--srf-mid)',
        border: `1px solid ${isFilled ? padColor : 'var(--srf-light)'}`,
        color: isFilled ? padColor : 'rgba(148, 163, 184, 0.7)',
        boxShadow: isFilled
          ? `inset 0 0 25px ${padColor}b3, 0 0 10px ${padColor}44, 0 2px 4px rgba(0,0,0,0.4)`
          : 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 #252525, 0 1px 0 rgba(255,255,255,0.015)',
      }}
    >
      {isFilled && (
        <span style={{ textShadow: `0 0 6px ${padColor}88` }}>{index + 1}</span>
      )}
    </button>
  );
};

// ── Loop Pad ─────────────────────────────────────────────────

const LoopPad: FC<{ deckId: DeckId; index: number }> = ({ deckId, index }) => {
  const activeLoop = useMixiStore((s) => s.decks[deckId].activeLoop);
  const setAutoLoop = useMixiStore((s) => s.setAutoLoop);
  const exitLoopAction = useMixiStore((s) => s.exitLoop);

  const beats = LOOP_BEATS[index];
  const label = LOOP_LABELS[index];
  const isActive = activeLoop !== null && activeLoop.lengthInBeats === beats;

  const handleClick = useCallback(() => {
    if (isActive) {
      exitLoopAction(deckId);
    } else {
      setAutoLoop(deckId, beats);
    }
  }, [deckId, beats, isActive, setAutoLoop, exitLoopAction]);

  const LOOP_COLOR = 'var(--clr-b)'; // orange

  return (
    <button
      type="button"
      onPointerDown={(e) => {
        if (e.button === 0) handleClick();
      }}
      className="mixi-pad relative flex items-center justify-center rounded-[6px] h-9 text-[11px] font-medium transition select-none"
      style={{
        background: isActive
          ? `${LOOP_COLOR}08`
          : 'var(--srf-mid)',
        border: `1px solid ${isActive ? LOOP_COLOR : 'var(--srf-light)'}`,
        color: isActive ? LOOP_COLOR : 'rgba(148, 163, 184, 0.7)',
        boxShadow: isActive
          ? `inset 0 0 25px ${LOOP_COLOR}b3, 0 0 10px ${LOOP_COLOR}44, 0 2px 4px rgba(0,0,0,0.4)`
          : 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 #252525, 0 1px 0 rgba(255,255,255,0.015)',
        animation: isActive ? 'pulse 2s ease-in-out infinite' : 'none',
      }}
    >
      {label}
    </button>
  );
};

// ── Loop Roll Pad (momentary: hold = loop + slip, release = snap back) ──

const LoopRollPad: FC<{ deckId: DeckId; index: number }> = ({ deckId, index }) => {
  const startLoopRoll = useMixiStore((s) => s.startLoopRoll);
  const exitLoopAction = useMixiStore((s) => s.exitLoop);
  const setSlipMode = useMixiStore((s) => s.setSlipMode);

  const beats = LOOP_BEATS[index];
  const label = LOOP_LABELS[index];
  const [held, setHeld] = useState(false);
  const ROLL_COLOR = '#22d3ee';

  const handleDown = useCallback(() => {
    setHeld(true);
    setSlipMode(deckId, true);
    // Roll con Slip: loop momentáneo cuantizado + reloj virtual.
    startLoopRoll(deckId, beats);
  }, [deckId, beats, startLoopRoll, setSlipMode]);

  const handleUp = useCallback(() => {
    if (!held) return;
    setHeld(false);
    // exitLoop con roll activo = retomar el tiempo real virtual (slip).
    exitLoopAction(deckId);
    setSlipMode(deckId, false);
  }, [deckId, held, exitLoopAction, setSlipMode]);

  return (
    <button
      type="button"
      onPointerDown={handleDown}
      onPointerUp={handleUp}
      onPointerLeave={handleUp}
      onPointerCancel={handleUp}
      className="mixi-pad relative flex items-center justify-center rounded-[6px] h-9 text-[11px] font-medium transition select-none touch-none"
      style={{
        background: held ? `${ROLL_COLOR}15` : 'var(--srf-mid)',
        border: `1px solid ${held ? ROLL_COLOR : 'var(--srf-light)'}`,
        color: held ? ROLL_COLOR : 'rgba(148, 163, 184, 0.7)',
        boxShadow: held
          ? `inset 0 0 25px ${ROLL_COLOR}88, 0 0 10px ${ROLL_COLOR}44, 0 2px 4px rgba(0,0,0,0.4)`
          : 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 #252525, 0 1px 0 rgba(255,255,255,0.015)',
        animation: held ? 'pulse 0.5s ease-in-out infinite' : 'none',
      }}
    >
      {label}
    </button>
  );
};

// ── Beat Jump Pad ───────────────────────────────────────────

const BeatJumpPad: FC<{ deckId: DeckId; index: number }> = ({ deckId, index }) => {
  const beatJump = useMixiStore((s) => s.beatJump);

  const beats = JUMP_BEATS[index];
  const label = JUMP_LABELS[index];
  const JUMP_COLOR = 'var(--clr-master)';

  const [flash, setFlash] = useState(false);

  const handleClick = useCallback(() => {
    beatJump(deckId, beats);
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
  }, [deckId, beats, beatJump]);

  return (
    <button
      type="button"
      onPointerDown={(e) => {
        if (e.button === 0) handleClick();
      }}
      className="mixi-pad relative flex items-center justify-center rounded-[6px] h-9 text-[11px] font-medium font-mono transition select-none"
      style={{
        background: flash ? `${JUMP_COLOR}20` : 'var(--srf-mid)',
        border: `1px solid ${flash ? JUMP_COLOR : 'var(--srf-light)'}`,
        color: flash ? JUMP_COLOR : 'rgba(148, 163, 184, 0.7)',
        boxShadow: flash
          ? `inset 0 0 15px ${JUMP_COLOR}55, 0 0 8px ${JUMP_COLOR}33`
          : 'inset 0 2px 6px rgba(0,0,0,0.6), inset 0 -1px 0 #252525, 0 1px 0 rgba(255,255,255,0.015)',
      }}
    >
      {label}
    </button>
  );
};

// ── FX Toggle Button (FX1/FX2 ON/OFF) ──────────────────────

const FxToggleButton: FC<{ deckId: DeckId; unitKey: 'fx1' | 'fx2'; color: string }> = ({ deckId, unitKey, color }) => {
  const [active, setActive] = useState(false);

  // Listen to shared state
  useEffect(() => {
    return fxUnitState.subscribe(() => {
      const snap = fxUnitState.get(deckId)[unitKey];
      setActive(snap.active);
    });
  });

  const toggle = useCallback(() => {
    const next = !fxUnitState.get(deckId)[unitKey].active;
    fxUnitState.set(deckId, unitKey, { active: next });
  }, [deckId, unitKey]);

  const label = unitKey.toUpperCase();

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex-1 rounded-md text-[11px] font-medium uppercase tracking-[0.15em] transition active:scale-95"
      style={{
        background: active ? `${color}22` : 'rgba(255,255,255,0.03)',
        border: `1px solid ${active ? color : 'var(--brd-default)'}`,
        color: active ? color : 'rgba(148, 163, 184, 0.7)',
        boxShadow: active ? `0 0 8px ${color}33` : 'none',
      }}
      title={`${label}: ${active ? 'ON' : 'OFF'}`}
    >
      {label}
    </button>
  );
};
