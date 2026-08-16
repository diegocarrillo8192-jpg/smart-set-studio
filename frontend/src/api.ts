import type {
  DJSet,
  EnergyProfile,
  Folder,
  RecommendationsResponse,
  ScanJob,
  Settings,
  Track,
  TrackAnalysis,
} from "./types";

const BASE = "http://127.0.0.1:8765/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  // Folders
  listFolders: () => request<Folder[]>("/folders"),
  addFolder: (path: string) =>
    request<Folder>("/folders", { method: "POST", body: JSON.stringify({ path }) }),
  removeFolder: (id: number) =>
    request<{ ok: boolean }>(`/folders/${id}`, { method: "DELETE" }),
  renameFolder: (id: number, name: string) =>
    request<Folder>(`/folders/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  scanFolder: (id: number, force = false) =>
    request<ScanJob>(`/folders/${id}/scan${force ? "?force=true" : ""}`, { method: "POST" }),
  scanStatus: (id: number) => request<ScanJob | null>(`/folders/${id}/scan/status`),

  // Tracks
  listTracks: (params: Record<string, string | number | boolean | undefined>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    return request<Track[]>(`/tracks?${qs.toString()}`);
  },
  /** URL de streaming del audio servida por el backend (CORS + Range). */
  audioUrl: (track: Track) =>
    `${BASE}/audio/stream?path=${encodeURIComponent(track.file_path)}`,
  /** URL de la carátula del track (404 = sin portada, el frontend pone placeholder). */
  artworkUrl: (track: Track) =>
    `${BASE}/audio/artwork?path=${encodeURIComponent(track.file_path)}`,
  /** Análisis estructural (onda RGB, frases, cues, zonas vocales): lazy + cacheado. */
  getAnalysis: (filePath: string) =>
    request<TrackAnalysis>(`/audio/analysis?path=${encodeURIComponent(filePath)}`),
  /** Recomendador en vivo: top N de compatibilidad armónica+BPM del seed. */
  getRecommendations: (trackId: number) =>
    request<RecommendationsResponse>(`/tracks/${trackId}/recommendations`),

  // Sets
  generateSet: (payload: {
    duration_min: number;
    folder_ids: number[];
    energy_profile: EnergyProfile;
    seed_track_id?: number | null;
    name?: string | null;
  }) => request<DJSet>("/sets/generate", { method: "POST", body: JSON.stringify(payload) }),
  listSets: () => request<DJSet[]>("/sets"),
  deleteSet: (id: number) => request<{ ok: boolean }>(`/sets/${id}`, { method: "DELETE" }),
  renameSet: (id: number, name: string) =>
    request<DJSet>(`/sets/${id}`, { method: "PUT", body: JSON.stringify({ name }) }),
  exportUsb: (id: number, destination: string) =>
    request<{ copied: number; total: number; destination: string }>(`/sets/${id}/export/usb`, {
      method: "POST",
      body: JSON.stringify({ destination }),
    }),

  // Settings
  getSettings: () => request<Settings>("/settings"),
  updateSettings: (payload: Settings) =>
    request<Settings>("/settings", { method: "PUT", body: JSON.stringify(payload) }),
};

declare global {
  interface Window {
    smartSet?: {
      selectFolder: () => Promise<string | null>;
      selectFolderForExport: () => Promise<string | null>;
      /** Siempre true cuando la app corre embebida en Electron (escritorio). */
      isDesktop: true;
    };
  }
}
