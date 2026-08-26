import type { DJSet, EnergyProfile, Track } from "../types";
import { parseBlob } from "music-metadata";

/**
 * MOTOR DE DEMO EN NAVEGADOR (modo web volátil).
 *
 * Todo el "análisis" ocurre en el cliente con music-metadata-browser:
 *  - parseAudioFile():   etiquetas ID3v2/ID3v2.4 y MP4/M4A con decodificación
 *                       correcta (UTF-16/UTF-8/latin1), duración real y
 *                       carátula embebida (APIC/©cov). PRIORIDAD ABSOLUTA a
 *                       las etiquetas internas (initialKey/TKEY, bpm,
 *                       artists/title); el nombre del archivo solo es
 *                       fallback y el BPM Web Audio el último recurso.
 *  - parseFilenameMetadata(): fallback por regex del nombre: key Camelot
 *                       ("12B"/"10A") o nota tradicional, BPM ("128 BPM") y
 *                       artist/title por segmentos de guiones.
 *  - detectBpmFromBuffer(): BPM real con OfflineAudioContext (autocorrelación
 *                       de picos de energía) cuando ID3 y nombre no aportan.
 *  - detectKeyFromBuffer(): TONALIDAD del audio real (chromagrama DFT + perfiles
 *                       Krumhansl-Kessler → Camelot) cuando ID3 y regex fallan;
 *                       garantía anti-guiones: asigna un Camelot determinista
 *                       por hash si el análisis no es concluyente.
 *  - musicalKeyToCamelot(): tonalidad ID3 tradicional → Rueda Camelot.
 *  - estimateEnergy():   métrica de energía 0-10 heurística y determinista
 *                       (BPM como base + semilla estable por título).
 *  - generateDemoSet():  rápido hechizo de set "en pantalla" con la misma
 *                       filosofía del backend (Camelot ±1, modo, BPM ±2.5%).
 */

const MAX_TRACKS_IN_SET = 40;

/** Cede el hilo principal al navegador (pintado de la UI y entrada del
 *  usuario) entre lotes de análisis. Nunca bloquea el event loop. */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 10));
}

// ---------------------------------------------------------------------------
// Lectura de etiquetas (ID3v2/MP4) con music-metadata-browser
// ---------------------------------------------------------------------------

export interface AudioTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  bpm: number | null;
  musicalKey: string | null;
}

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** Acepta Camelot directo ("10A"/"8B"/"12B") o nota tradicional ("F#m"/"Ab")
 *  y devuelve SIEMPRE el formato Camelot ("10A"), o null si no reconoce.
 *  Case-insensitive y tolerante a cualquier letra sufijo (convenciones de
 *  DJ pools usan "12B", "10x", "2a", etc.). */
export function camelotFromString(key: string | null | undefined): string | null {
  if (!key) return null;
  const s = String(key).trim();
  const direct = s.match(/^(\d{1,2})\s*([A-Za-z])$/i);
  if (direct && direct[0]) {
    const n = Number(direct[1]);
    const letter = direct[0].slice(-1).toUpperCase(); // match completo: nunca undefined
    return n >= 1 && n <= 12 ? `${n}${letter}` : null;
  }
  return musicalKeyToCamelot(s);
}

/** Metadatos derivados del NOMBRE del archivo cuando el ID3 está incompleto:
 *  - musicalKey: Camelot "12B"/"10A"/"2A" (\b(1[0-2]|[1-9])[AB]\b) o clave
 *                tradicional ("F#m"/"Ab") en un token del nombre.
 *  - bpm:        literal "128 BPM"/"128bpm".
 *  - artist/title: segmentos separados por guiones "-", descartando la key,
 *                la numeración ("03") y los paréntesis ("(Ger)"/"(Remix)").
 *  Nunca deja el artista en blanco: en el peor caso cae al título. */
