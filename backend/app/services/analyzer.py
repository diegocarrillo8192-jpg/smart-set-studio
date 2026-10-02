"""Análisis de audio: metadatos, BPM, tonalidad (Camelot) y energía."""
import logging
from dataclasses import dataclass

import numpy as np

from .camelot import KS_MAJOR, KS_MINOR, NOTE_NAMES, NOTE_PC, note_to_camelot

logger = logging.getLogger(__name__)

SAMPLE_RATE = 22050
ANALYSIS_MAX_SEC = 90  # se analizan los primeros N segundos para velocidad
KEY_ANALYSIS_MAX_SEC = 45  # re-análisis rápido de key: menos audio, aún preciso
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


# Mapeo del byte de tonalidad de Serato (0-23) -> Camelot.
# Serato numera las 24 claves sobre el círculo de quintas: 0-11 son las
# mayores (C, G, D, A, E, B, F#, C#, F, Bb, Eb, Ab) y 12-23 las menores
# (Am, Em, Bm, F#m, C#m, G#m, Ebm, Bbm, Fm, Cm, Gm, Dm), igual que la
# numeración Camelot.
SERATO_KEY_TO_CAMELOT = (
    "8B", "9B", "10B", "11B", "12B", "1B", "2B", "3B", "7B", "6B", "5B", "4B",
    "8A", "9A", "10A", "11A", "12A", "1A", "2A", "3A", "4A", "5A", "6A", "7A",
)


def _id3_txxx(audio, *descriptions: str) -> str:
    """Primer valor de un frame TXXX cuyo descriptor coincida (case-insensitive).

    Mixed In Key y Rekordbox escriben 'InitialKey'/'KEY' como TXXX cuando no
    usan TKEY/INITIALKEY.
    """
    try:
        for frame in audio.getall("TXXX"):
            try:
                desc = (str(frame.desc) if frame.desc is not None else "").strip().lower()
            except Exception:
                continue
            if desc not in descriptions:
                continue
            try:
                parts = [str(t) for t in frame.text if str(t).strip()]
            except Exception:
                continue
            if parts:
                return parts[0]
    except Exception:
        pass
    return ""


def _zlib_inflate(data: bytes) -> bytes:
    """Descomprime un GEOB Serato si viene comprimido; '' si no aplica."""
    try:
        import zlib

        return zlib.decompress(data)
    except Exception:
        return b""


def _serato_key_code(payload: bytes) -> int | None:
    """Escanea el payload binario del GEOB 'Serato *' buscando el campo KEY.

    Formato de campo: 4 bytes de identificador ('KEY'+0x00/0x20) + 4 bytes de
    longitud big-endian + datos (la key es el primer byte, 0-23).
    """
    idx = payload.find(b"KEY")
    while idx != -1:
        if idx + 8 <= len(payload) and idx + 8 + 1 <= len(payload):
            length = int.from_bytes(payload[idx + 4 : idx + 8], "big")
            if 1 <= length <= 4:
                code = payload[idx + 8]
                if 0 <= code < 24:
                    return code
        idx = payload.find(b"KEY", idx + 1)
    return None


def _serato_key_json(audio) -> str:
    """Tonalidad desde el GEOB 'Key' en JSON (Serato DJ Pro moderno).

    Serato DJ Pro 2.x+ guarda la key en un GEOB cuyo descriptor es 'Key' y
    cuyo contenido es JSON codificado en base64:
    ``{"key":"9A","source":"mixedinkey","algorithm":94}``.
    """
    try:
        for frame in audio.getall("GEOB"):
            try:
                desc = (str(frame.desc) if frame.desc is not None else "").strip().lower()
            except Exception:
                continue
            if desc != "key":
                continue
            try:
                data = bytes(frame.data)
            except Exception:
                continue
            import base64
            import json

            try:
                text = base64.b64decode(data).decode("utf-8", "replace")
                payload = json.loads(text)
            except Exception:
                continue
            key = payload.get("key")
            if isinstance(key, str) and key.strip():
                code = key.strip().upper()
                if code.endswith(("A", "B")) and code[:-1].isdigit():
                    return code
    except Exception:
        pass
    return ""


