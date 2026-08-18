import type { DJSet, EnergyProfile, Track } from "../types";

/**
 * MOTOR DE DEMO EN NAVEGADOR (modo web volátil).
 *
 * Todo el "análisis" ocurre en el cliente con JavaScript puro, sin backend:
 *  - parseAudioTags():  ID3v2 (MP3) y átomos MP4/M4A (©nam/©ART/©alb/tmpo)
 *                       leyendo SOLO los primeros ~128 KB del archivo.
 *  - musicalKeyToCamelot(): tonalidad ID3 tradicional → Rueda Camelot.
 *  - estimateEnergy():   métrica de energía 0-10 heurística y determinista
 *                       (BPM como base + semilla estable por título).
 *  - generateDemoSet():  rápido hechizo de set "en pantalla" con la misma
 *                       filosofía del backend (Camelot ±1, modo, BPM ±2.5%).
 */

const TAG_SLICE = 128 * 1024;
const MAX_TRACKS_IN_SET = 40;

// ---------------------------------------------------------------------------
// Lectura de etiquetas (ID3v2 de MP3)
// ---------------------------------------------------------------------------

function syncsafe32(b: Uint8Array, o: number): number {
  return (
    ((b[o] & 0x7f) << 21) |
    ((b[o + 1] & 0x7f) << 14) |
    ((b[o + 2] & 0x7f) << 7) |
    (b[o + 3] & 0x7f)
  );
}

function u32(b: Uint8Array, o: number): number {
  return (
    ((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) | ((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff)
  );
}

/** Texto de un frame ID3v2 respetando el byte de encoding (0/1/2/3). */
function decodeId3Text(b: Uint8Array, start: number, end: number): string {
  const enc = b[start];
  let raw = b.subarray(start + 1, end);
  if (raw.length === 0) return "";
  try {
    if (enc === 1 || enc === 2) {
      // UTF-16 con/sin BOM (ID3v2 usa big-endian): quitar BOM y NUL final.
      if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) raw = raw.subarray(2);
      else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) raw = raw.subarray(2);
      let trimmed = raw;
      while (trimmed.length >= 2 && trimmed[trimmed.length - 1] === 0) trimmed = trimmed.subarray(0, trimmed.length - 1);
      return new TextDecoder("utf-16be").decode(trimmed).replace(/\u0000+$/g, "").trim();
    }
    if (enc === 3) {
      return new TextDecoder("utf-8").decode(raw).replace(/\u0000+$/g, "").trim();
    }
    // ISO-8859-1 / latin1
    let out = "";
    for (let i = 0; i < raw.length; i++) out += String.fromCharCode(raw[i]);
    return out.replace(/\u0000+$/g, "").trim();
  } catch {
    return "";
  }
}

export interface AudioTags {
  title: string | null;
  artist: string | null;
  album: string | null;
  bpm: number | null;
  musicalKey: string | null;
}

function emptyTags(): AudioTags {
  return { title: null, artist: null, album: null, bpm: null, musicalKey: null };
}

