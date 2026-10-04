/**
 * Motor de audio de la consola DJ nativa (Decks A/B + Mixer estilo MIXI).
 *
 * Cadena por deck:
 *   source → analyser → TRIM(gain) → EQ LOW → EQ MID → EQ HIGH → LowKill
 *          → FILTER (Color FX) → PHASE → CUE GAIN → CUE BUS  (Pre-Fader Listen)
 *          → FX (dry/wet) → FADER → [VU] → CROSS → MASTER → destination
 *
 * Pre-Fader Listen (PFL / Cue):
 *   El nodo CUE GAIN de cada canal se conecta ANTES del fader de canal y del
 *   crossfader, directamente al CUE BUS. De este modo, pulsar CUE en un canal
 *   envía la señal de monitoreo a los auriculares independientemente de la
 *   posición del fader o del crossfader (estándar Traktor/Rekordbox).
 *   El bus de auriculares se mezcla con el master mediante los controles de
 *   LEVEL / MIX / SPLIT del panel de headphones.
 *
 * Controles:
 *   · PLAY/PAUSE/CUE     → transporte del <audio>.
 *   · PITCH/TEMPO        → playbackRate = 1 + pitch/100 (keylock por preservesPitch).
 *   · SYNC               → un solo disparo: rate = targetBPM / trackBPM + fase.
 *   · GAIN / EQ 3 bandas → nodos Web Audio (trim + Biquads).
 *   · FADER / CROSSFADER → gains.
 *   · JOG/SCRATCH        → bend de playbackRate o seek (según play/pause).
 *
 * El SYNC es de estándar profesional (Master Audio Clock + Phase Lock
 * continuo, al nivel de Traktor/Rekordbox — CERO deriva acumulativa):
 *   · Master Audio Clock: AudioContext.currentTime es el ÚNICO reloj maestro
 *     (avanza exactamente con las muestras que consume el hardware:
 *     t = muestras / sampleRate). NINGÚN cálculo de tempo/fase usa relojes
 *     wall-clock ni acumuladores del tipo "segundos × BPM/60": la fase
 *     siempre se mide como posición de deck vs posición de deck sobre el
 *     reloj maestro, sin sumas que arrastra el redondeo flotante.
 *   · Tempo:  rate base = BPM efectivo del maestro / BPM original del
 *     esclavo, SIEMPRE 1:1 (sin ratios armónicos), como antes.
 *   · Fase (enganche): Hard Snap único cuantizado — la aguja del esclavo
 *     cae EXACTO sobre el marcador de beat más cercano de la rejilla del
 *     maestro (hardAlignShift), con latencia relativa nula (DelayNode
 *     estático a PHASE_BASE en ambos decks).
 *   · Fase (mantenida): servo PI continuo (servoTick, cada 200 ms). Los dos
 *     decoders <audio> avanzan a tasas REALES ligeramente distintas
 *     (pipeline de decodificación propio por elemento, estiramiento
 *     preservesPitch/keylock, buffering): escribir playbackRate una sola
 *     vez y confiar produce deriva progresiva (~0.1-0.3% de error de tasa
 *     ⇒ decenas de ms por minuto). El servo mide la tasa REALIZADA de cada
 *     deck (Δposición / Δctx.currentTime) y el error de fase exacto contra
 *     la rejilla del maestro, y recorta el rate del esclavo (±0.15% en
 *     zona de lock, inaudible; ±1.2% convergiendo; keylock activo ⇒ puro
 *     tempo, el tono no salta) hasta clavar la fase en 0 ms para siempre:
 *     sin micro-saltos ni seeks audibles. Solo si la desviación crece
 *     más de ~medio beat (seek manual, estancamiento) se re-engecha con
 *     un Hard Snap rígido.
 *
 * Estabilidad: el AudioContext se vigila (statechange): interrupciones del
 * driver se reanudan solas y una pérdida total (state "closed") reconstruye
 * todo el grafo sobre elementos <audio> nuevos sin congelar la UI ni perder
 * la posición (el reloj de cada <audio> es independiente del contexto).
 */

import { hardAlignShift, syncPlaybackRate } from "./mixi";

export type EqBand = 0 | 1 | 2; // 0 = LOW, 1 = MID, 2 = HIGH

export interface DeckHandle {
  el: HTMLAudioElement;
  analyser: AnalyserNode; // waveform (pre-fader)
  trim: GainNode; // GAIN
  eqLow: BiquadFilterNode;
  eqMid: BiquadFilterNode;
  eqHi: BiquadFilterNode;
  lowKill: BiquadFilterNode; // FILTER (pasa-altos)
  fader: GainNode; // canal
  vu: AnalyserNode; // metering post-fader
  cross: GainNode; // crossfader
  /** Nodo de ganancia PFL (Pre-Fader Listen) — antes del fader de canal. */
  cue: GainNode;
  /** Estado del botón CUE de este canal. */
  cueActive: boolean;
  pitch: number;
  range: number;
  synced: boolean;
  /** Role of this deck within a synced pair. */
  syncRole: "master" | "follower" | null;
  originalBpm: number;
  gridOff: number;
  masterName: "A" | "B" | null;
  jogging: boolean;
  eq: [number, number, number]; // dB (-26..+6; -30 = kill)
  /** Blob URL vigente del deck (se revoca al reemplazar la fuente). */
  objectUrl: string | null;
  /** Filtro bimodal: LP (izquierda) + HP (derecha) en serie; neutro en el centro. */
  filterLP: BiquadFilterNode;
  filterHP: BiquadFilterNode;
  /** FX: Delay (send paralelo) + Phaser (allpass + LFO). */
  dly: DelayNode;
  dlyFb: GainNode;
  dlyWet: GainNode;
  phaWet: GainNode;
  /** Envelope de loop: micro-fade 3-5 ms en los bordes del loop para
   *  eliminar clicks y hacer el fold imperceptible. */
  loopEnv: GainNode;
  /** DelayNode ESTÁTICO (nunca se modula): retardo de reposo PHASE_BASE,
   *  idéntico en ambos decks → latencia relativa SIEMPRE nula. El SYNC es
   *  Hard Lock (un solo seek), sin correcciones de fase dinámicas. */
  phase: DelayNode;
  /** Objetivo estático del alineador (s) = PHASE_BASE, sin correcciones. */
  phaseDelayTarget: number;
  /** Loop activo (Auto Loop / Manual / Roll), cuantizado a la grilla.
   *  roll = Loop Roll con Slip: el audio buclea mientras el tiempo REAL
   *  virtual avanza (rollBase + wall-clock × rate) y se retoma al soltar. */
  loop: LoopInfo | null;
  /** Punto LOOP IN pendiente (sin loop aún): se arma al presionar LOOP OUT. */
  loopInPending: number | null;
  /** Estado del micro-crossfade del loop ('idle' cuando no hay fade activo). */
  loopFadeState: "idle" | "fade-out" | "fade-in";
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
  /** wall-clock (performance.now) de entrada al roll. */
  rollStartWall: number;
}

export const CROSSFADE_CUTOFF = 0.8;
export const DEFAULT_PITCH_RANGE = 8;
export const EQ_MIN_DB = -26;
export const EQ_MAX_DB = 6;
const EQ_KILL_DB = -60;

/** Retardo de reposo del alineador (s): idéntico en ambos decks, de modo que
 *  la latencia relativa entre ellos es SIEMPRE nula. Estático: no se rampea. */
const PHASE_BASE = 0.05;

/** Duración del micro-crossfade de loop (s): la caída y la subida de la
 *  costura. 4 ms (rango 3-5 ms) borra el click por discontinuidad de fase de
 *  la onda justo en la muestra de retorno sin ser audible como ducking. */
const LOOP_CROSSFADE_S = 0.004;
/** Ventana de ANTICIPACIÓN del pre-fade (s): con cuánta antelación (máx.)
 *  se programa la rampa al borde. El fade AUDIBLE es solo el tramo final de
 *  LOOP_CROSSFADE_S; la ventana solo garantiza que al menos un frame del rAF
 *  (16-33 ms) aterrice ANTES del fold. Se adapta a loops cortos (nunca
 *  excede 1/4 de la longitud del loop). */
