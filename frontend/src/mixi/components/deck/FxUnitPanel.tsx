/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

// ─────────────────────────────────────────────────────────────
// FX Unit Panel — Traktor-style FX1/FX2 (selector + knob only)
//
// ON/OFF buttons are in PerformancePads (same group as Q button).
// This panel shows: effect name selector + amount knob.
// State shared via fxUnitState.ts pub/sub.
// ─────────────────────────────────────────────────────────────

import { useState, useCallback, useRef, useEffect, type FC } from 'react';
import { MixiEngine } from '../../audio/MixiEngine';
import { Knob } from '../controls/Knob';
import { fxUnitState } from './fxUnitState';
import type { DeckId } from '../../types';
import type { FxId } from '../../audio/nodes/DeckFx';

const FX_LIST: FxId[] = ['dly', 'rev', 'pha', 'flg', 'gate', 'crush', 'echo', 'tape', 'noise', 'flt'];
const FX_LABELS: Record<FxId, string> = {
  dly: 'DLY', rev: 'REV', pha: 'PHA', flg: 'FLG', gate: 'GATE',
  crush: 'CRU', echo: 'ECH', tape: 'TAPE', noise: 'NSE', flt: 'FLT',
};

interface FxUnitProps {
  unitKey: 'fx1' | 'fx2';
  deckId: DeckId;
  color: string;
}

const FxUnit: FC<FxUnitProps> = ({ unitKey, deckId, color }) => {
  // FX1 = DLY (index 0), FX2 = PHA (index 2) por defecto (Delay + Phaser).
  const [selectedIdx, setSelectedIdx] = useState(unitKey === 'fx1' ? 0 : 2);
  const [amount, setAmount] = useState(0.5);
  const [active, setActive] = useState(false);

  const amountRef = useRef(amount);
  useEffect(() => { amountRef.current = amount; }, [amount]);
  const selectedIdxRef = useRef(selectedIdx);
  useEffect(() => { selectedIdxRef.current = selectedIdx; }, [selectedIdx]);

  const selectedFx = FX_LIST[selectedIdx];
  const label = FX_LABELS[selectedFx];

  // Sync to shared state
  useEffect(() => {
    fxUnitState.set(deckId, unitKey, { selectedFx, amount, active });
  }, [deckId, unitKey, selectedFx, amount, active]);

  // Listen for external toggle (from PerformancePads buttons)
  useEffect(() => {
    return fxUnitState.subscribe(() => {
      const snap = fxUnitState.get(deckId)[unitKey];
      if (snap.active !== active) {
        setActive(snap.active);
        MixiEngine.getInstance().setDeckFx(deckId, selectedFx, amountRef.current, snap.active);
      }
    });
  }, [deckId, unitKey, selectedFx, active]);

  // Cycle effect selector
  const cycleEffect = useCallback(() => {
    // El updater de estado es PURO: los efectos secundarios (motor de audio y
    // estado compartido) se ejecutan fuera, con el índice leído vía ref.
    const prevIdx = selectedIdxRef.current;
    const oldFx = FX_LIST[prevIdx];
    const nextIdx = (prevIdx + 1) % FX_LIST.length;
    const newFx = FX_LIST[nextIdx];
    const engine = MixiEngine.getInstance();
    engine.setDeckFx(deckId, oldFx, 0, false);
    if (active) {
      engine.setDeckFx(deckId, newFx, amountRef.current, true);
    }
    fxUnitState.set(deckId, unitKey, { selectedFx: newFx });
    setSelectedIdx(nextIdx);
  }, [deckId, unitKey, active]);

  // Activar/desactivar (comparte estado con el motor vía fxUnitState)
  const toggleActive = useCallback(() => {
    fxUnitState.set(deckId, unitKey, { active: !fxUnitState.get(deckId)[unitKey].active });
  }, [deckId, unitKey]);

  // Amount change
  const onAmountChange = useCallback((v: number) => {
    setAmount(v);
    fxUnitState.set(deckId, unitKey, { amount: v });
    if (active) {
      MixiEngine.getInstance().setDeckFx(deckId, selectedFx, v, true);
    }
  }, [deckId, unitKey, selectedFx, active]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      MixiEngine.getInstance().setDeckFx(deckId, FX_LIST[selectedIdx], 0, false);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isGate = selectedFx === 'gate';

  return (
    <div className="flex flex-col items-center gap-1 w-full">
      {/* Unit label */}
      <span className="text-[8px] font-medium tracking-widest"
        style={{ color: active ? color : 'var(--txt-muted)' }}>
        {unitKey.toUpperCase()}
      </span>

      {/* Effect selector — click to cycle */}
      <button
        type="button"
        onClick={cycleEffect}
        className="text-[11px] font-mono font-medium tracking-wider w-full rounded py-1 transition active:scale-95"
        style={{
          color: active ? color : 'var(--txt-secondary)',
          background: active ? `${color}22` : 'rgba(255,255,255,0.04)',
          border: `1px solid ${active ? color + '66' : 'rgba(255,255,255,0.08)'}`,
          boxShadow: active ? `0 0 10px ${color}44` : 'none',
        }}
        title={`Click to cycle effect (current: ${label})`}
      >
        {label}
      </button>

      {/* Amount knob */}
      <Knob
        value={amount}
        min={0}
        max={isGate ? 4 : 1}
        onChange={onAmountChange}
        color={active ? color : 'var(--txt-secondary)'}
        scale={0.85}
      />

      {/* ON/OFF */}
      <button
        type="button"
        onClick={toggleActive}
        className="w-full rounded py-0.5 text-[9px] font-medium tracking-widest transition active:scale-95"
        style={{
          color: active ? '#fff' : 'var(--txt-secondary)',
          background: active ? color : 'rgba(255,255,255,0.05)',
          border: `1px solid ${active ? color : 'rgba(255,255,255,0.12)'}`,
          boxShadow: active ? `0 0 10px ${color}66` : 'none',
        }}
        title={`${active ? 'Desactivar' : 'Activar'} ${label}`}
      >
        {active ? 'ON' : 'OFF'}
      </button>
    </div>
  );
};

export const FxUnitPanel: FC<{ deckId: DeckId; color: string; horizontal?: boolean }> = ({
  deckId,
  color,
  horizontal = false,
}) => (
  <div
    className={`mixi-fx-strip flex shrink-0 items-center rounded-lg ${
      horizontal ? 'flex-row gap-3 px-3 py-2' : 'flex-col gap-3 px-1.5 py-2.5'
    }`}
    style={{
      width: horizontal ? undefined : 68,
      background: 'rgba(15,20,32,0.7)',
      border: '1px solid rgba(148,163,184,0.10)',
      boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.02)',
    }}
  >
    <div style={{ width: horizontal ? 64 : undefined }}>
      <FxUnit unitKey="fx1" deckId={deckId} color={color} />
    </div>
    <div
      className={horizontal ? 'h-16 w-px' : 'h-px w-6'}
      style={{ background: 'rgba(255,255,255,0.08)' }}
    />
    <div style={{ width: horizontal ? 64 : undefined }}>
      <FxUnit unitKey="fx2" deckId={deckId} color={color} />
    </div>
  </div>
);
