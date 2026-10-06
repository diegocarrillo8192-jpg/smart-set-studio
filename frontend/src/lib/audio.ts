/**
 * Motor de audio de la consola DJ nativa (Decks A/B + Mixer estilo MIXI).
 *
 * Reproducción por deck sobre AudioBufferSourceNode (Web Audio API), NO sobre
 * <audio>: esto habilita loops 100 % sample-accurate (loopStart/loopEnd) y un
 * SYNC sin deriva (los dos decks comparten el MISMO reloj — AudioContext.
 * currentTime — de modo que la fase no puede desviarse como ocurría con los
 * relojes independientes de dos <audio>).
 *
 * Cadena por deck:
 *   source ──(KEY LOCK: phase-vocoder AudioWorklet)──> analyser
 *          → TRIM(gain) → EQ LOW → EQ MID → EQ HIGH → LowKill
 *          → FILTER (Color FX) → CUE GAIN → CUE BUS (Pre-Fader Listen)
 *          → FX (dry/wet) → FADER → [VU] → CROSS → MASTER → destination
 *
 * KEY LOCK:
 *   AudioBufferSourceNode cambia el TONO al cambiar playbackRate. Para
 *   preservar el tono (key lock) se inserta un phase-vocoder (AudioWorklet,
 *   lib/phaseVocoder.worklet.js) que aplica un pitch-shift por factor 1/rate:
 *   el source suena a `rate` (tempo) y el vocoder devuelve el tono original
 *   sin tocar el tempo (hop de síntesis == hop de análisis). Con Key Lock OFF
 *   el vocoder se bypasea (comportamiento vinyl: el tono sigue al tempo).
 *
 * Controles:
 *   · PLAY/PAUSE/CUE → start()/stop() del source + posición sobre el reloj ctx.
 *   · PITCH/TEMPO   → source.playbackRate (AudioParam, rampa con setTargetAtTime).
 *   · SYNC          → rate = BPM_Master / BPM_Original (1:1) + fase cuantizada
 *                     al beatgrid con audioContext.currentTime (sin deriva).
 *   · GAIN / EQ 3 bandas → nodos Web Audio (trim + Biquads).
 *   · FADER / CROSSFADER → gains.
 *   · JOG/SCRATCH    → bend de playbackRate o seek (según play/pause).
 *
 * SYNC (Master Audio Clock + Phase Lock, sin deriva):
 *   · Reloj maestro = AudioContext.currentTime. Ambos sources se programan
 *     sobre ese MISMO reloj, así que dos rates iguales avanzan en fase
 *     exacta para siempre (cero deriva acumulativa por construcción).
 *   · Tempo: rate base = BPM_Master_efectivo / BPM_Original_del_esclavo (1:1).
 *   · Fase (enganche): alinear el offset del esclavo al beat más cercano de la
 *     rejilla del maestro. Con el deck en pausa es un seek inaudible; sonando,
 *     el servo converge la fase con un trim SUAVE de rate (sin seek audible).
 *   · Fase (mantenida): servo PI cada 200 ms que recorta el rate del esclavo
 *     (trim ±4 % convergiendo, ~0 % en lock) para clavar la fase en 0 ms. Al
 *     no existir deriva, el bias aprende solo el residuo mínimo de redondeo.
 */

import { hardAlignShift, syncPlaybackRate } from "./mixi";

export type EqBand = 0 | 1 | 2; // 0 = LOW, 1 = MID, 2 = HIGH

export const CROSSFADE_CUTOFF = 0.8;
export const DEFAULT_PITCH_RANGE = 8;
export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;
const EQ_KILL_DB = -60;

/** Tau (s) de la rampa suave de playbackRate/Key Lock (AudioParam). */
const RATE_TAU = 0.012;

/** ── Master Audio Clock / Phase Servo (SYNC profesional) ────────────────── */
const SERVO_INTERVAL_MS = 200;
/** Deriva (en beats) que dispara el re-enganche rígido (Hard Snap). */
const SERVO_SNAP_BEATS = 0.4;
/** Constante de tiempo del corrector proporcional de fase (s): trim = err/C. */
const SERVO_CONVERGE_S = 0.25;
/** Máximo trim de tasa durante la convergencia (±4 %, inaudible con key lock). */
const SERVO_MAX_TRIM = 0.04;
/** Ganancia integral (1/s) para clavar el error estacionario residual. */
const SERVO_I_GAIN = 1.5;

/** Estado del servo de fase por deck. */
interface ServoState {
  /** Término integral: corrección estacionaria de tasa aprendida. */
  bias: number;
}