def _serato_key(audio) -> str:
    """Tonalidad desde el GEOB 'Serato Analysis/Markers' (byte 0-23 -> Camelot).

    Formato legacy (Serato Scratch Live / Serato DJ 1.x): campo 'KEY' de 4
    bytes de identificador + 4 bytes de longitud big-endian + datos (la key
    es el primer byte, 0-23, sobre el círculo de quintas).
    """
    try:
        for frame in audio.getall("GEOB"):
            try:
                desc = (str(frame.desc) if frame.desc is not None else "").strip().lower()
            except Exception:
                continue
            if "serato" not in desc:
                continue
            try:
                data = bytes(frame.data)
            except Exception:
                continue
            for payload in (data, _zlib_inflate(data)):
                if not payload:
                    continue
                code = _serato_key_code(payload)
                if code is not None:
                    return SERATO_KEY_TO_CAMELOT[code]
    except Exception:
        pass
    return ""


def read_metadata(file_path: str) -> TrackMetadata:
    """Lee metadatos robustos con mutagen: ID3, FLAC/OGG (Vorbis), MP4/M4A, APE.

    Extrae título, artista, álbum, duración, BPM embebido y tonalidad
    original (TKEY / INITIALKEY / Key tag) para MP3, AIFF y WAV (bloques
    ID3 en RIFF/AIFF), FLAC/OGG y M4A/AAC — además de género y año.
    """
    from mutagen import File
    from mutagen.id3 import ID3Tags

    # Un archivo corrupto (MPEG inválido, tags rotos...) no debe reventar la
    # lectura: se devuelven metadatos por defecto y el error queda en el log.
    try:
        audio = File(file_path, easy=False)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Archivo ilegible para metadatos %s: %s", file_path, exc)
        audio = None
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
                # `tags` es el ID3Tags real: tiene getall() (TXXX/GEOB), que
                # WAVE/AIFF no exponen en el objeto File de mutagen.
                title = _id3_text(tags, "TIT2")
                artist = _id3_text(tags, "TPE1") or _id3_text(tags, "TPE2")
                album = _id3_text(tags, "TALB")
                genre = _id3_text(tags, "TCON")
                year = _id3_text(tags, "TDRC")[:4] or _id3_text(tags, "TYER")
                bpm_raw = _id3_text(tags, "TBPM")
                # Prioridad de fuentes de tonalidad: TKEY (Rekordbox/Traktor/
                # Mixed In Key), INITIALKEY (ID3v2.4), TXXX 'InitialKey'/'KEY'
                # y, por último, los GEOB propietarios de Serato (JSON moderno
                # primero, byte legacy del círculo de quintas después).
                embedded_key = (
                    _id3_text(tags, "TKEY")
                    or _id3_text(tags, "INITIALKEY")
                    or _id3_txxx(tags, "initialkey", "initial key", "key")
                    or _serato_key_json(tags)
                    or _serato_key(tags)
                )
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
    # Notación Open Key de Traktor: '8m' (menor) / '8d' (mayor) == 8A / 8B.
    import re

    op = re.match(r"^\s*(\d{1,2})\s*([md])\s*$", text, re.IGNORECASE)
    if op:
        num = int(op.group(1))
        if 1 <= num <= 12:
            code = normalize_camelot(f"{num}{'A' if op.group(2).lower() == 'm' else 'B'}")
            if code:
                note, mode = camelot_to_note(code)
                return f"{note} {mode}", code
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
    return f"{body} {mode}", code


