"""API de tracks: búsqueda, filtros, streaming y análisis de audio."""
import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Folder, Track
from ..schemas import TrackOut
from ..services.camelot import normalize_camelot, relation
from ..config import AUDIO_EXTENSIONS

router = APIRouter(prefix="/api", tags=["tracks"])

# Caché en memoria de carátulas embebidas: {file_path: (bytes, mime)}
_artwork_cache: dict[str, tuple[bytes, str]] = {}


def _cors_headers() -> dict[str, str]:
    """Encabezados CORS explícitos para respuestas de media (reforzando el
    middleware global): la UI web (localhost:5173) lee covers y stream desde
    el navegador mediante fetch/<audio>/Web Audio y necesita ACAO siempre."""
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
    }


def _resolve_existing_path(path: str) -> Path:
    """Ruta real en disco desde la almacenada en BD, reparando el mojibake
    heredado ('MÃºsica' → 'Música': el nombre UTF-8 fue leído como cp1252 al
    indexar) y las variantes Unicode NFC/NFD. Devuelve la original si no hay
    reparación posible (aguas abajo fallará con 404 y se usará el fallback)."""
    import unicodedata

    p = Path(path.strip()).expanduser()
    if p.exists():
        return p
    try:
        alt = path.encode("cp1252").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        alt = path
    for candidate in (alt, path):
        for form in (unicodedata.normalize("NFC", candidate), unicodedata.normalize("NFD", candidate)):
            q = Path(form).expanduser()
            if q != p and q.exists():
                return q
    return p


def _is_indexed(db: Session, path: str) -> bool:
    """¿La ruta pertenece a la biblioteca indexada? Tolerante a case y a la
    forma de los separadores (web puede enviar 'd:/...' vs 'D:\\...')."""
    if db.query(Track).filter(Track.file_path == path).first() is not None:
        return True
    if db.query(Folder).filter(Folder.path == path).first() is not None:
        return True
    from sqlalchemy import func

    norm = os.path.normcase(os.path.normpath(path))
    if (
        db.query(Track).filter(func.lower(Track.file_path) == norm.lower()).first()
        is not None
    ):
        return True
    return (
        db.query(Folder).filter(func.lower(Folder.path) == norm.lower()).first()
        is not None
    )


def _read_embedded_artwork(path: str) -> tuple[bytes, str] | None:
    """Extrae la portada incrustada con mutagen: ID3 APIC (MP3), PICTURE
    (FLAC/Vorbis), covr (MP4/M4A), APE. Devuelve (bytes, mime) o None."""
    try:
        from mutagen import File
    except ImportError:
        return None
    try:
        audio = File(path)
        if audio is None:
            return None
        # MP3 / ID3: etiquetas APIC
        tags = getattr(audio, "tags", None)
        if tags is not None:
            for apic in tags.getall("APIC"):
                data = apic.data if hasattr(apic, "data") else None
                if data:
                    return (data, apic.mime or "image/jpeg")
        # FLAC / OGG / OPUS: pictures
        pictures = getattr(audio, "pictures", []) or []
        for pic in pictures:
            data = getattr(pic, "data", None)
            if data:
                return (data, getattr(pic, "mime", None) or "image/jpeg")
        # MP4 / M4A: covr
        if tags is not None and tags.get("covr"):
            item = tags["covr"][0]
            data = getattr(item, "data", None) or (bytes(item) if isinstance(item, bytes) else None)
            if data:
                return (data, "image/jpeg" if not isinstance(item, bytes) else "image/jpeg")
    except Exception:
        return None
    return None

SORTABLE = {
    "title": Track.title,
    "artist": Track.artist,
    "bpm": Track.bpm,
    "energy": Track.energy,
    "camelot_key": Track.camelot_key,
    "duration_sec": Track.duration_sec,
}