function freshServo(): ServoState {
  return { bias: 0 };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Información de un loop activo (tiempos de FUENTE, cuantizados a la grilla). */
export interface LoopInfo {
  start: number;
  end: number;
  /** Longitud del loop en beats (start/end alineados a la rejilla exacta). */
  beats: number;
  /** Loop Roll (Slip): al salir se retoma el tiempo real virtual. */
  roll: boolean;
  /** Posición de fuente al entrar en el roll (base del reloj virtual). */
  rollBase: number;
  /** AudioContext.currentTime de entrada al roll (reloj maestro). */
  rollStartCtx: number;
}

// ── DeckElement: shim con interfaz de media element ────────────────────────
// Los decks exponen un objeto que emula el HTMLAudioElement que antes usaba el
// reproductor compacto (components/Deck.tsx · DualDeck.tsx): currentTime,
// playbackRate, play/pause, eventos. Toda la semántica delega en el motor ABSS.
type DeckListener = (ev?: unknown) => void;

export class DeckElement {
  onerror: ((e?: unknown) => void) | null = null;
  muted = false;
  crossOrigin: string | null = null;
  preload = "auto";
  dataset: Record<string, string> = {};

  private _src = "";
  private listeners = new Map<string, Set<DeckListener>>();

  constructor(
    private engine: AudioEngine,
    private name: "A" | "B",
  ) {}

  addEventListener(type: string, cb: DeckListener): void {
    let s = this.listeners.get(type);
    if (!s) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(cb);
  }

  removeEventListener(type: string, cb: DeckListener): void {
    this.listeners.get(type)?.delete(cb);
  }

  /** Emite un evento (usado por el motor en play/pause/ended/loadedmetadata). */
  emit(type: string, ev?: unknown): void {
    const s = this.listeners.get(type);
    if (s) for (const cb of Array.from(s)) cb(ev);
  }

  get currentTime(): number {
    const h = this.engine.deck(this.name);
    return h ? this.engine.deckPosition(h) : 0;
  }
  set currentTime(v: number) {
    this.engine.seek(this.name, v);
  }

  get playbackRate(): number {
    return this.engine.deck(this.name)?.rate ?? 1;
  }
  set playbackRate(v: number) {
    this.engine.setRate(this.name, v, false);
  }

  get duration(): number {
    return this.engine.deck(this.name)?.buffer?.duration ?? 0;
  }

  get paused(): boolean {
    return !(this.engine.deck(this.name)?.playing ?? false);
  }

  get readyState(): number {
    return this.engine.deck(this.name)?.buffer ? 4 : 0;
  }

  get preservesPitch(): boolean {
    return this.engine.deck(this.name)?.keylockEnabled ?? false;
  }
  set preservesPitch(v: boolean) {
    this.engine.setKeyLock(this.name, v);
  }

  get src(): string {
    return this._src;
  }
  set src(url: string) {
    this._src = url;
    this.engine.loadSource(this.name, url);
  }
  load(): void {
    /* no-op: el fetch/decode lo hace loadSource */
  }

  play(): Promise<void> {
    this.engine.play(this.name);
    return Promise.resolve();
  }
  pause(): void {
    this.engine.pause(this.name);
  }
}

/** Mango de un deck del motor (estado de transporte ABSS + nodos del grafo). */
export interface DeckHandle {
  // ── transporte ABSS ──
  buffer: AudioBuffer | null;
  source: AudioBufferSourceNode | null;
  keylockNode: AudioWorkletNode | null;
  keylockEnabled: boolean;
  playing: boolean;
  /** ctx.currentTime en el que arrancó el source actual. */
  startCtxTime: number;
  /** Offset en el buffer (s) en startCtxTime. */
  startOffset: number;
  /** performance.now() en startCtxTime (para recuperar posición tras un crash
   *  del AudioContext, cuando ya no hay reloj ctx que consultar). */
  wallTime: number;
  /** playbackRate actual (s de contenido / s reales). */
  rate: number;
  /** Posición (s) al pausar. */
  pausedAt: number;
  /** Token de carga: descarta decodificaciones obsoletas. */
  loadingToken: number;

  // ── grafo (pre-fader) ──
  analyser: AnalyserNode;
  trim: GainNode;
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHi: BiquadFilterNode;
  lowKill: BiquadFilterNode;
  filterLP: BiquadFilterNode;
  filterHP: BiquadFilterNode;
  fader: GainNode;
  vu: AnalyserNode;
  cross: GainNode;
  cue: GainNode;
  dly: DelayNode;
  dlyFb: GainNode;
  dlyWet: GainNode;
  phaWet: GainNode;

  // ── pitch / sync ──
  pitch: number;
  range: number;
  synced: boolean;
  syncRole: "master" | "follower" | null;
  originalBpm: number;
  gridOff: number;
  masterName: "A" | "B" | null;
  jogging: boolean;
  eq: [number, number, number]; // dB (-26..+6; -30 = kill)
  cueActive: boolean;

  // ── loop ──
  loop: LoopInfo | null;
  loopInPending: number | null;

  // ── shim ──
  el: DeckElement;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  deckA: DeckHandle | null = null;
  deckB: DeckHandle | null = null;
  private master: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private masterEq: [BiquadFilterNode, BiquadFilterNode, BiquadFilterNode] | null = null;
  private masterFilterLP: BiquadFilterNode | null = null;
  private masterFilterHP: BiquadFilterNode | null = null;
  /** Bus de CUE/PFL: suma de las señales pre-fader de cada canal. */
  private cueBus: GainNode | null = null;
  /** Mezcla de auriculares: master → hpMasterGain, cue → hpCueGain. */
  private hpMasterGain: GainNode | null = null;
  private hpCueGain: GainNode | null = null;
  private hpMixBus: GainNode | null = null;
  private hpLevelGain: GainNode | null = null;
  private hpMerger: ChannelMergerNode | null = null;
  private hpMixConnected = true;
  private headphoneMix = 1;
  private headphoneLevel = 0.7;
  private splitMode = false;
  private meterBuf = new Float32Array(1024);
  private crossfader = 0.5;
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recording = false;
  /** Timer del servo de fase (solo vive mientras hay SYNC activo). */
  private servoTimer: ReturnType<typeof setInterval> | null = null;
  /** Ventana/estado del servo por deck. */
  private servo: Record<"A" | "B", ServoState> = { A: freshServo(), B: freshServo() };
  /** Promesa de carga del módulo AudioWorklet (key lock). */
  private workletPromise: Promise<void> | null = null;

  // ── Contexto de audio ────────────────────────────────────────────────────

  ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      ctx.onstatechange = () => this.handleCtxState();
      this.buildMasterChain(ctx);
      // Reconstrucción tras una pérdida total (state "closed"): los decks se
      // re-enganchan al grafo nuevo conservando buffer (AudioBuffer sobrevive
      // al contexto), posición, tempo y SYNC.
      if (this.deckA || this.deckB) {
        for (const n of ["A", "B"] as const) this.rebindDeckAfterCtxLoss(n);
        this.setCrossfader(this.crossfader);
        this.setSplitMode(this.splitMode);
      }
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  /** Carga (una sola vez) el módulo del phase-vocoder. */
  private ensureWorklet(): Promise<void> {
    if (!this.ctx) return Promise.reject(new Error("no ctx"));
    if (!this.workletPromise) {
      this.workletPromise = this.ctx.audioWorklet
        .addModule(new URL("./phaseVocoder.worklet.js", import.meta.url))
        .then(() => undefined);
    }
    return this.workletPromise;
  }

  /** Cadena master (EQ global + filtro bimodal + analizador). */
  private buildMasterChain(ctx: AudioContext): void {
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const mk = (type: BiquadFilterType, freq: number, q?: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q !== undefined) f.Q.value = q;
      f.gain.value = 0;
      return f;
    };
    this.masterEq = [mk("lowshelf", 200), mk("peaking", 1000, 0.8), mk("highshelf", 3500)];
    this.masterFilterLP = mk("lowpass", 22000, 0.71);
    this.masterFilterHP = mk("highpass", 20, 0.71);
    this.masterAnalyser = ctx.createAnalyser();
    this.masterAnalyser.fftSize = 1024;

    this.master
      .connect(this.masterEq[0])
      .connect(this.masterEq[1])
      .connect(this.masterEq[2])
      .connect(this.masterFilterLP)
      .connect(this.masterFilterHP)
      .connect(this.masterAnalyser)
      .connect(ctx.destination);

    this.cueBus = ctx.createGain();
    this.cueBus.gain.value = 1;

    this.hpMasterGain = ctx.createGain();
    this.hpMasterGain.gain.value = this.headphoneMix;
    this.hpCueGain = ctx.createGain();
    this.hpCueGain.gain.value = 1 - this.headphoneMix;
    this.hpMixBus = ctx.createGain();
    this.hpMixBus.gain.value = 1;
    this.hpLevelGain = ctx.createGain();
    this.hpLevelGain.gain.value = this.headphoneLevel;
    this.hpMerger = ctx.createChannelMerger(2);

    this.masterFilterHP.connect(this.hpMasterGain);
    this.cueBus.connect(this.hpCueGain);
    this.hpMasterGain.connect(this.hpMixBus);
    this.hpCueGain.connect(this.hpMixBus);
    this.hpMixBus.connect(this.hpLevelGain);
    this.hpLevelGain.connect(ctx.destination);

    this.cueBus.connect(this.hpMerger, 0, 0);
    this.masterFilterHP.connect(this.hpMerger, 0, 1);
  }

  private ctxResumeAttempts = 0;

  private handleCtxState(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "closed") {
      console.warn("[audio] AudioContext cerrado — reconstruyendo el grafo de audio");
      this.master = null;
      this.masterEq = null;
      this.masterFilterLP = null;
      this.masterFilterHP = null;
      this.masterAnalyser = null;
      this.recDest = null;
      this.ctx = null;
      this.workletPromise = null;
      void this.ensureContext();
    } else if (ctx.state === "suspended" && this.ctxResumeAttempts < 4) {
      this.ctxResumeAttempts += 1;
      setTimeout(() => {
        const c = this.ctx;
        if (c === ctx && c.state === "suspended") {
          void c
            .resume()
            .then(() => {
              this.ctxResumeAttempts = 0;
            })
            .catch(() => undefined);
        }
      }, 400 * this.ctxResumeAttempts);
    } else if (ctx.state === "running") {
      this.ctxResumeAttempts = 0;
    }
  }

  resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      return ctx.resume().catch(() => undefined);
    }
    return Promise.resolve();
  }

  deck(name: "A" | "B"): DeckHandle | null {
    return name === "A" ? this.deckA : this.deckB;
  }

  getElement(name: "A" | "B"): DeckElement | null {    return this.deck(name)?.el ?? null;
  }

  getOutputTime(name: "A" | "B"): number {
    const h = this.deck(name);
    return h ? this.deckPosition(h) : 0;
  }

  getAnalyser(name: "A" | "B"): AnalyserNode | null {
    return this.deck(name)?.analyser ?? null;
  }

  getMasterAnalyser(): AnalyserNode | null {
    this.ensureContext();
    return this.masterAnalyser;
  }

  // ── Construcción del grafo de un deck ────────────────────────────────────

  /** Crea todos los nodos estáticos del deck (sin source ni buffer). */
  private buildDeckGraph(name: "A" | "B"): DeckHandle {
    const ctx = this.ensureContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;

    const trim = ctx.createGain();
    trim.gain.value = 1;

    const mkEq = (type: BiquadFilterType, freq: number, q?: number) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q !== undefined) f.Q.value = q;
      f.gain.value = 0;
      return f;
    };
    const eqLow = mkEq("lowshelf", 200);
    const eqMid = mkEq("peaking", 1000, 0.8);
    const eqHi = mkEq("highshelf", 3500);

    const lowKill = ctx.createBiquadFilter();
    lowKill.type = "highpass";
    lowKill.frequency.value = 20;
    lowKill.Q.value = 0.71;

    const fader = ctx.createGain();
    fader.gain.value = 1;

    const vu = ctx.createAnalyser();
    vu.fftSize = 1024;

    const cross = ctx.createGain();
    cross.gain.value = Math.SQRT1_2;

    const cue = ctx.createGain();
    cue.gain.value = 0;

    const filterLP = ctx.createBiquadFilter();
    filterLP.type = "lowpass";
    filterLP.frequency.value = 22000;
    filterLP.Q.value = 0.71;
    const filterHP = ctx.createBiquadFilter();
    filterHP.type = "highpass";
    filterHP.frequency.value = 20;
    filterHP.Q.value = 0.71;

    // FX en paralelo (sends): dry + delay + phaser.
    const fxDry = ctx.createGain();
    fxDry.gain.value = 1;
    const dly = ctx.createDelay(4);
    dly.delayTime.value = 0.3;
    const dlyFb = ctx.createGain();
    dlyFb.gain.value = 0;
    const dlyWet = ctx.createGain();
    dlyWet.gain.value = 0;
    const phaWet = ctx.createGain();
    phaWet.gain.value = 0;
    const phaStages: BiquadFilterNode[] = [];
    let phaNode: AudioNode = filterHP;
    const phaLfo = ctx.createOscillator();
    phaLfo.type = "sine";
    phaLfo.frequency.value = 0.4;
    const phaLfoGain = ctx.createGain();
    phaLfoGain.gain.value = 900;
    phaLfo.connect(phaLfoGain);
    for (const f of [400, 800, 1600, 3200]) {
      const ap = ctx.createBiquadFilter();
      ap.type = "allpass";
      ap.frequency.value = f;
      ap.Q.value = 1.2;
      phaLfoGain.connect(ap.frequency);
      phaStages.push(ap);
    }
    phaLfo.start();

    analyser.connect(trim);
    trim.connect(eqLow);
    eqLow.connect(eqMid);
    eqMid.connect(eqHi);
    eqHi.connect(lowKill);
    lowKill.connect(filterLP);
    filterLP.connect(filterHP);
    // Dry
    filterHP.connect(fxDry);
    fxDry.connect(fader);
    // Delay send
    filterHP.connect(dly);
    dly.connect(dlyFb);
    dlyFb.connect(dly);
    dly.connect(dlyWet);
    dlyWet.connect(fader);
    // Phaser send
    for (const ap of phaStages) {
      phaNode.connect(ap);
      phaNode = ap;
    }
    phaNode.connect(phaWet);
    phaWet.connect(fader);
    // Pre-Fader Listen (CUE): después de EQ/Trim/Filtro, antes del fader.
    filterHP.connect(cue);
    cue.connect(this.cueBus!);

    fader.connect(vu);
    fader.connect(cross);
    cross.connect(this.master!);

    const handle: DeckHandle = {
      buffer: null,
      source: null,
      keylockNode: null,
      keylockEnabled: false,
      playing: false,
      startCtxTime: 0,
      startOffset: 0,
      wallTime: 0,
      rate: 1,
      pausedAt: 0,
      loadingToken: 0,
      analyser,
      trim,
      eqLow,
      eqMid,
      eqHi,
      lowKill,
      filterLP,
      filterHP,
      fader,
      vu,
      cross,
      cue,
      dly,
      dlyFb,
      dlyWet,
      phaWet,
      pitch: 0,
      range: DEFAULT_PITCH_RANGE,
      synced: false,
      syncRole: null,
      originalBpm: 0,
      gridOff: 0,
      masterName: null,
      jogging: false,
      eq: [0, 0, 0],
      cueActive: false,
      loop: null,
      loopInPending: null,
      el: new DeckElement(this, name),
    };
    return handle;
  }

  bindDeck(name: "A" | "B"): DeckHandle | null {
    const existing = this.deck(name);
    if (existing) return existing;
    try {
      const handle = this.buildDeckGraph(name);
      if (name === "A") this.deckA = handle;
      else this.deckB = handle;
      return handle;
    } catch (err) {
      console.error("[audio] No se pudo enlazar el deck", name, err);
      return null;
    }
  }

  /** Re-engancha un deck al grafo tras reconstruir el AudioContext. El
   *  AudioBuffer sobrevive al contexto; solo se recrean los nodos y el source
   *  y se restaura posición/tempo/SYNC/loop. */
  private rebindDeckAfterCtxLoss(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    // Posición aproximada tras el crash: el reloj ctx ya no existe, así que se
    // estima con wall-clock (performance.now) desde el último anclaje.
    let time: number;
    if (h.playing && h.buffer) {
      const elapsed = (performance.now() - h.wallTime) / 1000;
      time = clamp(h.startOffset + elapsed * h.rate, 0, h.buffer.duration);
    } else {
      time = h.pausedAt;
    }
    const snapshot = {
      buffer: h.buffer,
      time,
      playing: h.playing,
      rate: h.rate,
      keylockEnabled: h.keylockEnabled,
      pitch: h.pitch,
      range: h.range,
      synced: h.synced,
      syncRole: h.syncRole,
      originalBpm: h.originalBpm,
      gridOff: h.gridOff,
      masterName: h.masterName,
      eq: h.eq,
      cueActive: h.cueActive,
      loop: h.loop,
      loopInPending: h.loopInPending,
    };
    // Desconectar el grafo viejo del master para no dejar colas.
    try {
      h.cross.disconnect();
      h.cue.disconnect();
    } catch {
      /* ok */
    }

    const fresh = this.buildDeckGraph(name);
    fresh.buffer = snapshot.buffer;
    fresh.rate = snapshot.rate;
    fresh.keylockEnabled = snapshot.keylockEnabled;
    fresh.pitch = snapshot.pitch;
    fresh.range = snapshot.range;
    fresh.synced = snapshot.synced;
    fresh.syncRole = snapshot.syncRole;
    fresh.originalBpm = snapshot.originalBpm;
    fresh.gridOff = snapshot.gridOff;
    fresh.masterName = snapshot.masterName;
    fresh.eq = snapshot.eq;
    fresh.cueActive = snapshot.cueActive;
    fresh.loop = snapshot.loop;
    fresh.loopInPending = snapshot.loopInPending;
    if (name === "A") this.deckA = fresh;
    else this.deckB = fresh;

    this.setEq(name, 0, fresh.eq[0]);
    this.setEq(name, 1, fresh.eq[1]);
    this.setEq(name, 2, fresh.eq[2]);
    this.setCueActive(name, fresh.cueActive);
    if (fresh.keylockEnabled) {
      void this.ensureWorklet().then(() => {
        this.createKeylockNode(name);
        this.applyKeylockRoute(name, true);
      });
    }
    if (snapshot.playing) {
      fresh.pausedAt = snapshot.time;
      this.play(name);
    } else {
      fresh.pausedAt = snapshot.time;
    }
    if (snapshot.synced && snapshot.masterName && snapshot.playing) {
      this.commitSync(name);
    }
  }

  // ── Carga / liberación de fuente (decodeAudioData) ───────────────────────

  /** Carga una fuente (URL/blob/ArrayBuffer), la decodifica a AudioBuffer y la
   *  deja lista. Libera el buffer anterior. Devuelve una función de limpieza
   *  opcional (compatibilidad con el API anterior). */
  loadSource(name: "A" | "B", source: string | Blob | ArrayBuffer): (() => void) | undefined {
    const h = this.deck(name);
    if (!h) return undefined;
    const token = ++h.loadingToken;
    this.clearSync(name);
    this.exitLoop(name);
    h.loopInPending = null;
    h.pausedAt = 0;
    if (h.playing) this.pause(name);
    // No se libera el buffer hasta que la nueva decodificación esté lista
    // (evita un corte audible si la carga falla a mitad de camino).

    void this.decodeToBuffer(source).then(
      (buffer) => {
        if (!this.deck(name) || token !== this.deck(name)!.loadingToken) return;
        const hh = this.deck(name)!;
        hh.buffer = buffer;
        hh.pausedAt = 0;
        hh.el.emit("loadedmetadata");
        hh.el.emit("canplay");
      },
      (err) => {
        console.warn("[audio] falló la carga de", name, err);
        const el = this.deck(name)?.el;
        if (el?.onerror) el.onerror(err);
      },
    );
    return undefined;
  }

  /** Decodifica un ArrayBuffer/Blob/URL a AudioBuffer. */
  private async decodeToBuffer(source: string | Blob | ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    let buf: ArrayBuffer;
    if (typeof source === "string") {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buf = await res.arrayBuffer();
    } else if (source instanceof ArrayBuffer) {
      buf = source;
    } else {
      buf = await source.arrayBuffer();
    }
    return ctx.decodeAudioData(buf);
  }

  /** Libera la fuente del deck (pausa + suelta el buffer). */
  releaseSource(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    this.clearSync(name);
    this.exitLoop(name);
    h.loopInPending = null;
    this.pause(name);
    this.setCueActive(name, false);
    h.loadingToken += 1;
    h.buffer = null;
    h.pausedAt = 0;
  }

  // ── Transporte (ABSS) ────────────────────────────────────────────────────

  /** Posición CRUDA (sin envolver el loop) del deck en el buffer. */
  private rawPosition(h: DeckHandle): number {
    if (!h.buffer) return 0;
    if (!h.playing) return h.pausedAt;
    const now = this.ctx ? this.ctx.currentTime : 0;
    return h.startOffset + (now - h.startCtxTime) * h.rate;
  }

  /** Envuelve t dentro del loop activo (si lo hay). */
  private loopWrap(h: DeckHandle, t: number): number {
    if (!h.loop) return t;
    const len = h.loop.end - h.loop.start;
    if (len <= 0) return t;
    return h.loop.start + ((((t - h.loop.start) % len) + len) % len);
  }

  /** Posición EFECTIVA (envuelta al loop) — lo que "suena"/se muestra. */
  deckPosition(h: DeckHandle): number {
    if (!h.buffer) return 0;
    const raw = this.rawPosition(h);
    const pos = this.loopWrap(h, raw);
    return clamp(pos, 0, h.buffer.duration);
  }

  /** Re-ancla la posición de seguimiento (startOffset/startCtxTime) al ahora. */
  private rebase(h: DeckHandle): number {
    const pos = this.deckPosition(h);
    h.startOffset = pos;
    h.startCtxTime = this.ctx ? this.ctx.currentTime : 0;
    h.wallTime = performance.now();
    return pos;
  }

  /** Crea y arranca un source (con loop si procede) en `when` a partir de
   *  `offset`. El offset se envuelve al loop para arrancar siempre dentro. */
  private startSource(h: DeckHandle, when: number, offset: number): void {
    const ctx = this.ctx;
    if (!ctx || !h.buffer) return;
    if (h.loop) offset = this.loopWrap(h, offset);
    const src = ctx.createBufferSource();
    src.buffer = h.buffer;
    src.loop = !!h.loop;
    if (h.loop) {
      src.loopStart = h.loop.start;
      src.loopEnd = h.loop.end;
    }
    src.playbackRate.value = h.rate;
    if (h.keylockEnabled && h.keylockNode) src.connect(h.keylockNode);
    else src.connect(h.analyser);
    src.onended = () => {
      if (h.source === src) {
        h.source = null;
        if (h.playing && !h.loop) {
          h.playing = false;
          h.pausedAt = h.buffer ? h.buffer.duration : 0;
          h.el.emit("ended");
        }
      }
    };
    h.source = src;
    try {
      src.start(when, offset);
    } catch {
      /* sin datos aún */
    }
  }

  /** Detiene y desconecta el source actual. */
  private stopSource(h: DeckHandle): void {
    const src = h.source;
    h.source = null;
    if (src) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        /* ya detenido */
      }
      try {
        src.disconnect();
      } catch {
        /* ok */
      }
    }
  }

  /** Aplica loop/loopStart/loopEnd al source activo (o al próximo arranque). */
  private applyLoopToSource(h: DeckHandle): void {
    if (!h.source) return;
    h.source.loop = !!h.loop;
    if (h.loop) {
      h.source.loopStart = h.loop.start;
      h.source.loopEnd = h.loop.end;
    }
  }

  play(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || h.playing) return;
    // SYNC activo: alinear fase (snap inaudible si estaba pausado) + rate.
    if (h.synced && h.masterName) this.commitSync(name);
    void this.resume();
    const offset = h.loop ? this.loopWrap(h, h.pausedAt) : h.pausedAt;
    const now = this.ctx ? this.ctx.currentTime : 0;
    this.startSource(h, now, offset);
    h.playing = true;
    h.startCtxTime = now;
    h.startOffset = offset;
    h.wallTime = performance.now();
    h.el.emit("play");
  }

  pause(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !h.playing) return;
    h.pausedAt = this.deckPosition(h);
    h.playing = false;
    this.stopSource(h);
    h.el.emit("pause");
    // PAUSE/CUE: congelar la corrección de fase de inmediato (limpia el bias).
    this.resetPhaseLock();
  }

  toggle(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    if (h.playing) this.pause(name);
    else this.play(name);
  }

  seek(name: "A" | "B", t: number): void {
    const h = this.deck(name);
    if (!h) return;
    const dur = h.buffer ? h.buffer.duration : Number.MAX_SAFE_INTEGER;
    let target = clamp(t, 0, dur);
    if (h.loop) target = this.loopWrap(h, target);
    if (h.playing) {
      const now = this.ctx ? this.ctx.currentTime : 0;
      this.stopSource(h);
      this.startSource(h, now, target);
      h.startOffset = target;
      h.startCtxTime = now;
      h.wallTime = performance.now();
      // Reinicia el estado del phase-vocoder (nuevo contenido, fase distinta).
      if (h.keylockEnabled && h.keylockNode) {
        h.keylockNode.port.postMessage({ type: "reset" });
      }
    } else {
      h.pausedAt = target;
    }
    this.servoRetune(name);
  }

  stopAll(): void {
    this.pause("A");
    this.pause("B");
  }

  // ── Pitch / rate ─────────────────────────────────────────────────────────

  /** Fija el playbackRate (y el factor de key lock 1/rate) con rampa suave. */
  setRate(name: "A" | "B", target: number, smooth = true): void {
    const h = this.deck(name);
    if (!h) return;
    const rate = clamp(target, 0.25, 4);
    if (h.playing) this.rebase(h);
    h.rate = rate;
    if (h.source && this.ctx) {
      const now = this.ctx.currentTime;
      const pr = h.source.playbackRate;
      pr.cancelScheduledValues(now);
      if (smooth) pr.setTargetAtTime(rate, now, RATE_TAU);
      else pr.setValueAtTime(rate, now);
    }
    if (h.keylockEnabled && h.keylockNode && this.ctx) {
      const now = this.ctx.currentTime;
      const kr = h.keylockNode.parameters.get("rate");
      if (kr) {
        kr.cancelScheduledValues(now);
        if (smooth) kr.setTargetAtTime(1 / rate, now, RATE_TAU);
        else kr.setValueAtTime(1 / rate, now);
      }
    }
  }

  setPitch(name: "A" | "B", pct: number): void {
    const h = this.deck(name);
    if (!h) return;
    if (h.synced) this.clearSync(name);
    h.pitch = clamp(pct, -h.range, h.range);
    this.applyManualRate(name);
    this.recommitFollowersOf(name);
  }

  private applyManualRate(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || h.synced || h.jogging) return;
    this.setRate(name, clamp(1 + h.pitch / 100, 0.5, 2), true);
  }

  getPitch(name: "A" | "B"): number {
    return this.deck(name)?.pitch ?? 0;
  }

  getPitchRange(name: "A" | "B"): number {
    return this.deck(name)?.range ?? DEFAULT_PITCH_RANGE;
  }

  getEffectiveBpm(name: "A" | "B"): number {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return 0;
    return h.originalBpm * h.rate;
  }

  isSynced(name: "A" | "B"): boolean {
    return this.deck(name)?.synced ?? false;
  }

  getSyncState(
    name: "A" | "B",
  ): { isSynced: boolean; role: "master" | "follower" | null; masterDeck: "A" | "B" | null } {
    const h = this.deck(name);
    return {
      isSynced: h?.synced ?? false,
      role: h?.syncRole ?? null,
      masterDeck: h?.masterName ?? null,
    };
  }

  // ── Key lock (phase-vocoder) ─────────────────────────────────────────────

  private createKeylockNode(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !this.ctx || h.keylockNode) return;
    const node = new AudioWorkletNode(this.ctx, "phase-vocoder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 2,
      channelCountMode: "explicit",
      outputChannelCount: [2],
    });
    node.parameters.get("rate")?.setValueAtTime(1 / (h.rate || 1), this.ctx.currentTime);
    node.connect(h.analyser);
    h.keylockNode = node;
  }

  /** Conecta el source a través del vocoder (on) o directo al analizador (off). */
  private applyKeylockRoute(name: "A" | "B", enabled: boolean): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    if (h.source) {
      try {
        h.source.disconnect();
      } catch {
        /* ok */
      }
      if (enabled && h.keylockNode) h.source.connect(h.keylockNode);
      else h.source.connect(h.analyser);
    }
  }

  setKeyLock(name: "A" | "B", enabled: boolean): void {
    const h = this.deck(name);
    if (!h) return;
    h.keylockEnabled = enabled;
    if (enabled && !h.keylockNode) {
      void this.ensureWorklet().then(() => {
        this.createKeylockNode(name);
        this.applyKeylockRoute(name, true);
      });
      return;
    }
    this.applyKeylockRoute(name, enabled);
  }

  // ── SYNC ─────────────────────────────────────────────────────────────────

  private phaseShift(name: "A" | "B", masterName: "A" | "B"): number {
    const slave = this.deck(name);
    const master = this.deck(masterName);
    if (!slave || !master || slave === master) return 0;
    if (!slave.originalBpm || !master.originalBpm) return 0;
    return hardAlignShift(
      this.deckPosition(master),
      master.originalBpm,
      master.gridOff,
      this.deckPosition(slave),
      slave.originalBpm,
      slave.gridOff,
    );
  }

  alignPhase(name: "A" | "B", masterName: "A" | "B"): number {
    const h = this.deck(name);
    if (!h) return 0;
    const shift = this.phaseShift(name, masterName);
    if (Math.abs(shift) < 0.0005) return 0;
    this.seek(name, this.deckPosition(h) + shift);
    return shift;
  }

  alignToMasterOnce(name: "A" | "B", masterName: "A" | "B"): number {
    const slave = this.deck(name);
    const master = this.deck(masterName);
    if (!slave || !master || slave === master) return 0;
    if (!slave.originalBpm || !master.originalBpm) return 0;
    return this.alignPhase(name, masterName);
  }

  syncTo(name: "A" | "B", masterName: "A" | "B"): boolean {
    const slave = this.deck(name);
    const master = this.deck(masterName);
    if (!slave || !master || slave === master) return false;
    if (!slave.originalBpm || !master.originalBpm) return false;

    if (master.synced && master.masterName === name) {
      this.clearSync(masterName);
    }
    if (master.syncRole === "follower") {
      this.clearSync(masterName);
    }
    master.syncRole = "master";
    master.masterName = null;

    const masterBpm = this.getEffectiveBpm(masterName) || master.originalBpm;
    const targetRate = syncPlaybackRate(masterBpm, slave.originalBpm);
    slave.pitch = (targetRate - 1) * 100;
    slave.synced = true;
    slave.syncRole = "follower";
    slave.masterName = masterName;
    this.servo[name].bias = 0;

    this.commitSync(name);
    return true;
  }

  private syncTargetRate(h: DeckHandle): number {
    if (!h.synced || !h.masterName) return clamp(1 + h.pitch / 100, 0.5, 2);
    const master = this.deck(h.masterName);
    const masterBpm = this.getEffectiveBpm(h.masterName) || master?.originalBpm || 0;
    if (!masterBpm || !h.originalBpm) return h.rate;
    return syncPlaybackRate(masterBpm, h.originalBpm);
  }

  private commitSync(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !h.synced || !h.masterName) return;
    const master = this.deck(h.masterName);
    if (!master) return;
    const targetRate = this.syncTargetRate(h);
    // Tempo: rampa suave al rate base (1:1 exacto). El tempo SIEMPRE se copia,
    // suene o no el otro deck.
    this.setRate(name, targetRate, true);
    // Fase: solo se alinea si AMBOS decks están reproduciendo. Si el otro deck
    // está pausado/detenido, el SYNC únicamente copia el BPM/pitch y deja el
    // audio correr normal sin seeks (la fase se corregirá cuando ambos suenen).
    const period = 60 / h.originalBpm;
    const shift = this.phaseShift(name, h.masterName);
    const bothPlaying = h.playing && master.playing;
    const needSnap =
      bothPlaying &&
      Number.isFinite(period) &&
      period > 0 &&
      Math.abs(shift) > SERVO_SNAP_BEATS * period;
    if (needSnap) this.snapPhaseToMaster(name);
    this.servoRetune(name);
    this.servoRetune(h.masterName);
    this.ensureServo();
  }

  private snapPhaseToMaster(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !h.synced || !h.masterName || !h.buffer) return;
    const shift = this.phaseShift(name, h.masterName);
    if (Math.abs(shift) < 0.0001) return;
    this.seek(name, this.deckPosition(h) + shift);
  }

  clearSync(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    const wasMaster = h.syncRole === "master";
    const masterRef = h.masterName;
    h.synced = false;
    h.syncRole = null;
    h.masterName = null;
    if (wasMaster) {
      const other = name === "A" ? "B" : "A";
      const otherDeck = this.deck(other);
      if (otherDeck && otherDeck.synced && otherDeck.masterName === name) {
        otherDeck.synced = false;
        otherDeck.syncRole = null;
        otherDeck.masterName = null;
        this.servo[other].bias = 0;
        this.servoRetune(other);
      }
    } else if (masterRef) {
      const m = this.deck(masterRef);
      if (m && m.syncRole === "master" && !m.synced) {
        m.syncRole = null;
      }
    }
    this.servo[name].bias = 0;
    this.servoRetune(name);
    this.stopServoIfIdle();
    if (!h.playing) {
      h.pitch = 0;
      this.setRate(name, 1, true);
      return;
    }
    this.setRate(name, clamp(1 + h.pitch / 100, 0.5, 2), true);
  }

  private recommitFollowersOf(masterName: "A" | "B"): void {
    for (const [n, h] of [["A", this.deckA], ["B", this.deckB]] as const) {
      if (!h || h.synced !== true || h.masterName !== masterName) continue;
      this.commitSync(n);
    }
  }

  // ── Servo de fase (Master Audio Clock) ───────────────────────────────────

  private servoRetune(name: "A" | "B"): void {
    /* con ABSS la posición sale del reloj ctx (sin deriva): solo re-ancla el
     * bias integral si el deck dejó de existir. */
    const h = this.deck(name);
    if (!h) this.servo[name].bias = 0;
  }

  /** Limpia los buffers de corrección de fase (bias integral) de ambos decks.
   *  Se invoca al PAUSE/CUE de cualquier deck: el deck que sigue reproduciendo
   *  congela la corrección de fase de inmediato (mantiene el tempo emparejado
   *  pero ignora la posición del deck detenido, sin entrar en re-sync). */
  private resetPhaseLock(): void {
    this.servo.A.bias = 0;
    this.servo.B.bias = 0;
    this.servoRetune("A");
    this.servoRetune("B");
  }

  private ensureServo(): void {
    if (this.servoTimer !== null) return;
    if (!this.deckA?.synced && !this.deckB?.synced) return;
    this.servoTimer = setInterval(() => this.servoTick(), SERVO_INTERVAL_MS);
  }

  private stopServoIfIdle(): void {
    if (this.servoTimer === null) return;
    if (this.deckA?.synced || this.deckB?.synced) return;
    clearInterval(this.servoTimer);
    this.servoTimer = null;
  }

  private servoTick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.deckA?.synced && !this.deckB?.synced) {
      this.stopServoIfIdle();
      return;
    }
    // Regla estricta: solo corregir FASE si AMBOS decks están reproduciendo.
    // Si uno está pausado/detenido, se congela la corrección de fase de
    // inmediato (se mantiene el tempo emparejado, pero se ignora la posición
    // del deck parado para no entrar en el bucle de re-sync).
    if (!(this.deckA?.playing && this.deckB?.playing)) return;
    for (const n of ["A", "B"] as const) {
      const h = this.deck(n);
      if (!h || !h.synced || !h.masterName) continue;
      const master = this.deck(h.masterName);
      if (!master || master === h) continue;
      if (!h.originalBpm || !master.originalBpm) continue;
      if (master.synced) continue;
      if (!h.playing) continue;
      if (h.jogging || h.loop) continue;

      const err = this.phaseShift(n, h.masterName);
      const period = 60 / h.originalBpm;

      if (Math.abs(err) > SERVO_SNAP_BEATS * period) {
        this.snapPhaseToMaster(n);
        this.servo[n].bias = 0;
        continue;
      }

      // Corrección PI suave (sin seeks): el trim de tasa converge la fase a
      // 0 ms; el bias sostiene el lock contra el residuo mínimo de redondeo.
      const p = err / SERVO_CONVERGE_S;
      const s = this.servo[n];
      const dt = SERVO_INTERVAL_MS / 1000;
      s.bias = clamp(s.bias + err * SERVO_I_GAIN * dt, -SERVO_MAX_TRIM, SERVO_MAX_TRIM);
      const trim = clamp(p + s.bias, -SERVO_MAX_TRIM, SERVO_MAX_TRIM);
      const baseRate = this.syncTargetRate(h);
      const target = clamp(baseRate * (1 + trim), 0.5, 2);
      if (Math.abs(target - h.rate) > 1e-5) {
        this.setRate(n, target, true);
      }
    }
  }

  // ── Loops / Beat Jump / Loop Roll (Slip) ─────────────────────────────────

  private gridBeatStart(h: DeckHandle, t: number): number {
    const period = 60 / h.originalBpm;
    let k = Math.round((t - h.gridOff) / period);
    let start = h.gridOff + k * period;
    if (start > t) {
      k -= 1;
      start = h.gridOff + k * period;
    }
    return Math.max(0, start);
  }

  setLoop(name: "A" | "B", start: number, end: number, beats: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm || !h.buffer) return null;
    const dur = h.buffer.duration;
    const s = clamp(start, 0, Math.max(0, dur - 0.05));
    const e = clamp(end, s + 0.05, dur);
    if (e <= s) return null;
    const raw = this.rawPosition(h);
    h.loop = { start: s, end: e, beats, roll: false, rollBase: 0, rollStartCtx: 0 };
    this.applyLoopToSource(h);
    // Re-anclar dentro del loop si el source quedó fuera del rango.
    if (h.playing && (raw < s || raw >= e)) {
      this.seek(name, this.loopWrap(h, raw));
    }
    return h.loop;
  }

  setLoopManual(name: "A" | "B", start: number, end: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const period = 60 / h.originalBpm;
    const beats = Math.max(0.125, Math.round((end - start) / period));
    return this.setLoop(name, start, end, beats);
  }

  setAutoLoop(name: "A" | "B", beats: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const period = 60 / h.originalBpm;
    const t = this.deckPosition(h);
    const start = this.gridBeatStart(h, t);
    const end = start + beats * period;
    return this.setLoop(name, start, end, beats);
  }

  setLoopIn(name: "A" | "B"): number | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const t = this.deckPosition(h);
    const point = this.gridBeatStart(h, t);
    h.loopInPending = point;
    return point;
  }

  setLoopOut(name: "A" | "B"): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm || h.loopInPending === null) return null;
    const period = 60 / h.originalBpm;
    const t = this.deckPosition(h);
    const out = this.gridBeatStart(h, t) + period;
    const start = h.loopInPending;
    if (out - start < 0.25 * period) return null;
    const beats = (out - start) / period;
    h.loopInPending = null;
    return this.setLoop(name, start, out, beats);
  }

  startLoopRoll(name: "A" | "B", beats: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const period = 60 / h.originalBpm;
    const t = this.deckPosition(h);
    const start = this.gridBeatStart(h, t);
    const end = start + beats * period;
    const dur = h.buffer ? h.buffer.duration : Number.MAX_SAFE_INTEGER;
    const s = clamp(start, 0, Math.max(0, dur - 0.05));
    const e = clamp(end, s + 0.05, dur);
    if (e <= s) return null;
    const raw = this.rawPosition(h);
    h.loop = { start: s, end: e, beats, roll: true, rollBase: t, rollStartCtx: this.ctx ? this.ctx.currentTime : 0 };
    this.applyLoopToSource(h);
    if (h.playing && (raw < s || raw >= e)) {
      this.seek(name, this.loopWrap(h, raw));
    }
    return h.loop;
  }

  exitLoop(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    const loop = h.loop;
    h.loop = null;
    if (h.source) h.source.loop = false;
    if (loop && loop.roll && this.ctx) {
      const elapsed = this.ctx.currentTime - loop.rollStartCtx;
      const virtual = loop.rollBase + elapsed * h.rate;
      this.seek(name, virtual);
    }
    this.servoRetune(name);
  }

  getLoop(name: "A" | "B"): LoopInfo | null {
    return this.deck(name)?.loop ?? null;
  }

  isLoopActive(name: "A" | "B"): boolean {
    return this.deck(name)?.loop != null;
  }

  beatJump(name: "A" | "B", beats: number): void {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return;
    const period = 60 / h.originalBpm;
    const dur = h.buffer ? h.buffer.duration : Number.MAX_SAFE_INTEGER;
    this.seek(name, clamp(this.deckPosition(h) + beats * period, 0, dur));
  }

  // ── Jog / scratch ────────────────────────────────────────────────────────

  beginJog(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    h.jogging = true;
  }

  setJogRate(name: "A" | "B", rate: number): void {
    const h = this.deck(name);
    if (!h) return;
    const r = clamp(rate, 0.1, 4);
    this.setRate(name, r, false);
  }

  scratchSeek(name: "A" | "B", deltaSec: number): void {
    const h = this.deck(name);
    if (!h) return;
    this.seek(name, this.deckPosition(h) + deltaSec);
  }

  endJog(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    h.jogging = false;
    if (h.synced && h.masterName) {
      const master = this.deck(h.masterName);
      if (master) {
        const masterBpm = this.getEffectiveBpm(h.masterName) || master.originalBpm;
        this.setRate(name, syncPlaybackRate(masterBpm, h.originalBpm), true);
        this.servoRetune(name);
        return;
      }
    }
    this.applyManualRate(name);
    this.servoRetune(name);
  }

  // ── Mixer: crossfader / master ───────────────────────────────────────────

  setCrossfader(position: number): void {
    this.crossfader = clamp(position, 0, 1);
    const t = clamp(this.crossfader / CROSSFADE_CUTOFF, 0, 1);
    const angle = (t * Math.PI) / 2;
    const now = this.ctx ? this.ctx.currentTime : 0;
    this.deckA?.cross.gain.setTargetAtTime(Math.cos(angle), now, 0.012);
    this.deckB?.cross.gain.setTargetAtTime(Math.sin(angle), now, 0.012);
  }

  getCrossfader(): number {
    return this.crossfader;
  }

  setMasterGain(v: number): void {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(clamp(v, 0, 1.4), this.ctx.currentTime, 0.012);
  }

  setMasterEq(band: 0 | 1 | 2, db: number): void {
    if (!this.masterEq || !this.ctx) return;
    const clamped = clamp(db, EQ_MIN_DB, EQ_MAX_DB);
    this.masterEq[band].gain.setTargetAtTime(db <= EQ_MIN_DB ? -60 : clamped, this.ctx.currentTime, 0.01);
  }

  setMasterFilter(v: number): void {
    if (!this.masterFilterLP || !this.masterFilterHP || !this.ctx) return;
    const t = this.ctx.currentTime;
    const value = clamp(v, -1, 1);
    if (value < -0.001) {
      const k = Math.abs(value);
      this.masterFilterLP.frequency.setTargetAtTime(22000 * Math.pow(200 / 22000, k), t, 0.015);
      this.masterFilterHP.frequency.setTargetAtTime(20, t, 0.015);
    } else if (value > 0.001) {
      this.masterFilterHP.frequency.setTargetAtTime(20 * Math.pow(9000 / 20, value), t, 0.015);
      this.masterFilterLP.frequency.setTargetAtTime(22000, t, 0.015);
    } else {
      this.masterFilterLP.frequency.setTargetAtTime(22000, t, 0.015);
      this.masterFilterHP.frequency.setTargetAtTime(20, t, 0.015);
    }
  }

  // ── Headphones / CUE (PFL) ───────────────────────────────────────────────

  setCueActive(name: "A" | "B", active: boolean): void {
    const h = this.deck(name);
    if (!h) return;
    h.cueActive = active;
    const now = this.ctx ? this.ctx.currentTime : 0;
    h.cue.gain.setTargetAtTime(active ? 1 : 0, now, 0.01);
  }

  setHeadphoneLevel(v: number): void {
    this.headphoneLevel = clamp(v, 0, 1);
    this.applyHeadphoneGains(this.ctx ? this.ctx.currentTime : 0);
  }

  setHeadphoneMix(v: number): void {
    this.headphoneMix = clamp(v, 0, 1);
    this.applyHeadphoneGains(this.ctx ? this.ctx.currentTime : 0);
  }

  setSplitMode(enabled: boolean): void {
    if (!this.hpMixBus || !this.hpMerger || !this.hpLevelGain) return;
    this.splitMode = enabled;
    const now = this.ctx ? this.ctx.currentTime : 0;
    if (enabled) {
      if (this.hpMixConnected) {
        try {
          this.hpMixBus.disconnect(this.hpLevelGain);
        } catch {
          /* ya desconectado */
        }
        this.hpMixConnected = false;
      }
      this.hpMerger.connect(this.hpLevelGain);
    } else {
      try {
        this.hpMerger.disconnect(this.hpLevelGain);
      } catch {
        /* ya desconectado */
      }
      if (!this.hpMixConnected) {
        this.hpMixBus.connect(this.hpLevelGain);
        this.hpMixConnected = true;
      }
    }
    this.applyHeadphoneGains(now);
  }

  private applyHeadphoneGains(now: number): void {
    if (!this.hpMasterGain || !this.hpCueGain || !this.hpLevelGain) return;
    const level = this.headphoneLevel;
    if (this.splitMode) {
      this.hpMasterGain.gain.setTargetAtTime(0, now, 0.01);
      this.hpCueGain.gain.setTargetAtTime(0, now, 0.01);
      this.hpLevelGain.gain.setTargetAtTime(level, now, 0.01);
    } else {
      this.hpMasterGain.gain.setTargetAtTime(this.headphoneMix, now, 0.01);
      this.hpCueGain.gain.setTargetAtTime(1 - this.headphoneMix, now, 0.01);
      this.hpLevelGain.gain.setTargetAtTime(level, now, 0.01);
    }
  }

  // ── Mixer: canal (gain / EQ / fader / filter / FX) ───────────────────────

  setGain(name: "A" | "B", gain: number): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    h.trim.gain.setTargetAtTime(clamp(gain, 0, 2), this.ctx.currentTime, 0.012);
  }

  setEq(name: "A" | "B", band: EqBand, db: number): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    const node = band === 0 ? h.eqLow : band === 1 ? h.eqMid : h.eqHi;
    const clamped = clamp(db, EQ_MIN_DB, EQ_MAX_DB);
    h.eq[band] = clamped;
    const value = db <= EQ_MIN_DB ? EQ_KILL_DB : clamped;
    node.gain.setTargetAtTime(value, this.ctx.currentTime, 0.008);
  }

  setChannelFader(name: "A" | "B", v: number): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    h.fader.gain.setTargetAtTime(clamp(v, 0, 1), this.ctx.currentTime, 0.012);
  }

  setLowKill(name: "A" | "B", on: boolean): void {
    const f = this.deck(name)?.lowKill;
    if (!f) return;
    const t = this.ctx ? this.ctx.currentTime : 0;
    f.frequency.setTargetAtTime(on ? 110 : 20, t, 0.004);
  }

  setFilter(name: "A" | "B", v: number): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    const t = this.ctx.currentTime;
    const value = clamp(v, -1, 1);
    if (value < -0.001) {
      const k = Math.abs(value);
      h.filterLP.frequency.setTargetAtTime(22000 * Math.pow(200 / 22000, k), t, 0.015);
      h.filterHP.frequency.setTargetAtTime(20, t, 0.015);
    } else if (value > 0.001) {
      h.filterHP.frequency.setTargetAtTime(20 * Math.pow(9000 / 20, value), t, 0.015);
      h.filterLP.frequency.setTargetAtTime(22000, t, 0.015);
    } else {
      h.filterLP.frequency.setTargetAtTime(22000, t, 0.015);
      h.filterHP.frequency.setTargetAtTime(20, t, 0.015);
    }
  }

  setDeckFx(name: "A" | "B", fxId: string, amount: number, active: boolean): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    const t = this.ctx.currentTime;
    const a = clamp(amount, 0, 1);
    if (fxId === "dly" || fxId === "echo") {
      h.dlyWet.gain.setTargetAtTime(active ? a * 0.7 : 0, t, 0.02);
      h.dlyFb.gain.setTargetAtTime(active ? 0.2 + a * 0.4 : 0, t, 0.03);
    } else if (fxId === "pha") {
      h.phaWet.gain.setTargetAtTime(active ? a * 0.8 : 0, t, 0.02);
    }
  }

  resetDeckFx(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !this.ctx) return;
    const t = this.ctx.currentTime;
    h.dlyWet.gain.setTargetAtTime(0, t, 0.02);
    h.phaWet.gain.setTargetAtTime(0, t, 0.02);
  }

  // ── Meting (VU) ──────────────────────────────────────────────────────────

  private rms(an: AnalyserNode | null): number {
    if (!an) return 0;
    an.getFloatTimeDomainData(this.meterBuf);
    let sum = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const s = this.meterBuf[i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / this.meterBuf.length);
    return Math.min(1, rms * 2.8);
  }

  getLevel(name: "A" | "B"): number {
    return this.rms(this.deck(name)?.vu ?? null);
  }

  getMasterLevel(): number {
    return this.rms(this.masterAnalyser);
  }

  // ── Track meta ───────────────────────────────────────────────────────────

  setDeckMeta(name: "A" | "B", meta: { originalBpm?: number; gridOff?: number }): void {
    const h = this.deck(name);
    if (!h) return;
    const bpmChanged = meta.originalBpm !== undefined && meta.originalBpm > 0 && meta.originalBpm !== h.originalBpm;
    const gridChanged = meta.gridOff !== undefined && meta.gridOff !== h.gridOff;
    if (meta.originalBpm !== undefined) h.originalBpm = meta.originalBpm > 0 ? meta.originalBpm : 0;
    if (meta.gridOff !== undefined) h.gridOff = meta.gridOff;
    if (bpmChanged || gridChanged) {
      this.servo[name].bias = 0;
      this.servoRetune(name);
    }
  }

  // ── Grabación (REC) del bus master ───────────────────────────────────────

  get isRecording(): boolean {
    return this.recording;
  }

  toggleRecording(): boolean {
    if (this.recording) {
      this.recorder?.stop();
      return false;
    }
    try {
      const ctx = this.ensureContext();
      if (!this.recDest) {
        this.recDest = ctx.createMediaStreamDestination();
        this.master?.connect(this.recDest);
      }
      const recorder = new MediaRecorder(this.recDest.stream);
      this.recChunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size) this.recChunks.push(e.data);
      };
      recorder.onstop = () => {
        this.recording = false;
        if (this.recChunks.length) {
          const blob = new Blob(this.recChunks, { type: "audio/webm" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `smart-set-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.webm`;
          a.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
      };
      recorder.start();
      this.recorder = recorder;
      this.recording = true;
      return true;
    } catch (err) {
      console.warn("[audio] grabación no disponible", err);
      this.recording = false;
      return false;
    }
  }
}

export const audioEngine = new AudioEngine();