# ---------------------------------------------------------------------------
# Librosa: BPM, key y energía
# ---------------------------------------------------------------------------
def _load_mono(path: str, duration: float = ANALYSIS_MAX_SEC) -> tuple[np.ndarray, float]:
    import librosa

    # Decodificación optimizada para velocidad: downsample a 22050 Hz MONO
    # (suficiente para BPM/key/energía) y resampleo `soxr_mq` (calidad media,
    # mucho más rápido que el soxr_hq por defecto y sin pérdida relevante para
    # las features musicales que extraemos). El recorte de duración acota aún
    # más el trabajo por archivo.
    y, sr = librosa.load(
        path,
        sr=SAMPLE_RATE,
        mono=True,
        duration=duration,
        res_type="soxr_mq",
    )
    if len(y) == 0:
        raise ValueError("Audio vacío o ilegible")
    return y, float(sr)


def _librosa_tempo():
    """Devuelve la función tempo() disponible (librosa.feature.rhythm o beat)."""
    try:
        from librosa.feature.rhythm import tempo  # librosa >= 0.10

        return tempo
    except (ImportError, AttributeError):  # librosa < 0.10
        import librosa

        return librosa.beat.tempo


def _tempo_from_envelope(onset_env: np.ndarray, sr: float) -> float | None:
    """Estimación robusta de BPM desde el onset envelope (anti double/half-time).

    La ambigüedad de octava (el doble o la mitad del tempo real) es el fallo
    clásico de los detectores de BPM: patrones de bombo/plato repetidos cada
    dos beats generan periodicidad más fuerte en el doble del periodo real.

    Estrategia:
    1. Varios arranques de `tempo()` (prior 60/90/120/150 BPM) generan
       candidatos en octavas distintas (el DP es multiestable).
    2. Cada candidato (y sus mitades/dobles) se evalúa con el beat tracker
       y se puntúa por:
       - Contraste de onset sobre la rejilla (mean onset en beats / mean),
       - Periodicidad de autocorrelación normalizada en ese lag,
       - Prior de convención DJ (70-190 BPM domina; mitades/dobles extremos
         solo ganan si la evidencia es claramente superior).
    3. El periodo ganador se refina con interpolación parabólica.
    """
    import librosa

    n = len(onset_env)
    if n < 16:
        return None
    fps = sr / HOP_LENGTH

    # Autocorrelación normalizada por solape (comparable entre lags)
    ac = librosa.autocorrelate(onset_env, max_size=n)
    acn = ac / np.maximum(n - np.arange(len(ac)), 1.0)

    def ac_strength(tempo: float) -> float:
        lag = int(round(60.0 / tempo * fps))
        if lag < 2 or lag > len(acn) - 2:
            return 0.0
        return float(acn[lag - 1 : lag + 2].max())

    def grid_contrast(tempo: float) -> tuple[float, float]:
        est, beats = librosa.beat.beat_track(
            onset_envelope=onset_env,
            sr=sr,
            hop_length=HOP_LENGTH,
            start_bpm=tempo,
            tightness=100,
        )
        t = float(np.atleast_1d(est)[0])
        frames = np.round(beats).astype(int)
        frames = frames[(frames >= 0) & (frames < n)]
        if len(frames) < 8:
            return t, 0.0
        contrast = float(onset_env[frames].mean() / (onset_env.mean() + 1e-9))
        return t, contrast

    def prior(tempo: float) -> float:
        if 70 <= tempo <= 190:
            return 1.0
        if 190 < tempo <= 230 or 40 <= tempo < 70:
            return 0.55
        return 0.3

    tempo_fn = _librosa_tempo()
    candidates: set[float] = set()
    for start in (60, 90, 120, 150):
        try:
            est = tempo_fn(
                onset_envelope=onset_env,
                sr=sr,
                hop_length=HOP_LENGTH,
                aggregate=np.median,
                start_bpm=start,
            )
            t = float(np.atleast_1d(est)[0])
            if 30 <= t <= 300:
                candidates.add(round(t, 1))
        except Exception:
            continue
    if not candidates:
        return None

    # Familias de octava: cada candidato genera su mitad y su doble
    family: set[float] = set()
    for t in candidates:
        for f in (t / 2, t, t * 2):
            if 35 <= f <= 300:
                family.add(round(f, 1))

    best_tempo: float | None = None
    best_score = -np.inf
    for cand in family:
        try:
            t, contrast = grid_contrast(cand)
        except Exception:
            continue
        if not (35 <= t <= 300) or contrast <= 0:
            continue
        score = contrast * (0.4 + 0.15 * ac_strength(t)) * prior(t)
        if score > best_score:
            best_score, best_tempo = score, t
    if best_tempo is None:
        return None

    # Guardia anti-ruido: en audio sin ritmo (ruido/silencio) la autocorrelación
    # normalizada es plana (~1.0); en música real el pico del periodo supera
    # claramente ese piso. Sin periodicidad real no se devuelve tempo.
    baseline = float(np.median(acn))
    if ac_strength(best_tempo) < max(1.6, baseline * 1.4):
        return None

    # Interpolación parabólica del pico de autocorrelación (precisión sub-muestra)
    lag0 = 60.0 / best_tempo * fps
    i0 = int(round(lag0))
    if 2 <= i0 < len(acn) - 1:
        y0, y1, y2 = acn[i0 - 1], acn[i0], acn[i0 + 1]
        denom = y0 - 2 * y1 + y2
        if abs(denom) > 1e-12:
            lag0 += max(-0.5, min(0.5, 0.5 * (y0 - y2) / denom))
    tempo = 60.0 / (lag0 / fps)
    if 40 <= tempo <= 300:
        return round(tempo, 1)
    return round(best_tempo, 1)


