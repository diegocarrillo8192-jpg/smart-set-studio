/*
 * Copyright (c) 2026 Fabrizio Salmi. All rights reserved.
 *
 * This file is part of MIXI.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 * You may not use this file for commercial purposes without explicit permission.
 * For commercial licensing, contact: fabrizio.salmi@gmail.com
 */

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Mixi â€“ Deck Section (responsive layout)
//
// DeckSection is intentionally thin: it owns only the deck-level eject guard
// and composes focused subcomponents. Every render branch (transport controls,
// mixer row, track-loader overlay, header) lives in its own component so the
// control-flow complexity stays low and each piece is easy to reason about.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { useCallback, useEffect, useRef, useState, type FC } from 'react';
import { useMixiStore } from '../../store/mixiStore';
import { MixiEngine } from '../../audio/MixiEngine';
import { PremiumJogWheel } from './PremiumJogWheel';
import { NeonPlayButton, NeonSyncButton, NeonCueButton } from './NeonTransport';
import Artwork from '../../../components/Artwork';
import { useDeckTracks } from '../console/deckTracks';
import { TrackLoader } from './TrackLoader';
import { TrackInfo } from './TrackInfo';
import { PerformancePads } from './PerformancePads';
import { PitchStrip } from './PitchStrip';
import { FxUnitPanel } from './FxUnitPanel';
import type { DeckId } from '../../types';
import { CAMELOT_KEY_COLORS } from '../../theme';
import { deckRegistry } from '../../decks/registry';
import { doubleBpm as doubleBpmHelper, halveBpm as halveBpmHelper } from '../../audio/utils/mathUtils';

interface DeckSectionProps {
  deckId: DeckId;
  color: string;
}

// ── Pure helpers (no React, no branches inside the components) ──────────

type SyncRole = 'master' | 'follower' | null;

interface SyncBadgeInfo {
  label: string;
  title: string;
}

/** Etiqueta y tooltip del estado de SYNC (una sola rama resuelta aquí).
 *  El color activo es SIEMPRE el del deck (A cian / B morado): no hay
 *  roleColors ajenos que rompan el código de colores estricto. */
function syncBadgeInfo(
  isSynced: boolean,
  syncRole: SyncRole,
  syncMasterDeck: DeckId | null,
): SyncBadgeInfo {
  if (!isSynced) return { label: 'SYNC', title: 'Sync' };
  if (syncRole === 'master') {
    return { label: 'MASTER', title: 'MASTER: este deck marca el tempo' };
  }
  if (syncRole === 'follower') {
    return {
      label: syncMasterDeck ? `FOLLOW ${syncMasterDeck}` : 'SYNC',
      title: syncMasterDeck
        ? `FOLLOWER: sincronizado al deck ${syncMasterDeck}`
        : 'SYNC activo — clic para liberar',
    };
  }
  return { label: 'SYNC', title: 'SYNC activo — clic para liberar' };
}

/** Clase del contenedor de contenido según el track esté cargado o no. */
function deckContentClass(loaded: boolean): string {
  const state = loaded ? 'opacity-100 blur-0' : 'pointer-events-none opacity-60 blur-[2px]';
  return `grid flex-1 min-h-0 gap-1 transition duration-500 ease-out ${state}`;
}

// ── Deck Section (thin orchestrator) ────────────────────────────────────

