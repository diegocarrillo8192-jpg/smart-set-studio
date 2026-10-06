/*
 * Phase-vocoder pitch-shifter (KEY LOCK) como AudioWorklet.
 *
 * `AudioBufferSourceNode` no preserva el tono al cambiar `playbackRate`
 * (comportamiento "vinyl"): acelerar sube el tono. Este worklet deshace esa
 * variación de pitch: recibe la salida del source (que ya va a la velocidad
 * deseada `r` y por tanto con el tono escalado por `r`) y aplica un
 * pitch-shift por factor `1/r`, devolviendo el tono original SIN alterar el
 * tempo (hop de síntesis == hop de análisis).
 *
 *   · `rate` AudioParam = factor de pitch-shift (p). Para Key Lock: p = 1/r.
 *   · Algoritmo: phase vocoder clásico (análisis FFT → corrección de fase →
 *     síntesis IFFT con acumulador de fase escalado por p).
 *   · Ventana seno, N=1024, hop=N/4 (75 % de solape). OLA de sin² a 75 %
 *     suma 2 → la síntesis se normaliza por 0.5 (ganancia unidad).
 *   · Mensaje `{ type: 'reset' }` para vaciar el estado en cada seek.
 */

const N = 1024;
const HA = 256;
const TWO_PI = Math.PI * 2;
const BINS = N / 2 + 1;

function makeWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = Math.sin((Math.PI * i) / n);
  return w;
}

function makeBitRev(n) {
  const bits = Math.round(Math.log2(n));
  const br = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    let x = i;
    for (let b = 0; b < bits; b++) {
      r = (r << 1) | (x & 1);
      x >>= 1;
    }
    br[i] = r;
  }
  return br;
}

function makeTwiddles(n) {
  const cos = new Float32Array(n);
  const sin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cos[i] = Math.cos((TWO_PI * i) / n);
    sin[i] = Math.sin((TWO_PI * i) / n);
  }
  return { cos, sin };
}

function fft(re, im, n, bitRev, cosTab, sinTab, invert) {
  for (let i = 0; i < n; i++) {
    const j = bitRev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const tabStep = n / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const k = j * tabStep;
        const wr = cosTab[k];
        const wi = invert ? sinTab[k] : -sinTab[k];
        const a = i + j;
        const b = a + half;
        const tre = re[b] * wr - im[b] * wi;
        const tim = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tre;
        im[b] = im[a] - tim;
        re[a] += tre;
        im[a] += tim;
      }
    }
  }
  if (invert) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

class PhaseVocoderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      {
        name: 'rate',
        defaultValue: 1,
        minValue: 0.25,
        maxValue: 4,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.window = makeWindow(N);
    this.bitRev = makeBitRev(N);
    this.twiddles = makeTwiddles(N);
    this.chans = new Map();
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.type === 'reset') {
        for (const ch of this.chans.values()) this.resetChan(ch);
      }
    };
  }

  ensureChan(c) {
    let ch = this.chans.get(c);
    if (!ch) {
      ch = {
        inFifo: new Float32Array(N),
        inFill: 0,
        toNext: N,
        prevPhase: new Float32Array(BINS),
        phaseAccum: new Float32Array(BINS),
        outRing: new Float32Array(N * 2),
        synthPos: 0,
        outRead: 0,
        re: new Float32Array(N),
        im: new Float32Array(N),
      };
      this.chans.set(c, ch);
    }
    return ch;
  }

  resetChan(ch) {
    ch.inFifo.fill(0);
    ch.inFill = 0;
    ch.toNext = N;
    ch.prevPhase.fill(0);
    ch.phaseAccum.fill(0);
    ch.outRing.fill(0);
    ch.synthPos = 0;
    ch.outRead = 0;
  }

  analyze(ch, rate) {
    const re = ch.re;
    const im = ch.im;
    const win = this.window;
    for (let k = 0; k < N; k++) {
      re[k] = ch.inFifo[k] * win[k];
      im[k] = 0;
    }
    fft(re, im, N, this.bitRev, this.twiddles.cos, this.twiddles.sin, false);

    const prev = ch.prevPhase;
    const accum = ch.phaseAccum;
    for (let k = 0; k < BINS; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const phase = Math.atan2(im[k], re[k]);
      const omega = (TWO_PI * k) / N;
      let delta = phase - prev[k] - omega * HA;
      delta -= Math.round(delta / TWO_PI) * TWO_PI;
      const trueOmega = omega + delta / HA;
      accum[k] += trueOmega * rate * HA;
      const outPhase = accum[k];
      re[k] = mag * Math.cos(outPhase);
      im[k] = mag * Math.sin(outPhase);
      prev[k] = phase;
    }
    for (let k = 1; k < N / 2; k++) {
      const src = N - k;
      re[src] = re[k];
      im[src] = -im[k];
    }
    im[0] = 0;
    im[N / 2] = 0;

    fft(re, im, N, this.bitRev, this.twiddles.cos, this.twiddles.sin, true);

    const ring = ch.outRing;
    const pos = ch.synthPos % (N * 2);
    for (let k = 0; k < N; k++) {
      const idx = pos + k;
      ring[idx >= N * 2 ? idx - N * 2 : idx] += re[k] * win[k] * 0.5;
    }
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0 || output.length === 0) return true;

    const rateParam = parameters['rate'];
    const rate = rateParam && rateParam.length > 0 ? rateParam[0] : 1;

    const nCh = Math.min(input.length, output.length);

    for (let c = 0; c < nCh; c++) {
      const src = input[c];
      const dst = output[c];
      if (!src || !dst) continue;
      const ch = this.ensureChan(c);
      const len = src.length;

      let i = 0;
      while (i < len) {
        const take = Math.min(ch.toNext, len - i);
        const keep = ch.inFill;
        if (keep + take <= N) {
          ch.inFifo.set(src.subarray(i, i + take), keep);
          ch.inFill = keep + take;
        } else {
          const shift = keep + take - N;
          ch.inFifo.copyWithin(0, shift, keep);
          ch.inFifo.set(src.subarray(i, i + take), keep - shift);
          ch.inFill = N;
        }
        i += take;
        ch.toNext -= take;
        if (ch.toNext === 0) {
          this.analyze(ch, rate);
          ch.synthPos += HA;
          ch.toNext = HA;
        }
      }

      let produced = 0;
      const ring = ch.outRing;
      const ringSize = N * 2;
      while (produced < len && ch.outRead < ch.synthPos) {
        const idx = ch.outRead % ringSize;
        dst[produced] = ring[idx];
        ring[idx] = 0;
        ch.outRead++;
        produced++;
      }
      for (; produced < len; produced++) dst[produced] = 0;
    }

    return true;
  }
}

registerProcessor('phase-vocoder', PhaseVocoderProcessor);
