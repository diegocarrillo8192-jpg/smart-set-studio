"""Escaneo de carpetas: descubre archivos de audio y los analiza en background."""
import logging
import os
import threading
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import AUDIO_EXTENSIONS
from ..models import Folder, ScanJob, Track
from .analyzer import analyze_file, embedded_key_to_camelot, read_metadata
from .artwork_cache import extract_embedded, get_cached, store_embedded
from .id3_writer import write_camelot_id3
from .settings import get_all_settings

logger = logging.getLogger(__name__)

_jobs: dict[int, ScanJob] = {}


def discover_audio_files(root: str) -> list[Path]:
    """Lista recursivamente los archivos de audio bajo `root`.

    Nunca lanza: si un subdirectorio no es accesible (permisos, enlaces rotos,
    disco removido) se salta y se registra en el log; una carpeta entera rota
    no debe tumbar el escaneo ni la respuesta HTTP del endpoint."""
    files: list[Path] = []
    root_path = Path(root)
    if not root_path.exists():
        logger.warning("Carpeta raíz inexistente durante el escaneo: %s", root)
        return files

    def _on_error(exc: OSError) -> None:
        logger.warning("Subdirectorio no legible durante el escaneo: %s", exc)

    for dirpath, _dirnames, filenames in os.walk(root_path, onerror=_on_error):
        for name in filenames:
            try:
                ext = Path(name).suffix.lower()
            except Exception:  # noqa: BLE001
                continue  # nombre ilegible: omitir, jamás abortar
            if ext in AUDIO_EXTENSIONS:
                files.append(Path(dirpath) / name)
    return files


def _cache_artwork_once(path: str, force: bool = False) -> None:
    """Precache en el primer escaneo: la carátula embebida se extrae UNA vez
    y se persiste (disco sha1 + SQLite). Así, al abrir una carpeta ya
    escaneada, el endpoint sirve el 100% de las portadas desde la caché en
    <1 ms cada una. SOLO guarda positivos: el negativo (sin arte) lo decide
    el endpoint, porque la carpeta puede tener una portada adjunta.

    `force=True` (re-escaneo manual): re-extrae la carátula embebida aunque
    ya exista fila en caché, y regenera la miniatura si el arte cambió."""
    try:
        if not force and get_cached(path) is not None:
            return
        embedded = extract_embedded(path)
        if embedded is not None:
            data, mime = embedded
            store_embedded(path, data, mime)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Arte de %s no precacheable: %s", path, exc)


def _upsert_track(
    db: Session, folder: Folder, path: str, mtime: float, force_meta: bool = False
) -> Track | None:
    """Inserta o actualiza un track (solo si el archivo cambió o fue no analizado).

    `force_meta=True` (re-escaneo manual): re-lee SIEMPRE las etiquetas
    (mutagen) para repoblar género/artista/tonalidad de la pista sin depender
    del mtime — los 1049 tracks indexados antes de la columna `genre` quedan
    NULL y este re-escaneo los rellena. No re-analiza BPM (los datos de
    análisis del archivo intacto se conservan)."""
    track = db.query(Track).filter_by(file_path=path).one_or_none()
    if track is None:
        meta = read_metadata(path)
        track = Track(
            file_path=path,
            folder_id=folder.id,
            title=meta.title,
            artist=meta.artist,
            album=meta.album,
            duration_sec=meta.duration_sec,
            embedded_bpm=meta.embedded_bpm,
            embedded_key=meta.embedded_key,
            # Nuevo: guardar género leído (fallback a nombre de carpeta si está vacío)
            genre=meta.genre or folder.name,
            file_modified_at=mtime,
        )
        db.add(track)
        db.flush()
        _cache_artwork_once(path)
        return track

    # Actualizar metadatos si el archivo cambió o el usuario pidió re-escaneo
    if track.file_modified_at != mtime or force_meta:
        meta = read_metadata(path)
        track.title = meta.title
        track.artist = meta.artist
        track.album = meta.album
        track.duration_sec = meta.duration_sec
        track.embedded_bpm = meta.embedded_bpm
        track.embedded_key = meta.embedded_key
        track.file_modified_at = mtime
        # Género real de las etiquetas; si el archivo no define uno, se usa el
        # nombre de la carpeta contenedora (nunca "Desconocido").
        if meta.genre:
            track.genre = meta.genre
        elif not track.genre:
            track.genre = folder.name  # fallback a nombre de carpeta
        track.analyzed = False if not force_meta else track.analyzed
        track.has_error = False
        track.error_message = None
        _cache_artwork_once(path, force=force_meta)

    return track


