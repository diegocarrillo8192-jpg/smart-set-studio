/**
 * Motor de audio del Dual Pre-listener.
 * Dos decks independientes + crossfader con curva de mute al 80% del recorrido.
 * Controles directos por plato: SYNC (ajuste de playbackRate al BPM opuesto)
 * y FILTER (Low Kill pasa-altos). SIN mezclas automáticas.
 */

export interface DeckHandle {
  el: HTMLAudioElement;
  analyser: AnalyserNode; // solo para dibujar la waveform
  lowKill: BiquadFilterNode; // pasa-altos (FILTER ON corta los graves)
  cross: GainNode; // crossfader del canal (curva equal-power + mute 80%)
}

/** Fracción del recorrido a la que el canal opuesto queda muteado al 100%. */
export const CROSSFADE_CUTOFF = 0.8;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  deckA: DeckHandle | null = null;
  deckB: DeckHandle | null = null;
  private master: GainNode | null = null;
  private crossfader = 0; // 0 = solo A, 1 = solo B
  private boundElements = new WeakSet<HTMLAudioElement>();

  ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  private deck(name: "A" | "B"): DeckHandle | null {
    return name === "A" ? this.deckA : this.deckB;
  }

  bindDeck(name: "A" | "B", el: HTMLAudioElement): DeckHandle | null {
    // createMediaElementSource solo puede llamarse UNA vez por elemento.
    // (StrictMode de React monta efectos dos veces en dev.)
    if (this.boundElements.has(el)) {
      return this.deck(name);
    }
    try {
      const ctx = this.ensureContext();
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      // Low Kill: pasa-altos de corte de graves (inactivo a 20Hz, inaudible)
      const lowKill = ctx.createBiquadFilter();
      lowKill.type = "highpass";
      lowKill.frequency.value = 20;
      lowKill.Q.value = 0.71;
      const cross = ctx.createGain();
      cross.gain.value = name === "A" ? 1 : 0;

      source.connect(analyser);
      analyser.connect(lowKill);
      lowKill.connect(cross);
      cross.connect(this.master!);

      const handle: DeckHandle = { el, analyser, lowKill, cross };
      if (name === "A") this.deckA = handle;
      else this.deckB = handle;
      this.boundElements.add(el);
      return handle;
    } catch (err) {
      console.error("[audio] No se pudo enlazar el deck", name, err);
      return null;
    }
  }

  /**
   * Posición del crossfader 0..1 con curva equal-power y "mute temprano":
   * el canal opuesto queda al 100% silenciado al llegar al 80% del recorrido
   * (CROSSFADE_CUTOFF), movimiento fluido con setTargetAtTime.
   */
  setCrossfader(position: number): void {
    this.crossfader = Math.max(0, Math.min(1, position));
    const t = Math.max(0, Math.min(1, this.crossfader / CROSSFADE_CUTOFF));
    const angle = (t * Math.PI) / 2;
    const now = this.ctx ? this.ctx.currentTime : 0;
    this.deckA?.cross.gain.setTargetAtTime(Math.cos(angle), now, 0.02);
    this.deckB?.cross.gain.setTargetAtTime(Math.sin(angle), now, 0.02);
  }

  getCrossfader(): number {
    return this.crossfader;
  }

  /** FILTER (Low Kill): ON corta los graves con un pasa-altos de golpe. */
  setLowKill(name: "A" | "B", on: boolean): void {
    const f = this.deck(name)?.lowKill;
    if (!f) return;
    const t = this.ctx ? this.ctx.currentTime : 0;
    f.frequency.setTargetAtTime(on ? 110 : 20, t, 0.004);
  }

  /** SYNC: ajusta el playbackRate del deck para sonar exactamente al BPM del opuesto. */
  setSync(name: "A" | "B", rate: number): boolean {
    const h = this.deck(name);
    if (!h) return false;
    const clamped = Math.max(0.5, Math.min(2.0, rate));
    h.el.playbackRate = clamped;
    try {
      h.el.preservesPitch = true;
    } catch {
      /* navegadores sin soporte */
    }
    return true;
  }

  /**
   * Alinea la fase de beat del deck `name` con el deck maestro (A), sin tocar
   * el playbackRate: desplaza el punto de reproducción del esclavo para que su
   * pulso (periodo = 60/BPM) coincida con el pulso actual del maestro. Así
   * ambas canciones se pre-escuchan compaginadas, sin desfase de beat.
   * Devuelve el desplazamiento aplicado en segundos (0 si no hay nada que
   * corregir o los BPM no son válidos).
   */
  alignPhase(name: "A" | "B", ownBpm: number, masterBpm: number): number {
    const slave = this.deck(name);
    const master = this.deckA; // el deck maestro es siempre A
    if (!slave || !master || slave === master) return 0;
    if (!ownBpm || !masterBpm || ownBpm <= 0 || masterBpm <= 0) return 0;
    const slavePeriod = 60 / ownBpm;
    const masterPeriod = 60 / masterBpm;
    const slavePhase = ((slave.el.currentTime % slavePeriod) + slavePeriod) % slavePeriod;
    const masterPhase = ((master.el.currentTime % masterPeriod) + masterPeriod) % masterPeriod;
    let shift = masterPhase - slavePhase;
    // Camino más corto dentro de un beat (evita saltos de casi un beat entero).
    if (shift > slavePeriod / 2) shift -= slavePeriod;
    else if (shift < -slavePeriod / 2) shift += slavePeriod;
    if (Math.abs(shift) < 0.005) return 0;
    slave.el.currentTime += shift;
    return shift;
  }

  clearSync(name: "A" | "B"): void {
    const h = this.deck(name);
    if (!h) return;
    h.el.playbackRate = 1;
  }

  stopAll(): void {
    this.deckA?.el.pause();
    this.deckB?.el.pause();
  }
}

export const audioEngine = new AudioEngine();