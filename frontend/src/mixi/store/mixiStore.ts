/*
 * MIXI mixer store — compatibility implementation for the vendored console UI.
 *
 * Keeps the exact public shape the vendored Mixi views expect (`MixiStore` =
 * `MixerState` & `MixiActions`, consumed via `useMixiStore`), but every audio
 * side-effect is delegated to Smart Set Studio's native engine (src/lib/audio.ts)
 * and the one-shot beat sync lives in src/lib/mixi.ts. The original 973-line store
 * orchestrated the Rust/Wasm engine, BPM/Waveform analysis and PhaseLockLoop,
 * none of which are vendored.
 *
 * MIXI is licensed under the PolyForm Noncommercial License 1.0.0.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type {
  DeckId,
  DeckMode,
  EqBand,
  EqValue,
  UnitValue,
  GainValue,
  ColorFxValue,
  PlaybackRate,
  WaveformPoint,
  LoopState,
  AiMode,
  CrossfaderCurve,
  MixerState,
} from '../types';
import { HOT_CUE_COUNT } from '../types';
import { clamp } from '../audio/utils/mathUtils';
import { audioEngine } from '../../lib/audio';

// ── Public action surface (identical to MIXI's MixiActions) ──────

export interface MixiActions {
  setMasterVolume: (v: UnitValue) => void;
  setMasterEq: (band: EqBand, v: number) => void;
  setMasterFilter: (v: number) => void;
  setMasterDistortion: (v: UnitValue) => void;
  setMasterPunch: (v: UnitValue) => void;

  setCrossfader: (v: UnitValue) => void;
  setCrossfaderCurve: (curve: CrossfaderCurve) => void;

  ejectDeck: (deck: DeckId) => void;
  setDeckTrackLoaded: (deck: DeckId, loaded: boolean) => void;
  setDeckPlaying: (deck: DeckId, playing: boolean) => void;
  setDeckGain: (deck: DeckId, v: GainValue) => void;
  setDeckVolume: (deck: DeckId, v: UnitValue) => void;
  setDeckEq: (deck: DeckId, band: EqBand, v: EqValue) => void;
  setDeckColorFx: (deck: DeckId, v: ColorFxValue) => void;
  setDeckPlaybackRate: (deck: DeckId, v: PlaybackRate) => void;
  setDeckWaveform: (deck: DeckId, data: WaveformPoint[] | null, duration: number) => void;

  setDeckBpm: (deck: DeckId, bpm: number, firstBeatOffset: number, bpmConfidence?: number) => void;
  setFirstBeatOffset: (deck: DeckId, offset: number) => void;
  setDeckAnalysis: (deck: DeckId, dropBeats: number[], musicalKey: string) => void;
  setDeckTrackName: (deck: DeckId, name: string) => void;
  setDeckLoadingStage: (deck: DeckId, stage: string | null) => void;
  syncDeck: (deck: DeckId) => void;
  unsyncDeck: (deck: DeckId) => void;

  setHotCue: (deck: DeckId, index: number, time: number) => void;
  triggerHotCue: (deck: DeckId, index: number) => void;
  deleteHotCue: (deck: DeckId, index: number) => void;

  beatJump: (deck: DeckId, beats: number) => void;
  shiftGrid: (deck: DeckId, beats: number) => void;
  setSyncMode: (deck: DeckId, mode: 'beat' | 'bar' | 'phrase') => void;
  vinylBrake: (deck: DeckId) => void;
  setSlipMode: (deck: DeckId, active: boolean) => void;

  alignDrops: () => void;

  setAutoLoop: (deck: DeckId, beats: number) => void;
  exitLoop: (deck: DeckId) => void;
  startLoopRoll: (deck: DeckId, beats: number) => void;

  setQuantize: (deck: DeckId, enabled: boolean) => void;
  setKeyLock: (deck: DeckId, enabled: boolean) => void;
  toggleCue: (deck: DeckId) => void;
  /** CDJ-style CUE. */
  cueDeck: (deck: DeckId) => void;

  setHeadphoneLevel: (v: UnitValue) => void;
  setHeadphoneMix: (v: UnitValue) => void;
  toggleSplitMode: () => void;

  setAiMode: (mode: AiMode) => void;
  setAiPaused: (paused: boolean) => void;
  registerUserInteraction: () => void;

  setDeckMode: (deck: DeckId, mode: DeckMode) => void;
}

export type MixiStore = MixerState & MixiActions;

