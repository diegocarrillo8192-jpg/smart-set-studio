"""Análisis estructural avanzado de tracks (onda RGB, frases, cues, vocales).

Replica las funciones de la vista de onda de Rekordbox 7 / Mixed In Key:

- **Onda RGB por frecuencia**: espectrograma reducido a tres bandas
  (graves rojo/naranja, medios verdes, agudos azul/cian), muestreado a un
  máximo de `BARS_MAX` puntos temporales.
- **Frases**: la pista se divide en frases de 8 compases (32 beats) alineadas
  al beatgrid; cada frase se etiqueta por su energía relativa como
  Intro / Chorus/Drop / Bridge / Outro.
- **Hot cues automáticos**: Intro, Drop, Break y Outro sobre la estructura.
- **Zonas vocales**: regiones donde la banda de formantes (200-4000 Hz)
  domina el espectro (ratio adaptativo), pintadas como badges "Vocal Zone".

El resultado se cachea en disco (`~/.smart-set-studio/analysis/<hash>.json`)
y en memoria (LRU) para que solo se calcule una vez por archivo.
"""
import hashlib
import json
import logging
import threading
from pathlib import Path

import numpy as np

from ..config import DATA_DIR
from .camelot import normalize_camelot

logger = logging.getLogger(__name__)

SAMPLE_RATE = 22050
HOP_LENGTH = 1024
N_FFT = 2048
BARS_MAX = 680  # puntos máximos de la onda RGB devuelta

# Bandas de frecuencia (Hz) de la onda RGB
LO_EDGE = 300.0     # graves (kicks/bajos) -> rojo/naranja
MID_EDGE = 5000.0   # medios (sintes/voces) -> verde
# por encima de MID_EDGE: agudos (hi-hats) -> azul/cian

PHRASE_BEATS = 32  # 8 compases x 4 beats por frase
VOCAL_MIN_ZONE_SEC = 6.0
VOCAL_MIN_RATIO = 0.34

_ANALYSIS_DIR = DATA_DIR / "analysis"
_mem_cache: dict[str, dict] = {}
_mem_cache_lock = threading.Lock()
_mem_cache_max = 128


def _cache_path(path: str) -> Path:
    digest = hashlib.sha1(path.encode("utf-8", "surrogatepass")).hexdigest()[:18]
    return _ANALYSIS_DIR / f"{digest}.json"


def _mtime_key(path: str) -> float:
    try:
        return Path(path).stat().st_mtime
    except OSError:
        return 0.0


def _round2(x: float) -> float:
    return round(float(x), 2)


def _load_mono_full(path: str) -> tuple[np.ndarray, float]:
    import librosa

    y, sr = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    if len(y) == 0:
        raise ValueError("Audio vacío o ilegible")
    return y, float(sr)