const LOOP_FADE_WIN_S = 0.05;
/** Máximo retardo del DelayNode (s): solo margen de construcción del grafo. */
const PHASE_MAX_DELAY = 0.1;

/** ── Master Audio Clock / Phase Servo (SYNC profesional) ──────────────────
 *  El reloj maestro es AudioContext.currentTime. El servo mide la deriva de
 *  fase del esclavo contra la rejilla del maestro, pero NO aplica trimming
 *  continuo de playbackRate: ese pitch-bending gradual genera distorsión.
 *  Solo realiza un re-enganche rígido (Hard Snap) cuando la deriva supera
 *  ~medio beat. */
const SERVO_INTERVAL_MS = 200;
/** Desviación (s) respecto a la posición esperada que delata un seek/estancamiento
 *  y obliga a re-abrir la ventana de medición. */
const SERVO_SEEK_DETECT = 0.25;
/** Deriva (en beats) que dispara el re-enganche rígido (Hard Snap). */
const SERVO_SNAP_BEATS = 0.4;

/** Ventana de medición de un deck para el servo de fase. */
interface ServoState {
  /** Último AudioContext.currentTime (reloj maestro) medido. */
  ctxTime: number;
  /** Último el.currentTime (posición del decoder) medido. */
  deckTime: number;
  /** Último el.playbackRate observado al medir. */
  rate: number;
  /** Duración (s, reloj maestro) de la última ventana válida. */
  lastDt: number;
  /** Término integral: corrección estacionaria de tasa aprendida. */
  bias: number;
  /** Ventana inicializada (hay una medición base válida). */
  init: boolean;
}

