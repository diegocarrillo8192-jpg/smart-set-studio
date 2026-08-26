"""Análisis de audio: metadatos, BPM, tonalidad (Camelot) y energía."""
import logging
from dataclasses import dataclass

import numpy as np

from .camelot import KS_MAJOR, KS_MINOR, NOTE_NAMES, note_to_camelot

logger = logging.getLogger(__name__)

SAMPLE_RATE = 22050
ANALYSIS_MAX_SEC = 90  # se analizan los primeros N segundos para velocidad
HOP_LENGTH = 512


@dataclass
class TrackMetadata:
    title: str
    artist: str
    album: str
    duration_sec: float
    embedded_bpm: float | None = None
    embedded_key: str = ""  # tonalidad original (TKEY / INITIALKEY / Key tag)
    genre: str = ""
    year: str = ""


@dataclass
class AnalysisResult:
    bpm: float | None
    musical_key: str | None
    camelot_key: str | None
    loudness_db: float | None
    spectral_centroid: float | None
    energy: int | None  # 1-10
    error: str | None = None


# ---------------------------------------------------------------------------
# Mutagen: etiquetas y duración
# ---------------------------------------------------------------------------
def _first(values, *keys: str) -> str:
    """Primer valor no vacío de entre las claves dadas (tags tipo dict)."""
    for key in keys:
        v = values.get(key)
        if v is None:
            continue
        if isinstance(v, list):
            if v and str(v[0]).strip():
                return str(v[0]).strip()
        elif isinstance(v, str) and v.strip():
            return v.strip()
        else:
            try:
                text = str(v)
                if text and not text.startswith("<"):
                    return text
            except Exception:
                continue
    return ""


def _id3_text(audio, key: str) -> str:
    """Extrae el texto de un frame ID3 (TIT2, TPE1, TALB, TBPM, TCON, TDRC...)."""
    frame = audio.get(key)
    if frame is None:
        return ""
    try:
        if hasattr(frame, "text"):
            parts = [str(t) for t in frame.text if str(t).strip()]
            return parts[0] if parts else ""
        return str(frame).strip()
    except Exception:
        return ""


def _mp4_text(audio, key: str) -> str:
    """Extrae el texto de un tag MP4/M4A ('©nam', '©ART', '©alb'...)."""
    values = audio.get(key)
    if not values:
        return ""
    try:
        parts = [str(v) for v in values if str(v).strip()]
        return parts[0] if parts else ""
    except Exception:
        return ""