def _serialize(track: Track, folder_name: str | None = None) -> TrackOut:
    return TrackOut(
        id=track.id,
        file_path=track.file_path,
        folder_id=track.folder_id,
        folder_name=folder_name,
        title=track.title,
        artist=track.artist,
        album=track.album,
        duration_sec=track.duration_sec,
        bpm=track.bpm,
        embedded_bpm=track.embedded_bpm,
        musical_key=track.musical_key,
        camelot_key=track.camelot_key,
        embedded_key=track.embedded_key,
        energy=track.energy,
        loudness_db=track.loudness_db,
        spectral_centroid=track.spectral_centroid,
        analyzed=track.analyzed,
        has_error=track.has_error,
        error_message=track.error_message,
    )


@router.get("/tracks", response_model=list[TrackOut])
def list_tracks(
    db: Session = Depends(get_db),
    q: str | None = Query(None, description="Búsqueda global"),
    folder_id: int | None = None,
    camelot: str | None = Query(None, description="Filtrar por clave Camelot"),
    compatible_with: str | None = Query(None, description="Claves compatibles con esta"),
    min_bpm: float | None = None,
    max_bpm: float | None = None,
    min_energy: int | None = None,
    max_energy: int | None = None,
    analyzed_only: bool = False,
    sort: str = "artist",
    order: str = "asc",
    limit: int = 500,
    offset: int = 0,
):
    query = db.query(Track, Folder.name).outerjoin(Folder, Track.folder_id == Folder.id)

    if q:
        like = f"%{q.strip()}%"
        query = query.filter(
            or_(
                Track.title.ilike(like),
                Track.artist.ilike(like),
                Track.album.ilike(like),
                Track.camelot_key.ilike(like),
                Track.musical_key.ilike(like),
                Folder.name.ilike(like),
            )
        )
    if folder_id is not None:
        query = query.filter(Track.folder_id == folder_id)
    if camelot:
        code = normalize_camelot(camelot)
        if not code:
            raise HTTPException(400, "Camelot inválido")
        query = query.filter(Track.camelot_key == code)
    if compatible_with:
        from ..services.camelot import is_compatible

        code = normalize_camelot(compatible_with)
        if not code:
            raise HTTPException(400, "Camelot inválido")
        all_tracks = query.all()
        filtered = [row for row in all_tracks if row[0].camelot_key and is_compatible(code, row[0].camelot_key)]
        return [_serialize(t, f) for t, f in filtered][offset : offset + limit]
    if min_bpm is not None:
        query = query.filter(Track.bpm >= min_bpm)
    if max_bpm is not None:
        query = query.filter(Track.bpm <= max_bpm)
    if min_energy is not None:
        query = query.filter(Track.energy >= min_energy)
    if max_energy is not None:
        query = query.filter(Track.energy <= max_energy)
    if analyzed_only:
        query = query.filter(Track.analyzed.is_(True))

    column = SORTABLE.get(sort, Track.title)
    if order == "desc":
        column = column.desc()
    query = query.order_by(column, Track.id).offset(offset).limit(limit)

    rows = query.all()
    return [_serialize(t, f) for t, f in rows]


@router.get("/tracks/{track_id}", response_model=TrackOut)
def get_track(track_id: int, db: Session = Depends(get_db)):
    row = db.query(Track, Folder.name).outerjoin(Folder, Track.folder_id == Folder.id).filter(Track.id == track_id).first()
    if not row:
        raise HTTPException(404, "Track no encontrado")
    track, folder_name = row
    return _serialize(track, folder_name)