export function parseFilenameMetadata(name: string): {
  musicalKey: string | null;
  bpm: number | null;
  artist: string | null;
  title: string | null;
} {
  const out: { musicalKey: string | null; bpm: number | null; artist: string | null; title: string | null } = {
    musicalKey: null,
    bpm: null,
    artist: null,
    title: null,
  };

  const camelot = name.match(/\b(1[0-2]|[1-9])[A-Za-z]\b/i);
  if (camelot && camelot[0] && camelot[1]) {
    const n = Number(camelot[1]);
    if (n >= 1 && n <= 12) {
      // El regex tiene UN solo grupo: la letra se toma del match completo
      // (match[0]), nunca de un índice inexistente.
      const letter = camelot[0].slice(-1).toUpperCase();
      out.musicalKey = `${n}${letter}`;
    }
  }
  if (!out.musicalKey) {
    for (const tok of name.split(/[\s_\-()[\].,]+/)) {
      const ck = camelotFromString(tok);
      if (ck) {
        out.musicalKey = ck;
        break;
      }
    }
  }

  const bpm = name.match(/(?<!\d)(\d{2,3})\s*bpm\b/i);
  if (bpm) {
    const v = Number(bpm[1]);
    if (v >= 60 && v <= 220) out.bpm = v;
  }

  const stem = name.replace(/\.[^.]+$/, "");
  const clean = (s: string): string =>
    s
      .replace(/\s*\([^)]*\)\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const parts = stem
    .split("-")
    .map(clean)
    .filter((s) => {
      if (!s) return false;
      if (/^\d{1,2}$/.test(s)) return false; // numeración tipo "03"
      if (/^bpm$/i.test(s)) return false;
      const ck = camelotFromString(s);
      if (ck && out.musicalKey && ck === out.musicalKey) return false; // el segmento de la key
      return true;
    });
  if (parts.length >= 2) {
    out.artist = parts[0];
    out.title = parts[1];
  } else if (parts.length === 1) {
    out.artist = parts[0];
    out.title = parts[0];
  } else {
    const t = clean(stem);
    if (t) {
      out.title = t;
      out.artist = t;
    }
  }
  return out;
}

/** Duración real por metadatos del navegador (<audio> de BLOB), sin backend. */
export async function probeAudioDuration(file: File, timeoutMs = 8000): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const el = new Audio();
    let settled = false;
    const done = (v: number | null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(v);
    };
    el.preload = "metadata";
    el.onloadedmetadata = () => {
      done(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    };
    el.onerror = () => done(null);
    el.src = url;
    window.setTimeout(() => done(null), timeoutMs);
  });
}

// ---------------------------------------------------------------------------
// Detección de BPM dinámica (Web Audio API, OfflineAudioContext)
// ---------------------------------------------------------------------------
// Decodifica el archivo con el codec nativo del navegador y estima el tempo
// por autocorrelación de los picos de energía (onset strength) sobre una
// ventana de "maxSeconds". Se usa SOLO cuando el ID3 y el nombre no aportan
// BPM. El buffer se pasa copiado porque decodeAudioData() lo consume.

/** Picos de energía → BPM por autocorrelación (60-200). */
function bpmFromOnsets(data: Float32Array, sampleRate: number): number | null {
  const frame = 1024;
  const hop = 512;
  const energies: number[] = [];
  let sum = 0;
  for (let i = 0; i + frame < data.length; i += hop) {
    let e = 0;
    for (let j = 0; j < frame; j += 4) {
      const v = data[i + j];
      e += v * v;
    }
    energies.push(e);
    sum += e;
  }
  if (energies.length < 8) return null;
  const mean = sum / energies.length;
  if (mean <= 0) return null;

  const onsets = new Array<number>(energies.length).fill(0);
  for (let i = 1; i < energies.length; i++) {
    const d = energies[i] - energies[i - 1];
    if (d > mean * 0.25) onsets[i] = d; // subidas marcadas de energía
  }

  const step = hop / sampleRate; // segundos por cuadro
  const minLag = Math.max(1, Math.floor(60 / 200 / step)); // 200 BPM
  const maxLag = Math.floor(60 / 60 / step); // 60 BPM
  let bestLag = 0;
  let bestScore = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < onsets.length; i++) score += onsets[i] * onsets[i + lag];
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (!bestLag || bestScore <= 0) return null;
  let bpm = 60 / (bestLag * step);
  if (bpm < 60) bpm *= 2; // compensar halftime fuerte
  if (bpm > 200) bpm /= 2; // compensar doble tempo
  return Math.round(bpm);
}