def read_metadata(file_path: str) -> TrackMetadata:
    """Lee metadatos robustos con mutagen: ID3, FLAC/OGG (Vorbis), MP4/M4A, APE.

    Extrae título, artista, álbum, duración, BPM embebido y tonalidad
    original (TKEY / INITIALKEY / Key tag) para MP3, AIFF y WAV (bloques
    ID3 en RIFF/AIFF), FLAC/OGG y M4A/AAC — además de género y año.
    """
    from mutagen import File
    from mutagen.id3 import ID3Tags

    audio = File(file_path, easy=False)
    duration = None
    title = artist = album = ""
    embedded_bpm: float | None = None
    embedded_key = ""
    genre = year = ""
    ext = file_path.rsplit(".", 1)[-1].lower() if "." in file_path else ""

    if audio is not None:
        try:
            duration = float(audio.info.length) if getattr(audio.info, "length", None) else None
        except Exception:
            duration = None

        tags = getattr(audio, "tags", None)
        kind = type(audio).__name__.lower()
        # ID3 real (MP3/AIFF/WAV con bloques ID3 en RIFF/AIFF) o dicts de tags
        is_id3 = isinstance(tags, ID3Tags)
        is_vorbis = "vorbis" in kind or "flac" in kind or "ogg" in kind
        is_mp4 = "mp4" in kind or "m4a" in kind
        is_ape = "ape" in kind

        try:
            if is_id3:
                title = _id3_text(audio, "TIT2")
                artist = _id3_text(audio, "TPE1") or _id3_text(audio, "TPE2")
                album = _id3_text(audio, "TALB")
                genre = _id3_text(audio, "TCON")
                year = _id3_text(audio, "TDRC")[:4] or _id3_text(audio, "TYER")
                bpm_raw = _id3_text(audio, "TBPM")
                embedded_key = _id3_text(audio, "TKEY")
            elif is_mp4:
                title = _mp4_text(audio, "\xa9nam")
                artist = _mp4_text(audio, "\xa9ART") or _mp4_text(audio, "aART")
                album = _mp4_text(audio, "\xa9alb")
                genre = _mp4_text(audio, "\xa9gen")
                year = _mp4_text(audio, "\xa9day")[:4]
                bpm_raw = _mp4_text(audio, "tmpo")
                # Initial Key de Mixed In Key / Rekordbox en M4A (freeform)
                for tag_name in ("----:com.apple.iTunes:initialkey", "\xa9key"):
                    val = tags.get(tag_name) if tags else None
                    if val:
                        try:
                            embedded_key = str(val[0] if isinstance(val, list) else val).strip()
                        except Exception:
                            pass
            elif is_ape and tags is not None:
                title = _first(tags, "Title")
                artist = _first(tags, "Artist", "Album Artist")
                album = _first(tags, "Album")
                genre = _first(tags, "Genre")
                year = _first(tags, "Year")
                bpm_raw = _first(tags, "BPM")
                embedded_key = _first(tags, "Key")
            elif is_vorbis and tags is not None:
                title = _first(tags, "title", "TITLE")
                artist = _first(tags, "artist", "ARTIST", "albumartist")
                album = _first(tags, "album", "ALBUM")
                genre = _first(tags, "genre", "GENRE")
                year = _first(tags, "date", "DATE", "year", "YEAR")[:4]
                bpm_raw = _first(tags, "bpm", "BPM")
                embedded_key = _first(tags, "key", "KEY", "initialkey", "INITIALKEY")
            else:
                # Fallback genérico: tags en forma de dict
                title = _first(tags, "title", "TIT2", "Title") if tags else ""
                artist = _first(tags, "artist", "TPE1", "Artist") if tags else ""
                album = _first(tags, "album", "TALB", "Album") if tags else ""
                genre = _first(tags, "genre", "TCON", "Genre") if tags else ""
                bpm_raw = _first(tags, "bpm", "TBPM", "BPM") if tags else ""
                embedded_key = _first(tags, "key", "KEY", "TKEY", "initialkey") if tags else ""
        except Exception as exc:
            logger.warning("Tags parciales para %s: %s", file_path, exc)

        if bpm_raw:
            try:
                bpm_val = float(str(bpm_raw).replace(",", "."))
                if 40 <= bpm_val <= 300:
                    embedded_bpm = round(bpm_val, 1)
            except (TypeError, ValueError):
                embedded_bpm = None

    return TrackMetadata(
        title=title or _stem(file_path),
        artist=artist or "Unknown Artist",
        album=album or "",
        duration_sec=duration or 0.0,
        embedded_bpm=embedded_bpm,
        embedded_key=_embedded_key_text(embedded_key),
        genre=genre,
        year=year,
    )


def _embedded_key_text(raw: str) -> str:
    """Limpia la tonalidad leída de las etiquetas ('8A', 'A minor', 'Am'...)."""
    text = " ".join(str(raw).split())
    if not text:
        return ""
    # Preferencia: notación Camelot directa ('10B') / nota con modo ('A minor')
    if len(text) >= 2 and text[-1] in ("A", "B") and text[:-1].isdigit():
        return text.upper()
    parts = text.split()
    if len(parts) == 2 and parts[1].lower() in ("minor", "major", "min", "maj", "m", ""):
        return text
    return text


def _stem(path: str) -> str:
    import os

    base = os.path.basename(path)
    return os.path.splitext(base)[0]


