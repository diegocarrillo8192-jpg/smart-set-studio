"""Renombrado físico de archivos de audio con su tonalidad Camelot.

Formato: `[Key] - [Nombre Original].ext` (ej. "6A - Track.mp3").

Exclusivo de la versión de escritorio (Electron): la operación solo debe
invocarse cuando el backend corre embebido en la app de escritorio. En la
versión web el backend ni siquiera está en ejecución y jamás se toca el
filesystem.

Idempotente: si el archivo ya tiene un prefijo de key, este se reemplaza por
la key actual en lugar de duplicarse ("6A - 6A - Track.mp3" → "6A - Track.mp3").
Ante una colisión con otro archivo distinto se añade un sufijo numérico.
"""
import logging
import os
import re
from pathlib import Path

logger = logging.getLogger(__name__)

# "6A - Track", "8B – Track", "12A — Track"... (guion, raya, espacio + guion)
_KEY_PREFIX_RE = re.compile(r"^\s*(\d{1,2}[AB])\s*[-–—]+\s*(.*)$", re.IGNORECASE)


def _original_stem(stem: str) -> str:
    """Nombre original sin el prefijo de key (si ya venía prefijado)."""
    m = _KEY_PREFIX_RE.match(stem)
    if m and m.group(2).strip():
        return m.group(2).strip()
    return stem


def keyed_name(path: str, camelot_key: str) -> str:
    """Nombre de archivo objetivo `[Key] - [Nombre Original].ext`."""
    p = Path(path)
    stem = _original_stem(p.stem)
    return f"{camelot_key} - {stem}{p.suffix}"


def rename_with_key(path: str, camelot_key: str) -> tuple[str, bool]:
    """Renombra el archivo en disco a `[Key] - [Nombre].ext`.

    Devuelve `(ruta_final, cambió)`. No toca nada si falta la key o si el
    nombre ya es el correcto. Ante colisión añade ` (n)` antes de la extensión
    para no sobrescribir jamás otro archivo.
    """
    if not camelot_key:
        return path, False
    p = Path(path)
    if not p.exists() or not p.is_file():
        return path, False

    target_name = keyed_name(path, camelot_key)
    if target_name == p.name:
        return path, False

    target = p.with_name(target_name)
    counter = 1
    while target.exists() and target != p:
        stem = _original_stem(p.stem)
        target = p.with_name(f"{camelot_key} - {stem} ({counter}){p.suffix}")
        counter += 1
    if target.exists() and target != p:
        return path, False

    try:
        os.rename(p, target)
    except OSError:
        # Fallback: os.replace es atómico y cubre sistemas de archivos que
        # rechazan rename sobre destinos temporales.
        os.replace(p, target)
    return str(target), True