@router.get("/tracks/{track_id}/recommendations")
def track_recommendations(track_id: int, db: Session = Depends(get_db), limit: int = 5):
    """Recomendador en vivo: los `limit` tracks con mayor compatibilidad
    armónica (Rueda Camelot) y BPM similar al track semilla cargado en el
    Deck A. Devuelve el match con su relación y un score 0-100.
    """
    seed = db.get(Track, track_id)
    if not seed:
        raise HTTPException(404, "Track no encontrado")
    if not (seed.analyzed and seed.camelot_key and seed.bpm):
        return {"seed": _serialize(seed), "recommendations": []}

    from ..services.camelot import camelot_number, camelot_mode, normalize_camelot
    from ..services.settings import get_all_settings

    settings = get_all_settings(db)
    max_bpm_var = float(settings.get("max_bpm_variation_pct", 2.5))
    radius = int(settings.get("harmonic_radius", 1))
    allow_mode = bool(settings.get("allow_mode_change", True))

    seed_key = normalize_camelot(seed.camelot_key)
    results: list[tuple[float, Track]] = []
    rows = db.query(Track).filter(Track.analyzed.is_(True), Track.id != track_id).all()
    for t in rows:
        key = normalize_camelot(t.camelot_key)
        if not key or not t.bpm:
            continue
        # Puntuación armónica (misma escala que el generador de sets)
        if key == seed_key:
            harmonic = 100
            rel_key, rel_label = "same", "Perfect Match"
        else:
            rel_key, rel_label = relation(seed.camelot_key, t.camelot_key)
            if rel_key == "same":
                harmonic = 100
            elif rel_key == "mode":
                harmonic = 90 if allow_mode else 0
            elif rel_key == "neighbor":
                num = camelot_number(seed_key)
                harmonic = 75 if abs(camelot_number(key) - num) <= radius else 40
            elif rel_key == "boost":
                harmonic = 85
            else:
                harmonic = 0
        if harmonic == 0:
            continue
        # Penalización por desviación de BPM (lineal: -40 pts por cada 2.5%)
        diff_pct = abs(t.bpm - seed.bpm) / seed.bpm * 100
        bpm_score = max(0.0, 1.0 - (diff_pct - max_bpm_var) / max(max_bpm_var, 0.01))
        if diff_pct <= max_bpm_var:
            bpm_score = 1.0
        score = harmonic * bpm_score
        results.append((score, t, rel_key, rel_label, round(diff_pct, 1)))

    results.sort(key=lambda r: (-r[0], r[1].artist.lower(), r[1].title.lower()))
    recs = []
    for score, t, rel_key, rel_label, bpm_diff in results[:limit]:
        item = _serialize(t)
        item = item.model_dump() if hasattr(item, "model_dump") else item
        recs.append(
            {
                "track": item,
                "score": round(score, 1),
                "relation": rel_key,
                "relation_label": rel_label,
                "bpm_diff_pct": bpm_diff,
            }
        )
    return {"seed": _serialize(seed).model_dump(), "recommendations": recs}


@router.get("/tracks/{track_id}/audio")
def stream_audio(track_id: int, db: Session = Depends(get_db)):
    """Streaming del archivo de audio por ID de track (soporta Range para seek)."""
    track = db.get(Track, track_id)
    if not track:
        raise HTTPException(404, "Track no encontrado")
    return _stream_file(track.file_path)


@router.get("/audio/stream")
def stream_audio_by_path(path: str, db: Session = Depends(get_db)):
    """Streaming directo por ruta local: /api/audio/stream?path=C:\...\track.mp3

    Los elementos <audio> del frontend usan esta URL (servida por el backend con
    CORS + Range requests), evitando bloqueos de acceso a archivos locales.
    Blindaje: la ruta debe pertenecer a un track indexado o a una carpeta
    registrada en la biblioteca (previene Path Traversal a archivos arbitrarios).
    """
    if not path or not path.strip():
        raise HTTPException(400, "Falta el parámetro path")
    p = _resolve_existing_path(path)
    if not _is_indexed(db, str(Path(path.strip()).expanduser())):
        raise HTTPException(403, "Ruta no autorizada")
    return _stream_file(str(p))


@router.get("/audio")
def stream_audio_alias(path: str, db: Session = Depends(get_db)):
    """Alias de /api/audio/stream (/api/audio?path=...) para los reproductores
    web: recibe el stream del archivo y lo entrega al <audio>/Web Audio API."""
    return stream_audio_by_path(path, db)


