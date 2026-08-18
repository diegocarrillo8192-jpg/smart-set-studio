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

// --- Reproducción en la versión web (sin backend local) --------------------
// Registro de archivos elegidos localmente (File API / <input webkitdirectory>):
// cuando el path de un track coincide, el audio se sirve desde un Blob URL
// (URL.createObjectURL) en lugar de pedirlo al backend 127.0.0.1.
const localFiles = new Map<string, File>();
// Cache de Blob URLs por archivo: se crean UNA sola vez para que el <audio> use
// siempre la misma URL estable (crear una por llamada rompía el src inmediato).
const blobUrlCache = new Map<string, string>();

export function registerLocalFiles(files: File[]): void {
  const audioRe = /\.(mp3|flac|m4a|aac|aiff?|wav|ogg|opus)$/i;
  for (const f of files) {
    // Guard: entradas no-File (nunca asumir propiedades de File).
    if (!f || typeof f !== "object") continue;
    const rel = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath;
    if (!rel || !f.name) continue;
    const key = rel.replace(/\\/g, "/");
    // Carpeta re-elegida: reciclar (revocar) la URL anterior del mismo archivo.
    if (localFiles.has(key)) {
      const oldUrl = blobUrlCache.get(key);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
      blobUrlCache.delete(key);
    }
    localFiles.set(key, f);
    // Web: extraer la carátula EMBEBIDA (ID3 APIC / FLAC PICTURE / M4A covr)
    // aquí mismo, convertida a Data URL/base64, sin tocar el filesystem.
    if (audioRe.test(key) && !artworkCache.has(key)) {
      void extractEmbeddedArtwork(f).then((url) => {
        artworkCache.set(key, url);
        notifyArtworkChanged();
      });
    }
  }
}

// --- Extracción de carátulas embebidas en el navegador (versión web) ---------
// Los metadatos de imagen viven en los primeros bytes del archivo: leemos solo
// un slice de 2 MB por pista (ID3v2/FLAC al inicio; M4A moov normalmente al
// inicio también) y lo convertimos a Data URL base64 sin tocar el disco.

const ARTWORK_SLICE = 2 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, Math.min(i + chunk, bytes.length)))
    );
  }
  return btoa(bin);
}

function imageDataUrl(mime: string, data: Uint8Array): string {
  const base = bytesToBase64(data);
  const mimeNorm = /^image\//i.test(mime) ? mime : "image/jpeg";
  return `data:${mimeNorm};base64,${base}`;
}

function syncsafe32(b: Uint8Array, o: number): number {
  return (
    ((b[o] & 0x7f) << 21) |
    ((b[o + 1] & 0x7f) << 14) |
    ((b[o + 2] & 0x7f) << 7) |
    (b[o + 3] & 0x7f)
  );
}

/** ID3v2 'APIC' (MP3) — encodings 0/3 (latin1/utf8) y 1/2 (utf16). */
function readId3Apic(b: Uint8Array): string | null {
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null;
  const ver = b[3];
  if (ver !== 3 && ver !== 4) return null;
  const tagSize = syncsafe32(b, 6);
  const end = Math.min(b.length, 10 + tagSize);
  const flags = b[5];
  let p = 10;
  if (flags & 0x40) {
    // header extendido: v2.3 usa tamaño plano; v2.4 syncsafe
    const esz =
      ver === 3
        ? ((b[p] & 0xff) << 24) | ((b[p + 1] & 0xff) << 16) | ((b[p + 2] & 0xff) << 8) | (b[p + 3] & 0xff)
        : syncsafe32(b, p);
    p += 4 + esz;
  }
  while (p + 10 <= end) {
    if (b[p] === 0) break; // padding
    const id = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const fsz = ver === 4 ? syncsafe32(b, p + 4) : ((b[p + 4] & 0xff) << 24) | ((b[p + 5] & 0xff) << 16) | ((b[p + 6] & 0xff) << 8) | (b[p + 7] & 0xff);
    if (fsz <= 0) break;
    const fstart = p + 10;
    if (fsz + fstart > b.length) break;
    if (id === "APIC") {
      const enc = b[fstart];
      let q = fstart + 1;
      let mime = "";
      while (q < end && b[q] !== 0) {
        mime += String.fromCharCode(b[q]);
        q++;
      }
      q++; // NUL del MIME
      q++; // tipo de imagen
      if (enc === 1 || enc === 2) {
        // descripción UTF-16 terminada en 00 00
        while (q + 1 < end && !(b[q] === 0 && b[q + 1] === 0)) q += 2;
        q += 2;
      } else {
        while (q < end && b[q] !== 0) q++;
        q++;
      }
      if (q + 32 > fstart + fsz) return null;
      const data = b.subarray(q, fstart + fsz);
      return data.length > 32 ? imageDataUrl(mime, data) : null;
    }
    p = fstart + fsz;
  }
  return null;
}