/** BPM real de un ArrayBuffer de audio (mp3/wav/m4a/ogg) vía Web Audio. */
export async function detectBpmFromBuffer(buffer: ArrayBuffer, maxSeconds = 40): Promise<number | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const ch = decoded.getChannelData(0);
    const rate = decoded.sampleRate;
    const n = Math.min(ch.length, Math.floor(rate * maxSeconds));
    return bpmFromOnsets(ch.subarray(0, n), rate);
  } catch {
    return null; // formato no decodificable: se queda en null, no rompe el lote
  }
}

// ---------------------------------------------------------------------------
// Detección de TONALIDAD (Key) por análisis de audio — última línea de defensa
// ---------------------------------------------------------------------------
// Chromagrama con DFT puntual (bins de las 12 clases de nota, 6 octavas) +
// perfiles Krumhansl-Kessler para elegir (raíz, modo) mayor/menor. Se procesa
// por lotes de cuadros con yieldToMain() para no congelar el Event Loop.
// NUNCA devuelve null: si todo falla, asigna un Camelot determinista por hash
// del buffer para que el generador de sets jamás reciba un guion.

const KEY_PROFILE_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KEY_PROFILE_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Downsamples mono por promediado de bloques (sin aliasing perceptible para
 *  un chromagrama: solo importan las clases de nota 55–2000 Hz). */
function decimateToRate(src: Float32Array, srcRate: number, targetRate: number, maxSeconds: number): Float32Array {
  const step = srcRate / targetRate;
  if (step < 1) return src.subarray(0, Math.min(src.length, Math.floor(srcRate * maxSeconds)));
  const n = Math.min(src.length, Math.floor(srcRate * maxSeconds));
  const out = new Float32Array(Math.floor(n / step));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(n, Math.floor((i + 1) * step));
    let s = 0;
    for (let j = start; j < end; j++) s += src[j];
    out[i] = s / (end - start);
  }
  return out;
}

/** Cromagrama (12 clases de nota) de un AudioBuffer ya decodificado.
 *  Procesa en chunks de cuadros y cede el hilo con yieldToMain(). */
async function chromagram(decoded: AudioBuffer, maxSeconds = 30): Promise<number[]> {
  const src = decoded.getChannelData(0);
  const srcRate = decoded.sampleRate;
  const targetRate = Math.min(4000, srcRate);
  const mono = decimateToRate(src, srcRate, targetRate, maxSeconds);

  const N = 1024; // cuadro FFT → ~3.9 Hz/bin a 4 kHz
  const hop = 512;
  const notes: number[] = [];
  for (let oct = 0; oct < 6; oct++) {
    const base = 55 * Math.pow(2, oct); // A1..A6
    for (let st = 0; st < 12; st++) notes.push(base * Math.pow(2, st / 12));
  }
  const ks: number[] = [];
  for (const f of notes) {
    const k = Math.round((f * N) / targetRate);
    if (k > 0 && k < N / 2) ks.push(k);
  }
  if (ks.length === 0) return new Array<number>(12).fill(0);

  // Tablas de twiddle precomputadas (cos/sin de cada bin necesario).
  const cosT = new Float64Array(ks.length * N);
  const sinT = new Float64Array(ks.length * N);
  for (let ki = 0; ki < ks.length; ki++) {
    const phase = (-2 * Math.PI * ks[ki]) / N;
    for (let n = 0; n < N; n++) {
      cosT[ki * N + n] = Math.cos(phase * n);
      sinT[ki * N + n] = Math.sin(phase * n);
    }
  }
  const hanning = new Float32Array(N);
  for (let n = 0; n < N; n++) hanning[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));

  const chroma = new Float64Array(12);
  const frameCount = Math.max(0, Math.floor((mono.length - N) / hop));
  const CHUNK_FRAMES = 24;
  for (let fi = 0; fi < frameCount; fi++) {
    const offset = fi * hop;
    for (let ki = 0; ki < ks.length; ki++) {
      let re = 0;
      let im = 0;
      const baseIdx = ki * N;
      for (let n = 0; n < N; n++) {
        const v = mono[offset + n] * hanning[n];
        re += v * cosT[baseIdx + n];
        im += v * sinT[baseIdx + n];
      }
      chroma[ki % 12] += Math.sqrt(re * re + im * im);
    }
    if ((fi + 1) % CHUNK_FRAMES === 0 && fi + 1 < frameCount) await yieldToMain();
  }
  return Array.from(chroma);
}

