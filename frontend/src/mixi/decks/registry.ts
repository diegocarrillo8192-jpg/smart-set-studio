/*
 * Compatibility shim for the vendored MIXI UI.
 * Remote community decks are not used in Smart Set Studio; this registry only
 * exposes the built-in (empty) house decks so the vendored UI compiles/renders.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

import { HOUSE_DECKS, type HouseDeckEntry } from './index';

class DeckRegistryImpl {
  private listeners = new Set<() => void>();

  getAll(): HouseDeckEntry[] {
    return HOUSE_DECKS;
  }

  findByMode(mode: string): HouseDeckEntry | undefined {
    return HOUSE_DECKS.find((d) => d.mode === mode);
  }

  get isReady(): boolean {
    return true;
  }

  get externalCount(): number {
    return 0;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async fetchFromRemote(): Promise<void> {
    /* no external decks */
  }
}

export const deckRegistry = new DeckRegistryImpl();
