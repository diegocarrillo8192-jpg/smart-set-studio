"""Exportación de sets: XML Rekordbox/Serato y copia ordenada a USB."""
import os
import shutil
import time
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


def _rekordbox_location(path: str) -> str:
    """Convierte la ruta local del archivo en el URI estricto que Rekordbox
    necesita para reproducir el track al importar el XML:
    `file://localhost/C:/Users/.../Track.mp3` — barras invertidas → diagonales
    y codificación percent (RFC 3986) de espacios y caracteres reservados.
    Las rutas web (blob:/http) y las ya-URI se devuelven sin tocar."""
    from urllib.parse import quote

    if not path:
        return ""
    if path.startswith(("blob:", "http://", "https://", "file://")):
        return path
    norm = path.replace("\\", "/")
    # Solo convertimos rutas absolutas con unidad (C:/...); las relativas/UNC
    # se dejan tal cual: Rekordbox las reconstruye contra su biblioteca.
    if not (len(norm) >= 2 and norm[1] == ":"):
        return norm
    return "file://localhost/" + quote(norm, safe="/:")


def _track_xml(track, include_location: bool, track_id: int) -> ET.Element:
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
    file_type = _FILE_TYPE.get(ext, ext.lstrip(".").upper())
    location = _rekordbox_location(track.file_path)
    attrs = {
        "Name": track.title,
        "Artist": track.artist,
        "Album": track.album,
        "Genre": track.genre or "",
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
        "FileType": file_type,
        "Kind": f"{file_type} File",
        "Rate": "0",
        "DateAdded": _date_str(mtime),
        "ModificationTime": _date_str(mtime),
        "Mix": "",
        # Ubicación como URI estricto: indispensable para que Rekordbox
        # reproduzca/arrastre el track sin re-localizarlo manualmente.
        "Location": location,
        # ID del track dentro de esta COLLECTION; la playlist lo referencia
        # con <TRACK Key="ID"/>.
        "TrackID": str(track_id),
    }
    el = ET.Element("TRACK", attrs)
    if include_location:
        loc = ET.SubElement(el, "LOCATION")
        # El mismo URI en el nodo PATH (Rekordbox + Serato lo aceptan igual).
        ET.SubElement(loc, "PATH").text = location
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
    for idx, track in enumerate(tracks, start=1):
        collection.append(_track_xml(track, include_location=True, track_id=idx))

    playlists = ET.SubElement(root, "PLAYLISTS")
    node_root = ET.SubElement(playlists, "NODE", {"Name": "Root", "Type": "0"})
    node_set = ET.SubElement(
        node_root, "NODE",
        {
            "Name": _safe_name(dj_set.name),
            "Type": "1",
            "Entries": str(len(items)),
            "KeyType": "0",
        },
    )
    for idx, item in enumerate(items, start=1):
        # Key = TrackID del TRACK en la COLLECTION (referencia cruzada que
        # Rekordbox usa para mapear la playlist con los archivos).
        ET.SubElement(node_set, "TRACK", {"Num": str(item.position), "Key": str(idx)})

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


def _copy_track(src: Path, target: Path) -> bool:
    """Copia un único track de forma secuencial (bloqueante) con 1 reintento.

    Devuelve True si la copia terminó correctamente y False si falló también
    tras el reintento (lentitud del buffer USB, permisos, etc.)."""
    for attempt in range(2):
        try:
            if target.exists():
                target.unlink()
            shutil.copy2(src, target)
            return True
        except OSError:
            if attempt == 0:
                time.sleep(0.3)
    return False


def export_to_usb(dj_set: Set, destination: str) -> dict:
    """Copia los tracks en orden con prefijo numérico a un destino (USB/otra carpeta).

    La transferencia es secuencial: se espera a que cada track termine antes de
    iniciar el siguiente, evitando así bloqueos de I/O y saturación del puerto USB."""
    import re

    if not destination or not destination.strip():
        raise ValueError("Destino vacío")
    dest = Path(destination).expanduser().resolve()
    if not dest.is_absolute():
        raise ValueError("El destino debe ser una ruta absoluta")
    dest.mkdir(parents=True, exist_ok=True)

    items = sorted(dj_set.items, key=lambda i: i.position)
    copied: list[str] = []
    failed: list[str] = []
    for item in items:
        src = Path(item.track.file_path)
        if not src.exists():
            failed.append(item.track.file_path)
            continue
        ext = src.suffix.lower()
        # Sanitizar el nombre: sin caracteres inválidos ni segmentos ".."
        # (previene Path Traversal dentro del destino copiado).
        safe_stem = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", src.stem).strip().replace("..", "_") or "track"
        target = dest / f"{item.position:02d} - {safe_stem}{ext}"

        if not _copy_track(src, target):
            failed.append(item.track.file_path)
            continue
        copied.append(target.name)

    return {
        "copied": len(copied),
        "failed": len(failed),
        "failed_files": failed,
        "total": len(items),
        "destination": str(dest),
    }