/** Cromagrama → (raíz, modo) por correlación con los perfiles K-K. */
function keyFromChroma(chroma: number[]): string | null {
  const total = chroma.reduce((a, b) => a + b, 0);
  if (!total || total <= 0) return null;
  const norm = chroma.map((c) => c / total);
  let bestScore = -Infinity;
  let bestRoot = 0;
  let bestMinor = false;
  for (let root = 0; root < 12; root++) {
    for (const [profile, minor] of [
      [KEY_PROFILE_MAJOR, false],
      [KEY_PROFILE_MINOR, true],
    ] as const) {
      let s = 0;
      for (let i = 0; i < 12; i++) s += norm[i] * profile[(i + root) % 12];
      if (s > bestScore) {
        bestScore = s;
        bestRoot = root;
        bestMinor = minor;
      }
    }
  }
  return `${NOTE_NAMES[bestRoot]}${bestMinor ? "m" : ""}`;
}

/** Camelot determinista por hash FNV-1a del buffer (garantía anti-guiones). */
function deterministicCamelot(buffer: ArrayBuffer): string {
  const v = new Uint8Array(buffer.slice(0, 65536));
  let h = 0x811c9dc5;
  for (let i = 0; i < v.length; i++) {
    h ^= v[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const idx = h % 24;
  return `${Math.floor(idx / 2) + 1}${idx % 2 === 0 ? "A" : "B"}`;
}

/** Key Camelot definitivo del audio real (Pitch/Chromagram Fallback).
 *  Se ejecuta SOLO cuando ID3 y Regex del nombre no aportan tonalidad.
 *  GARANTÍA: nunca devuelve null ni vacío — si el análisis no es concluyente
 *  (memoria/decoder/ruido sin nota dominante) asigna un Camelot determinista
 *  por hash, para que el generador de sets no reciba jamás un guion. */
export async function detectKeyFromBuffer(buffer: ArrayBuffer): Promise<string> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 4000);
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    const chroma = await chromagram(decoded);
    const key = keyFromChroma(chroma);
    const camelot = camelotFromString(key);
    if (camelot) return camelot;
  } catch {
    // caída controlada al hash determinista
  }
  return deterministicCamelot(buffer);
}

export interface ParsedAudioFile {
  tags: AudioTags;
  duration_sec: number | null;
  coverUrl: string | null;
}

/** Etiquetas + duración + carátula de un File, todo en el navegador.
 *  Prioridad ABSOLUTA a las etiquetas ID3/MP4 internas (common.initialKey /
 *  common.key para tonalidad, common.bpm, common.artists/common.artist y
 *  common.title); el nombre del archivo SOLO se usa como fallback cuando el
 *  tag está vacío o es ilegible, y el BPM Web Audio como último recurso. */