function defaultDeck() {
  return {
    isPlaying: false,
    isTrackLoaded: false,
    gain: 0,
    volume: 1.0,
    eq: { low: 0, mid: 0, high: 0 },
    colorFx: 0,
    playbackRate: 1.0,
    waveformData: null as WaveformPoint[] | null,
    duration: 0,
    bpm: 0,
    originalBpm: 0,
    firstBeatOffset: 0,
    detectedFirstBeatOffset: 0,
    bpmConfidence: 0,
    isSynced: false,
    syncMode: 'beat' as const,
    hotCues: new Array(HOT_CUE_COUNT).fill(null) as (number | null)[],
    activeLoop: null as LoopState | null,
    quantize: true,
    keyLock: false,
    slipModeActive: false,
    cueActive: false,
    trackName: '',
    dropBeats: [] as number[],
    musicalKey: '',
    loadingStage: null as string | null,
  };
}

function otherDeck(deck: DeckId): DeckId {
  return deck === 'A' ? 'B' : 'A';
}

const EQ_INDEX: Record<EqBand, 0 | 1 | 2> = { low: 0, mid: 1, high: 2 };

/** Update one deck immutably. */
function patch(set: (fn: (s: MixiStore) => Partial<MixiStore>) => void, deck: DeckId, p: object) {
  set((s) => ({ decks: { ...s.decks, [deck]: { ...s.decks[deck], ...p } } }));
}