@router.get("/audio/artwork")
def track_artwork(path: str, db: Session = Depends(get_db)):
    """Carátula (album art) del track: /api/audio/artwork?path=...

    Prioridad: 1) carátula EMBEBIDA en el archivo (ID3 APIC / FLAC PICTURE /
    M4A covr, extraída con mutagen y cacheada en memoria); 2) imagen gemela
    del audio ("track.mp3" -> "track.jpg"); 3) nombres estándar de portada
    en su carpeta (cover/folder/front/artwork/art/album). Misma validación
    de biblioteca indexada que el streaming (Path Traversal).
    """
    if not path or not path.strip():
        raise HTTPException(400, "Falta el parámetro path")
    # La ruta indexada puede arrastrar mojibake heredado; resuélvela al disco.
    p = _resolve_existing_path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "El archivo ya no existe en disco")
    if not _is_indexed(db, str(Path(path.strip()).expanduser())):
        raise HTTPException(403, "Ruta no autorizada")

    # 1) Carátula embebida (ID3 Cover Picture) con caché en memoria
    cached = _artwork_cache.get(str(p))
    if cached is not None:
        data, mime = cached
        return Response(
            content=data,
            media_type=mime,
            headers={
                **_cors_headers(),
                "Cache-Control": "public, max-age=86400",
            },
        )
    embedded = _read_embedded_artwork(str(p))
    if embedded is not None:
        data, mime = embedded
        if len(_artwork_cache) > 256:
            _artwork_cache.clear()
        _artwork_cache[str(p)] = (data, mime)
        return Response(
            content=data,
            media_type=mime,
            headers={
                **_cors_headers(),
                "Cache-Control": "public, max-age=86400",
            },
        )

    # 2-3) Carátulas adjuntas en disco
    candidates = [p.with_suffix(ext) for ext in (".jpg", ".jpeg", ".png")]
    folder = p.parent
    for name in ("cover", "folder", "front", "artwork", "art", "album", "scan"):
        candidates += [folder / f"{name}.{ext}" for ext in ("jpg", "jpeg", "png")]
    for c in candidates:
        if c.exists():
            return FileResponse(
                str(c),
                headers={
                    **_cors_headers(),
                    "Cache-Control": "public, max-age=86400",
                },
            )
    raise HTTPException(404, "Sin carátula")


@router.get("/audio/analysis")
def track_analysis(path: str, db: Session = Depends(get_db)):
    """Análisis estructural del track (onda RGB por frecuencia, frases,
    hot cues y zonas vocales): /api/audio/analysis?path=C:\...\track.mp3

    Estilo Rekordbox 7 / Mixed In Key, calculado con librosa (STFT en 3
    bandas, beatgrid, energía por frase y ratio de formantes vocales) y
    cacheado en disco + memoria. Misma validación de biblioteca indexada
    que el streaming y las carátulas (Path Traversal).
    """
    if not path or not path.strip():
        raise HTTPException(400, "Falta el parámetro path")
    p = Path(path.strip()).expanduser()
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "El archivo ya no existe en disco")
    if not _is_indexed(db, str(p)):
        raise HTTPException(403, "Ruta no autorizada")
    try:
        from ..services.analysis import analyze_structure

        data = analyze_structure(str(p))
    except Exception as exc:  # noqa: BLE001
        logger = logging.getLogger(__name__)
        logger.warning("Análisis estructural fallido para %s: %s", p, exc)
        raise HTTPException(422, f"No se pudo analizar la estructura: {exc}") from exc
    return data


def _stream_file(path: str):
    import os
    from pathlib import Path

    if not path or not path.strip():
        raise HTTPException(400, "Falta el parámetro path")
    p = _resolve_existing_path(path)
    if not p.exists() or not p.is_file():
        raise HTTPException(404, "El archivo de audio ya no existe en disco")
    ext = p.suffix.lower()
    if ext not in AUDIO_EXTENSIONS:
        raise HTTPException(400, f"Extensión no soportada: {ext}")
    return FileResponse(
        str(p),
        media_type=_media_type(str(p)),
        headers=_cors_headers(),
    )


def _media_type(path: str) -> str:
    ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    return {
        "mp3": "audio/mpeg",
        "wav": "audio/wav",
        "flac": "audio/flac",
        "aiff": "audio/aiff",
        "aif": "audio/aiff",
        "ogg": "audio/ogg",
        "m4a": "audio/mp4",
        "opus": "audio/opus",
    }.get(ext, "application/octet-stream")
