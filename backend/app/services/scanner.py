"""Escaneo de carpetas: descubre archivos de audio y los analiza en background."""
import logging
import os
import threading
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import AUDIO_EXTENSIONS
from ..models import Folder, ScanJob, Track
from .analyzer import analyze_file, embedded_key_to_camelot, read_metadata
from .id3_writer import write_camelot_id3
from .settings import get_all_settings

logger = logging.getLogger(__name__)

_jobs: dict[int, ScanJob] = {}


def discover_audio_files(root: str) -> list[Path]:
    """Lista recursivamente los archivos de audio bajo `root`."""
    files: list[Path] = []
    root_path = Path(root)
    for dirpath, _dirnames, filenames in os.walk(root_path):
        for name in filenames:
            ext = Path(name).suffix.lower()
            if ext in AUDIO_EXTENSIONS:
                files.append(Path(dirpath) / name)
    return files


def _upsert_track(db: Session, folder: Folder, path: str, mtime: float) -> Track | None:
    """Inserta o actualiza un track (solo si el archivo cambió o no fue analizado)."""
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
            file_modified_at=mtime,
        )
        db.add(track)
        db.flush()
        return track

    # Actualizar metadatos si el archivo cambió
    if track.file_modified_at != mtime:
        meta = read_metadata(path)
        track.title = meta.title
        track.artist = meta.artist
        track.album = meta.album
        track.duration_sec = meta.duration_sec
        track.embedded_bpm = meta.embedded_bpm
        track.embedded_key = meta.embedded_key
        track.file_modified_at = mtime
        track.analyzed = False
        track.has_error = False
        track.error_message = None

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
            db.query(Track).filter(Track.folder_id == folder.id).update(
                {"analyzed": False, "has_error": False, "error_message": None}
            )
            db.commit()

        for idx, file_path in enumerate(files):
            if _job_cancelled(job):
                break
            try:
                mtime = os.path.getmtime(file_path)
                track = _upsert_track(db, folder, str(file_path), mtime)
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
                db.commit()

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