def run_scan(db: Session, job: ScanJob, folder: Folder, force: bool = False) -> None:
    """Ejecuta el escaneo + análisis de una carpeta (llamado desde un thread)."""
    job.status = "running"
    db.commit()

    try:
        files = discover_audio_files(folder.path)
        job.total_files = len(files)
        db.commit()

        if force:
            # Re-escaneo manual: NO se re-analiza BPM de archivos intactos (los
            # resultados existentes se conservan); el worker re-lee las etiquetas
            # (mutagen) y re-extrae las carátulas vía force_meta en _upsert_track.
            db.commit()

        # PASE 1 (rápido): poblar TODA la carpeta de golpe. Se insertan las
        # filas con los metadatos de etiquetas (title/artist/género) y
        # analyzed=False en un único commit: la UI muestra el listado completo
        # al instante con "Analizando…" y valores "-" en BPM/Key, igual que
        # la web. El análisis pesado de audio llega después, fila por fila.
        for file_path in files:
            try:
                mtime = os.path.getmtime(file_path)
                _upsert_track(db, folder, str(file_path), mtime, force_meta=force)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Track fallido (poblamiento) %s: %s", file_path, exc)
        try:
            db.commit()
        except Exception as exc:  # noqa: BLE001
            # Un commit inicial fallido no debe abortar el escaneo restante:
            # se descarta la transacción y el pase 2 reintenta cada track.
            db.rollback()
            logger.warning("Commit de poblamiento inicial fallido: %s", exc)

        # PASE 2 (lento): análisis audio por archivo → hidratación fila a fila.
        # Los tracks ya existen (pase 1); cada commit intermedio actualiza solo
        # lo que se terminó de analizar y la UI refresca la fila real.
        for idx, file_path in enumerate(files):
            if _job_cancelled(job):
                break
            try:
                mtime = os.path.getmtime(file_path)
                track = _upsert_track(db, folder, str(file_path), mtime, force_meta=force)
                if track is not None and not track.analyzed:
                    result = analyze_file(str(file_path), embedded_bpm=track.embedded_bpm)
                    if result.error:
                        track.has_error = True
                        track.error_message = result.error
                        track.analyzed = True
                    else:
                        track.bpm = result.bpm
                        track.musical_key = result.musical_key
                        track.camelot_key = result.camelot_key
                        # Fallback: tonalidad original de las etiquetas del archivo
                        # (TKEY/INITIALKEY en MP3, AIFF, WAV, FLAC y M4A)
                        if not track.camelot_key and track.embedded_key:
                            music, camelot = embedded_key_to_camelot(track.embedded_key)
                            track.musical_key = track.musical_key or music
                            track.camelot_key = camelot
                        track.loudness_db = result.loudness_db
                        track.spectral_centroid = result.spectral_centroid
                        track.energy = result.energy
                        track.analyzed = True
                        track.has_error = False
                        track.error_message = None
                        # Escritorio: escribir la key detectada en el ID3 del MP3
                        _tag_track_id3(db, str(file_path), result.camelot_key)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Track fallido %s: %s", file_path, exc)

            job.processed_files = idx + 1
            if idx % 5 == 0:
                try:
                    db.commit()
                except Exception as exc:  # noqa: BLE001
                    # Un commit intermedio no debe abortar el escaneo restante:
                    # se descarta la transacción y se reintenta en el siguiente
                    # lote (los tracks pendientes se re-insertan al re-procesar).
                    db.rollback()
                    logger.warning("Commit intermedio del escaneo fallido: %s", exc)

        db.commit()
        folder.last_scanned_at = job.started_at
        job.status = "done"
        job.message = f"{job.total_files} archivos, {job.processed_files} procesados"
    except Exception as exc:  # noqa: BLE001
        logger.exception("Escaneo fallido")
        job.status = "error"
        job.message = str(exc)
    finally:
        from datetime import datetime, timezone

        job.finished_at = datetime.now(timezone.utc)
        db.commit()


def _job_cancelled(job: ScanJob) -> bool:
    return job.status == "cancelled"


def _should_write_id3(db: Session, file_path: str) -> bool:
    """¿Etiquetar ID3 del archivo original? Solo escritorio + opción activa,
    y únicamente MP3 (TKEY/COMM de ID3v2). La versión web nunca toca archivos."""
    if not file_path.lower().endswith(".mp3"):
        return False
    s = get_all_settings(db)
    return bool(s.get("write_id3_keys")) and bool(s.get("is_desktop"))


def _tag_track_id3(db: Session, file_path: str, camelot_key: str | None) -> None:
    """Escribe la tonalidad detectada en TKEY/COMM del MP3 (integridad de audio
    garantizada por mutagen: solo se reescribe el bloque de tags)."""
    if camelot_key and _should_write_id3(db, file_path):
        write_camelot_id3(file_path, camelot_key)


def start_scan(db: Session, folder: Folder, force: bool = False) -> ScanJob:
    """Lanza el escaneo en un hilo daemon y devuelve el job."""
    from datetime import datetime, timezone

    job = ScanJob(folder_id=folder.id, status="pending")
    db.add(job)
    db.commit()
    db.refresh(job)

    def _worker():
        thread_db = Session(db.get_bind())
        try:
            folder_db = thread_db.get(Folder, folder.id)
            job_db = thread_db.get(ScanJob, job.id)
            if folder_db and job_db:
                run_scan(thread_db, job_db, folder_db, force=force)
        finally:
            thread_db.close()

    threading.Thread(target=_worker, daemon=True, name=f"scan-{folder.id}").start()
    return job