/** Bloque PICTURE de FLAC (tipo 6) dentro de los bloques de metadatos. */
function readFlacPicture(b: Uint8Array): string | null {
  if (b.length < 8 || b[0] !== 0x66 || b[1] !== 0x4c || b[2] !== 0x61 || b[3] !== 0x43) return null;
  const u32 = (o: number) =>
    ((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) | ((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff);
  let mp = 42; // "fLaC" + STREAMINFO (34 bytes)
  for (let i = 0; i < 16 && mp + 4 <= b.length; i++) {
    const isLast = (b[mp] & 0x80) !== 0;
    const type = b[mp] & 0x7f;
    const len = u32(mp + 1);
    const body = mp + 4;
    if (type === 6) {
      if (body + 36 > b.length) return null;
      const mimeLen = u32(body + 4);
      let q = body + 8;
      const mimeEnd = Math.min(q + mimeLen, b.length);
      let mime = "";
      while (q < mimeEnd) {
        mime += String.fromCharCode(b[q]);
        q++;
      }
      q = mimeEnd;
      const descLen = u32(q);
      q += 4 + descLen + 16; // descripción + width/height/depth/colors
      if (q + 4 > b.length) return null;
      const dataLen = u32(q);
      q += 4;
      const data = b.subarray(q, Math.min(q + dataLen, b.length));
      return data.length > 32 ? imageDataUrl(mime, data) : null;
    }
    if (isLast) break;
    mp = body + len;
  }
  return null;
}

/** Átomo 'covr' de M4A/AAC (moov → udta → meta → ilst → covr → data). */
function readM4aCovr(b: Uint8Array): string | null {
  if (b.length < 16) return null;
  const u32 = (o: number) =>
    ((b[o] & 0xff) << 24) | ((b[o + 1] & 0xff) << 16) | ((b[o + 2] & 0xff) << 8) | (b[o + 3] & 0xff);
  const fourcc = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const children = (start: number, end: number): { type: string; start: number; end: number }[] => {
    const out: { type: string; start: number; end: number }[] = [];
    let p = start;
    while (p + 8 <= end) {
      const size = u32(p);
      if (size < 8) break;
      out.push({ type: fourcc(p + 4), start: p + 8, end: p + size });
      p += size;
    }
    return out;
  };
  const find = (list: { type: string; start: number; end: number }[], t: string) =>
    list.find((a) => a.type === t) ?? null;
  const top = children(0, b.length);
  const moov = find(top, "moov");
  if (!moov) return null;
  const udta = find(children(moov.start, moov.end), "udta");
  if (!udta) return null;
  const meta = find(children(udta.start, udta.end), "meta");
  if (!meta) return null;
  const ilst = find(children(meta.start + 4, meta.end), "ilst"); // meta: fullbox (4 flags)
  if (!ilst) return null;
  const covr = find(children(ilst.start, ilst.end), "covr");
  if (!covr) return null;
  const data = find(children(covr.start, covr.end), "data");
  if (!data) return null;
  const payload = b.subarray(data.start + 4, data.end); // +4 version/flags
  if (payload.length <= 32) return null;
  const mime =
    payload[0] === 0x89 && payload[1] === 0x50
      ? "image/png"
      : payload[0] === 0xff && payload[1] === 0xd8
        ? "image/jpeg"
        : "image/jpeg";
  return imageDataUrl(mime, payload);
}

/** Carátula embebida del archivo (MP3/FLAC/M4A) como Data URL, o null. */
async function extractEmbeddedArtwork(file: File): Promise<string | null> {
  try {
    const slice = file.slice(0, ARTWORK_SLICE);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    let url: string | null = null;
    try {
      url = readId3Apic(bytes) ?? url;
      if (!url) url = readFlacPicture(bytes) ?? url;
      if (!url) url = readM4aCovr(bytes) ?? url;
    } catch {
      /* formato no reconocido */
    }
    return url;
  } catch {
    return null;
  }
}

// --- File System Access API (versión web) -----------------------------------
// Pide permiso explícito al usuario con showDirectoryPicker, recorre la
// carpeta de música y registra los File obtenidos (audio vía Blob URL y
// carátula vía extractor ID3 → Data URL persistente).

interface WebFsHandle {
  kind: string;
  name: string;
  values?: () => AsyncIterableIterator<WebFsHandle>;
  getFile?: () => Promise<File>;
}

/** Selecciona una carpeta con permiso del usuario y registra sus archivos. */
export async function pickMusicFolder(): Promise<string | null> {
  const picker = (
    window as unknown as {
      showDirectoryPicker?: () => Promise<WebFsHandle>;
    }
  ).showDirectoryPicker;
  if (typeof picker !== "function") return null; // sin soporte → fallback <input>
  let root: WebFsHandle;
  try {
    root = await picker();
  } catch {
    return null; // cancelado o sin permiso
  }
  const files: File[] = [];
  const walk = async (dir: WebFsHandle, prefix: string) => {
    for await (const entry of dir.values?.() ?? []) {
      if (entry.kind === "directory" && typeof entry.values === "function") {
        await walk(entry, `${prefix}/${entry.name}`);
      } else if (entry.kind === "file" && entry.getFile) {
        try {
          const f = await entry.getFile();
          Object.defineProperty(f, "webkitRelativePath", {
            value: `${root.name}${prefix}/${entry.name}`,
          });
          files.push(f);
        } catch {
          /* archivo sin permiso de lectura: omitir */
        }
      }
    }
  };
  try {
    await walk(root, "");
  } catch {
    return null;
  }
  if (files.length > 0) registerLocalFiles(files);
  return root.name;
}

/** Blob URL estable si existe un archivo local para este path de track, si no null. */
export function localUrlFor(path: string): string | null {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  for (const [rel, file] of localFiles) {
    const relN = rel.replace(/\\/g, "/").toLowerCase();
    if (norm === relN || norm.endsWith(`/${relN}`)) {
      const cached = blobUrlCache.get(rel);
      if (cached) return cached;
      const url = URL.createObjectURL(file);
      blobUrlCache.set(rel, url);
      return url;
    }
  }
  return null;
}

function audioUrlFor(track: Track): string {
  return (
    localUrlFor(track.file_path) ??
    `${BASE}/audio/stream?path=${encodeURIComponent(track.file_path)}`
  );
}

// --- Purga de caché web (SOLO navegador, nunca toca la BD ni Electron) -------
// Las builds anteriores pudieron dejar en LocalStorage/IndexedDB metadatos con
// referencias rotas a carátulas viejas. Al subir la versión de caché, la web
// limpia esas claves una sola vez. La app en Electron se detecta por
// window.smartSet y este código se omite por completo en ella.

const WEB_CACHE_VERSION_KEY = "smartset.web_cache_version";
const WEB_CACHE_VERSION = 1;
export const WEB_UNHEALTHY_KEY = "smartset.web_cache_unhealthy";

export const isWeb = (): boolean => !window.smartSet;

/** Marca la sesión web como "caché rota" (covers/stream que fallan por red):
 *  el próximo arranque hará un reseteo automático de LocalStorage/IndexedDB. */
export function markWebCacheUnhealthy(): void {
  if (!isWeb()) return;
  try {
    localStorage.setItem(WEB_UNHEALTHY_KEY, "1");
  } catch {
    /* almacenamiento no disponible */
  }
}

/** Borra LocalStorage (claves propias), Cache Storage (runtime HTTP) e
 *  IndexedDB. No toca la persistencia de Electron ni la base de datos. */
async function clearWebCaches(): Promise<void> {
  const storage = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  };
  const ls = storage();
  if (ls) {
    const stale: string[] = [];
    for (let i = 0; i < ls.length; i++) {
      const key = ls.key(i);
      if (
        key &&
        (key.startsWith("smartset.") ||
          key.startsWith("ssart.") ||
          key.startsWith("trackart_"))
      ) {
        stale.push(key);
      }
    }
    stale.forEach((key) => ls.removeItem(key));
  }
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {
    /* Cache Storage no disponible */
  }
  try {
    if ("indexedDB" in window && typeof indexedDB.databases === "function") {
      const dbs = await indexedDB.databases();
      await Promise.all(
        dbs.map((d) => {
          const name = d.name;
          if (!name) return undefined;
          return new Promise<void>((resolve) => {
            const req = indexedDB.deleteDatabase(name);
            req.onsuccess = () => resolve();
            req.onerror = () => resolve();
            req.onblocked = () => resolve();
          });
        })
      );
    }
  } catch {
    /* IndexedDB no disponible */
  }
}

/** Purga versionada de caché (web): se ejecuta en el arranque. Con `force`
 *  elimina TODO (LocalStorage + Cache Storage + IndexedDB) y actualiza la
 *  versión para no repetirse. Devuelve true si limpió algo. */
export async function purgeStaleWebCache(opts?: { force?: boolean }): Promise<boolean> {
  if (!isWeb() || (typeof localStorage === "undefined" && opts?.force !== true)) {
    return false;
  }
  try {
    const stored = Number(localStorage.getItem(WEB_CACHE_VERSION_KEY) ?? "0");
    if (!opts?.force && stored >= WEB_CACHE_VERSION) return false;
  } catch {
    return false;
  }
  await clearWebCaches();
  try {
    localStorage.setItem(WEB_CACHE_VERSION_KEY, String(WEB_CACHE_VERSION));
  } catch {
    /* ignorar */
  }
  return true;
}

/** Reset completo de la caché del navegador (botón de Ajustes y detección
 *  automática). La UI web debe recargar después para re-fetch limpio. */
export async function resetWebCache(): Promise<void> {
  await purgeStaleWebCache({ force: true });
  webCacheReset = true;
}

// Mientras esta sesión web tenga caché recién reseteada, las peticiones de
// carátulas ignoran el caché HTTP del navegador (cache: "reload").
let webCacheReset = false;

// --- Almacén de biblioteca en el navegador (modo web offline) ---------------
// Sin backend local, los archivos elegidos con <input webkitdirectory> se
// registran como una "carpeta" virtual con tracks sintéticos. listFolders y
// listTracks devuelven este almacén cuando corre en web, de modo que las
// canciones aparecen al instante en la tabla "Todos los tracks".
// PERSISTENCIA: el almacén se serializa en localStorage y se hidrata al
// arrancar para que carpetas y tracks vuelvan a mostrarse al reabrir la app.
let webFolderSeq = 0;
let webTrackSeq = 0;
let webFolders: Folder[] = [];
let webTracks: Track[] = [];
let webStoreLoaded = false;

const WEB_LIBRARY_KEY = "smartset.web_library_v1";

function ensureWebStoreLoaded(): void {
  if (webStoreLoaded) return;
  webStoreLoaded = true;
  try {
    const raw = localStorage.getItem(WEB_LIBRARY_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      folders?: Folder[];
      tracks?: Track[];
      folderSeq?: number;
      trackSeq?: number;
    };
    if (Array.isArray(parsed.folders)) webFolders = parsed.folders;
    if (Array.isArray(parsed.tracks)) webTracks = parsed.tracks;
    webFolderSeq = typeof parsed.folderSeq === "number" ? parsed.folderSeq : 0;
    webTrackSeq = typeof parsed.trackSeq === "number" ? parsed.trackSeq : 0;
  } catch {
    // Almacén corrupto (versión anterior): empezar de cero sin crashar.
    webFolders = [];
    webTracks = [];
  }
}

function saveWebStore(): void {
  if (!isWeb()) return;
  try {
    localStorage.setItem(
      WEB_LIBRARY_KEY,
      JSON.stringify({ folders: webFolders, tracks: webTracks, folderSeq: webFolderSeq, trackSeq: webTrackSeq })
    );
  } catch {
    // Cuota superada o almacenamiento no disponible: la sesión sigue en memoria.
  }
}

const AUDIO_EXT_RE = /\.(mp3|wav|aiff?|flac|m4a|aac|ogg|opus)$/i;

/** Nombre/ruta relativa segura de un File: nunca undefined. */
function safeRelPath(f: File): string {
  const rel = (f as unknown as { webkitRelativePath?: string }).webkitRelativePath;
  return (rel ?? f.name ?? "track").replace(/\\/g, "/");
}

/** Registra los archivos de una carpeta web; devuelve el nombre raíz o null. */
export function webRegisterFolder(files: File[]): string | null {
  ensureWebStoreLoaded();
  const audio = files.filter((f) => {
    if (!f || typeof f !== "object") return false;
    const rel = safeRelPath(f);
    const name = f.name ?? "";
    return !!name && AUDIO_EXT_RE.test(rel || name);
  });
  if (audio.length === 0) return null;
  registerLocalFiles(audio);
  // Conversión INMEDIATA a Blob URLs estables (una por archivo): la UI puede
  // reproducir y mostrar los archivos sin depender de la API REST de escritorio.
  for (const f of audio) localUrlFor(safeRelPath(f));

  const root = (safeRelPath(audio[0]).split(/[\\/]/)[0] || "Mi Música").trim();
  let folder = webFolders.find((f) => f.name === root);
  if (!folder) {
    folder = {
      id: --webFolderSeq,
      path: root,
      name: root,
      last_scanned_at: new Date().toISOString(),
      track_count: 0,
    };
    webFolders.push(folder);
  }

  const seen = new Set(webTracks.map((t) => t.file_path.toLowerCase()));
  const added: Track[] = [];
  for (const f of audio) {
    const name = f.name ?? "";
    if (!name) continue;
    const rel = safeRelPath(f);
    if (seen.has(rel.toLowerCase())) continue;
    seen.add(rel.toLowerCase());
    const base = name.replace(/\.[^.]+$/, "");
    added.push({
      id: --webTrackSeq,
      file_path: rel,
      folder_id: folder.id,
      folder_name: root,
      title: base,
      artist: root,
      album: root,
      duration_sec: null,
      bpm: null,
      embedded_bpm: null,
      musical_key: null,
      camelot_key: null,
      embedded_key: null,
      energy: null,
      loudness_db: null,
      spectral_centroid: null,
      analyzed: false,
      has_error: false,
      error_message: null,
    });
  }
  if (added.length > 0) {
    webTracks.push(...added);
    folder.track_count = webTracks.filter((t) => t.folder_id === folder.id).length;
  }
  saveWebStore();
  return root;
}

function webListTracks(params: Record<string, string | number | boolean | undefined>): Track[] {
  ensureWebStoreLoaded();
  let rows = webTracks.filter((t) => {
    const fid = params.folder_id;
    if (fid !== undefined && fid !== null && fid !== "" && t.folder_id !== fid) return false;
    const q = String(params.q ?? "").toLowerCase();
    if (q) {
      const hay = `${t.title ?? ""} ${t.artist ?? ""} ${t.album ?? ""} ${t.folder_name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return rows.slice(0, 1000);
}

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
    // El status HTTP queda accesible para decisiones de UI (p. ej. 409 →
    // "carpeta ya importada" dispara el refresco inmediato de la biblioteca).
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

const base64Prefix = /^data:image\/[a-z0-9.+-]+;base64,/;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const url = typeof fr.result === "string" ? fr.result : "";
      resolve(base64Prefix.test(url) ? url : "");
    };
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

// --- Caché de carátulas en memoria ------------------------------------------
// Data URLs (Base64) por track: UN solo request por archivo por sesión, tanto
// en Electron como en web. Evita re-procesar la carátula en cada render y los
// recuadros negros intermitentes (el placeholder es permanente si no hay arte).
// `null` = resultado negativo (sin portada) para no volver a intentar.
const artworkCache = new Map<string, string | null>();

// Notifica a la UI cuando un artwork llega al caché (extracción web async),
// para que biblioteca/Recomendados/Decks lo apliquen en tiempo real.
const artworkListeners = new Set<() => void>();

export function subscribeArtwork(listener: () => void): () => void {
  artworkListeners.add(listener);
  return () => {
    artworkListeners.delete(listener);
  };
}

function notifyArtworkChanged(): void {
  for (const listener of Array.from(artworkListeners)) listener();
}

/** Busca la clave de caché cuyo path relativo coincide con el del track,
 *  prefiriendo un resultado no-nulo (portada real sobre negativo local). */
function artworkKeyFor(path: string): string | null {
  const norm = path.replace(/\\/g, "/").toLowerCase();
  let firstMatch: string | null = null;
  for (const key of artworkCache.keys()) {
    const k = key.replace(/\\/g, "/").toLowerCase();
    if (norm === k || norm.endsWith(`/${k}`)) {
      if (artworkCache.get(key) !== null) return key;
      firstMatch ??= key;
    }
  }
  return firstMatch;
}

/** Consulta síncrona de la caché (undefined = aún sin resolver). */
export function cachedTrackArtwork(track: Track): string | null | undefined {
  const key = artworkKeyFor(track.file_path);
  return key !== null ? artworkCache.get(key) : undefined;
}

// Deduplica peticiones concurrentes (biblioteca + recomendados + deck).
const artworkInFlight = new Map<string, Promise<string | null | undefined>>();

// Cola de concurrencia: máx. 6 peticiones de carátulas a la vez. En listados
// masivos evita saturar el backend y que cada petición individual caduque
// por timeout (el servidor extrae el APIC por archivo bajo demanda).
const artworkQueue: Array<() => void> = [];
let artworkActive = 0;
const ARTWORK_CONCURRENCY = 6;

function enqueueArtwork<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      artworkActive += 1;
      void task()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          artworkActive -= 1;
          const next = artworkQueue.shift();
          if (next) void next();
        });
    };
    if (artworkActive < ARTWORK_CONCURRENCY) {
      run();
    } else {
      artworkQueue.push(run);
    }
  });
}

/**
 * Precarga diferida (lazy) de carátulas para un listado: dispara el fetch de
 * los primeros `count` tracks (p.ej. al hacer clic en una carpeta) para que
 * los covers lleguen por el endpoint CORS y se apliquen al estado/UI de una
 * vez, sin bloquear el render. El resto se resuelve al hacer scroll.
 */
export function prefetchArtworks(tracks: Track[], count = 24): void {
  for (const track of tracks.slice(0, count)) {
    if (cachedTrackArtwork(track) !== undefined) continue;
    void getTrackArtwork(track).catch(() => undefined);
  }
}

/**
 * Data URL (base64) de la carátula, cacheada en memoria para la sesión.
 * Web: la ruta local absoluta (C:\musica\track.mp3) no es legible por el
 * navegador, así que SIEMPRE se pide al servidor local (/api/audio/artwork),
 * que extrae el ID3 en el backend y entrega la imagen como Blob image/jpeg.
 */
/**
 * Data URL (base64) de la carátula, cacheada en memoria para la sesión.
 * Resultado por estados:
 *  string    = portada lista para la UI.
 *  null      = el servidor CONFIRMÓ (HTTP 404) que el archivo no tiene NINGUNA
 *              imagen (embebida ni adyacente): aquí el fallback es la marca.
 *  undefined = aún extrayendo o error transitorio (timeout/403/5xx): NO es
 *              una confirmación de ausencia; la UI muestra carga y se re-
 *              intentará en el próximo montaje, sin marcar "sin portada".
 * Web: la ruta local absoluta (C:\musica\track.mp3) no es legible por el
 * navegador, así que SIEMPRE se pide al servidor local (/api/audio/artwork),
 * que extrae el ID3 en el backend y entrega la imagen como Blob image/jpeg.
 */
// Negativos confirmados por el servidor que YA fueron reintentados con force
// en esta sesión (evita re-extraer la misma pista sin carátula en cada mount).
const artworkForceRetried = new Set<string>();

// --- Persistencia de carátulas entre sesiones (IndexedDB, versión web) -------
// El backend sirve miniaturas de 1-6 KB (`&thumb=1`); se guardan aquí como
// Data URLs reutilizables: al recargar la app las listas/decks/recomendados
// salen instantáneos SIN ninguna petición de red. Solo Data URLs pequeñas
// (los originales de cientos de KB no entran en la cuota). En Electron el
// navegador ya hace 304s con el ETag del backend, así que aquí persiste igual.
const IDB_NAME = "smart-set-studio";
const IDB_STORE = "artwork-thumbs";
let idbInit: Promise<IDBDatabase | null> | null = null;

async function doIdbOpen(): Promise<IDBDatabase | null> {
  try {
    return await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null; // IndexedDB no disponible (modo privado): la sesión sigue OK
  }
}

function idb(): Promise<IDBDatabase | null> {
  return (idbInit ??= doIdbOpen());
}

/** Hidrata la caché en memoria con las miniaturas guardadas en sesiones
 *  previas. Idempotente y tolerante a fallos (nunca bloquea la app). */
export function initArtworkPersistence(): Promise<void> {
  return idb().then(async (db) => {
    if (!db) return;
    try {
      const all = await new Promise<Map<string, string>>((resolve, reject) => {
        const out = new Map<string, string>();
        const tx = db.transaction(IDB_STORE, "readonly");
        const cur = tx.objectStore(IDB_STORE).openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (c) {
            out.set(String(c.key), String(c.value));
            c.continue();
          } else {
            resolve(out);
          }
        };
        cur.onerror = () => reject(cur.error);
      });
      let changed = false;
      for (const [k, v] of all) {
        if (v && !artworkCache.has(k)) {
          artworkCache.set(k, v);
          changed = true;
        }
      }
      if (changed) notifyArtworkChanged();
    } catch {
      // sin persistencia: la sesión sigue funcionando con caché de memoria
    }
  });
}

/** Escribe-through: guarda la miniatura para la próxima sesión (Data URLs
 *  grandes se descartan para no agotar la cuota del navegador). */
async function idbPersistArtwork(key: string, value: string): Promise<void> {
  if (value.length > 30000) return;
  const db = await idb();
  if (!db) return;
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // cuota llena u otro error: no crítico, la sesión sigue cacheando en RAM
  }
}

export async function getTrackArtwork(track: Track): Promise<string | null | undefined> {
  // Minituras de sesiones anteriores: la primera llamada las trae de IndexedDB
  // y la UI se actualiza en tiempo real vía notifyArtworkChanged().
  void initArtworkPersistence();
  const key = track.file_path;
  const matched = artworkKeyFor(key);
  const matchedHit = matched !== null ? artworkCache.get(matched) : undefined;
  // force = re-extracción (embebida + cover.jpg/folder.jpg): se usa cuando el
  // track tiene un negativo confirmado (null) que aún no se ha reintentado en
  // esta sesión, para recuperar portadas que aparecieron después del escaneo.
  const force = matchedHit === null && matched === key && !artworkForceRetried.has(key);
  if (matchedHit !== undefined) {
    if (matchedHit !== null) return matchedHit; // portada lista (no la re-pides)
    if (!force && matched === key) return null; // 404 confirmado y ya reintentado
    // null local = sin carátula EMBEBIDA, pero el servidor aún puede servir
    // la imagen adyacente (track.jpg / cover.jpg) de la ruta absoluta.
  }

  const pending =
    artworkInFlight.get(key) ??
    enqueueArtwork(async () => {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 12000);
      let result: string | null | undefined = undefined;
      try {
        const res = await fetch(
          `${BASE}/audio/artwork?path=${encodeURIComponent(key)}&thumb=1${force ? "&force=1" : ""}`,
          { signal: controller.signal, cache: webCacheReset ? "reload" : "force-cache" }
        );
        if (res.ok) {
          const blob = await res.blob();
          result = blob.size > 32 ? await blobToDataUrl(blob) : null;
        } else if (res.status === 404) {
          result = null; // el servidor confirma: el archivo no tiene imagen
        }
        // 403/5xx/timeout → `undefined`: transitorio, no definitivo.
      } catch {
        result = undefined;
        markWebCacheUnhealthy();
      } finally {
        window.clearTimeout(timer);
      }
      // Evitar crecimiento ilimitado con bibliotecas grandes (misma filosofía
      // que el caché del backend): reciclar el mapa al superar el tope.
      if (artworkCache.size >= 600) artworkCache.clear();
      // No pisar una carátula ya extraída localmente en web. Los negativos
      // solo se cachean cuando el servidor los confirmó (404); los fallos
      // transitorios quedan sin caché para poder reintentarse.
      if (result === undefined) {
        return undefined;
      }
      if (result !== null) {
        artworkCache.set(key, result);
        void idbPersistArtwork(key, result);
        artworkForceRetried.delete(key);
      } else {
        if (!artworkCache.has(key)) artworkCache.set(key, null);
        if (force) artworkForceRetried.add(key);
      }
      notifyArtworkChanged();
      return result;
    }).finally(() => artworkInFlight.delete(key));
  artworkInFlight.set(key, pending);
  return pending;
}

export const api = {
  health: () => request<{ status: string }>("/health"),

  // Folders
  listFolders: () => {
    if (isWeb()) {
      ensureWebStoreLoaded();
      return Promise.resolve([...webFolders]);
    }
    return request<Folder[]>("/folders");
  },
  addFolder: (path: string) =>
    request<Folder>("/folders", { method: "POST", body: JSON.stringify({ path }) }),
  removeFolder: (id: number) => {
    if (isWeb()) {
      ensureWebStoreLoaded();
      webFolders = webFolders.filter((f) => f.id !== id);
      webTracks = webTracks.filter((t) => t.folder_id !== id);
      saveWebStore();
      return Promise.resolve({ ok: true } as { ok: boolean });
    }
    return request<{ ok: boolean }>(`/folders/${id}`, { method: "DELETE" });
  },
  renameFolder: (id: number, name: string) => {
    if (isWeb()) {
      ensureWebStoreLoaded();
      const folder = webFolders.find((f) => f.id === id);
      if (!folder) return Promise.reject(new Error("Carpeta no encontrada"));
      folder.name = name;
      folder.path = name;
      for (const t of webTracks) if (t.folder_id === id) t.folder_name = name;
      saveWebStore();
      return Promise.resolve(folder);
    }
    return request<Folder>(`/folders/${id}`, { method: "PUT", body: JSON.stringify({ name }) });
  },
  scanFolder: (id: number, force = false) =>
    request<ScanJob>(`/folders/${id}/scan${force ? "?force=true" : ""}`, { method: "POST" }),
  scanStatus: (id: number) => request<ScanJob | null>(`/folders/${id}/scan/status`),

  // Tracks
  listTracks: (params: Record<string, string | number | boolean | undefined>) => {
    if (isWeb()) return Promise.resolve(webListTracks(params));
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    }
    return request<Track[]>(`/tracks?${qs.toString()}`);
  },
  /** URL de streaming del audio: Blob URL local (versión web) o servidor (CORS + Range). */
  audioUrl: (track: Track) => audioUrlFor(track),
  /** Stream por ID de track: salvoconducto cuando la ruta por path falla. */
  audioUrlById: (id: number) => `${BASE}/tracks/${id}/audio`,
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