def estimate_bpm(y: np.ndarray, sr: float, embedded_bpm: float | None = None) -> float | None:
    """Estima el BPM; prioriza el BPM embebido si es razonable.

    Sin BPM embebido se usa el detector calibrado de `_tempo_from_envelope`,
    que evalúa candidatos en varias octavas y resuelve la ambigüedad
    double-time/half-time con contraste de rejilla + autocorrelación
    normalizada + prior de convención DJ (70-190 BPM).
    """
    if embedded_bpm and 60 <= embedded_bpm <= 220:
        return round(embedded_bpm, 1)

    import librosa

    try:
        onset_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP_LENGTH)
        return _tempo_from_envelope(onset_env, sr)
    except Exception:
        return None


KEY_MIN_CORRELATION = 0.35   # confianza mínima para aceptar una tonalidad
KEY_MODE_TIE_MARGIN = 0.05   # margen para desempatar paralelas/relativas


def _relative_of(note: str, mode: str) -> tuple[str, str]:
    """Par relativo de una tonalidad: mayor -> menor relativa (raíz -3),
    menor -> mayor relativa (raíz +3 semitonos)."""
    idx = NOTE_PC[note]
    if mode == "major":
        return NOTE_NAMES[(idx - 3) % 12], "minor"
    return NOTE_NAMES[(idx + 3) % 12], "major"


def _mode_vote(chroma_mean: np.ndarray, note: str, mode: str) -> bool:
    """¿El cromagrama respalda el modo del candidato?

    Compara la energía en la tercera mayor vs la tercera menor de la raíz:
    el tercer grado es el discriminador más fiable entre mayor y menor
    cuando los perfiles K-S están empatados (típico entre relativos).
    """
    idx = NOTE_PC[note]
    maj3 = float(chroma_mean[(idx + 4) % 12])
    min3 = float(chroma_mean[(idx + 3) % 12])
    return (maj3 >= min3) if mode == "major" else (min3 >= maj3)


