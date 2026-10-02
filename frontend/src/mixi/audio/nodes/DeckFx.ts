/*
 * Compatibility shim for the vendored MIXI UI.
 * The DSP FX engine (mixi-core nodes/DeckFx.ts) is not vendored; only the
 * `FxId` union is required by FxUnitPanel/PerformancePads.
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

export type FxId =
  | 'dly'
  | 'rev'
  | 'pha'
  | 'flg'
  | 'gate'
  | 'crush'
  | 'echo'
  | 'tape'
  | 'noise'
  | 'flt';