def _band_energy_vectors(y: np.ndarray, sr: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Energía instantánea (W·s) por frame en las tres bandas de frecuencia."""
    import librosa

    S = np.abs(librosa.stft(y, n_fft=N_FFT, hop_length=HOP_LENGTH)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=N_FFT)
    lo_mask = freqs <= LO_EDGE
    mid_mask = (freqs > LO_EDGE) & (freqs <= MID_EDGE)
    hi_mask = freqs > MID_EDGE
    lo = S[lo_mask, :].sum(axis=0)
    mid = S[mid_mask, :].sum(axis=0)
    hi = S[hi_mask, :].sum(axis=0)
    return lo, mid, hi


def _normalize_log(x: np.ndarray) -> np.ndarray:
    """Energía -> dB relativos normalizada a [0,1] (rango dinámico de 60 dB)."""
    db = 10.0 * np.log10(np.maximum(x, 1e-12))
    db = db - db.max()
    return np.clip((db + 60.0) / 60.0, 0.0, 1.0)


def _downsample(vec: np.ndarray, n: int) -> np.ndarray:
    """Promedia `vec` en exactamente `n` segmentos temporales."""
    if vec.size <= n:
        return np.pad(vec.astype(float), (0, max(0, n - vec.size)))
    idx = np.linspace(0, vec.size, n + 1, dtype=int)
    out = np.empty(n)
    for i in range(n):
        seg = vec[idx[i] : idx[i + 1]]
        out[i] = seg.mean() if seg.size else 0.0
    return out


def _detect_vocal_zones(lo, mid, hi, sr: float, hop: int) -> list[dict]:
    """Regiones donde la banda de formantes (200-4000 Hz) domina el espectro.

    El ratio voz/total se suaviza con una mediana; una zona vocal es un tramo
    contiguo (con huecos < 4 s fusionados) donde el ratio supera el umbral
    adaptativo, con duración mínima de `VOCAL_MIN_ZONE_SEC`.
    """
    total = lo + mid + hi
    ratio = np.where(total > 1e-9, mid / np.maximum(total, 1e-12), 0.0)
    win = max(1, int(round(0.4 * sr / hop)))
    if ratio.size > win:
        ratio = np.convolve(ratio, np.ones(win) / win, mode="same")
    base = float(np.mean(ratio))
    thr = max(VOCAL_MIN_RATIO, base + 0.5 * float(np.std(ratio)))
    frame_sec = hop / sr

    zones: list[list[float]] = []
    start: int | None = None
    for i, r in enumerate(ratio):
        active = bool(r >= thr)
        if active and start is None:
            start = i
        elif not active and start is not None:
            zones.append([start, i])
            start = None
    if start is not None:
        zones.append([start, len(ratio) - 1])

    merged: list[list[float]] = []
    for z in zones:
        if not merged or z[0] * frame_sec - merged[-1][1] * frame_sec > 4.0:
            merged.append(z)
        else:
            merged[-1][1] = z[1]
    return [
        {"start": _round2(z[0] * frame_sec), "end": _round2(z[1] * frame_sec)}
        for z in merged
        if (z[1] - z[0]) * frame_sec >= VOCAL_MIN_ZONE_SEC
    ]


def _phrases(duration: float, beats: np.ndarray, rms: np.ndarray, frame_sec: float) -> list[dict]:
    """Divide la pista en frases de 8 compases (32 beats) y las etiqueta.

    Etiquetas heurísticas por energía media de la frase:
    primera = Intro, última con energía = Outro, alta = Chorus/Drop,
    baja = Bridge, intermedia = Break.
    """
    if beats.size < 4:
        return []
    beat = float(np.median(np.diff(beats)))
    if not np.isfinite(beat) or beat <= 0:
        return []
    phrase_sec = PHRASE_BEATS * beat
    n = max(1, int(np.ceil(duration / phrase_sec)))
    starts = [i * phrase_sec for i in range(n)]
    energies = []
    for s, e in zip(starts, starts[1:] + [duration]):
        i0, i1 = int(s / frame_sec), max(int(s / frame_sec) + 1, int(e / frame_sec))
        seg = rms[i0:i1]
        energies.append(float(seg.mean()) if seg.size else 0.0)
    arr = np.array(energies)
    mean, std = float(arr.mean()), float(arr.std(ddof=0))
    labels: list[str] = []
    for i, e in enumerate(energies):
        if i == 0:
            labels.append("Intro")
        elif i == n - 1:
            labels.append("Outro")
        else:
            z = (e - mean) / max(std, 1e-9)
            labels.append("Chorus/Drop" if z > 0.55 else "Bridge" if z < -0.55 else "Break")
    return [
        {"start": _round2(s), "end": _round2(starts[i + 1] if i + 1 < n else duration), "label": labels[i]}
        for i, s in enumerate(starts)
    ]


def _hot_cues(phrases: list[dict]) -> list[dict]:
    """Cuatro cues automáticos sobre la estructura: Intro, Drop, Break, Outro."""
    dropdown = next((p for p in phrases if p["label"].startswith("Chorus")), phrases[1] if len(phrases) > 1 else None)
    drop_ph = dropdown or phrases[-1]
    breaks = [p for p in phrases if p["label"] == "Bridge"]
    after_drop = [p for p in breaks if p["start"] >= drop_ph["start"]]
    break_ph = after_drop[0] if after_drop else (breaks[-1] if breaks else drop_ph)
    outros = [p for p in phrases if p["label"] == "Outro"]
    outro_ph = outros[-1] if outros else phrases[-1]
    cues = [
        {"type": "intro", "label": "Intro", "t": _round2(max(0.0, phrases[0]["start"]))},
        {"type": "drop", "label": "Drop", "t": _round2(drop_ph["start"])},
        {"type": "break", "label": "Break", "t": _round2(break_ph["start"] + (break_ph["end"] - break_ph["start"]) / 2)},
        {"type": "outro", "label": "Outro", "t": _round2(outro_ph["start"])},
    ]
    seen = set()
    uniq = []
    for c in cues:
        key = round(c["t"], 1)
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    return uniq


def analyze_structure(path: str, bpm_hint: float | None = None) -> dict:
    """Análisis estructural completo (RGB + frases + cues + vocales).

    Usa caché en disco (el JSON se regenera si el archivo cambió) y una LRU
    en memoria para peticiones repetidas durante la sesión.
    """
    key = str(path)
    mtime = _mtime_key(key)

    cached_disk = _cache_path(key)
    if cached_disk.exists():
        try:
            data = json.loads(cached_disk.read_text("utf-8"))
            if data.get("mtime") == mtime:
                return data
        except (OSError, ValueError):
            pass

    with _mem_cache_lock:
        hit = _mem_cache.get(key)
    if hit is not None and hit.get("mtime") == mtime:
        return hit

    y, sr = _load_mono_full(key)
    duration = float(len(y)) / sr

    lo, mid, hi = _band_energy_vectors(y, sr)
    frame_sec = HOP_LENGTH / sr

    # Onda RGB: normalización log por banda + muestreo a BARS_MAX puntos
    bar_lo = _downsample(_normalize_log(lo), BARS_MAX)
    bar_mid = _downsample(_normalize_log(mid), BARS_MAX)
    bar_hi = _downsample(_normalize_log(hi), BARS_MAX)
    n_bars = len(bar_lo)
    n_frames = len(lo)
    bars = [
        {
            "t": _round2((i + 0.5) * (n_frames * frame_sec) / n_bars),
            "lo": _round2(bar_lo[i]),
            "mid": _round2(bar_mid[i]),
            "hi": _round2(bar_hi[i]),
        }
        for i in range(n_bars)
    ]

    # Beatgrid fino (tiempos de los beats) para alinear frases y grid
    import librosa

    onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
    tempo, beats = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH, units="time"
    )
    beats_arr = np.asarray(beats, dtype=float).flatten()
    bpm = bpm_hint or (float(np.atleast_1d(tempo).mean()) if beats_arr.size else None)
    if not (30 <= (bpm or 0) <= 240):
        bpm = None

    # RMS por frame (para etiquetar frases por energía)
    rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)[0]
    rms_db = librosa.amplitude_to_db(rms, ref=1.0)
    rms_norm = np.clip((rms_db - rms_db.min()) / max(rms_db.max() - rms_db.min(), 1e-6), 0, 1)

    phrases = _phrases(duration, beats_arr, rms_norm, frame_sec)
    cues = _hot_cues(phrases)
    vocal_zones = _detect_vocal_zones(lo, mid, hi, sr, HOP_LENGTH)

    result = {
        "path": key,
        "mtime": mtime,
        "duration_sec": _round2(duration),
        "bpm": _round2(bpm) if bpm else None,
        "bars": bars,
        "phrases": phrases,
        "cues": cues,
        "vocal_zones": vocal_zones,
    }

    try:
        _ANALYSIS_DIR.mkdir(parents=True, exist_ok=True)
        cached_disk.write_text(json.dumps(result), "utf-8")
    except OSError as exc:
        logger.warning("No se pudo cachear análisis de %s: %s", key, exc)

    with _mem_cache_lock:
        if len(_mem_cache) >= _mem_cache_max:
            _mem_cache.clear()
        _mem_cache[key] = result
    return result