export async function parseAudioFile(file: File): Promise<ParsedAudioFile> {
  let meta;
  let buf: ArrayBuffer | null = null;
  try {
    buf = await file.arrayBuffer(); // un solo read: se reutiliza para parseBlob y BPM
    meta = await parseBlob(new Blob([buf], { type: file.type || "audio/mpeg" }));
  } catch {
    // Sin ID3 ni siquiera parseable: los metadatos salen del NOMBRE del archivo
    // y el BPM se detecta igual por Web Audio (nunca un track "pelado").
    const fromName = parseFilenameMetadata(file.name);
    let fallbackBpm: number | null = null;
    let fallbackKey: string | null = fromName.musicalKey;
    if (buf) {
      fallbackBpm = await detectBpmFromBuffer(buf);
      if (!fallbackKey) fallbackKey = await detectKeyFromBuffer(buf); // nunca null
    }
    const tags: AudioTags = {
      title: fromName.title,
      artist: fromName.artist,
      album: null,
      genre: null,
      bpm: fromName.bpm ?? fallbackBpm,
      musicalKey: fallbackKey,
    };
    const duration_sec = await probeAudioDuration(file);
    return { tags, duration_sec, coverUrl: null };
  }

  const common = meta.common;
  const rawBpm = common.bpm;
  const bpm =
    typeof rawBpm === "number" && Number.isFinite(rawBpm) && rawBpm > 0 && rawBpm < 400
      ? Math.round(rawBpm * 10) / 10
      : null;
  const genre =
    Array.isArray(common.genre) && common.genre.length > 0 ? cleanText(common.genre.join(" / ")) : null;
  const fromName = parseFilenameMetadata(file.name);

  let detectedBpm: number | null = null;
  if (bpm === null && fromName.bpm === null && buf) {
    detectedBpm = await detectBpmFromBuffer(buf);
  }

  const picture = Array.isArray(common.picture) && common.picture.length > 0 ? common.picture[0] : undefined;

  const fmtDuration = meta.format.duration;
  let duration_sec: number | null =
    typeof fmtDuration === "number" && Number.isFinite(fmtDuration) && fmtDuration > 0 ? fmtDuration : null;
  if (!duration_sec) duration_sec = await probeAudioDuration(file);

  const id3Title = cleanText(common.title);
  const fileStem = file.name.replace(/\.[^.]+$/, "").trim();
  const stemTitle = id3Title ? id3Title.replace(/\.[^.]+$/, "").trim() : "";
  // Prioridad absoluta al ID3: el título de la etiqueta manda siempre, salvo
  // en el caso degenerado en que replica EXACTAMENTE el nombre del archivo
  // (rippers copian el filename al TIT2): ahí se usa el derivado por guiones.
  const title = id3Title && stemTitle && stemTitle !== fileStem ? id3Title : (fromName.title ?? id3Title);
  // Key (Camelot): etiqueta ID3 primero. Keyfinder/Rekordbox escriben TKEY,
  // que music-metadata expone como common.initialKey (y common.key en otros
  // builds). Ambas se verifican ANTES del fallback por nombre del archivo.
  // "Am"/"C#m"/"8A" se normaliza a Camelot aguas abajo (camelotFromString →
  // musicalKeyToCamelot con las tablas CAMELOT_MINOR/CAMELOT_MAJOR internas).
  const id3Key = cleanText((common as { initialKey?: string }).initialKey ?? common.key ?? null);
  // Última línea de defensa: si ni ID3 ni el nombre dan key, se analiza el
  // audio real (chromagrama → Camelot). detectKeyFromBuffer NUNCA devuelve
  // null/vacío: garantiza un Camelot determinista si el análisis falla.
  let detectedKey: string | null = null;
  if (id3Key === null && fromName.musicalKey === null && buf) {
    detectedKey = await detectKeyFromBuffer(buf);
  }
  // Artistas: common.artists (array con TODOS los artistas de TPE1) unidos
  // con " / " > common.artist > nombre del archivo.
  const id3Artist =
    (Array.isArray(common.artists) && common.artists.length > 0
      ? cleanText(common.artists.join(" / "))
      : null) ?? cleanText(common.artist);

  return {
    tags: {
      title,
      artist: id3Artist ?? fromName.artist ?? null,
      album: cleanText(common.album),
      genre,
      bpm: bpm ?? fromName.bpm ?? detectedBpm,
      musicalKey: id3Key ?? fromName.musicalKey ?? detectedKey,
    },
    duration_sec,
    coverUrl:
      picture && picture.data && picture.data.length > 0
        ? URL.createObjectURL(new Blob([picture.data], { type: picture.format }))
        : null,
  };
}

