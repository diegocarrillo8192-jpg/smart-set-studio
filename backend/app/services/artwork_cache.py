"""Caché persistente de carátulas.

Arquitectura de dos niveles:
- SQLite (`artwork_cache`): fila por archivo. `file` apunta a la imagen
  procesada en disco (hash sha1 como nombre) o es NULL para un negativo
  confirmado (el archivo NO tiene carátula, para no re-abrir mutagen jamás).
- Disco (`ARTWORK_CACHE_DIR/<sha1>.<ext>`): la imagen tal cual se extrae y
  se sirve por FileResponse+ETag (304s de navegador/Chromium incluidos).

El endpoint sirve PRIMERO la fila de la BD: una carpeta ya escaneada
devuelve el 100% de las portadas sin re-extraer nada (sub-ms por consulta).
"""
import hashlib
import logging
from pathlib import Path

from ..config import ARTWORK_CACHE_DIR
from ..database import get_artwork_cache, set_artwork_cache

logger = logging.getLogger(__name__)

MIME_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif"}


def sniff_mime(data: bytes) -> str:
    """Detecta el MIME por las magic bytes (JPEG/PNG/GIF); por defecto JPEG."""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return "image/jpeg"


def extract_embedded(path: str) -> tuple[bytes, str] | None:
    """Extrae la portada incrustada con mutagen y sin fallos silenciosos:
    1) frames ID3 APIC (MP3, AIFF, WAV con chunk ID3) · 2) pictures
    (FLAC/OGG/OPUS) · 3) covr (MP4/M4A) · 4) APE "Cover Art (Front)".
    Cada formato se intenta en su propio bloque: un tag corrupto de un
    contenedor no impide probar los demás."""
    try:
        from mutagen import File
    except ImportError:
        return None
    try:
        audio = File(path)
        if audio is None:
            return None
    except Exception:
        return None
    tags = getattr(audio, "tags", None)

    # 1) ID3 APIC (MP3 / AIFF / WAV): todos los frames, tolere fallos parciales
    if tags is not None and hasattr(tags, "getall"):
        try:
            for apic in tags.getall("APIC"):
                data = getattr(apic, "data", None)
                if data:
                    mime = getattr(apic, "mime", None) or None
                    return data, mime or sniff_mime(bytes(data))
        except Exception:
            pass

    # 2) FLAC / OGG / OPUS: pictures
    try:
        pictures = getattr(audio, "pictures", None) or []
        for pic in pictures:
            data = getattr(pic, "data", None)
            if data:
                mime = getattr(pic, "mime", None) or None
                return data, mime or sniff_mime(bytes(data))
    except Exception:
        pass

    # 3) MP4 / M4A: covr
    try:
        if tags is not None and tags.get("covr"):
            item = tags["covr"][0]
            data = getattr(item, "data", None) or (
                bytes(item) if isinstance(item, bytes) else None
            )
            if data:
                return data, sniff_mime(bytes(data))
    except Exception:
        pass

    # 4) APE tags: "Cover Art (Front)" → valor binario tras el separador NUL
    try:
        if tags is not None and hasattr(tags, "keys"):
            for key in tags.keys():
                if "cover art" in str(key).lower():
                    val = tags.get(key)
                    if not val:
                        continue
                    raw = bytes(val) if not isinstance(val, bytes) else val
                    parts = raw.split(b"\x00", 2)
                    data = parts[2] if len(parts) > 2 else raw
                    if data:
                        return data, sniff_mime(data)
    except Exception:
        pass

    return None


def _cache_path(data: bytes, mime: str) -> Path:
    return ARTWORK_CACHE_DIR / f"{hashlib.sha1(data).hexdigest()}{MIME_EXT.get(mime, '.jpg')}"


def get_cached(path: str) -> tuple[str | None, str] | None:
    """Consulta la caché persistente: (file_disk, mime) si hay carátula;
    (None, mime) si hay negativo confirmado; None si no hay fila (o el
    archivo de disco se perdió: se volverá a extraer y a re-grabar)."""
    row = get_artwork_cache(path)
    if row is None:
        return None
    file, mime = row
    if not file:
        return None, mime
    if not Path(file).exists():
        return None  # archivo de caché perdido → re-extraer
    return file, mime


def store_embedded(path: str, data: bytes, mime: str) -> str:
    """Guarda la imagen procesada en disco (sha1) y la vincula en SQLite.
    Devuelve la ruta del archivo de caché."""
    target = _cache_path(data, mime)
    try:
        if not target.exists():
            tmp = target.with_suffix(target.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(target)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Escritura de carátula en disco fallida para %s: %s", path, exc)
    set_artwork_cache(path, str(target), mime)
    return str(target)


def store_negative(path: str) -> None:
    """Confirma en BD que `path` no tiene carátula (evita re-probar siempre)."""
    set_artwork_cache(path, None, None)