def embedded_key_to_camelot(text: str) -> tuple[str, str | None]:
    """Convierte la tonalidad original de las etiquetas a (nota+modo, Camelot).

    Soporta: '8A' / '10B' (notación Camelot directa), 'A minor' / 'F major'
    y abreviaturas tipo 'Am', 'F#m', 'C' (mayor por defecto si no hay modo).
    Devuelve ('', None) si no puede interpretar el texto.
    """
    from .camelot import camelot_to_note, normalize_camelot, note_to_camelot

    if not text:
        return "", None
    code = normalize_camelot(text)
    if code:
        try:
            note, mode = camelot_to_note(code)
            return f"{note} {mode}", code
        except ValueError:
            return "", code
    note = text.strip().split()[0]
    body = note
    mode = "major"
    if body.endswith("m") and body[-2] != "#" or body.endswith("m") and body[-2] != "b":
        if body[-1] == "m":
            body = body[:-1]
            mode = "minor"
    elif "min" in body.lower() or "min" in text.lower():
        mode = "minor"
    if not body or body[-1].isdigit():
        return "", None
    if body[-1] == "m" and body[-2].isdigit():
        return "", None
    code = note_to_camelot(body, mode)
    if not code:
        return "", None
    return f"{note} {mode}", code


# ---------------------------------------------------------------------------
# Librosa: BPM, key y energía
# ---------------------------------------------------------------------------
def _load_mono(path: str) -> tuple[np.ndarray, float]:
    import librosa

    # Decodificación optimizada para velocidad: downsample a 22050 Hz MONO
    # (suficiente para BPM/key/energía) y resampleo `soxr_mq` (calidad media,
    # mucho más rápido que el soxr_hq por defecto y sin pérdida relevante para
    # las features musicales que extraemos). El recorte a ANALYSIS_MAX_SEC
    # acota aún más el trabajo por archivo.
    y, sr = librosa.load(
        path,
        sr=SAMPLE_RATE,
        mono=True,
        duration=ANALYSIS_MAX_SEC,
        res_type="soxr_mq",
    )
    if len(y) == 0:
        raise ValueError("Audio vacío o ilegible")
    return y, float(sr)


def estimate_bpm(y: np.ndarray, sr: float, embedded_bpm: float | None = None) -> float | None:
    """Estima el BPM con beat tracking; prioriza el BPM embebido si es razonable."""
    if embedded_bpm and 60 <= embedded_bpm <= 220:
        return round(embedded_bpm, 1)

    import librosa

    try:
        onset_env = librosa.onset.onset_strength(
            y=y, sr=sr, hop_length=HOP_LENGTH
        )
        if onset_env.size < 16:
            return None
        try:
            from librosa.feature.rhythm import tempo as _tempo_fn
        except ImportError:  # librosa < 0.10
            _tempo_fn = librosa.beat.tempo
        coarse = _tempo_fn(
            onset_envelope=onset_env, sr=sr, hop_length=HOP_LENGTH,
            aggregate=np.mean,
        )
        coarse_val = float(np.atleast_1d(coarse)[0])
        if not (30 <= coarse_val <= 240):
            return None

        # Refinamiento fino vía autocorrelación del onset envelope
        ac = librosa.autocorrelate(onset_env, max_size=len(onset_env))
        center_lag = 60.0 / coarse_val * (sr / HOP_LENGTH)
        lo = max(2, int(center_lag * 0.80))
        hi = int(center_lag * 1.20) + 1
        if hi > len(ac) - 1:
            hi = len(ac) - 1
        if hi <= lo:
            return round(coarse_val, 1)

        window = ac[lo:hi]
        idx = int(np.argmax(window))
        lag = lo + idx

        # Interpolación parabólica para precisión sub-muestra
        if 1 <= idx < len(window) - 1:
            y0, y1, y2 = window[idx - 1], window[idx], window[idx + 1]
            denom = (y0 - 2 * y1 + y2)
            if abs(denom) > 1e-12:
                delta = 0.5 * (y0 - y2) / denom
                lag += max(-0.5, min(0.5, delta))

        tempo = 60.0 / (lag * HOP_LENGTH / sr)
        if 40 <= tempo <= 240:
            return round(tempo, 1)
        return round(coarse_val, 1)
    except Exception:
        return None