export const useMixiStore = create<MixiStore>()(
  subscribeWithSelector((set, get) => ({
    master: { volume: 0.9, eq: { low: 0, mid: 0, high: 0 }, filter: 0, distortion: 0, punch: 0 },
    // Crossfader neutro por defecto: arranca EXACTAMENTE al centro (0.5), con
    // ambos decks al mismo nivel (como un mixer físico recién encendido).
    crossfader: 0.5,
    crossfaderCurve: 'smooth',
    headphones: { level: 0.7, mix: 1, splitMode: false },
    ai: { mode: 'OFF', isPaused: false, lastInteractionTime: 0, assistResumeDelay: 5 },
    decks: { A: defaultDeck(), B: defaultDeck() },
    deckModes: { A: 'track', B: 'track' },

    // ── Master ──
    setMasterVolume: (v) => {
      audioEngine.setMasterGain(v);
      set((s) => ({ master: { ...s.master, volume: v } }));
    },
    setMasterEq: (band, v) => {
      audioEngine.setMasterEq(EQ_INDEX[band], v);
      set((s) => ({ master: { ...s.master, eq: { ...s.master.eq, [band]: v } } }));
    },
    setMasterFilter: (v) => {
      audioEngine.setMasterFilter(v);
      set((s) => ({ master: { ...s.master, filter: v } }));
    },
    setMasterDistortion: (v) => set((s) => ({ master: { ...s.master, distortion: v } })),
    setMasterPunch: (v) => set((s) => ({ master: { ...s.master, punch: v } })),

    // ── Crossfader ──
    setCrossfader: (v) => {
      audioEngine.setCrossfader(v);
      set({ crossfader: v });
    },
    setCrossfaderCurve: (curve) => set({ crossfaderCurve: curve }),

    // ── Deck transport ──
    setDeckPlaying: (deck, playing) => {
      const d = get().decks[deck];
      // Conectado directamente al motor de audio nativo.
      if (playing) {
        // Reanuda el AudioContext DENTRO del gesto del clic (policy de autoplay)
        // para que el audio suene de inmediato, sin esperar a eventos tardíos.
        void audioEngine.resume();
        const other = otherDeck(deck);
        const masterReady = get().decks[other].isTrackLoaded;

        // La sincronización/cuantización NUNCA debe impedir la reproducción.
        try {
          if (d.isSynced && masterReady) {
            audioEngine.syncTo(deck, other);
          } else if (d.quantize && masterReady) {
            audioEngine.alignToMasterOnce(deck, other);
          } else if (d.quantize && d.originalBpm > 0) {
            const el = audioEngine.getElement(deck);
            if (el) {
              // Rejilla en tiempo de fuente: BPM ORIGINAL (nunca el efectivo).
              const period = 60 / d.originalBpm;
              const k = Math.round((el.currentTime - d.firstBeatOffset) / period);
              audioEngine.seek(deck, Math.max(0, d.firstBeatOffset + k * period));
            }
          }
        } catch (err) {
          console.warn("[mixi] align on play failed", err);
        }
        audioEngine.play(deck);
      } else {
        audioEngine.pause(deck);
      }
      patch(set, deck, { isPlaying: playing });
    },
    setDeckGain: (deck, v) => {
      audioEngine.setGain(deck, Math.pow(10, v / 20));
      patch(set, deck, { gain: v });
    },
    setDeckVolume: (deck, v) => {
      audioEngine.setChannelFader(deck, v);
      patch(set, deck, { volume: v });
    },
    setDeckEq: (deck, band, v) => {
      audioEngine.setEq(deck, EQ_INDEX[band], v);
      const d = get().decks[deck];
      patch(set, deck, { eq: { ...d.eq, [band]: v } });
    },
    setDeckColorFx: (deck, v) => {
      // Color FX = filtro bimodal (LPF/HPF) sobre un BiquadFilterNode nativo.
      audioEngine.setFilter(deck, v);
      patch(set, deck, { colorFx: v });
    },
    setDeckPlaybackRate: (deck, v) => {
      audioEngine.setPitch(deck, (v - 1) * 100);
      const d = get().decks[deck];
      patch(set, deck, { playbackRate: v, bpm: d.originalBpm > 0 ? d.originalBpm * v : d.bpm });
    },
    setDeckWaveform: (deck, data, duration) => patch(set, deck, { waveformData: data, duration }),

    // ── BPM & sync ──
    setDeckBpm: (deck, bpm, firstBeatOffset, bpmConfidence = 1) => {
      // El motor de audio usa la MISMA rejilla que muestra la UI (tiempo de
      // fuente): sin esto, el Hard Alignment buscaría contra una rejilla
      // distinta de las líneas visibles y la fase quedaría descuadrada.
      audioEngine.setDeckMeta(deck, { originalBpm: bpm, gridOff: firstBeatOffset });
      patch(set, deck, {
        bpm,
        originalBpm: bpm,
        firstBeatOffset,
        detectedFirstBeatOffset: firstBeatOffset,
        bpmConfidence,
      });
    },
    setFirstBeatOffset: (deck, offset) => {
      audioEngine.setDeckMeta(deck, { gridOff: offset });
      patch(set, deck, { firstBeatOffset: offset });
    },
    setDeckAnalysis: (deck, dropBeats, musicalKey) =>
      patch(set, deck, { dropBeats, musicalKey }),
    setDeckTrackName: (deck, name) => patch(set, deck, { trackName: name }),
    setDeckLoadingStage: (deck, stage) => patch(set, deck, { loadingStage: stage }),
    setDeckTrackLoaded: (deck, loaded) => patch(set, deck, { isTrackLoaded: loaded }),

    syncDeck: (deck) => {
      const other = otherDeck(deck);
      const d = get().decks[deck];
      if (!(audioEngine.syncTo(deck, other) && d.originalBpm > 0)) return;
      const rate = 1 + audioEngine.getPitch(deck) / 100;
      patch(set, deck, { isSynced: true, playbackRate: rate, bpm: d.originalBpm * rate });
    },
    unsyncDeck: (deck) => {
      audioEngine.clearSync(deck);
      const d = get().decks[deck];
      const rate = 1 + audioEngine.getPitch(deck) / 100;
      patch(set, deck, { isSynced: false, playbackRate: rate, bpm: d.originalBpm * rate });
    },

    // ── Hot cues ──
    setHotCue: (deck, index, time) => {
      const cues = [...get().decks[deck].hotCues];
      cues[index] = time;
      patch(set, deck, { hotCues: cues });
    },
    triggerHotCue: (deck, index) => {
      const t = get().decks[deck].hotCues[index];
      if (t == null) return;
      audioEngine.seek(deck, t);
      // Rekordbox: el hot cue dispara la reproducción al instante si el deck
      // estaba en pausa (transporte inmediato, sin gesto adicional).
      const el = audioEngine.getElement(deck);
      if (el && el.paused) {
        audioEngine.play(deck);
        patch(set, deck, { isPlaying: true });
      }
    },
    deleteHotCue: (deck, index) => {
      const cues = [...get().decks[deck].hotCues];
      cues[index] = null;
      patch(set, deck, { hotCues: cues });
    },

    // ── Beat jump / grid ──
    beatJump: (deck, beats) => {
      // Salto cuantizado EXACTO sobre la grilla (tiempo de fuente, múltiplo
      // entero de beats): la fase no cambia y el SYNC Hard Lock se conserva.
      audioEngine.beatJump(deck, beats);
    },
    shiftGrid: (deck, beats) => {
      const d = get().decks[deck];
      if (d.originalBpm > 0) {
        // Desplazamiento de la rejilla en tiempo de fuente (BPM original).
        const next = d.firstBeatOffset + (beats * 60) / d.originalBpm;
        // El motor de audio debe conocer el desplazamiento de la rejilla
        // para que el próximo SYNC aterrice sobre las líneas visibles.
        audioEngine.setDeckMeta(deck, { gridOff: next });
        patch(set, deck, { firstBeatOffset: next });
      }
    },
    setSyncMode: (deck, mode) => patch(set, deck, { syncMode: mode }),
    vinylBrake: (deck) => {
      const el = audioEngine.getElement(deck);
      if (!el) return;
      const start = performance.now();
      const from = el.playbackRate;
      const step = () => {
        const k = Math.min(1, (performance.now() - start) / 500);
        el.playbackRate = Math.max(0, from * (1 - k));
        if (k < 1) requestAnimationFrame(step);
        else el.pause();
        audioEngine.setPitch(deck, 0);
      };
      requestAnimationFrame(step);
    },
    setSlipMode: (deck, active) => patch(set, deck, { slipModeActive: active }),
    alignDrops: () => {
      /* no-op: Smart Set Studio no calcula drops en la consola nativa */
    },

    // ── Loops (motor nativo: cuantizados a la grilla, fase continua) ──
    setAutoLoop: (deck, beats) => {
      const d = get().decks[deck];
      if (d.originalBpm <= 0) return;
      // El motor arma el loop EXACTO sobre la rejilla (start/end en tiempo
      // de fuente, N beats exactos) y lo reproduce al instante.
      const loop = audioEngine.setAutoLoop(deck, beats);
      if (!loop) return;
      patch(set, deck, { activeLoop: { start: loop.start, end: loop.end, lengthInBeats: loop.beats } });
    },
    exitLoop: (deck) => {
      // Libera el loop sin desfasar (en un Roll con Slip retoma el tiempo
      // real virtual, conservando la fase del SYNC).
      audioEngine.exitLoop(deck);
      patch(set, deck, { activeLoop: null });
    },
    startLoopRoll: (deck, beats) => {
      const d = get().decks[deck];
      if (d.originalBpm <= 0) return;
      // Roll con Slip: loop momentáneo + reloj virtual; al soltar (exitLoop)
      // la canción retoma donde le correspondía en tiempo real.
      const loop = audioEngine.startLoopRoll(deck, beats);
      if (!loop) return;
      patch(set, deck, { activeLoop: { start: loop.start, end: loop.end, lengthInBeats: loop.beats } });
    },

    setQuantize: (deck, enabled) => patch(set, deck, { quantize: enabled }),
    setKeyLock: (deck, enabled) => {
      const el = audioEngine.getElement(deck);
      if (el) {
        try {
          el.preservesPitch = enabled;
        } catch {
          /* sin soporte */
        }
      }
      patch(set, deck, { keyLock: enabled });
    },
    toggleCue: (deck) => patch(set, deck, { cueActive: !get().decks[deck].cueActive }),

    // ── CUE estilo CDJ ──
    cueDeck: (deck) => {
      const d = get().decks[deck];
      const el = audioEngine.getElement(deck);
      if (!el) return;
      const cue = d.hotCues[0];
      const snap = (t: number) => {
        if (!d.quantize || d.originalBpm <= 0) return t;
        // Rejilla en tiempo de fuente: BPM ORIGINAL.
        const period = 60 / d.originalBpm;
        const k = Math.round((t - d.firstBeatOffset) / period);
        return d.firstBeatOffset + k * period;
      };
      if (d.isPlaying) {
        // Reproduciendo: pausa y vuelve al CUE (o al inicio).
        audioEngine.pause(deck);
        audioEngine.seek(deck, cue != null ? cue : 0);
        patch(set, deck, { isPlaying: false });
      } else if (cue != null) {
        audioEngine.seek(deck, cue);
      } else {
        // Sin CUE: fija uno en la posición actual (cuantizada al beat).
        const t = Math.max(0, snap(el.currentTime));
        const cues = [...d.hotCues];
        cues[0] = t;
        patch(set, deck, { hotCues: cues });
        audioEngine.seek(deck, t);
      }
    },

    // ── Headphones ──
    setHeadphoneLevel: (v) => set((s) => ({ headphones: { ...s.headphones, level: v } })),
    setHeadphoneMix: (v) => set((s) => ({ headphones: { ...s.headphones, mix: v } })),
    toggleSplitMode: () =>
      set((s) => ({ headphones: { ...s.headphones, splitMode: !s.headphones.splitMode } })),

    // ── AI ──
    setAiMode: (mode) => set((s) => ({ ai: { ...s.ai, mode } })),
    setAiPaused: (paused) => set((s) => ({ ai: { ...s.ai, isPaused: paused } })),
    registerUserInteraction: () =>
      set((s) => ({ ai: { ...s.ai, lastInteractionTime: Date.now(), isPaused: true } })),

    // ── Deck mode ──
    setDeckMode: (deck, mode) => set((s) => ({ deckModes: { ...s.deckModes, [deck]: mode } })),

    // ── Eject ──
    ejectDeck: (deck) => {
      audioEngine.releaseSource(deck);
      patch(set, deck, { ...defaultDeck() });
    },
  }))
);

export const clampUnit = (v: number) => clamp(v, 0, 1);
