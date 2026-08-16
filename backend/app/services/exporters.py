"""Exportación de sets: XML Rekordbox/Serato y copia ordenada a USB."""
import os
import shutil
from datetime import datetime
from pathlib import Path

import xml.etree.ElementTree as ET

from ..config import EXPORTS_DIR
from ..models import Set

# Extensiones que Rekordbox entiende en <FileType>
_FILE_TYPE = {
    ".mp3": "MP3", ".wav": "WAV", ".flac": "FLAC", ".aiff": "AIFF", ".aif": "AIFF",
    ".ogg": "OGG", ".m4a": "M4A", ".opus": "OPUS",
}


def _date_str(ts: float | None) -> str:
    if not ts:
        return "2024-01-01"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def _track_xml(track, include_location: bool) -> ET.Element:
    size = 0
    mtime = None
    file_exists = False
    try:
        size = os.path.getsize(track.file_path)
        mtime = os.path.getmtime(track.file_path)
        file_exists = True
    except OSError:
        pass

    ext = Path(track.file_path).suffix.lower()
    attrs = {
        "Name": track.title,
        "Artist": track.artist,
        "Album": track.album,
        "Genre": "",
        "Year": "",
        "Comment": "",
        "Label": "",
        "Remixer": "",
        "Tonality": track.musical_key or "",
        "Key": track.camelot_key or "",
        "Bpm": f"{track.bpm:.1f}" if track.bpm else "0.0",
        "AverageBpm": f"{track.bpm:.1f}" if track.bpm else "0.0",
        "TimeSig": "4/4",
        "Rating": "0",
        "PlayCount": "0",
        "Autoload": "0",
        "BitRate": "320",
        "SampleRate": "44100",
        "TotalTime": _fmt_total_time(track.duration_sec or 0),
        "Duration": f"{int((track.duration_sec or 0) * 1000)}",
        "Size": str(size),
        "Volume": "0",
        "TrackNumber": "0",
        "DiscNumber": "0",
        "FileType": _FILE_TYPE.get(ext, ext.lstrip(".").upper()),
        "DateAdded": _date_str(mtime),
        "ModificationTime": _date_str(mtime),
        "Mix": "",
    }
    el = ET.Element("TRACK", attrs)
    if include_location:
        loc = ET.SubElement(el, "LOCATION")
        # Si la ruta absoluta no existe (ej. unidad no montada), usar el nombre
        # del archivo como ruta relativa para que Rekordbox/Serato puedan
        # reconstruir la ubicación al importar.
        path = track.file_path if file_exists else Path(track.file_path).name
        ET.SubElement(loc, "PATH").text = path
    # Curva de tempo (vacía; Rekordbox/Serato la reconstruyen al importar)
    ET.SubElement(el, "TEMPO")
    return el


def _fmt_total_time(sec: float) -> str:
    m, s = divmod(int(sec), 60)
    return f"{m:02d}:{s:02d}"


def build_rekordbox_xml(dj_set: Set) -> ET.ElementTree:
    """Construye el árbol XML Rekordbox 1.0.0 (DJ_PLAYLISTS > COLLECTION + PLAYLISTS)."""
    items = sorted(dj_set.items, key=lambda i: i.position)
    tracks = [i.track for i in items]

    root = ET.Element("DJ_PLAYLISTS", {"Version": "1.0.0"})
    ET.SubElement(
        root, "PRODUCT",
        {"Name": "rekordbox", "Version": "6.0.0", "Company": "Pioneer DJ"},
    )

    collection = ET.SubElement(root, "COLLECTION", {"Entries": str(len(tracks))})
    for track in tracks:
        collection.append(_track_xml(track, include_location=True))

    playlists = ET.SubElement(root, "PLAYLISTS")
    node_root = ET.SubElement(playlists, "NODE", {"Name": "Root", "Type": "0"})
    node_set = ET.SubElement(node_root, "NODE", {"Name": _safe_name(dj_set.name), "Type": "1"})
    for item in items:
        ET.SubElement(node_set, "TRACK", {"Num": str(item.position), "Key": item.track.camelot_key or ""})

    return ET.ElementTree(root)


def export_rekordbox_xml(dj_set: Set) -> tuple[Path, str]:
    """Escribe el XML en disco y devuelve (ruta, contenido)."""
    tree = build_rekordbox_xml(dj_set)
    safe = _safe_name(dj_set.name)
    out_path = EXPORTS_DIR / f"{safe}.xml"
    tree.write(out_path, encoding="UTF-8", xml_declaration=True)
    return out_path, tree_to_string(tree)


def tree_to_string(tree: ET.ElementTree) -> str:
    """Serializa el árbol con declaración XML y codificación UTF-8."""
    import io

    buffer = io.StringIO()
    buffer.write('<?xml version="1.0" encoding="UTF-8"?>\n')
    tree.write(buffer, encoding="unicode")
    return buffer.getvalue()


def _safe_name(name: str) -> str:
    return "".join(c if c.isalnum() or c in " -_" else "_" for c in name)


def export_to_usb(dj_set: Set, destination: str) -> dict:
    """Copia los tracks en orden con prefijo numérico a un destino (USB/otra carpeta)."""
    import re

    if not destination or not destination.strip():
        raise ValueError("Destino vacío")
    dest = Path(destination).expanduser().resolve()
    if not dest.is_absolute():
        raise ValueError("El destino debe ser una ruta absoluta")
    dest.mkdir(parents=True, exist_ok=True)

    items = sorted(dj_set.items, key=lambda i: i.position)
    copied: list[str] = []
    for item in items:
        src = Path(item.track.file_path)
        if not src.exists():
            continue
        ext = src.suffix.lower()
        # Sanitizar el nombre: sin caracteres inválidos ni segmentos ".."
        # (previene Path Traversal dentro del destino copiado).
        safe_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", src.stem).strip().replace("..", "_") or "track"
        target = dest / f"{item.position:02d} - {safe_stem}{ext}"
        if target.exists():
            target.unlink()
        shutil.copy2(src, target)
        copied.append(target.name)

    return {"copied": len(copied), "total": len(items), "destination": str(dest)}