def estimate_key(y: np.ndarray, sr: float) -> tuple[str | None, str | None]:
    """Detección de tonalidad vía chroma + correlación de Krumhansl-Schmuckler.

    Devuelve (nota, código Camelot) o (None, None) si no hay confianza.
    """
    try:
        import librosa

        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=HOP_LENGTH)
        chroma_mean = chroma.mean(axis=1)

        best_score = -np.inf
        best = (None, None)
        for shift in range(12):
            profile_major = np.roll(KS_MAJOR, shift)
            profile_minor = np.roll(KS_MINOR, shift)
            for mode, profile in (("major", profile_major), ("minor", profile_minor)):
                score = np.corrcoef(chroma_mean, profile)[0, 1]
                if np.isnan(score):
                    score = -np.inf
                if score > best_score:
                    best_score = score
                    root_pc = (shift) % 12
                    note = NOTE_NAMES[root_pc]
                    best = (note, mode)

        note, mode = best
        camelot = note_to_camelot(note, mode)
        return f"{note} {mode}", camelot
    except Exception:
        return None, None


def compute_features(y: np.ndarray, sr: float) -> tuple[float, float, float]:
    """Devuelve (loudness_db, spectral_centroid_hz, rms_db)."""
    try:
        import librosa

        rms = librosa.feature.rms(y=y, hop_length=HOP_LENGTH)[0]
        rms_db = librosa.amplitude_to_db(rms, ref=1.0)
        loudness_db = float(np.percentile(rms_db[rms_db > -100.0], 85)) if np.any(rms_db > -100.0) else -60.0

        centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=HOP_LENGTH)[0]
        centroid_hz = float(np.nanmean(centroid))
        if np.isnan(centroid_hz):
            centroid_hz = 0.0
        return loudness_db, centroid_hz, float(np.nanmean(rms_db))
    except Exception:
        return -60.0, 0.0, -60.0


def _loudness_to_energy(loudness_db: float) -> float:
    """Mapea loudness (-60..0 dB) a energía 1-10 con curva exponencial suave."""
    if loudness_db <= -45:
        return 1.0
    if loudness_db >= -3:
        return 10.0
    norm = (loudness_db + 45.0) / 42.0  # 0..1
    return round(1.0 + 9.0 * (norm**1.6), 1)


def _centroid_to_energy(centroid_hz: float) -> float:
    """Mapea el spectral centroid (0..12 kHz) a energía 1-10 (brillo tímbrico)."""
    if centroid_hz <= 200:
        return 1.0
    if centroid_hz >= 8000:
        return 10.0
    norm = (centroid_hz - 200.0) / 7800.0
    return round(1.0 + 9.0 * (norm**1.3), 1)


def compute_energy(loudness_db: float, centroid_hz: float) -> int:
    """Energía final 1-10: 70% loudness + 30% brillo tímbrico."""
    e_loud = _loudness_to_energy(loudness_db)
    e_centroid = _centroid_to_energy(centroid_hz)
    energy = 0.7 * e_loud + 0.3 * e_centroid
    return int(round(min(10.0, max(1.0, energy))))


def analyze_file(path: str, embedded_bpm: float | None = None) -> AnalysisResult:
    """Pipeline completo de análisis de un archivo de audio."""
    try:
        y, sr = _load_mono(path)
        bpm = estimate_bpm(y, sr, embedded_bpm)
        note, camelot = estimate_key(y, sr)
        loudness_db, centroid_hz, _ = compute_features(y, sr)
        energy = compute_energy(loudness_db, centroid_hz)
        return AnalysisResult(
            bpm=bpm,
            musical_key=note,
            camelot_key=camelot,
            loudness_db=round(loudness_db, 2),
            spectral_centroid=round(centroid_hz, 1),
            energy=energy,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("Fallo al analizar %s: %s", path, exc)
        return AnalysisResult(
            bpm=None, musical_key=None, camelot_key=None,
            loudness_db=None, spectral_centroid=None, energy=None,
            error=str(exc),
        )
