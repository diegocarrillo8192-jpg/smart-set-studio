/*
 * Compatibility shim for the vendored MIXI UI.
 * The full WebMIDI manager is not vendored; the console only needs the
 * MidiAction / MidiMapping types for the learn-mode store.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

export interface MidiAction {
  type: string;
  deck?: 'A' | 'B';
  [key: string]: unknown;
}

export interface MidiMapping {
  action: MidiAction;
  channel: number;
  kind: 'cc' | 'note';
  number: number;
  label?: string;
}
