/*
 * Compatibility shim for the vendored MIXI UI.
 * The 19 built-in/community instrument decks are not vendored (they require
 * AudioWorklets, synths, Rust DSP, etc.). The console only uses deck mode
 * metadata for the module picker, which is intentionally empty here.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

import type { LazyExoticComponent, FC } from 'react';
import type { DeckId, DeckMode } from '../types';

export interface HouseDeckProps {
  deckId: DeckId;
  color: string;
  onSwitchToTrack: () => void;
}

export interface HouseDeckEntry {
  mode: DeckMode;
  label: string;
  accentColor: string;
  component: LazyExoticComponent<FC<HouseDeckProps>>;
  mobileComponent?: LazyExoticComponent<FC<HouseDeckProps>>;
}

/** No instrument decks in Smart Set Studio: Track mode only. */
export const HOUSE_DECKS: HouseDeckEntry[] = [];
