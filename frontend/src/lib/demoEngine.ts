import type { DJSet, EnergyProfile, Track } from "../types";
import { parseBlob } from "music-metadata-browser";

/**
 * MOTOR DE DEMO EN NAVEGADOR (modo web volátil).
 *
 * Todo el "análisis" ocurre en el cliente con music-metadata-browser:
 *  - parseAudioFile():   etiquetas ID3v2/ID3v2.4 y MP4/M4A con decodificación
 *                       correcta (UTF-16/UTF-8/latin1), duración real y
 *                       carátula embebida (APIC/©cov).
 *  - musicalKeyToCamelot(): tonalidad ID3 tradicional → Rueda Camelot.
 *  - estimateEnergy():   métrica de energía 0-10 heurística y determinista
 *                       (BPM como base + semilla estable por título).
 *  - generateDemoSet():  rápido hechizo de set "en pantalla" con la misma
 *                       filosofía del backend (Camelot ±1, modo, BPM ±2.5%).
 */

const MAX_TRACKS_IN_SET = 40;

// ---------------------------------------------------------------------------
// Lectura de etiquetas (ID3v2/MP4) con music-metadata-browser
// ---------------------------------------------------------------------------

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

function cleanText(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
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

export interface ParsedAudioFile {
  tags: AudioTags;
  duration_sec: number | null;
  coverUrl: string | null;
}

/** Etiquetas + duración + carátula de un File, todo en el navegador. */
export async function parseAudioFile(file: File): Promise<ParsedAudioFile> {
  let meta;
  try {
    meta = await parseBlob(file);
  } catch {
    const tags = emptyTags();
    const duration_sec = await probeAudioDuration(file);
    return { tags, duration_sec, coverUrl: null };
  }

  const common = meta.common;
  const rawBpm = common.bpm;
  const bpm =
    typeof rawBpm === "number" && Number.isFinite(rawBpm) && rawBpm > 0 && rawBpm < 400
      ? Math.round(rawBpm * 10) / 10
      : null;
  const picture = Array.isArray(common.picture) && common.picture.length > 0 ? common.picture[0] : undefined;

  const fmtDuration = meta.format.duration;
  let duration_sec: number | null =
    typeof fmtDuration === "number" && Number.isFinite(fmtDuration) && fmtDuration > 0 ? fmtDuration : null;
  if (!duration_sec) duration_sec = await probeAudioDuration(file);

  return {
    tags: {
      title: cleanText(common.title),
      artist: cleanText(common.artist),
      album: cleanText(common.album),
      bpm,
      musicalKey: cleanText(common.key),
    },
    duration_sec,
    coverUrl:
      picture && picture.data && picture.data.length > 0
        ? URL.createObjectURL(new Blob([picture.data], { type: picture.format }))
        : null,
  };
}

/** Compatibilidad: solo etiquetas (sin carátula ni duración). */
export async function parseAudioTags(file: File): Promise<AudioTags> {
  const r = await parseAudioFile(file);
  return r.tags;
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