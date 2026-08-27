export interface Folder {
  id: number;
  path: string;
  name: string;
  last_scanned_at: string | null;
  track_count: number;
}

export interface Track {
  id: number;
  file_path: string;
  folder_id: number | null;
  folder_name: string | null;
  title: string;
  artist: string;
  album: string;
  duration_sec: number | null;
  bpm: number | null;
  embedded_bpm: number | null;
  musical_key: string | null;
  camelot_key: string | null;
  embedded_key: string | null;
  energy: number | null;
  loudness_db: number | null;
  spectral_centroid: number | null;
  analyzed: boolean;
  has_error: boolean;
  error_message: string | null;
  genre?: string;
}

export interface ScanJob {
  id: number;
  folder_id: number | null;
  status: string;
  total_files: number;
  processed_files: number;
  message: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface SetItem {
  id: number;
  position: number;
  transition_label: string | null;
  transition_relation: string | null;
  track: Track;
}

export interface DJSet {
  id: number;
  name: string;
  duration_min: number;
  energy_profile: string;
  folder_ids: string;
  total_sec: number;
  created_at: string;
  items: SetItem[];
}

export type EnergyProfile = "warmup" | "peak_hour" | "storytelling" | "energy_boost";

export const ENERGY_PROFILES: Record<
  EnergyProfile,
  { label: string; description: string; color: string }
> = {
  warmup: {
    label: "Warm-Up",
    description: "Progresivo, suave, atmosférico",
    color: "from-cyan-500 to-blue-600",
  },
  peak_hour: {
    label: "Peak Hour",
    description: "Sube rápido y se mantiene arriba",
    color: "from-orange-500 to-red-600",
  },
  storytelling: {
    label: "Storytelling / Journey",
    description: "Intro suave → Subida → Clímax → Cierre",
    color: "from-violet-500 to-fuchsia-600",
  },
  energy_boost: {
    label: "Explosivo / Energy Boost",
    description: "Saltos de clave +2 para máxima tensión",
    color: "from-amber-400 to-orange-600",
  },
};

export interface Settings {
  max_bpm_variation_pct: number;
  energy_boost_jump: number;
  harmonic_radius: number;
  allow_mode_change: boolean;
  /** Escribir la key detectada en ID3 de los archivos originales (solo escritorio). */
  write_id3_keys: boolean;
  /** La app corre embebida en Electron (desktop); en web siempre false. */
  is_desktop: boolean;
}

/** Onda RGB del análisis estructural (bandas graves/medios/agudos 0..1). */
export interface AnalysisBar {
  t: number;
  lo: number;
  mid: number;
  hi: number;
}

/** Estructura de frases alineada a compases (8 barras = 32 beats). */
export interface Phrase {
  start: number;
  end: number;
  label: string; // Intro | Chorus/Drop | Bridge | Break | Outro
}

/** Hot cue automático detectado. */
export interface HotCue {
  type: "intro" | "drop" | "break" | "outro";
  label: string;
  t: number;
}

/** Zona de presencia vocal (para evitar mezclar dos vocales a la vez). */
export interface VocalZone {
  start: number;
  end: number;
}

/** Análisis estructural completo de un track (Rekordbox RGB/Phrase style). */
export interface TrackAnalysis {
  path: string;
  mtime: number;
  duration_sec: number;
  bpm: number | null;
  bars: AnalysisBar[];
  phrases: Phrase[];
  cues: HotCue[];
  vocal_zones: VocalZone[];
}

/** Recomendación en vivo: tema de la biblioteca con su score armónico+BPM. */
export interface Recommendation {
  track: Track;
  score: number;
  relation: string;
  relation_label: string;
  bpm_diff_pct: number;
}

export interface RecommendationsResponse {
  seed: Track;
  recommendations: Recommendation[];
}

/** Estado del job de re-análisis rápido de Key (backend). */
export interface ReanalyzeJob {
  job_id?: number;
  status: string;
  total: number;
  processed: number;
  message: string;
}
