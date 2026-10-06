/*
 * MIXI engine façade for the vendored console UI.
 *
 * The real MIXI engine (Rust/Wasm DSP, AudioWorklet, BufferSource graph) is not
 * vendored. This façade implements the API surface the vendored Mixi views call
 * and delegates all audio to Smart Set Studio's native engine (src/lib/audio.ts),
 * which drives two AudioBufferSourceNodes (Web Audio API).
 *
 * SYNC = Master Audio Clock + Phase Lock profesional (motor nativo):
 *   · playbackRate base = BPM_Master / BPM_Original_del_deck (1:1 exacto),
 *     escrito en cada commit del SYNC (enganche/PLAY/cambio de tempo del
 *     maestro) por src/lib/audio.ts.
 *   · Fase: Hard Alignment al enganchar (seek único exacto a 0 ms,
 *     lib/mixi.ts → hardAlignShift) + servo PI continuo del motor nativo
 *     (servoTick, 200 ms) que recorta el rate del esclavo (±0.15% en lock,
 *     keylock activo) para mantener la fase CONGELADA en 0 ms durante todo
 *     el set, sin deriva acumulativa (estándar Traktor/Rekordbox).
 *   · applyPllRate / nudgeStart / nudgeStop siguen siendo NO-OPs: la
 *     corrección continua vive DENTRO del motor nativo (audio.ts), no en
 *     la UI — así el lock sigue activo aunque la vista no mueva nada.
 *
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

import { audioEngine } from '../../lib/audio';
import type { DeckId, EqBand } from '../types';

const EQ_INDEX: Record<EqBand, 0 | 1 | 2> = { low: 0, mid: 1, high: 2 };

export class MixiEngine {
  private static _instance: MixiEngine | null = null;
  /** Buffer estéreo reutilizado por getMasterStereoData (evita alloc por frame). */
  private masterStereoBuf: Float32Array | null = null;

  static getInstance(): MixiEngine {
    if (!MixiEngine._instance) MixiEngine._instance = new MixiEngine();
    return MixiEngine._instance;
  }

  static get instance(): MixiEngine {
    return MixiEngine.getInstance();
  }

  get isInitialized(): boolean {
    return !!audioEngine.deckA && !!audioEngine.deckB;
  }

  get stereoAnalyserSize(): number {
    return audioEngine.getMasterAnalyser()?.fftSize ?? 1024;
  }

  get wasmDspActive(): boolean {
    return false;
  }

  getAudioContext(): AudioContext {
    return audioEngine.ensureContext();
  }

  getAudioContextTime(): number {
    return audioEngine.ensureContext().currentTime;
  }

  getCurrentTime(deck: DeckId): number {
    const el = audioEngine.getElement(deck);
    return el && Number.isFinite(el.currentTime) ? el.currentTime : 0;
  }

  /** Tiempo efectivo de salida (posición + offset del alineador de fase): lo
   *  que realmente suena. Lo usa el PhaseMeter para mostrar la alineación
   *  audible entre Master y Slave (no la de las posiciones de fuente). */
  getOutputTime(deck: DeckId): number {
    return audioEngine.getOutputTime(deck);
  }

  getDeckAnalyser(deck: DeckId): AnalyserNode | null {
    return audioEngine.getAnalyser(deck);
  }

  getMasterOutput(): AnalyserNode | null {
    return audioEngine.getMasterAnalyser();
  }

  getLevel(deck: DeckId): number {
    return audioEngine.getLevel(deck);
  }

  getMasterLevel(): number {
    return audioEngine.getMasterLevel();
  }

  getMasterLevelL(): number {
    return audioEngine.getMasterLevel();
  }

  getMasterLevelR(): number {
    return audioEngine.getMasterLevel();
  }

  getLimiterReduction(): number {
    return 0;
  }

  /** Rellena L/R (mono duplicado) y devuelve el número de muestras. */
  getMasterStereoData(outL: Float32Array, outR: Float32Array): number {
    const an = audioEngine.getMasterAnalyser();
    if (!an) return 0;
    const n = Math.min(outL.length, an.fftSize);
    if (!this.masterStereoBuf || this.masterStereoBuf.length !== n) {
      this.masterStereoBuf = new Float32Array(n);
    }
    const tmp = this.masterStereoBuf;
    an.getFloatTimeDomainData(tmp);
    outL.set(tmp.subarray(0, outL.length));
    outR.set(tmp.subarray(0, outR.length));
    return n;
  }

  getSlipRealTime(_deck: DeckId): number {
    return 0;
  }

  isSlipActive(_deck: DeckId): boolean {
    return false;
  }

  getNudge(_deck: DeckId): number {
    return 0;
  }

  setPlaybackRate(deck: DeckId, rate: number): void {
    audioEngine.setPitch(deck, (rate - 1) * 100);
  }

  setEq(deck: DeckId, band: EqBand, db: number): void {
    audioEngine.setEq(deck, EQ_INDEX[band], db);
  }

  setDeckGain(deck: DeckId, db: number): void {
    audioEngine.setGain(deck, Math.pow(10, db / 20));
  }

  setDeckVolume(deck: DeckId, value: number): void {
    audioEngine.setChannelFader(deck, value);
  }

  setCrossfader(value: number): void {
    audioEngine.setCrossfader(value);
  }

  setMasterVolume(value: number): void {
    audioEngine.setMasterGain(value);
  }

  play(deck: DeckId): void {
    audioEngine.play(deck);
  }

  pause(deck: DeckId): void {
    audioEngine.pause(deck);
  }

  seek(deck: DeckId, time: number): void {
    audioEngine.seek(deck, time);
  }

  async loadTrack(deck: DeckId, data: ArrayBuffer | Blob | File | string): Promise<void> {
    audioEngine.loadSource(deck, data as ArrayBuffer | Blob | string);
  }

  releaseDeck(deck: DeckId): void {
    audioEngine.releaseSource(deck);
  }

  bumpLoadGen(_deck: DeckId): void {}
  setLoop(deck: DeckId, start: number, end: number): void {
    audioEngine.setLoopManual(deck, start, end);
  }
  exitLoop(deck: DeckId): void {
    audioEngine.exitLoop(deck);
  }
  setDeckFx(deck: DeckId, fxId: string, amount: number, active: boolean): void {
    audioEngine.setDeckFx(deck, fxId, amount, active);
  }
  resetDeckFx(deck: DeckId): void {
    audioEngine.resetDeckFx(deck);
  }
  vinylBrake(_deck: DeckId): void {
    const el = audioEngine.getElement(_deck);
    if (el) el.pause();
  }
  cancelBrake(_deck: DeckId): void {}
  nudgeStart(_deck: DeckId, _direction: 1 | -1, _fine = false): void {}
  nudgeStop(_deck: DeckId): void {}
  enterSlipMode(_deck: DeckId): void {}
  exitSlipMode(_deck: DeckId): void {}
  /** El PLL vive DENTRO del motor nativo (audio.ts · servoTick): esta façade
   *  no necesita (ni debe) aplicar correcciones por su cuenta. */
  applyPllRate(_deck: DeckId, _rate: number): void {}
  postWorkletMessage(_deck: DeckId, _message: unknown): void {}

  /** No-op stubs for the master DSP controls not present in SSA's engine. */
  setMasterEq(_band: 'low' | 'mid' | 'high', _db: number): void {}
  setMasterFilter(_knob: number): void {}
  setDistortion(_amount: number): void {}
  setPunch(_amount: number): void {}
  setColorFx(_deck: DeckId, _value: number): void {}
  setCueActive(deck: DeckId, active: boolean): void {
    audioEngine.setCueActive(deck, active);
  }
  setHeadphoneLevel(value: number): void {
    audioEngine.setHeadphoneLevel(value);
  }
  setHeadphoneMix(mix: number): void {
    audioEngine.setHeadphoneMix(mix);
  }
  setSplitMode(enabled: boolean): void {
    audioEngine.setSplitMode(enabled);
  }
  setKeyLock(deck: DeckId, enabled: boolean): void {
    const el = audioEngine.getElement(deck);
    if (el) {
      try {
        el.preservesPitch = enabled;
      } catch {
        /* sin soporte */
      }
    }
  }
  setLimiterEnabled(_enabled: boolean): void {}
  setEqModel(_model: unknown): void {}
}

export const mixiEngine = MixiEngine.getInstance();