def estimate_key(y: np.ndarray, sr: float) -> tuple[str | None, str | None]:
    """Detección de tonalidad vía chroma + correlación de Krumhansl-Schmuckler.

    Separación armónico/percursivo con HPSS (los kicks ensucian el croma con
    ruido de banda ancha), `chroma_cqt` solo sobre la señal armónica (promedio
    temporal normalizado, robusto a octavas: el croma pliega todas las octavas)
    y selección del par (raíz, modo) de mayor correlación contra los perfiles
    K-S de las 24 tonalidades.

    Calibración anti-confusión mayor/menor relativo:
    - Si el segundo candidato (paralelo o relativo) queda a menos de
      `KEY_MODE_TIE_MARGIN`, un voto del tercer grado (mayor vs menor) sobre el
      cromagrama decide el modo.
    - Si la correlación del ganador no alcanza `KEY_MIN_CORRELATION` (ruido,
      silencio, audio sin pitch claro), no se devuelve tonalidad: un nulo es
      preferible a una key falsa que corrompa las mezclas armónicas.

    Devuelve (nota, código Camelot) o (None, None) si no hay confianza.
    """
    try:
        import librosa

        y_harm, _ = librosa.effects.hpss(y)
        if y_harm.size == 0 or float(np.max(np.abs(y_harm))) < 1e-6:
            y_harm = y
        try:
            chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr, hop_length=HOP_LENGTH)
        except Exception:
            chroma = librosa.feature.chroma_stft(y=y_harm, sr=sr, hop_length=HOP_LENGTH)
        chroma_mean = chroma.mean(axis=1)
        norm = float(np.linalg.norm(chroma_mean))
        if norm > 1e-9:
            chroma_mean = chroma_mean / norm

        scores: list[tuple[str, str, float]] = []
        for shift in range(12):
            for mode, profile in (("major", KS_MAJOR), ("minor", KS_MINOR)):
                prof = np.roll(profile, shift)
                corr = float(np.corrcoef(chroma_mean, prof)[0, 1])
                if np.isnan(corr):
                    corr = -np.inf
                scores.append((NOTE_NAMES[shift], mode, corr))
        scores.sort(key=lambda item: -item[2])

        best_note, best_mode, best_score = scores[0]
        if best_score < KEY_MIN_CORRELATION:
            return None, None

        if len(scores) > 1:
            n2, m2, s2 = scores[1]
            if best_score - s2 < KEY_MODE_TIE_MARGIN:
                relative = _relative_of(best_note, best_mode)
                parallel = n2 == best_note and m2 != best_mode
                if (n2, m2) == relative or parallel:
                    vote_best = _mode_vote(chroma_mean, best_note, best_mode)
                    vote_alt = _mode_vote(chroma_mean, n2, m2)
                    if not vote_best and vote_alt:
                        best_note, best_mode = n2, m2

        camelot = note_to_camelot(best_note, best_mode)
        return f"{best_note} {best_mode}", camelot
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


def analyze_key_only(path: str) -> tuple[str | None, str | None]:
    """Re-análisis rápido EXCLUSIVO de tonalidad (sin BPM ni waveform).

    PRIORIDAD 1 — metadatos: si el archivo ya trae la key (TKEY/INITIALKEY/
    Rekordbox/Serato/Traktor), se usa tal cual y NO se toca el audio.
    FALLBACK — motor armónico: HPSS + chroma_cqt + Krumhansl-Schmuckler sobre
    los primeros `KEY_ANALYSIS_MAX_SEC` segundos.

    Devuelve (musical_key, camelot_key) o (None, None) si todo falla.
    """
    try:
        meta = read_metadata(path)
        if meta.embedded_key:
            music, camelot = embedded_key_to_camelot(meta.embedded_key)
            if camelot:
                return music, camelot
    except Exception as exc:  # noqa: BLE001
        logger.warning("Metadatos ilegibles para key de %s: %s", path, exc)

    try:
        y, sr = _load_mono(path, duration=KEY_ANALYSIS_MAX_SEC)
        return estimate_key(y, sr)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Re-análisis de key falló en %s: %s", path, exc)
        return None, None