/** Frames de texto ID3v2: TIT2/TPE1/TALB/TKEY/TBPM. */
function readId3TextFrames(b: Uint8Array): AudioTags {
  const out = emptyTags();
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return out;
  const ver = b[3];
  if (ver !== 3 && ver !== 4) return out;
  const tagSize = syncsafe32(b, 6);
  const end = Math.min(b.length, 10 + tagSize);
  const flags = b[5];
  let p = 10;
  if (flags & 0x40) {
    const esz =
      ver === 3
        ? ((b[p] & 0xff) << 24) | ((b[p + 1] & 0xff) << 16) | ((b[p + 2] & 0xff) << 8) | (b[p + 3] & 0xff)
        : syncsafe32(b, p);
    p += 4 + esz;
  }
  while (p + 10 <= end) {
    if (b[p] === 0) break; // padding
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const fsz =
      ver === 4
        ? syncsafe32(b, p + 4)
        : ((b[p + 4] & 0xff) << 24) | ((b[p + 5] & 0xff) << 16) | ((b[p + 6] & 0xff) << 8) | (b[p + 7] & 0xff);
    if (fsz <= 0) break;
    const fstart = p + 10;
    if (fsz + fstart > b.length) break;
    if (id === "TIT2") out.title = decodeId3Text(b, fstart, fstart + fsz);
    else if (id === "TPE1") out.artist = decodeId3Text(b, fstart, fstart + fsz);
    else if (id === "TALB") out.album = decodeId3Text(b, fstart, fstart + fsz);
    else if (id === "TKEY") out.musicalKey = decodeId3Text(b, fstart, fstart + fsz);
    else if (id === "TBPM") {
      const txt = decodeId3Text(b, fstart, fstart + fsz);
      const v = parseFloat(txt.replace(",", "."));
      if (Number.isFinite(v) && v > 0 && v < 400) out.bpm = Math.round(v * 10) / 10;
    }
    p = fstart + fsz;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lectura de etiquetas (átomos MP4/M4A)
// ---------------------------------------------------------------------------

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

function atomChildren(b: Uint8Array, start: number, end: number): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let p = start;
  while (p + 8 <= end) {
    const size = u32(b, p);
    if (size < 8) break;
    out.push({ type: fourcc(b, p + 4), start: p + 8, end: p + size });
    p += size;
  }
  return out;
}

function readMp4Tags(b: Uint8Array): AudioTags {
  const out = emptyTags();
  // Primer átomo debe ser tipo ftyp/moov... Omitimos verificación estricta:
  // buscamos moov/udta/meta/ilst por si el archivo es M4A con moov al inicio.
  let top = atomChildren(b, 0, b.length);
  if (top.length === 0) return out;
  if (top[0].type !== "ftyp" && top[0].type !== "moov") return out;
  const moov = top.find((a) => a.type === "moov") ?? null;
  if (!moov) return out;
  const udta = atomChildren(b, moov.start, moov.end).find((a) => a.type === "udta") ?? null;
  if (!udta) return out;
  const meta = atomChildren(b, udta.start, udta.end).find((a) => a.type === "meta") ?? null;
  if (!meta) return out;
  const ilst = atomChildren(b, meta.start + 4, meta.end).find((a) => a.type === "ilst") ?? null;
  if (!ilst) return out;
  for (const item of atomChildren(b, ilst.start, ilst.end)) {
    const data = atomChildren(b, item.start, item.end).find((a) => a.type === "data");
    if (!data) continue;
    // data: 4 bytes version/flags + 4 bytes de TIPO + payload
    const typeCode = u32(b, data.start + 4);
    const payload = b.subarray(data.start + 8, data.end);
    if (item.type === "tmpo" || typeCode === 21 || typeCode === 22) {
      // Tempo: entero (8/16 bits) dependiendo del tamaño útil
      let v: number;
      if (payload.length >= 4) v = u32(new Uint8Array([0, 0, ...payload.subarray(payload.length - 2)]), 2);
      else if (payload.length >= 2) v = payload[payload.length - 1];
      else v = NaN;
      if (Number.isFinite(v) && v > 0 && v < 400) out.bpm = v;
    } else if (typeCode === 1) {
      const txt = new TextDecoder("utf-8").decode(payload).replace(/^\uFEFF/, "").replace(/\u0000+$/g, "").trim();
      if (item.type === "©nam") out.title = txt;
      else if (item.type === "©ART") out.artist = txt;
      else if (item.type === "©alb") out.album = txt;
    }
  }
  return out;
}

/** Extrae etiquetas de un File de audio sin tocar el backend (lectura parcial). */
export async function parseAudioTags(file: File): Promise<AudioTags> {
  try {
    const slice = file.slice(0, TAG_SLICE);
    const b = new Uint8Array(await slice.arrayBuffer());
    if (b.length < 12) return emptyTags();
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return readId3TextFrames(b);
    const firstAtoms = atomChildren(b, 0, Math.min(b.length, 4096));
    if (firstAtoms.length > 0 && (firstAtoms[0].type === "ftyp" || firstAtoms[0].type === "moov")) {
      return readMp4Tags(b);
    }
    return emptyTags();
  } catch {
    return emptyTags();
  }
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
  const pool = allTracks
    .map(enrichDemoTrack)
    .filter((t) => o.folder_ids.length === 0 || o.folder_ids.includes(Number(t.folder_id)));

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