export const DeckSection: FC<DeckSectionProps> = ({ deckId, color }) => {
  const isPlaying = useMixiStore((s) => s.decks[deckId].isPlaying);
  const isTrackLoaded = useMixiStore((s) => s.decks[deckId].isTrackLoaded);
  const volume = useMixiStore((s) => s.decks[deckId].volume);
  const deckMode = useMixiStore((s) => s.deckModes[deckId]);
  const ejectDeck = useMixiStore((s) => s.ejectDeck);

  const [ejectPending, setEjectPending] = useState(false);
  const ejectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Eject safety guard (double-click when live).
  const handleEject = useCallback(() => {
    const isLive = isPlaying && volume > 0.05;
    if (!isLive) {
      ejectDeck(deckId);
      return;
    }
    if (ejectPending) {
      clearTimeout(ejectTimerRef.current);
      setEjectPending(false);
      ejectDeck(deckId);
    } else {
      setEjectPending(true);
      ejectTimerRef.current = setTimeout(() => setEjectPending(false), 2000);
    }
  }, [deckId, isPlaying, volume, ejectPending, ejectDeck]);

  useEffect(() => () => clearTimeout(ejectTimerRef.current), []);

  const moduleColor = deckRegistry.findByMode(deckMode)?.accentColor;

  return (
    <div
      className="flex flex-col gap-1 h-full overflow-hidden transition-opacity duration-500"
      style={{ opacity: !isTrackLoaded && !isPlaying ? 0.6 : 1 }}
    >
      <DeckHeader
        deckId={deckId}
        color={color}
        moduleColor={moduleColor}
        ejectPending={ejectPending}
        onEject={handleEject}
      />

      {/* ── Content ─────────────────────────────────────────────── */}
      <div className="mixi-deck-content flex flex-1 flex-col px-1 pb-1 min-h-0 relative">
        <TrackLoaderOverlay visible={!isTrackLoaded} deckId={deckId} color={color} />
        <div className={deckContentClass(isTrackLoaded)} style={{ gridTemplateRows: 'minmax(0, 1fr) auto' }}>
          <DeckMainRow deckId={deckId} color={color} />

          {/* Fila inferior: pads de Hot Cues / Loops a todo el ancho del deck */}
          <div className="min-h-0 pt-0.5" data-deck-pads>
            <PerformancePads deckId={deckId} color={color} />
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Track loader overlay (only mounts while there is no track) ──────────

interface TrackLoaderOverlayProps {
  visible: boolean;
  deckId: DeckId;
  color: string;
}

const TrackLoaderOverlay: FC<TrackLoaderOverlayProps> = ({ visible, deckId, color }) => {
  const setDeckMode = useMixiStore((s) => s.setDeckMode);
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm rounded-xl m-1.5 pointer-events-auto p-6">
      <TrackLoader
        deckId={deckId}
        color={color}
        onSwitchToGroovebox={() => setDeckMode(deckId, 'groovebox')}
        onSwitchModule={(mode) => setDeckMode(deckId, mode)}
      />
    </div>
  );
};

// ── Main deck row: FX · JogWheel · Transport (mirrored for deck B) ──────

interface DeckRowProps {
  deckId: DeckId;
  color: string;
}

/**
 * Layout del deck en 3 columnas (izquierda → derecha):
 *   · Columna externa → panel de FX.
 *   · Columna central → JogWheel.
 *   · Columna interna (pegada al mixer) → transporte PLAY/CUE/SYNC + Pitch.
 * El Deck B refleja las columnas externa/interna (espejo A | B).
 */
const DeckMainRow: FC<DeckRowProps> = ({ deckId, color }) => {
  const mirrored = deckId === 'B';
  return (
    <div className="grid min-h-0 gap-1 overflow-hidden" style={{ gridTemplateColumns: '1fr auto 1fr' }}>
      <div
        className={`flex h-full min-w-0 flex-col justify-center ${
          mirrored ? 'order-3 items-end' : 'order-1 items-start'
        }`}
      >
        <FxUnitPanel deckId={deckId} color={color} />
      </div>

      <div className="order-2 flex min-h-0 flex-col items-center justify-center" style={{ transform: 'translateY(-24px)' }}>
        <PremiumJogWheel deckId={deckId} color={color} size={380} />
      </div>

      <DeckTransport deckId={deckId} color={color} />
    </div>
  );
};

// ── Transport column (reads its own deck slice from the store) ──────────

interface DeckTransportProps {
  deckId: DeckId;
  color: string;
}

const DeckTransport: FC<DeckTransportProps> = ({ deckId, color }) => {
  const isPlaying = useMixiStore((s) => s.decks[deckId].isPlaying);
  const isSynced = useMixiStore((s) => s.decks[deckId].isSynced);
  const syncRole = useMixiStore((s) => s.decks[deckId].syncRole);
  const syncMasterDeck = useMixiStore((s) => s.decks[deckId].syncMasterDeck);
  const originalBpm = useMixiStore((s) => s.decks[deckId].originalBpm);
  const playbackRate = useMixiStore((s) => s.decks[deckId].playbackRate);
  const cueSet = useMixiStore((s) => s.decks[deckId].hotCues[0] != null);
  const otherDeckId: DeckId = deckId === 'A' ? 'B' : 'A';
  const otherBpm = useMixiStore((s) => s.decks[otherDeckId].bpm);
  const setPlaying = useMixiStore((s) => s.setDeckPlaying);
  const setPlaybackRate = useMixiStore((s) => s.setDeckPlaybackRate);
  const syncDeck = useMixiStore((s) => s.syncDeck);
  const unsyncDeck = useMixiStore((s) => s.unsyncDeck);
  const cueDeck = useMixiStore((s) => s.cueDeck);

  const mirrored = deckId === 'B';
  const canSync = originalBpm > 0 && otherBpm > 0;
  const badge = syncBadgeInfo(isSynced, syncRole, syncMasterDeck);

  const togglePlay = useCallback(
    () => setPlaying(deckId, !isPlaying),
    [deckId, isPlaying, setPlaying],
  );
  const onPitchChange = useCallback(
    (val: number) => setPlaybackRate(deckId, val),
    [deckId, setPlaybackRate],
  );
  const toggleSync = useCallback(() => {
    if (isSynced) unsyncDeck(deckId);
    else syncDeck(deckId);
  }, [deckId, isSynced, syncDeck, unsyncDeck]);

  return (
    <div
      className={`flex h-full min-w-0 items-center gap-[20px] ${
        mirrored ? 'order-1 justify-start' : 'order-3 justify-end'
      }`}
    >
      <div
        className="flex shrink-0 flex-col items-center justify-center gap-1.5"
        style={{ order: mirrored ? 1 : 2 }}
      >
        <TransportLabel label="PLAY" active={isPlaying} activeColor={color}>
          <NeonPlayButton
            isPlaying={isPlaying}
            onToggle={togglePlay}
            color={color}
            size={64}
            midiAction={{ type: 'DECK_PLAY', deck: deckId }}
          />
        </TransportLabel>

        <TransportLabel label="CUE" active={cueSet} activeColor={color}>
          <NeonCueButton isSet={cueSet} onPress={() => cueDeck(deckId)} color={color} size={52} />
        </TransportLabel>

        <TransportLabel label={badge.label} active={isSynced} activeColor={color} title={badge.title}>
          <NeonSyncButton
            isSynced={isSynced}
            canSync={canSync}
            onToggle={toggleSync}
            color={color}
            size={52}
            midiAction={{ type: 'DECK_SYNC', deck: deckId }}
          />
        </TransportLabel>
      </div>

      <div style={{ order: mirrored ? 2 : 1 }}>
        <PitchStrip
          value={playbackRate}
          onChange={onPitchChange}
          color={color}
          deckId={deckId}
          midiAction={{ type: 'DECK_PITCH', deck: deckId }}
        />
      </div>
    </div>
  );
};

interface TransportLabelProps {
  label: string;
  active: boolean;
  activeColor: string;
  title?: string;
  children: React.ReactNode;
}

/** Botón de transporte con su etiqueta inferior (color según estado). */
const TransportLabel: FC<TransportLabelProps> = ({ label, active, activeColor, title, children }) => (
  <div className="flex flex-col items-center gap-0.5">
    {children}
    <span
      className="text-[11px] font-medium tracking-[1.5px]"
      title={title}
      style={{ color: active ? activeColor : 'rgba(255,255,255,0.5)' }}
    >
      {label}
    </span>
  </div>
);

// ── Deck Header container (owns BPM inline editing) ─────────────────────

interface DeckHeaderContainerProps {
  deckId: DeckId;
  color: string;
  moduleColor: string | undefined;
  ejectPending: boolean;
  onEject: () => void;
}

const DeckHeader: FC<DeckHeaderContainerProps> = ({ deckId, color, moduleColor, ejectPending, onEject }) => {
  const isPlaying = useMixiStore((s) => s.decks[deckId].isPlaying);
  const cueActive = useMixiStore((s) => s.decks[deckId].cueActive);
  const isTrackLoaded = useMixiStore((s) => s.decks[deckId].isTrackLoaded);
  const trackName = useMixiStore((s) => s.decks[deckId].trackName);
  const musicalKey = useMixiStore((s) => s.decks[deckId].musicalKey);
  const bpm = useMixiStore((s) => s.decks[deckId].bpm);
  const bpmConfidence = useMixiStore((s) => s.decks[deckId].bpmConfidence);
  const deckTrack = useDeckTracks()[deckId];

  /** BPM inline editing state. */
  const [editingBpm, setEditingBpm] = useState(false);
  const [bpmInput, setBpmInput] = useState('');
  const bpmInputRef = useRef<HTMLInputElement>(null);

  const doubleBpm = useCallback(() => {
    const store = useMixiStore.getState();
    const d = store.decks[deckId];
    // El BPM de la REJILLA es el original (tiempo de fuente): x2/÷2 operan
    // sobre ese valor, nunca sobre el efectivo escalado por el pitch.
    const newBpm = doubleBpmHelper(d.originalBpm);
    if (newBpm !== null) store.setDeckBpm(deckId, newBpm, d.firstBeatOffset);
  }, [deckId]);

  const halveBpm = useCallback(() => {
    const store = useMixiStore.getState();
    const d = store.decks[deckId];
    const newBpm = halveBpmHelper(d.originalBpm);
    if (newBpm !== null) store.setDeckBpm(deckId, newBpm, d.firstBeatOffset);
  }, [deckId]);

  const startBpmEdit = useCallback(() => {
    setEditingBpm(true);
    setBpmInput(bpm.toFixed(1));
    setTimeout(() => bpmInputRef.current?.select(), 0);
  }, [bpm]);

  const commitBpmEdit = useCallback(() => {
    setEditingBpm(false);
    const val = parseFloat(bpmInput);
    if (!isNaN(val) && val >= 30 && val <= 300) {
      const store = useMixiStore.getState();
      store.setDeckBpm(deckId, val, store.decks[deckId].firstBeatOffset);
    }
  }, [deckId, bpmInput]);

  const cancelBpmEdit = useCallback(() => setEditingBpm(false), []);

  return (
    <DeckHeaderView
      deckId={deckId}
      color={color}
      moduleColor={moduleColor}
      isPlaying={isPlaying}
      cueActive={cueActive}
      isTrackLoaded={isTrackLoaded}
      deckTrack={deckTrack}
      trackName={trackName}
      musicalKey={musicalKey}
      bpm={bpm}
      bpmConfidence={bpmConfidence}
      editingBpm={editingBpm}
      bpmInput={bpmInput}
      bpmInputRef={bpmInputRef}
      ejectPending={ejectPending}
      onEject={onEject}
      onHalveBpm={halveBpm}
      onDoubleBpm={doubleBpm}
      onStartBpmEdit={startBpmEdit}
      onBpmInput={setBpmInput}
      onCommitBpmEdit={commitBpmEdit}
      onCancelBpmEdit={cancelBpmEdit}
    />
  );
};

// ── Deck Header (presentational) ────────────────────────────────────────

interface DeckHeaderProps {
  deckId: DeckId;
  color: string;
  moduleColor: string | undefined;
  isPlaying: boolean;
  cueActive: boolean;
  isTrackLoaded: boolean;
  deckTrack: ReturnType<typeof useDeckTracks>[DeckId];
  trackName: string;
  musicalKey: string;
  bpm: number;
  bpmConfidence: number;
  editingBpm: boolean;
  bpmInput: string;
  bpmInputRef: React.RefObject<HTMLInputElement | null>;
  ejectPending: boolean;
  onEject: () => void;
  onHalveBpm: () => void;
  onDoubleBpm: () => void;
  onStartBpmEdit: () => void;
  onBpmInput: (v: string) => void;
  onCommitBpmEdit: () => void;
  onCancelBpmEdit: () => void;
}

/** Estilo del header según el módulo activo (helper puro). */
function headerStyle(moduleColor: string | undefined, color: string): React.CSSProperties | undefined {
  if (!moduleColor) return undefined;
  return {
    background: `linear-gradient(90deg, ${color}15, ${moduleColor}10)`,
    borderBottom: `1px solid ${moduleColor}22`,
  };
}

/** Estilo del dot de estado (helper puro). */
function statusDotStyle(isPlaying: boolean, color: string): React.CSSProperties {
  return {
    backgroundColor: isPlaying ? color : 'var(--txt-muted)',
    boxShadow: isPlaying ? `0 0 8px ${color}` : 'none',
  };
}

/** Subtítulo del track: artista · álbum (helper puro). */
function trackSubtitle(deckTrack: ReturnType<typeof useDeckTracks>[DeckId]): string {
  if (!deckTrack) return '';
  const artist = deckTrack.artist ?? '';
  const album = deckTrack.album ?? '';
  if (!artist) return album;
  return album ? `${artist} · ${album}` : artist;
}

/** Badge de tonalidad Camelot (componente módulo). */
const KeyBadge: FC<{ musicalKey: string; color: string }> = ({ musicalKey, color }) => {
  const keyColor = CAMELOT_KEY_COLORS[musicalKey] || color;
  return (
    <span
      key={`key-${musicalKey}`}
      className="shrink-0 rounded px-1.5 py-0.5 text-[15px] font-medium tracking-wider mixi-pop"
      style={{
        background: `${keyColor}30`,
        border: `1px solid ${keyColor}55`,
        color: '#fff',
        textShadow: `0 0 6px ${keyColor}66`,
      }}
    >
      {musicalKey}
    </span>
  );
};

const DeckHeaderView: FC<DeckHeaderProps> = ({
  deckId, color, moduleColor, isPlaying, cueActive, isTrackLoaded,
  deckTrack, trackName, musicalKey, bpm, bpmConfidence,
  editingBpm, bpmInput, bpmInputRef, ejectPending,
  onEject, onHalveBpm, onDoubleBpm, onStartBpmEdit,
  onBpmInput, onCommitBpmEdit, onCancelBpmEdit,
}) => (
  <div
    className="mixi-deck-header flex items-center gap-2 px-2 pt-1.5 pb-0.5 border-b border-zinc-800/30"
    style={headerStyle(moduleColor, color)}
  >
    {/* Status dot */}
    <div
      className={`h-2 w-2 shrink-0 rounded-full ${isPlaying ? 'mixi-dot-pulse' : ''}`}
      style={statusDotStyle(isPlaying, color)}
    />
    {/* Deck label */}
    <span className="text-[13px] font-medium tracking-[0.15em] shrink-0" style={{ color }}>
      {deckId}
    </span>
    {/* Headphone icon — visible when CUE is active (color del deck) */}
    {cueActive && (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0" style={{ filter: `drop-shadow(0 0 3px ${color}99)` }}>
        <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
        <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3v5z" />
        <path d="M3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3v5z" />
      </svg>
    )}
    {/* Eject */}
    {isTrackLoaded && (
      <button
        type="button"
        onClick={onEject}
        className={`shrink-0 rounded p-0.5 transition-colors ${
          ejectPending
            ? 'text-red-400 animate-pulse'
            : 'text-zinc-600 hover:text-zinc-300'
        }`}
        title={ejectPending ? 'Click again to eject (live!)' : 'Eject track'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5,18 12,6 19,18" />
          <line x1="5" y1="22" x2="19" y2="22" />
        </svg>
      </button>
    )}
    {/* Track name — fills available space */}
    {deckTrack && (
      <Artwork track={deckTrack} accent={color} size={56} remountKey={deckTrack.id} />
    )}
    {isTrackLoaded && (
      <div className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
        <span className="truncate text-[19px] font-medium tracking-tight text-white">
          {deckTrack?.title || trackName || ''}
        </span>
        <span className="truncate text-[13px] font-normal text-slate-300">
          {trackSubtitle(deckTrack)}
        </span>
      </div>
    )}
    {/* Spacer when no track */}
    {!isTrackLoaded && <span className="flex-1" />}
    {/* Key badge — Camelot-colored */}
    {musicalKey && <KeyBadge musicalKey={musicalKey} color={color} />}
    {/* BPM + Beat counter */}
    {bpm > 0 && (
      <BpmControls
        deckId={deckId}
        color={color}
        bpm={bpm}
        bpmConfidence={bpmConfidence}
        editingBpm={editingBpm}
        bpmInput={bpmInput}
        bpmInputRef={bpmInputRef}
        onHalveBpm={onHalveBpm}
        onDoubleBpm={onDoubleBpm}
        onStartBpmEdit={onStartBpmEdit}
        onBpmInput={onBpmInput}
        onCommitBpmEdit={onCommitBpmEdit}
        onCancelBpmEdit={onCancelBpmEdit}
      />
    )}
    {/* Time counter */}
    {isTrackLoaded && (
      <TrackInfo deckId={deckId} color={color} compact />
    )}
  </div>
);

// ── BPM controls (header): /2, edición inline, x2, warning y beat counter ──

interface BpmControlsProps {
  deckId: DeckId;
  color: string;
  bpm: number;
  bpmConfidence: number;
  editingBpm: boolean;
  bpmInput: string;
  bpmInputRef: React.RefObject<HTMLInputElement | null>;
  onHalveBpm: () => void;
  onDoubleBpm: () => void;
  onStartBpmEdit: () => void;
  onBpmInput: (v: string) => void;
  onCommitBpmEdit: () => void;
  onCancelBpmEdit: () => void;
}

const BpmControls: FC<BpmControlsProps> = ({
  deckId, color, bpm, bpmConfidence, editingBpm, bpmInput, bpmInputRef,
  onHalveBpm, onDoubleBpm, onStartBpmEdit, onBpmInput, onCommitBpmEdit, onCancelBpmEdit,
}) => (
  <div key={`bpm-${bpm.toFixed(0)}`} className="flex items-center gap-0.5 shrink-0 mixi-pop">
    {/* /2 button */}
    <button type="button" onClick={onHalveBpm} className="text-[16px] text-zinc-600 hover:text-zinc-300 font-mono transition-colors px-0.5" title="Halve BPM">/2</button>

    {/* BPM value — double-click to edit */}
    {editingBpm ? (
      <input
        ref={bpmInputRef}
        value={bpmInput}
        onChange={(e) => onBpmInput(e.target.value)}
        onBlur={onCommitBpmEdit}
        onKeyDown={(e) => { if (e.key === 'Enter') onCommitBpmEdit(); if (e.key === 'Escape') onCancelBpmEdit(); }}
        aria-label="Editar BPM"
        className="w-12 text-sm font-mono font-medium text-white bg-transparent border-b border-zinc-500 outline-none text-center"
        style={{ fontFeatureSettings: '"tnum"' }}
      />
    ) : (
      <span
        className="text-[20px] font-mono font-medium cursor-pointer"
        style={{
          fontFeatureSettings: '"tnum"',
          color: bpmConfidence < 0.3 ? '#f97316' : bpmConfidence < 0.6 ? '#eab308' : '#fff',
        }}
        title={`BPM confidence: ${(bpmConfidence * 100).toFixed(0)}% — Double-click to edit`}
        onDoubleClick={onStartBpmEdit}
      >
        {bpm.toFixed(1)}
      </span>
    )}

    {/* Confidence warning */}
    {bpmConfidence > 0 && bpmConfidence < 0.5 && (
      <span className="text-[16px] text-amber-400" title={`Low confidence: ${(bpmConfidence * 100).toFixed(0)}%`}>?</span>
    )}

    {/* x2 button */}
    <button type="button" onClick={onDoubleBpm} className="text-[16px] text-zinc-600 hover:text-zinc-300 font-mono transition-colors px-0.5" title="Double BPM">x2</button>

    <BeatCounter deckId={deckId} color={color} />
  </div>
);

// â”€â”€ Beat Counter (header, after BPM) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const BeatCounter: FC<{ deckId: DeckId; color: string }> = ({ deckId, color }) => {
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const engine = MixiEngine.getInstance();
    let rafId = 0;
    let lastBeat = -1;
    let lastTick = 0;
    let hidden = false;
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
      // #57: el contador solo necesita ~25 FPS (cambia 4 veces por compás):
      // se ahorran 35 frames de trabajo por segundo sin perder respuesta.
      const now = performance.now();
      if (now - lastTick >= 40) {
        lastTick = now;
        const deck = useMixiStore.getState().decks[deckId];
        const el = spanRef.current;
        if (el && engine.isInitialized && deck.isPlaying && deck.originalBpm > 0) {
          const t = engine.getCurrentTime(deckId);
          // Beat counter sobre la rejilla en tiempo de fuente (BPM original).
          const beatPeriod = 60 / deck.originalBpm;
          const beat = (((Math.floor((t - deck.firstBeatOffset) / beatPeriod) % 4) + 4) % 4) + 1;
          if (beat !== lastBeat) {
            lastBeat = beat;
            el.textContent = `.${beat}`;
          }
        } else if (el && lastBeat !== -1) {
          lastBeat = -1;
          el.textContent = '';
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [deckId]);

  return (
    <span
      ref={spanRef}
      className="text-[13px] font-mono font-medium"
      style={{ color, fontFeatureSettings: '"tnum"', minWidth: 12, marginLeft: 1 }}
    />
  );
};

// FxStrip replaced by FxUnitPanel (imported from ./FxUnitPanel.tsx)