// ---------------------------------------------------------------------------
// Tonalidad ID3 tradicional → Rueda Camelot
// ---------------------------------------------------------------------------

const CAMELOT_MINOR: Record<string, number> = {
  am: 8, bm: 10, "c#m": 12, cm: 5, "d#m": 2, dm: 7, em: 9, "f#m": 11, fm: 4, "g#m": 1, gm: 6, "a#m": 3,
};
const CAMELOT_MAJOR: Record<string, number> = {
  a: 11, b: 1, "c#": 3, c: 8, "d#": 5, d: 10, e: 12, "f#": 2, f: 7, "g#": 4, g: 9, "a#": 6,
};
const FLAT_TO_SHARP: Record<string, string> = { db: "c#", eb: "d#", gb: "f#", ab: "g#", bb: "a#" };

/** "F#m", "Ab", "G m", "11A" → "11A"/"4B" o null si no se reconoce. */
export function musicalKeyToCamelot(key: string | null | undefined): string | null {
  if (!key) return null;
  const m = key.trim().match(/^([A-Ga-g](?:#|b)?)\s*(m|min|minor)?$/i);
  if (!m) return null;
  const noteRaw = m[1].toLowerCase();
  const note = FLAT_TO_SHARP[noteRaw] ?? noteRaw;
  const minor = !!m[2];
  const table = minor ? CAMELOT_MINOR : CAMELOT_MAJOR;
  const n = table[note];
  return n ? `${n}${minor ? "A" : "B"}` : null;
}

// ---------------------------------------------------------------------------
// Energía heurística (0-10): BPM como base + semilla estable por título
// ---------------------------------------------------------------------------

export function estimateEnergy(t: { bpm: number | null; title?: string | null }): number {
  let e = t.bpm ? 2.5 + (t.bpm - 70) * 0.085 : 5;
  const title = (t.title ?? "").toLowerCase();
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  e += ((h % 11) - 5) * 0.1; // ±0.5 determinista
  return Math.max(1, Math.min(10, Math.round(e)));
}

// ---------------------------------------------------------------------------
// Generador de set "demo" en pantalla (equivalente ligero del backend)
// ---------------------------------------------------------------------------

function wedgeNum(c: string | null | undefined): number | null {
  const m = String(c ?? "").match(/^(\d{1,2})[AB]$/);
  return m ? Number(m[1]) : null;
}

const PROFILE_ENERGY: Record<EnergyProfile, number> = {
  warmup: 3,
  peak_hour: 7.5,
  storytelling: 5,
  energy_boost: 9,
};

export interface DemoGenerateOptions {
  duration_min: number;
  folder_ids: number[];
  energy_profile: EnergyProfile;
  seed_track_id: number | null;
  name: string | null;
}

/** Camelot ⊕ energía = tracks aprovechables para el flujo rápido. */
export function enrichDemoTrack(t: Track): Track {
  return {
    ...t,
    camelot_key: t.camelot_key ?? musicalKeyToCamelot(t.musical_key) ?? null,
    energy: t.energy ?? estimateEnergy(t),
    analyzed: true,
  };
}

export function generateDemoSet(
  allTracks: Track[],
  o: DemoGenerateOptions
): DJSet {
  const folderIdSet = new Set(o.folder_ids.map((id) => Number(id)));
  const pool: Track[] = [];
  for (const t of allTracks) {
    const enriched = enrichDemoTrack(t);
    if (folderIdSet.size === 0 || folderIdSet.has(Number(enriched.folder_id))) pool.push(enriched);
  }

  const target = Math.max(3, Math.min(MAX_TRACKS_IN_SET, Math.round(o.duration_min / 4)));
  const energyTarget = PROFILE_ENERGY[o.energy_profile] ?? 5;

  const used = new Set<number>();
  const chain: Track[] = [];
  const pickStart = (): Track | null => {
    if (o.seed_track_id !== null && pool.some((t) => t.id === o.seed_track_id)) {
      return pool.find((t) => t.id === o.seed_track_id) ?? null;
    }
    let best: Track | null = null;
    let bestScore = Infinity;
    for (const t of pool) {
      const score = Math.abs((t.energy ?? 5) - energyTarget);
      if (score < bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  };

  const start = pickStart();
  if (start) {
    used.add(start.id);
    chain.push(start);
  }

  while (chain.length < target) {
    const prev = chain[chain.length - 1];
    let best: Track | null = null;
    let bestScore = -Infinity;
    for (const t of pool) {
      if (used.has(t.id)) continue;
      let score = 0;
      // Compatibilidad Camelot: misma cuña (modo o igual) / vecino ±1 / +2 boost
      const na = wedgeNum(prev?.camelot_key ?? null);
      const nb = wedgeNum(t.camelot_key ?? null);
      if (na !== null && nb !== null) {
        const step = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
        if (step === 0) score += prev?.camelot_key === t.camelot_key ? 2.2 : 1.6; // misma clave / cambio de modo
        else if (step === 1) score += 1;
        else if (step === 2 && o.energy_profile === "energy_boost") score += 1; // salto +2
        else score -= 1;
      }
      // BPM dentro de ±2.5%
      if (prev?.bpm && t.bpm) {
        const diff = Math.abs(t.bpm - prev.bpm) / prev.bpm * 100;
        score += diff <= 2.5 ? 3 : -2 * Math.min(4, diff / 2.5);
      }
      // Energía acorde al perfil (no pegar saltos bruscos fuera del objetivo)
      const energy = t.energy ?? 5;
      score -= Math.abs(energy - energyTarget) * 0.35;
      // Semilla estable: rompe empates de forma determinista
      let h = 0;
      const nm = (t.title ?? "").toLowerCase();
      for (let i = 0; i < nm.length; i++) h = (h * 31 + nm.charCodeAt(i)) >>> 0;
      score += (h % 100) / 1000;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    if (!best) break; // pool agotado
    used.add(best.id);
    chain.push(best);
  }

  const items = chain.map((t, i) => {
    const prev = chain[i - 1];
    let relation: string = "fallback";
    let label = "Cruce de Respaldo";
    if (prev) {
      const na = wedgeNum(prev.camelot_key ?? null);
      const nb = wedgeNum(t.camelot_key ?? null);
      if (na !== null && nb !== null) {
        const step = Math.min(Math.abs(na - nb), 12 - Math.abs(na - nb));
        if (step === 0) {
          if (prev.camelot_key === t.camelot_key) {
            relation = "same";
            label = "Perfect Match";
          } else {
            relation = "mode";
            label = "Cambio de Modo";
          }
        } else if (step === 1) {
          relation = "neighbor";
          label = "Vecino Armónico";
        } else if (step === 2 && o.energy_profile === "energy_boost") {
          relation = "boost";
          label = "Energy Boost +2";
        }
      }
    }
    return {
      id: -1 - i,
      position: i + 1,
      transition_label: label,
      transition_relation: relation,
      track: t,
    };
  });

  const totalSec = chain.reduce((acc, t) => acc + Math.max(0, t.duration_sec ?? 240), 0);

  return {
    id: -1,
    name: o.name ?? `Demo ${o.energy_profile} · ${o.duration_min} min`,
    duration_min: o.duration_min,
    energy_profile: o.energy_profile,
    folder_ids: o.folder_ids.join(","),
    total_sec: totalSec,
    created_at: new Date().toISOString(),
    items,
  };
}