function freshServo(): ServoState {
  return { ctxTime: 0, deckTime: 0, rate: 1, lastDt: 0, bias: 0, init: false };
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
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
  /** Crossfader neutro por defecto: al centro (0.5), ambos decks al 50%. */
  private crossfader = 0.5;
  private boundElements = new WeakSet<HTMLAudioElement>();
  private recDest: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private recChunks: Blob[] = [];
  private recording = false;
  /** rAF del vigilante de loops: solo vive mientras HAY un loop activo
   *  (cero timers de por medio cuando no se usa ningún loop/roll). */
  private loopRaf: number | null = null;
  /** Timer del servo de fase (Master Audio Clock): bucle de corrección
   *  continua del SYNC. Solo vive mientras algún deck está sincronizado. */
  private servoTimer: ReturnType<typeof setInterval> | null = null;
  /** Ventana de medición por deck para el servo (reloj maestro vs reloj
   *  del decoder de cada <audio>). */
  private servo: Record<"A" | "B", ServoState> = { A: freshServo(), B: freshServo() };

  ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      this.ctx = ctx;
      ctx.onstatechange = () => this.handleCtxState();
      this.buildMasterChain(ctx);
      // Reconstrucción tras una pérdida total (state "closed"): los decks se
      // re-enganchan al grafo nuevo con elementos <audio> nuevos, conservando
      // posición, tempo y SYNC (el reloj de cada <audio> es independiente).
      if (this.deckA || this.deckB) {
        for (const n of ["A", "B"] as const) this.rebindDeckAfterCtxLoss(n);
        // Re-aplicar el crossfader (los gains de los nodos nuevos nacen en
        // neutro; la posición guardada se restaura aquí).
        this.setCrossfader(this.crossfader);
        // Re-aplicar el estado de auriculares tras reconstruir el grafo.
        this.setSplitMode(this.splitMode);
      }
    }
    if (this.ctx.state === "suspended") {
      void this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
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

    // Master principal: siempre a destination (main out).
    this.master
      .connect(this.masterEq[0])
      .connect(this.masterEq[1])
      .connect(this.masterEq[2])
      .connect(this.masterFilterLP)
      .connect(this.masterFilterHP)
      .connect(this.masterAnalyser)
      .connect(ctx.destination);

    // Bus de CUE/PFL (Pre-Fader Listen): suma de las señales pre-fader de cada deck.
    this.cueBus = ctx.createGain();
    this.cueBus.gain.value = 1;

    // Mezcla de auriculares: master + cue, con controles de LEVEL / MIX / SPLIT.
    this.hpMasterGain = ctx.createGain();
    this.hpMasterGain.gain.value = this.headphoneMix;
    this.hpCueGain = ctx.createGain();
    this.hpCueGain.gain.value = 1 - this.headphoneMix;
    this.hpMixBus = ctx.createGain();
    this.hpMixBus.gain.value = 1;
    this.hpLevelGain = ctx.createGain();
    this.hpLevelGain.gain.value = this.headphoneLevel;
    this.hpMerger = ctx.createChannelMerger(2);

    // Ruta normal: master y cue se mezclan estéreo.
    this.masterFilterHP.connect(this.hpMasterGain);
    this.cueBus.connect(this.hpCueGain);
    this.hpMasterGain.connect(this.hpMixBus);
    this.hpCueGain.connect(this.hpMixBus);
    this.hpMixBus.connect(this.hpLevelGain);
    this.hpLevelGain.connect(ctx.destination);

    // Ruta split (L = CUE, R = MASTER): se conecta/desconecta dinámicamente.
    this.cueBus.connect(this.hpMerger, 0, 0);
    this.masterFilterHP.connect(this.hpMerger, 0, 1);
  }

  /** Reintentos pendientes de resume() tras una interrupción del driver. */
  private ctxResumeAttempts = 0;

  /** Vigilante del ciclo de vida del AudioContext (crashes e interrupciones). */
  private handleCtxState(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "closed") {
      // Pérdida total del contexto de audio (crash del driver/GPU): se anula
      // el grafo y se reconstruye todo en caliente. La UI no se congela ni se
      // reinicia: los <audio> mantienen su reloj y su posición.
      console.warn("[audio] AudioContext cerrado — reconstruyendo el grafo de audio");
      this.master = null;
      this.masterEq = null;
      this.masterFilterLP = null;
      this.masterFilterHP = null;
      this.masterAnalyser = null;
      this.recDest = null;
      this.ctx = null;
      void this.ensureContext();
    } else if (ctx.state === "suspended" && this.ctxResumeAttempts < 4) {
      // Interrupción transitoria (driver de audio / ahorro de energía): se
      // reintenta el resume con backoff; si el sistema lo sigue negando, el
      // próximo gesto del usuario (PLAY) lo reanudará igualmente.
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

  /** Re-engancha un deck al grafo tras reconstruir el AudioContext. El
   *  elemento <audio> viejo no se puede reutilizar (MediaElementSource es
   *  único por elemento), así que se crea uno nuevo y se restaura todo el
   *  estado: posición, tempo, keylock, SYNC y offset del alineador. */
  private rebindDeckAfterCtxLoss(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    const old = h.el;
    let keylock = false;
    try {
      keylock = old.preservesPitch;
    } catch {
      keylock = false;
    }
    const snapshot = {
      src: h.objectUrl ?? old.getAttribute("src"),
      time: Number.isFinite(old.currentTime) ? old.currentTime : 0,
      paused: old.paused,
      rate: old.playbackRate,
      keylock,
      pitch: h.pitch,
      range: h.range,
      synced: h.synced,
      syncRole: h.syncRole,
      originalBpm: h.originalBpm,
      gridOff: h.gridOff,
      masterName: h.masterName,
      eq: h.eq,
      delayTarget: h.phaseDelayTarget,
      cueActive: h.cueActive,
      loop: h.loop,
      loopInPending: h.loopInPending,
      loopFadeState: h.loopFadeState,
    };
    try {
      old.removeAttribute("src");
      old.load();
    } catch {
      /* sin soporte */
    }
    const el = this.createDeckElement(name);
    if (snapshot.src) el.src = snapshot.src;
    const bound = this.bindDeck(name, el);
    if (!bound) return;
    bound.pitch = snapshot.pitch;
    bound.range = snapshot.range;
    bound.synced = snapshot.synced;
    bound.syncRole = snapshot.syncRole;
    bound.originalBpm = snapshot.originalBpm;
    bound.gridOff = snapshot.gridOff;
    bound.masterName = snapshot.masterName;
    bound.eq = snapshot.eq;
    bound.cueActive = snapshot.cueActive;
    try {
      this.setEq(name, 0, bound.eq[0]);
      this.setEq(name, 1, bound.eq[1]);
      this.setEq(name, 2, bound.eq[2]);
    } catch {
      /* ok */
    }
    try {
      bound.el.preservesPitch = snapshot.keylock;
    } catch {
      /* sin soporte */
    }
    bound.el.playbackRate = snapshot.rate;
    bound.phaseDelayTarget = clamp(snapshot.delayTarget, 0, PHASE_MAX_DELAY);
    if (this.ctx) {
      bound.phase.delayTime.setValueAtTime(bound.phaseDelayTarget, this.ctx.currentTime);
    }
    bound.loop = snapshot.loop;
    bound.loopInPending = snapshot.loopInPending;
    // El envelope nuevo nace en unity: el micro-crossfade del loop se
    // re-programa limpio desde idle en el próximo frame del vigilante
    // (nunca se hereda un estado de fade colgado del grafo anterior).
    bound.loopFadeState = "idle";
    if (bound.loop) this.ensureLoopWatcher();
    this.setCueActive(name, bound.cueActive);
    const restore = () => {
      try {
        if (snapshot.time > 0) bound.el.currentTime = snapshot.time;
      } catch {
        /* ok */
      }
      if (!snapshot.paused) {
        void bound.el.play().catch(() => undefined);
      }
    };
    if (bound.el.readyState >= 1) restore();
    else bound.el.addEventListener("loadedmetadata", restore, { once: true });
    if (snapshot.synced && snapshot.masterName && !snapshot.paused) {
      this.commitSync(name);
    }
  }

  /**
   * Reanuda el AudioContext. Debe invocarse SIEMPRE dentro del gesto del
   * usuario (clic en Play): si no, la policy de autoplay del navegador rechaza
   * la promesa y el motor queda suspendido (sin sonido). El error se ignora.
   */
  resume(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state === "suspended") {
      return ctx.resume().catch(() => undefined);
    }
    return Promise.resolve();
  }

  private deck(name: "A" | "B"): DeckHandle | null {
    return name === "A" ? this.deckA : this.deckB;
  }

  /** Accesores para la UI de la consola MIXI. */
  getElement(name: "A" | "B"): HTMLAudioElement | null {
    return this.deck(name)?.el ?? null;
  }

  /** Tiempo EFECTIVO de salida del deck: la posición del <audio>. El DelayNode
   *  del grafo es ESTÁTICO (PHASE_BASE en ambos decks), así que la latencia
   *  relativa entre decks es siempre nula y el tiempo de salida coincide con
   *  el de fuente. El medidor de fase lo usa para mostrar la alineación. */
  getOutputTime(name: "A" | "B"): number {
    const h = this.deck(name);
    if (!h) return 0;
    const t = h.el.currentTime;
    return Number.isFinite(t) ? t : 0;
  }

  getAnalyser(name: "A" | "B"): AnalyserNode | null {
    return this.deck(name)?.analyser ?? null;
  }

  getMasterAnalyser(): AnalyserNode | null {
    this.ensureContext();
    return this.masterAnalyser;
  }

  /** Carga una fuente (URL/blob/ArrayBuffer) en el deck y la deja lista.
   *  Para fuentes Blob devuelve la función de limpieza que revoca su Blob
   *  URL (la misma liberación que hace releaseSource al soltar el deck). */
  loadSource(name: "A" | "B", source: string | Blob | ArrayBuffer): (() => void) | undefined {
    const h = this.deck(name);
    if (!h) return undefined;
    this.clearSync(name);
    this.exitLoop(name);
    h.loopInPending = null;
    h.el.pause();
    const previous = h.objectUrl;
    h.objectUrl = null;
    if (previous) URL.revokeObjectURL(previous);

    if (typeof source === "string") {
      h.el.src = source;
      h.el.load();
      return undefined;
    }

    const blob = source instanceof ArrayBuffer ? new Blob([source]) : source;
    return this.loadBlobSource(h, blob);
  }

  /** Carga un Blob en el deck y devuelve la función que revoca su Blob URL:
   *  el ciclo create→revoke queda cerrado y verificable. */
  private loadBlobSource(h: DeckHandle, blob: Blob): () => void {
    const url = URL.createObjectURL(blob);
    h.objectUrl = url;
    h.el.src = url;
    h.el.load();
    return () => URL.revokeObjectURL(url);
  }

  /** PLAY/PAUSE explícito del deck (resume el AudioContext en el gesto).
   *  Disparo inmediato: todo es síncrono dentro del mismo gesto del clic —
   *  commitSync (rate + fase), resume() del contexto y el.play() se lanzan
   *  en el milisegundo exacto, sin esperas ni micro-pausas. */
  play(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    const el = h.el;
    // SYNC activo: Instant Phase Lock al dar PLAY. Se calcula la fase exacta
    // del maestro y se salta INMEDIATAMENTE al offset de muestra exacto en el
    // follower, SIN pitch-bending ni correcciones graduales. El rate base
    // (BPM_Maestro / BPM_Original) se aplica de forma instantánea y limpia.
    if (h.synced && h.masterName) {
      this.commitSync(name);
    }
    // Reanuda el AudioContext (policy de autoplay) en el MISMO gesto del clic.
    void this.resume();
    try {
      el.muted = false;
    } catch {
      /* ok */
    }
    const attempt = () => {
      const p = el.play();
      if (p && typeof p.catch === "function") {
        p.catch((err) => {
          console.warn("[audio] play deck", name, err);
          // Si aún no hay datos suficientes, reintenta al poder reproducir.
          if (el.readyState < 3) {
            const retry = () => {
              el.removeEventListener("canplay", retry);
              // Si el primer commitSync no pudo seekear (elemento sin datos),
              // se re-comite AHORA: rate 1:1 + snap de fase exacto (0 ms)
              // justo antes de arrancar — el Play jamás sale desalineado.
              if (h.synced && h.masterName) {
                this.commitSync(name);
              }
              void el.play().catch(() => undefined);
            };
            el.addEventListener("canplay", retry, { once: true });
          }
        });
      }
    };
    attempt();
  }

  pause(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    h.el.pause();
    // El reloj del deck se congela: ventana de medición del servo re-abierta.
    this.servoRetune(name);
  }

  toggle(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    if (h.el.paused) this.play(name);
    else this.pause(name);
  }

  /** Libera la fuente del deck (pausa, revoca Blob URL y limpia el src). */
  releaseSource(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    this.clearSync(name);
    this.exitLoop(name);
    h.loopInPending = null;
    h.el.pause();
    // Al liberar la fuente también se apaga el CUE de este canal.
    this.setCueActive(name, false);
    if (h.objectUrl) {
      URL.revokeObjectURL(h.objectUrl);
      h.objectUrl = null;
    }
    h.el.removeAttribute("src");
    h.el.load();
  }

  private createDeckElement(name: "A" | "B"): HTMLAudioElement {
    const el = new Audio();
    el.crossOrigin = "anonymous";
    el.preload = "auto";
    el.dataset.deck = name;
    return el;
  }

  bindDeck(name: "A" | "B", el?: HTMLAudioElement): DeckHandle | null {
    if (!el) {
      const existing = this.deck(name);
      if (existing) return existing;
    } else if (this.boundElements.has(el)) {
      return this.deck(name);
    }
    const target = el ?? this.createDeckElement(name);
    try {
      const ctx = this.ensureContext();
      const source = ctx.createMediaElementSource(target);

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
      // Neutro: cos(π/4) = sin(π/4) = √2/2 — ambos canales al mismo nivel.
      cross.gain.value = Math.SQRT1_2;

      // CUE/PFL: ganancia pre-fader, antes del fader de canal y del crossfader.
      const cue = ctx.createGain();
      cue.gain.value = 0;

      // Filtro bimodal (Color FX): LP a la izquierda (corta agudos), HP a la
      // derecha (corta graves); ambos abiertos en el centro = neutral.
      const filterLP = ctx.createBiquadFilter();
      filterLP.type = "lowpass";
      filterLP.frequency.value = 22000;
      filterLP.Q.value = 0.71;
      const filterHP = ctx.createBiquadFilter();
      filterHP.type = "highpass";
      filterHP.frequency.value = 20;
      filterHP.Q.value = 0.71;

      // DelayNode ESTÁTICO en serie con todos los envíos (dry + FX): vale
      // PHASE_BASE en AMBOS decks (latencia relativa siempre nula). El SYNC
      // es Hard Lock (un solo seek): este nodo NUNCA se modula.
      const phase = ctx.createDelay(PHASE_MAX_DELAY);
      phase.delayTime.value = PHASE_BASE;

      // Envelope de loop: gain intercalado para micro-crossfade 3-5 ms en
      // el fold del loop, eliminando clicks por discontinuidad de amplitud.
      const loopEnv = ctx.createGain();
      loopEnv.gain.value = 1;

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
      // Phaser: 4 etapas allpass moduladas por un LFO.
      const phaStages: BiquadFilterNode[] = [];
      let phaNode: AudioNode = phase;
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

      source.connect(analyser);
      analyser.connect(trim);
      trim.connect(eqLow);
      eqLow.connect(eqMid);
      eqMid.connect(eqHi);
      eqHi.connect(lowKill);
      lowKill.connect(filterLP);
      filterLP.connect(filterHP);
      filterHP.connect(phase);
      // Envelope de loop: todo el audio pasa por aquí antes de los sends y del
      // fader/cue, así el micro-crossfade afecta tanto al master como al PFL.
      phase.connect(loopEnv);
      // Dry
      loopEnv.connect(fxDry);
      fxDry.connect(fader);
      // Delay send
      loopEnv.connect(dly);
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

      // Pre-Fader Listen: la señal se toma DESPUÉS de EQ/Trim/Filtro/FX phase
      // y del envelope de loop, y ANTES del fader de canal, por lo que el cue
      // no se ve afectado por el fader ni por el crossfader.
      loopEnv.connect(cue);
      cue.connect(this.cueBus!);

      fader.connect(vu);
      fader.connect(cross);
      cross.connect(this.master!);

      const handle: DeckHandle = {
        el: target,
        analyser,
        trim,
        eqLow,
        eqMid,
        eqHi,
        lowKill,
        fader,
        vu,
        cross,
        pitch: 0,
        range: DEFAULT_PITCH_RANGE,
        synced: false,
        syncRole: null,
        originalBpm: 0,
        gridOff: 0,
        masterName: null,
        jogging: false,
        eq: [0, 0, 0],
        objectUrl: null,
        filterLP,
        filterHP,
        dly,
        dlyFb,
        dlyWet,
        phaWet,
        loopEnv,
        phase,
        phaseDelayTarget: PHASE_BASE,
        cue,
        cueActive: false,
        loop: null,
        loopInPending: null,
        loopFadeState: "idle",
      };
      if (name === "A") this.deckA = handle;
      else this.deckB = handle;
      this.boundElements.add(target);
      return handle;
    } catch (err) {
      console.error("[audio] No se pudo enlazar el deck", name, err);
      return null;
    }
  }

  // ── Mixer: crossfader / master ──────────────────────────────────────────
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

  /** EQ global master (0 = LOW, 1 = MID, 2 = HIGH) en dB. */
  setMasterEq(band: 0 | 1 | 2, db: number): void {
    if (!this.masterEq || !this.ctx) return;
    const clamped = clamp(db, EQ_MIN_DB, EQ_MAX_DB);
    this.masterEq[band].gain.setTargetAtTime(db <= EQ_MIN_DB ? -60 : clamped, this.ctx.currentTime, 0.01);
  }

  /** Filtro bimodal master (-1 LPF … 0 neutral … +1 HPF). */
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

  // ── Headphones / CUE (PFL) ──────────────────────────────────────────────

  /** Activa/desactiva el CUE (PFL) de un canal: la señal se toma antes del
   *  fader y del crossfader, por lo que suena en los auriculares aunque el
   *  canal esté cortado en el master. */
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

  /** Split mode: L = CUE, R = MASTER (mezcla de auriculares). */
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
      // En split el paneo es hard (L=CUE, R=MASTER); MIX no aplica.
      this.hpMasterGain.gain.setTargetAtTime(0, now, 0.01);
      this.hpCueGain.gain.setTargetAtTime(0, now, 0.01);
      this.hpLevelGain.gain.setTargetAtTime(level, now, 0.01);
    } else {
      this.hpMasterGain.gain.setTargetAtTime(this.headphoneMix, now, 0.01);
      this.hpCueGain.gain.setTargetAtTime(1 - this.headphoneMix, now, 0.01);
      this.hpLevelGain.gain.setTargetAtTime(level, now, 0.01);
    }
  }

  // ── Mixer: canal (gain / EQ / fader) ────────────────────────────────────
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

  /** FILTER (Low Kill): ON corta los graves con un pasa-altos de golpe. */
  setLowKill(name: "A" | "B", on: boolean): void {
    const f = this.deck(name)?.lowKill;
    if (!f) return;
    const t = this.ctx ? this.ctx.currentTime : 0;
    f.frequency.setTargetAtTime(on ? 110 : 20, t, 0.004);
  }

  /**
   * Filtro bimodal (Color FX): v = -1 (LPF, corta agudos) → 0 (neutral) →
   * +1 (HPF, corta graves). Conectado a nodos BiquadFilterNode en serie.
   */
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

  /** FX de deck: DLY (delay con feedback) y PHA (phaser) en paralelo. */
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

  // ── Meting (VU) ─────────────────────────────────────────────────────────
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

  // ── Track meta / pitch / sync ───────────────────────────────────────────
  setDeckMeta(name: "A" | "B", meta: { originalBpm?: number; gridOff?: number }): void {
    const h = this.deck(name);
    if (!h) return;
    const bpmChanged = meta.originalBpm !== undefined && meta.originalBpm > 0 && meta.originalBpm !== h.originalBpm;
    const gridChanged = meta.gridOff !== undefined && meta.gridOff !== h.gridOff;
    if (meta.originalBpm !== undefined) h.originalBpm = meta.originalBpm > 0 ? meta.originalBpm : 0;
    if (meta.gridOff !== undefined) h.gridOff = meta.gridOff;
    if (bpmChanged || gridChanged) {
      // La referencia de fase (rejilla) se movió: la corrección estacionaria
      // aprendida ya no aplica — memoria integral a cero y ventana re-abierta.
      this.servo[name].bias = 0;
      this.servoRetune(name);
    }
  }

  setPitch(name: "A" | "B", pct: number): void {
    const h = this.deck(name);
    if (!h) return;
    if (h.synced) this.clearSync(name);
    h.pitch = clamp(pct, -h.range, h.range);
    this.applyManualRate(name);
    // Si este deck es MAESTRO de un esclavo sincronizado, su tempo efectivo
    // acaba de cambiar: se re-comite el SYNC del esclavo AHORA (rate 1:1
    // exacto + snap de fase) para que la diferencia quede en 0 ms sin
    // desviación acumulativa. Un solo disparo, sin bucles de corrección.
    this.recommitFollowersOf(name);
  }

  /** Re-comite el Hard Lock de todos los decks sincronizados que tengan a
   *  `masterName` como maestro. Se usa cuando el tempo EFECTIVO del maestro
   *  cambia (pitch, jog o carga de track): el esclavo vuelve a clavar rate
   *  y fase en un solo disparo (sin watchdog ni PLL). */
  private recommitFollowersOf(masterName: "A" | "B"): void {
    for (const [n, h] of [["A", this.deckA], ["B", this.deckB]] as const) {
      if (!h || h.synced !== true || h.masterName !== masterName) continue;
      this.commitSync(n);
    }
  }

  private applyManualRate(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || h.synced || h.jogging) return;
    const rate = clamp(1 + h.pitch / 100, 0.5, 2);
    h.el.playbackRate = rate;
    try {
      if (!h.el.preservesPitch) h.el.preservesPitch = true;
    } catch {
      /* navegadores sin soporte */
    }
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
    return h.originalBpm * h.el.playbackRate;
  }

  isSynced(name: "A" | "B"): boolean {
    return this.deck(name)?.synced ?? false;
  }

  /** Estado de SYNC del deck según el MOTOR (fuente de verdad del audio):
   *  isSynced = este deck es ESCLAVO de otro (su rate no es libre), role =
   *  papel dentro de la pareja (master/follower) y masterDeck = deck maestro
   * al que sigue. La UI lo espeja para pintar MASTER / FOLLOW A|B según el
   * master ACTIVO — las etiquetas jamás se cruzan porque salen del motor. */
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

  /** Desfase EXACTO de grilla (Beat Offset, segundos de tiempo de fuente)
   *  entre esclavo y maestro, calculado UNA vez para el Hard Lock: cuánto hay
   *  que mover la aguja del esclavo para que su línea de beat quede 100%
   *  superpuesta (0 ms) sobre la rejilla del maestro. La fase se mide en
   *  TIEMPO DE FUENTE con los periodos ORIGINALES (60 / BPM_Original): la
   *  rejilla vive en tiempo de fuente y, con BPM efectivos iguales, la
   *  alineación queda ESTÁTICA para siempre. Solo cálculo puro: no toca el
   *  elemento. */
  private phaseShift(name: "A" | "B", masterName: "A" | "B"): number {
    const slave = this.deck(name);
    const master = this.deck(masterName);
    if (!slave || !master || slave === master) return 0;
    if (!slave.originalBpm || !master.originalBpm) return 0;
    return hardAlignShift(
      master.el.currentTime,
      master.originalBpm,
      master.gridOff,
      slave.el.currentTime,
      slave.originalBpm,
      slave.gridOff,
    );
  }

  /** Hard Phase Lock: un solo seek rígido de la aguja del esclavo al beat más
   *  cercano del maestro. Sin rampas, sin filtros, sin re-centrados: se
   *  calcula una vez y se aplica en el instante. */
  alignPhase(name: "A" | "B", masterName: "A" | "B"): number {
    const slave = this.deck(name);
    if (!slave) return 0;
    const shift = this.phaseShift(name, masterName);
    if (Math.abs(shift) < 0.0005) return 0;
    slave.el.currentTime = Math.max(0, slave.el.currentTime + shift);
    return shift;
  }

  /**
   * Alineación con la rejilla del master (sin cambiar tempo) para el QUANTIZE
   * al dar Play. El deck está en pausa: el seek cuantizado a beat es
   * inaudible y deja la rejilla clavada (Absolute Snap de un solo disparo).
   */
  alignToMasterOnce(name: "A" | "B", masterName: "A" | "B"): number {
    const slave = this.deck(name);
    const master = this.deck(masterName);
    if (!slave || !master || slave === master) return 0;
    if (!slave.originalBpm || !master.originalBpm) return 0;
    return this.alignPhase(name, masterName);
  }

  /**
   * SYNC profesional (Master Audio Clock + Phase Lock continuo):
   *   · Tempo: playbackRate base = BPM_Master_efectivo / BPM_Original_del_deck,
   *     SIEMPRE 1:1 (sin ratios armónicos).
   *   · Fase: Hard Alignment al enganchar (seek cuantizado al beat más
   *     cercano del maestro, 0 ms) + servo PI continuo durante la
   *     reproducción (servoTick) que congela la fase en 0 ms para siempre,
   *     sin deriva acumulativa (ver cabecera del archivo).
   */
  syncTo(name: "A" | "B", masterName: "A" | "B"): boolean {
    const slave = this.deck(name);
    const master = this.deck(masterName);
    if (!slave || !master || slave === master) return false;
    if (!slave.originalBpm || !master.originalBpm) return false;

    // Guard anti-ciclo (A sincronizado a B y B a la vez a A): sin referencia
    // independiente la fase deriva sin correctivo posible. El deck que pulsa
    // SYNC se convierte en esclavo y el antiguo esclavo queda liberado como
    // maestro independiente (determinista, una sola referencia de tempo).
    if (master.synced && master.masterName === name) {
      this.clearSync(masterName);
    }

    // Establecer roles Master/Follower de forma explícita. Si el deck maestro
    // ya era follower de alguien, lo liberamos primero para garantizar una
    // única referencia de tempo.
    if (master.syncRole === "follower") {
      this.clearSync(masterName);
    }
    master.syncRole = "master";
    master.masterName = null;

    // BPM objetivo: el efectivo del maestro (source BPM × pitch del maestro).
    const masterBpm = this.getEffectiveBpm(masterName) || master.originalBpm;
    // rate base = BPM_Master / BPM_Original (1:1 exacto, sin ratios).
    const targetRate = syncPlaybackRate(masterBpm, slave.originalBpm);
    slave.pitch = (targetRate - 1) * 100;
    slave.synced = true;
    slave.syncRole = "follower";
    slave.masterName = masterName;
    // Enganche fresco: la corrección estacionaria se aprende de cero para
    // esta pareja de decks (el bias es tasa, no posición).
    this.servo[name].bias = 0;

    // Aplicación inmediata (rate base + snap rígido de fase), suene o no.
    this.commitSync(name);
    return true;
  }

  // ── Hard Phase Lock (tempo fijo + snap único) ────────────────────────────

  /** Rate objetivo FIJO del esclavo bajo SYNC (masterBPM / trackBPM, 1:1).
   *  Constante mientras el SYNC esté activo: nunca se re-modula en bucle. */
  private syncTargetRate(h: DeckHandle): number {
    if (!h.synced || !h.masterName) return clamp(1 + h.pitch / 100, 0.5, 2);
    const master = this.deck(h.masterName);
    const masterBpm = this.getEffectiveBpm(h.masterName) || master?.originalBpm || 0;
    if (!masterBpm || !h.originalBpm) return h.el.playbackRate;
    return syncPlaybackRate(masterBpm, h.originalBpm);
  }

  /**
   * Aplica el SYNC (rate base + fase):
   *   1) Tempo: playbackRate = masterBPM / trackBPM (1:1 exacto).
   *   2) Fase: Hard Alignment — seek único cuantizado de la aguja a la línea
   *      de beat más cercana de la rejilla del maestro (0 ms de desfasaje).
   *   3) Arranca el servo de fase (Master Audio Clock): a partir de aquí la
   *      fase se mantiene CONGELADA por corrección continua de rate (±0.15%
   *      en lock), sin deriva acumulativa durante todo el set.
   */
  private commitSync(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !h.synced || !h.masterName) return;
    const master = this.deck(h.masterName);
    if (!master) return;
    // rate = masterBPM / trackBPM (1:1 exacto).
    const targetRate = this.syncTargetRate(h);
    try {
      // Keylock: solo si no está ya activo (evita re-configurar el modo de
      // resampling del elemento mientras suena).
      if (!h.el.preservesPitch) h.el.preservesPitch = true;
    } catch {
      /* sin soporte */
    }
    // Tempo EXACTO al instante: el BPM se clava de inmediato.
    h.el.playbackRate = targetRate;
    // Fase: Hard Alignment (un seek rígido de 0 ms al enganchar).
    this.snapPhaseToMaster(name);
    // Ventanas de medición frescas (esclavo y maestro) + servo en marcha.
    this.servoRetune(name);
    this.servoRetune(h.masterName);
    this.ensureServo();
  }

  /** Hard Alignment: mueve la aguja del esclavo a la línea de beat más
   *  cercana de la rejilla del maestro con UN seek exacto (0 ms de
   *  desfasaje). Tras el seek, la ventana de medición del servo se re-abre
   *  (una discontinuidad de posición no es error de tasa). El retardo del
   *  grafo permanece SIEMPRE en reposo (PHASE_BASE). */
  private snapPhaseToMaster(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h || !h.synced || !h.masterName) return;
    // Sin datos cargados aún no hay timeline sobre el que seekear: el snap se
    // re-intenta en el commitSync del propio PLAY (readyState ≥ 1).
    if (h.el.readyState < 1) return;
    const shift = this.phaseShift(name, h.masterName);
    if (Math.abs(shift) < 0.00005) return; // ya clavado a 0 ms (ruido float)
    try {
      h.el.currentTime = Math.max(0, h.el.currentTime + shift);
    } catch {
      /* seek no disponible todavía: se reintenta en el próximo commitSync */
    }
    this.servoRetune(name);
  }

  clearSync(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    const wasMaster = h.syncRole === "master";
    const masterRef = h.masterName;
    h.synced = false;
    h.syncRole = null;
    h.masterName = null;
    // Si este deck era maestro, liberar también a sus followers para evitar
    // que queden huérfanos de referencia.
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
      // Roles RELACIONALES: al liberarse el follower, la pareja deja de
      // existir y el maestro pierde también su rol. Así MASTER / FOLLOW son
      // estados de la MISMA pareja (nunca queda un "MASTER" huérfano que
      // cruce las etiquetas del botón SYNC).
      const m = this.deck(masterRef);
      if (m && m.syncRole === "master" && !m.synced) {
        m.syncRole = null;
      }
    }
    // El servo deja de corregir este deck: memoria integral a cero y
    // ventana de medición re-abierta (por si se re-engancha más tarde).
    this.servo[name].bias = 0;
    this.servoRetune(name);
    this.stopServoIfIdle();
    if (h.el.paused) {
      // SYNC cancelado antes de sonar: el rate nunca se aplicó; se restaura
      // el tempo neutro para que el próximo PLAY salga limpio.
      h.pitch = 0;
      try {
        h.el.playbackRate = 1;
      } catch {
        /* sin soporte */
      }
      return;
    }
    // Vuelta al tempo manual: escritura DIRECTA e instantánea (sin rampas).
    h.el.playbackRate = clamp(1 + h.pitch / 100, 0.5, 2);
  }

  // ── Master Audio Clock: servo de fase continua (Phase Lock pro) ─────────
  //
  // Los decoders de los dos <audio> avanzan a tasas REALES ligeramente
  // distintas (pipeline por elemento, keylock, buffering): un rate escrito
  // una sola vez deriva ~0.1-0.3% ⇒ decenas de ms por minuto de set. Este
  // servo cierra el bucle sobre el observable real — el desfase de fase
  // contra la rejilla del maestro — referenciado SIEMPRE al reloj maestro
  // (AudioContext.currentTime, muestras consumidas): nunca se acumula
  // tiempo, nunca se arrastra error de redondeo.

  /** Re-abre la ventana de medición del servo de un deck (tras seeks,
   *  plays, cambios de rate, commits de sync o liberaciones). No toca el
   *  término integral: el bias es conocimiento de tasa, no de posición. */
  private servoRetune(name: "A" | "B"): void {
    const h = this.deck(name);
    const s = this.servo[name];
    s.lastDt = 0;
    if (!h) {
      s.init = false;
      return;
    }
    s.ctxTime = this.ctx ? this.ctx.currentTime : 0;
    s.deckTime = Number.isFinite(h.el.currentTime) ? h.el.currentTime : 0;
    s.rate = h.el.playbackRate;
    s.init = true;
  }

  /** Arranca el servo de fase si hay algún deck sincronizado (idempotente). */
  private ensureServo(): void {
    if (this.servoTimer !== null) return;
    if (!this.deckA?.synced && !this.deckB?.synced) return;
    this.servoTimer = setInterval(() => this.servoTick(), SERVO_INTERVAL_MS);
  }

  /** Detiene el servo cuando ya no queda ningún deck sincronizado. */
  private stopServoIfIdle(): void {
    if (this.servoTimer === null) return;
    if (this.deckA?.synced || this.deckB?.synced) return;
    clearInterval(this.servoTimer);
    this.servoTimer = null;
  }

  /** Un paso de medición de un deck contra el reloj maestro. Devuelve:
   *  · "fresh"   — ventana recién abierta (sin dato comparable aún).
   *  · "ok"      — ventana válida: el decoder avanzó conforme a su rate.
   *  · "jump"    — discontinuidad (seek/beat jump/carga): ventana re-abierta.
   *  · "frozen"  — reloj del deck congelado (pausa o estancamiento). */
  private servoMeasure(name: "A" | "B", nowCtx: number): "fresh" | "ok" | "jump" | "frozen" {
    const h = this.deck(name);
    const s = this.servo[name];
    if (!h) {
      s.init = false;
      return "fresh";
    }
    const t = h.el.currentTime;
    if (!Number.isFinite(t)) {
      s.init = false;
      return "fresh";
    }
    if (!s.init) {
      this.servoRetune(name);
      return "fresh";
    }
    const dtCtx = nowCtx - s.ctxTime;
    if (dtCtx <= 0.005) return "ok"; // reloj maestro detenido (ctx suspendido)
    // Deck pausado: su reloj está congelado (nunca es un "salto" de posición).
    if (h.el.paused) {
      s.ctxTime = nowCtx;
      s.deckTime = t;
      s.rate = h.el.playbackRate;
      s.lastDt = dtCtx;
      return "frozen";
    }
    const dt = t - s.deckTime;
    const expected = s.rate * dtCtx;
    if (Math.abs(dt - expected) > SERVO_SEEK_DETECT) {
      // Salto de posición o estancamiento grande: re-abrir la ventana. La
      // tasa realizada de este intervalo sería basura (Δposición inválido).
      this.servoRetune(name);
      return "jump";
    }
    // Ventana válida: actualizar la medición (la tasa realizada del decoder
    // queda implícita en dt/dtCtx; el servo actúa sobre el error de fase
    // absoluto, que no depende de esta ventana).
    s.ctxTime = nowCtx;
    s.deckTime = t;
    s.rate = h.el.playbackRate;
    s.lastDt = dtCtx;
    if (Math.abs(dt) < 0.002) return "frozen"; // decoder estancado (buffering)
    return "ok";
  }

  /** Un tick del servo de fase: corrección PI continua del SYNC. Mide el
   *  error de fase EXACTO (posición vs posición, en tiempo de fuente) del
   *  esclavo contra la rejilla del maestro y recorta su playbackRate para
   *  converger y CONGELAR la fase en 0 ms, sin seeks audibles. */
  private servoTick(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (!this.deckA?.synced && !this.deckB?.synced) {
      this.stopServoIfIdle();
      return;
    }
    const nowCtx = ctx.currentTime;

    for (const n of ["A", "B"] as const) {
      const h = this.deck(n);
      if (!h || !h.synced || !h.masterName) continue;
      const master = this.deck(h.masterName);
      if (!master || master === h) continue;
      if (!h.originalBpm || !master.originalBpm) continue;

      const s = this.servo[n];
      const slaveMeas = this.servoMeasure(n, nowCtx);
      const masterMeas = this.servoMeasure(h.masterName, nowCtx);

      // Ciclo de sync (A↔B): sin referencia independiente no se corrige
      // (syncTo lo impide al enganchar; defensa en profundidad).
      if (master.synced) continue;
      // El esclavo no avanza (pausa/buffering) o acaba de saltar (seek):
      // sin trim este tick — la ventana se re-abre en el próximo.
      if (slaveMeas !== "ok") continue;
      // Maestro congelado (pausado/estancado): su rejilla no avanza; se
      // congela también el tempo del esclavo (corregir contra un reloj
      // parado arrastraría la fase sin referencia real).
      if (masterMeas === "frozen") continue;
      // Un salto del maestro discontinuo en posición pero CONTINUO en fase
      // (loop fold / beat jump del maestro: bordes cuantizados a la rejilla)
      // NO anula el término integral: el error de fase no se movió. Si el
      // salto rompe la fase de verdad, el umbral catastrófico de abajo
      // re-engecha con Hard Snap y ahí sí se anula el bias.
      // El jog y el loop poseen el rate/posición del esclavo: no interferir.
      if (h.jogging || h.loop) continue;

      // Error de fase EXACTO (s de tiempo de fuente del esclavo) contra la
      // rejilla del maestro: > 0 ⇒ el esclavo va retrasado.
      const err = hardAlignShift(
        master.el.currentTime,
        master.originalBpm,
        master.gridOff,
        h.el.currentTime,
        h.originalBpm,
        h.gridOff,
      );
      const period = 60 / h.originalBpm;

      // Deriva catastrófica (> ~medio beat: seek manual del esclavo o
      // estancamiento largo): re-enganche rígido al beat del maestro.
      // NO aplicamos trimming continuo de playbackRate: ese pitch-bending
      // gradual genera distorsión perceptible, especialmente al iniciar la
      // reproducción con SYNC. El lock se mantiene mediante Hard Snap
      // instantáneo + rate base exacto (BPM_Maestro / BPM_Original).
      if (Math.abs(err) > SERVO_SNAP_BEATS * period) {
        this.snapPhaseToMaster(n);
        s.bias = 0;
        this.servoRetune(n);
        this.servoRetune(h.masterName);
        continue;
      }

      // El trimming continuo está DESHABILITADO para evitar pitch-bending y
      // distorsión. Mantenemos la medición y el bias por si en el futuro se
      // opta por una corrección suave, pero no se toca el playbackRate aquí.
      // La sincronización se sostiene con rate base exacto + Hard Snap.
    }
  }

  // ── Loops / Beat Jump / Loop Roll (Slip) ─────────────────────────────────
  //
  // Los loops viven en TIEMPO DE FUENTE y quedan cuantizados a la rejilla
  // (gridOff + k · 60/originalBpm): la longitud del loop es SIEMPRE un
  // número exacto de beats, así que la fase de la rejilla es continua a
  // través del corte (0 ms de desfase por ciclo) y el SYNC Hard Lock sigue
  // clavado mientras el loop suena.
  //
  // Vigilante de loops: un ÚNICO rAF que solo existe mientras hay un loop o
  // roll activo. En cada frame, al cruzar el final del loop, se busca con
  // compensación de overshoot (mod de la longitud): el audio nunca se atrasa
  // ni se adelanta y el corte es imperceptible. Fuera de los loops NO se
  // toca la posición ni el rate (cero interferencia con el SYNC).

  /** Beat de la rejilla en el que cae `t` (start del beat, tiempo de fuente).
   *  Con seguridad de borde flotante: nunca devuelve un beat FUTURO. */
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

  /** Loop genérico (start/end ya cuantizados, tiempos de fuente). */
  setLoop(name: "A" | "B", start: number, end: number, beats: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const dur = Number.isFinite(h.el.duration) ? h.el.duration : Number.MAX_SAFE_INTEGER;
    const s = clamp(start, 0, Math.max(0, dur - 0.05));
    const e = clamp(end, s + 0.05, dur);
    if (e <= s) return null;
    h.loop = { start: s, end: e, beats, roll: false, rollBase: 0, rollStartWall: 0 };
    h.loopFadeState = "idle";
    this.ensureLoopWatcher();
    return h.loop;
  }

  /** Loop manual con límites ya cuantizados (LOOP IN/OUT y arrastre de
   *  bordes): la longitud en beats se deriva del BPM ORIGINAL. */
  setLoopManual(name: "A" | "B", start: number, end: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const period = 60 / h.originalBpm;
    const beats = Math.max(0.125, Math.round((end - start) / period));
    return this.setLoop(name, start, end, beats);
  }

  /** Auto Loop: arma un loop de N beats desde el beat actual de la rejilla.
   *  Inmediato: el watcher ya está activo y el borde cae exacto en la grilla. */
  setAutoLoop(name: "A" | "B", beats: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const period = 60 / h.originalBpm;
    const t = h.el.currentTime;
    const start = this.gridBeatStart(h, t);
    const end = start + beats * period;
    return this.setLoop(name, start, end, beats);
  }

  /** LOOP IN manual: cuantiza la posición actual a la grilla y guarda el
   *  punto pendiente. No altera la reproducción. */
  setLoopIn(name: "A" | "B"): number | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const t = h.el.currentTime;
    const point = this.gridBeatStart(h, t);
    h.loopInPending = point;
    return point;
  }

  /** LOOP OUT manual: cierra el loop con el punto pendiente (cuantizado al
   *  beat actual) y lo arma al instante. Sin IN pendiente no hace nada. */
  setLoopOut(name: "A" | "B"): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm || h.loopInPending === null) return null;
    const period = 60 / h.originalBpm;
    const t = h.el.currentTime;
    const out = this.gridBeatStart(h, t) + period; // el OUT cae en el SIGUIENTE beat
    const start = h.loopInPending;
    if (out - start < 0.25 * period) return null; // demasiado corto
    const beats = (out - start) / period;
    h.loopInPending = null;
    return this.setLoop(name, start, out, beats);
  }

  /** Loop Roll (Slip): loop momentáneo mientras se mantiene el pad. El audio
   *  buclea cuantizado a la grilla y el reloj VIRTUAL sigue avanzando; al
   *  soltar, exitLoop retoma exactamente donde le correspondía en tiempo
   *  real (rollBase + wall-clock × rate), conservando la fase del SYNC. */
  startLoopRoll(name: "A" | "B", beats: number): LoopInfo | null {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return null;
    const period = 60 / h.originalBpm;
    const t = h.el.currentTime;
    const start = this.gridBeatStart(h, t);
    const end = start + beats * period;
    const dur = Number.isFinite(h.el.duration) ? h.el.duration : Number.MAX_SAFE_INTEGER;
    const s = clamp(start, 0, Math.max(0, dur - 0.05));
    const e = clamp(end, s + 0.05, dur);
    if (e <= s) return null;
    h.loop = { start: s, end: e, beats, roll: true, rollBase: t, rollStartWall: performance.now() };
    h.loopFadeState = "idle";
    this.ensureLoopWatcher();
    return h.loop;
  }

  /** Restaura el envelope de loop a unity con una micro-rampa de 4 ms
   *  (cambio de planes: pausa, seek lejos del borde o salida del loop).
   *  Deja el vigilante en idle para que el pre-fade se re-programe limpio. */
  private restoreLoopEnv(h: DeckHandle): void {
    const now = this.ctx ? this.ctx.currentTime : 0;
    try {
      h.loopEnv.gain.cancelScheduledValues(now);
      h.loopEnv.gain.setValueAtTime(Math.max(0, Math.min(h.loopEnv.gain.value, 1)), now);
      h.loopEnv.gain.linearRampToValueAtTime(1, now + LOOP_CROSSFADE_S);
    } catch {
      /* ok */
    }
    h.loopFadeState = "idle";
  }

  /** Libera el loop (Auto / Manual / Roll) sin desfasar el track: la aguja
   *  sigue fluyendo desde donde está (fase continua). En un Roll con Slip se
   *  retoma la posición real virtual. */
  exitLoop(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    const loop = h.loop;
    h.loop = null;
    // Restaurar el envelope de loop a unity al salir.
    this.restoreLoopEnv(h);
    this.updateLoopWatcher();
    if (loop && loop.roll) {
      // Slip: retomar donde le correspondía en tiempo real. El reloj virtual
      // avanza a la MISMA velocidad efectiva que el maestro sincronizado, de
      // modo que la fase del SYNC se conserva exacta.
      const elapsed = (performance.now() - loop.rollStartWall) / 1000;
      const virtual = loop.rollBase + elapsed * h.el.playbackRate;
      try {
        h.el.currentTime = Math.max(0, virtual);
      } catch {
        /* seek no disponible todavía */
      }
    }
    // Discontinuidad de posición (salida del loop / slip): ventana del
    // servo re-abierta (el loop era un estado custodiado, no error de tasa).
    this.servoRetune(name);
  }

  /** Loop activo del deck (o null). */
  getLoop(name: "A" | "B"): LoopInfo | null {
    return this.deck(name)?.loop ?? null;
  }

  isLoopActive(name: "A" | "B"): boolean {
    return this.deck(name)?.loop !== null;
  }

  /** Beat Jump: salto EXACTO de N beats sobre la grilla (tiempo de fuente).
   *  Como el salto es un múltiplo entero del periodo, la fase de la rejilla
   *  no cambia: el Phase Lock se conserva (el servo solo re-abre ventana). */
  beatJump(name: "A" | "B", beats: number): void {
    const h = this.deck(name);
    if (!h || !h.originalBpm) return;
    const period = 60 / h.originalBpm;
    const dur = Number.isFinite(h.el.duration) ? h.el.duration : Number.MAX_SAFE_INTEGER;
    h.el.currentTime = clamp(h.el.currentTime + beats * period, 0, dur);
    this.servoRetune(name);
  }

  /** Arranca el rAF del vigilante (idempotente). */
  private ensureLoopWatcher(): void {
    if (this.loopRaf !== null) return;
    this.loopRaf = requestAnimationFrame(this.loopTick);
  }

  /** Detiene el rAF si ya no queda ningún loop/roll activo. */
  private updateLoopWatcher(): void {
    if (this.loopRaf !== null && !this.deckA?.loop && !this.deckB?.loop) {
      cancelAnimationFrame(this.loopRaf);
      this.loopRaf = null;
    }
  }

  /** Un frame del vigilante: dobla cada deck cuyo loop esté activo al
   *  cruzar su borde final. Micro-crossfade DETERMINISTA de 4 ms en la
   *  costura (borra el "saltito"/click del seamless loop repeat):
   *   1) PRE-FADE: al entrar el borde en la ventana de anticipación
   *      (≤ 50 ms reales, ≤ 1/4 del loop) se programa una rampa que
   *      MANTIENE el gain hasta 4 ms antes del borde y cae a 0 EXACTO en
   *      el borde — instante REAL corregido por playbackRate (la aguja
   *      avanza a rate × tiempo real, no a tiempo de fuente).
   *   2) FOLD: cruzado el borde → seek compensado por overshoot (mod de
   *      la longitud) de vuelta al Loop In + fade-in lineal de 4 ms a
   *      unity: la discontinuidad de fase de la onda en la muestra de
   *      retorno queda suavizada por el micro-crossfade.
   *   3) Fugas (pausa / seek lejos del borde): el envelope se restaura a
   *      unity y el micro-fade se re-programa limpio desde idle.
   *  Caída y subida de 4 ms cada una (3-5 ms): inaudibles como ducking,
   *  suficientes para eliminar el click de fase en el reinicio del ciclo. */
  private loopTick = (): void => {
    for (const h of [this.deckA, this.deckB]) {
      if (!h || !h.loop) continue;
      // Pausa con el micro-fade abierto: el AudioContext sigue corriendo y
      // la rampa programada dejaría el gain en 0 para siempre. Se restaura
      // a unity y el pre-fade se re-programa al reanudar la reproducción.
      if (h.el.paused) {
        if (h.loopFadeState !== "idle") this.restoreLoopEnv(h);
        continue;
      }
      const loop = h.loop;
      const t = h.el.currentTime;
      if (!Number.isFinite(t)) continue;
      const len = loop.end - loop.start;
      if (len <= 0) continue;

      const now = this.ctx ? this.ctx.currentTime : 0;
      const rate = h.el.playbackRate > 0.01 ? h.el.playbackRate : 1;
      const lookaheadSrc = Math.min(LOOP_FADE_WIN_S, len * 0.25) * rate;

      // FASE 1 — FOLD: cruzamos el borde → seek compensado + micro fade-in
      // de 4 ms justo en la muestra de retorno (Loop In).
      if (t >= loop.end) {
        const target = loop.start + ((((t - loop.start) % len) + len) % len);
        try {
          h.el.currentTime = Math.max(0, target);
        } catch {
          /* seek no disponible todavía */
        }
        try {
          h.loopEnv.gain.cancelScheduledValues(now);
          h.loopEnv.gain.setValueAtTime(Math.max(0, Math.min(h.loopEnv.gain.value, 1)), now);
          h.loopEnv.gain.linearRampToValueAtTime(1, now + LOOP_CROSSFADE_S);
        } catch {
          /* ok */
        }
        h.loopFadeState = "fade-in";
        continue;
      }

      // FASE 2 — PRE-FADE: rampa a 0 con llegada EXACTA al borde; la caída
      // audible se concentra en los últimos 4 ms (hold → 0), nunca un
      // decaimiento largo que se oiga como ducking.
      if (h.loopFadeState === "idle") {
        const distSrc = loop.end - t;
        if (distSrc <= lookaheadSrc) {
          const tBorder = now + Math.max(distSrc / rate, 0.0005);
          const fadeStart = Math.max(now, tBorder - LOOP_CROSSFADE_S);
          try {
            h.loopEnv.gain.cancelScheduledValues(now);
            h.loopEnv.gain.setValueAtTime(h.loopEnv.gain.value, now);
            h.loopEnv.gain.setValueAtTime(h.loopEnv.gain.value, fadeStart);
            h.loopEnv.gain.linearRampToValueAtTime(0, tBorder);
          } catch {
            /* ok */
          }
          h.loopFadeState = "fade-out";
        }
      }

      // FASE 2b — FUGA: en fade-out pero la aguja quedó lejos del borde
      // (seek manual / borde arrastrado): el fade programado ya no aplica,
      // se restaura a unity y se re-programa desde idle.
      if (h.loopFadeState === "fade-out" && loop.end - t > lookaheadSrc) {
        this.restoreLoopEnv(h);
      }

      // FASE 3 — fade-in completado (gain de vuelta a unity) → idle.
      if (h.loopFadeState === "fade-in") {
        try {
          if (h.loopEnv.gain.value >= 0.99) h.loopFadeState = "idle";
        } catch {
          h.loopFadeState = "idle";
        }
      }
    }
    this.loopRaf = requestAnimationFrame(this.loopTick);
  };

  // ── Jog / scratch / pads ────────────────────────────────────────────────
  beginJog(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    h.jogging = true; // el scratch toma el control directo del rate
  }

  /** Rate directo durante el jog (1 = normal, >1 acelera, <1 frena). */
  setJogRate(name: "A" | "B", rate: number): void {
    const h = this.deck(name);
    if (!h) return;
    h.el.playbackRate = clamp(rate, 0.1, 4);
  }

  /** Seek relativo durante el scratch con el deck en pausa. */
  scratchSeek(name: "A" | "B", deltaSec: number): void {
    const h = this.deck(name);
    if (!h) return;
    const dur = Number.isFinite(h.el.duration) ? h.el.duration : Number.MAX_SAFE_INTEGER;
    h.el.currentTime = clamp(h.el.currentTime + deltaSec, 0, dur);
    this.servoRetune(name);
  }

  endJog(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    h.jogging = false;
    // Con SYNC activo se restaura el rate BASE del SYNC (masterBPM/trackBPM)
    // y el servo de fase retoma el control: re-converge el desfase que haya
    // dejado el jog con trims inaudibles (±0.15%) o, si es mayor de ~medio
    // beat, re-engecha con Hard Snap.
    if (h.synced && h.masterName) {
      const master = this.deck(h.masterName);
      if (master) {
        const masterBpm = this.getEffectiveBpm(h.masterName) || master.originalBpm;
        h.el.playbackRate = syncPlaybackRate(masterBpm, h.originalBpm);
        this.servoRetune(name);
        return;
      }
    }
    this.applyManualRate(name);
    this.servoRetune(name);
  }

  seek(name: "A" | "B", t: number): void {
    const h = this.deck(name);
    if (!h) return;
    const dur = Number.isFinite(h.el.duration) ? h.el.duration : Number.MAX_SAFE_INTEGER;
    h.el.currentTime = clamp(t, 0, dur);
    // Seek = discontinuidad de posición: ventana de medición re-abierta (el
    // servo re-alineará la fase con trims suaves o Hard Snap si procede).
    this.servoRetune(name);
  }

  stopAll(): void {
    this.deckA?.el.pause();
    this.deckB?.el.pause();
  }

  // ── Grabación (REC) del bus master ──────────────────────────────────────
  get isRecording(): boolean {
    return this.recording;
  }

  /** Inicia/detiene la grabación del master; al parar descarga un .webm. */
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
