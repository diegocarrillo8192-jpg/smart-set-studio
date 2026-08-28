"""Escaneo de carpetas: descubre archivos de audio y los analiza en background.

Pipeline de rendimiento:

- **Paralelización**: un `ThreadPoolExecutor` compartido (4-6 hilos) ejecuta en
  simultáneo el trabajo CPU/IO por archivo (lectura de tags con mutagen,
  análisis BPM/key/energía con librosa y extracción de carátula). numpy/librosa
  liberan el GIL durante la decodificación, el resampling y las FFT, así que los
  hilos aprovechan todos los núcleos de la CPU.
- **Escritura en lote**: el hilo principal consolida los resultados y hace
  `commit` de SQLite cada `DB_COMMIT_BATCH` tracks (no por track), evitando
  fsync/commit continuos y manteniendo el lock de escritura abierto el mínimo
  tiempo posible (WAL).
"""
import logging
import os
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy.orm import Session

from ..config import AUDIO_EXTENSIONS
from ..models import Folder, ScanJob, Track
from .analyzer import (
    AnalysisResult,
    TrackMetadata,
    analyze_file,
    analyze_key_only,
    embedded_key_to_camelot,
    read_metadata,
)
from .artwork_cache import extract_embedded, get_cached, store_embedded
from .id3_writer import write_camelot_id3
from .settings import get_all_settings

logger = logging.getLogger(__name__)

_jobs: dict[int, ScanJob] = {}

# Número de hilos de análisis concurrentes (4-6, según núcleos disponibles).
def _analysis_workers() -> int:
    try:
        n = os.cpu_count() or 4
    except Exception:  # noqa: BLE001
        n = 4
    return max(4, min(6, n))


ANALYSIS_WORKERS = _analysis_workers()

# Escritura agrupada: commit de SQLite cada N tracks (no por track individual).
DB_COMMIT_BATCH = 25

# Pool compartido de análisis (único para toda la app): acota la concurrencia
# global a 4-6 hilos aunque se lancen varios escaneos de carpetas a la vez.
_analysis_pool: ThreadPoolExecutor | None = None
_pool_lock = threading.Lock()


def _get_pool() -> ThreadPoolExecutor:
    global _analysis_pool
    with _pool_lock:
        if _analysis_pool is None:
            _analysis_pool = ThreadPoolExecutor(
                max_workers=ANALYSIS_WORKERS, thread_name_prefix="ssa-analysis"
            )
        return _analysis_pool


@dataclass
class _FileWork:
    path: str
    mtime: float
    needs_meta: bool
    needs_analysis: bool
    embedded_bpm: float | None
    extract_art: bool


@dataclass
class _FileResult:
    path: str
    mtime: float
    meta: TrackMetadata | None
    analysis: AnalysisResult | None
    artwork: tuple[bytes, str] | None


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


def _process_file(work: _FileWork) -> _FileResult:
    """Trabajo CPU/IO por archivo, ejecutado en un hilo del pool (sin tocar BD)."""
    meta: TrackMetadata | None = None
    analysis: AnalysisResult | None = None
    artwork: tuple[bytes, str] | None = None
    try:
        if work.needs_meta:
            meta = read_metadata(work.path)
        if work.needs_analysis:
            embedded = meta.embedded_bpm if meta is not None else work.embedded_bpm
            analysis = analyze_file(work.path, embedded_bpm=embedded)
        if work.extract_art:
            artwork = extract_embedded(work.path)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Análisis de worker falló en %s: %s", work.path, exc)
    return _FileResult(work.path, work.mtime, meta, analysis, artwork)


def _apply_result(
    db: Session,
    folder: Folder,
    track: Track | None,
    result: _FileResult,
    force: bool,
    id3_enabled: bool,
) -> None:
    """Aplica metadatos, análisis y carátula de un track a la BD (sin commit).

    El commit se agrupa aguas arriba (`DB_COMMIT_BATCH`) para no escribir en
    disco por cada track individual.
    """
    path = result.path

    if track is None:
        if result.meta is None:
            raise ValueError(f"Metadatos ilegibles para nuevo track: {path}")
        meta = result.meta
        track = Track(
            file_path=path,
            folder_id=folder.id,
            title=meta.title,
            artist=meta.artist,
            album=meta.album,
            duration_sec=meta.duration_sec,
            embedded_bpm=meta.embedded_bpm,
            embedded_key=meta.embedded_key,
            genre=meta.genre or folder.name,
            file_modified_at=result.mtime,
        )
        db.add(track)
    elif result.meta is not None:
        meta = result.meta
        track.title = meta.title
        track.artist = meta.artist
        track.album = meta.album
        track.duration_sec = meta.duration_sec
        track.embedded_bpm = meta.embedded_bpm
        track.embedded_key = meta.embedded_key
        track.file_modified_at = result.mtime
        # Género real de las etiquetas; si el archivo no define uno, se usa el
        # nombre de la carpeta contenedora (nunca "Desconocido").
        if meta.genre:
            track.genre = meta.genre
        elif not track.genre:
            track.genre = folder.name
        # force (re-escaneo manual) conserva el análisis existente; un cambio
        # real del archivo (mtime distinto) fuerza el re-análisis.
        track.analyzed = False if not force else track.analyzed
        track.has_error = False
        track.error_message = None

    if result.analysis is not None:
        r = result.analysis
        if r.error:
            track.has_error = True
            track.error_message = r.error
            track.analyzed = True
        else:
            track.bpm = r.bpm
            track.musical_key = r.musical_key
            track.camelot_key = r.camelot_key
            # Fallback: tonalidad original de las etiquetas del archivo
            # (TKEY/INITIALKEY en MP3, AIFF, WAV, FLAC y M4A)
            if not track.camelot_key and track.embedded_key:
                music, camelot = embedded_key_to_camelot(track.embedded_key)
                track.musical_key = track.musical_key or music
                track.camelot_key = camelot
            track.loudness_db = r.loudness_db
            track.spectral_centroid = r.spectral_centroid
            track.energy = r.energy
            track.analyzed = True
            track.has_error = False
            track.error_message = None
            # Escritorio: escribir la key detectada en el ID3 del MP3
            if id3_enabled and path.lower().endswith(".mp3") and r.camelot_key:
                write_camelot_id3(path, r.camelot_key)

    if result.artwork is not None:
        data, mime = result.artwork
        try:
            store_embedded(path, data, mime)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Carátula de %s no cacheable: %s", path, exc)


def run_scan(db: Session, job: ScanJob, folder: Folder, force: bool = False) -> None:
    """Ejecuta el escaneo + análisis de una carpeta (llamado desde un thread).

    Descubre los archivos, planifica el trabajo por archivo (una sola consulta
    masiva de estado, no N), analiza en paralelo con el pool de workers y
    persiste los resultados en lotes.
    """
    job.status = "running"
    db.commit()

    try:
        files = discover_audio_files(folder.path)

        # 1) Estado actual en UNA consulta masiva (no una por track).
        existing = {
            t.file_path: t for t in db.query(Track).filter_by(folder_id=folder.id).all()
        }
        id3_enabled = _id3_enabled(db)

        # 2) Planificación: qué necesita cada archivo (meta / análisis / arte).
        work_items: list[_FileWork] = []
        for file_path in files:
            path = str(file_path)
            try:
                mtime = os.path.getmtime(file_path)
            except OSError:
                logger.warning("Track inaccesible (mtime): %s", path)
                continue

            track = existing.get(path)
            if track is None:
                needs_meta = True
                needs_analysis = True
                embedded_bpm: float | None = None
            elif force:
                # Re-escaneo manual: relee tags y arte, pero NO re-analiza BPM
                # de archivos ya analizados (los resultados se conservan).
                needs_meta = True
                needs_analysis = not track.analyzed
                embedded_bpm = track.embedded_bpm
            else:
                changed = track.file_modified_at != mtime
                needs_meta = changed
                needs_analysis = changed or not track.analyzed
                embedded_bpm = track.embedded_bpm

            extract_art = force or get_cached(path) is None
            work_items.append(
                _FileWork(path, mtime, needs_meta, needs_analysis, embedded_bpm, extract_art)
            )

        job.total_files = len(work_items)
        db.commit()

        # 3) Análisis concurrente + escritura en lote de resultados.
        processed = 0
        pool = _get_pool()
        futures = {pool.submit(_process_file, w): w for w in work_items}

        for fut in as_completed(futures):
            if _job_cancelled(job):
                for f in futures:
                    f.cancel()
                break
            work = futures[fut]
            try:
                result = fut.result()
            except Exception as exc:  # noqa: BLE001
                logger.warning("Worker de %s reventó: %s", work.path, exc)
                result = _FileResult(work.path, work.mtime, None, None, None)

            try:
                _apply_result(db, folder, existing.get(work.path), result, force, id3_enabled)
            except Exception as exc:  # noqa: BLE001
                logger.warning("Track fallido %s: %s", work.path, exc)
                try:
                    db.rollback()
                except Exception:  # noqa: BLE001
                    pass

            processed += 1
            job.processed_files = processed
            if processed % DB_COMMIT_BATCH == 0:
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


def _id3_enabled(db: Session) -> bool:
    """¿Etiquetar ID3 de los archivos originales? Solo escritorio + opción
    activa, y únicamente MP3. La versión web nunca toca archivos."""
    s = get_all_settings(db)
    return bool(s.get("write_id3_keys")) and bool(s.get("is_desktop"))


def start_scan(db: Session, folder: Folder, force: bool = False) -> ScanJob:
    """Lanza el escaneo en un hilo daemon y devuelve el job."""
    from datetime import datetime, timezone

    job = ScanJob(folder_id=folder.id, status="pending")
    db.add(job)
    db.commit()
    db.refresh(job)

    def _worker():
        # expire_on_commit=False: los tracks precargados en `existing` no se
        # recargan de la BD tras cada commit por lote (evita SELECTs por track).
        thread_db = Session(db.get_bind(), expire_on_commit=False)
        try:
            folder_db = thread_db.get(Folder, folder.id)
            job_db = thread_db.get(ScanJob, job.id)
            if folder_db and job_db:
                run_scan(thread_db, job_db, folder_db, force=force)
        finally:
            thread_db.close()

    threading.Thread(target=_worker, daemon=True, name=f"scan-{folder.id}").start()
    return job


# ---------------------------------------------------------------------------
# Re-análisis rápido de TONALIDAD (solo Key) sobre toda la biblioteca
# ---------------------------------------------------------------------------
# A diferencia del escaneo completo, este proceso omite BPM y waveform: para
# cada track lee los metadatos (TKEY/INITIALKEY/Rekordbox/Serato/Traktor) y,
# solo si no hay key embebida, aplica el motor armónico HPSS+chroma. Con una
# biblioteca ya etiquetada (típico en DJ) el pase completo toma segundos.
_key_jobs: dict[int, dict] = {}
_key_jobs_lock = threading.Lock()
_key_job_seq = 0


def _process_key_only(path: str) -> tuple[str | None, str | None]:
    try:
        return analyze_key_only(path)
    except Exception:  # noqa: BLE001
        return None, None


def _flush_key_results(db: Session, tracks: list[Track], results: dict[str, tuple[str | None, str | None]]) -> None:
    """Aplica las tonalidades re-analizadas a los tracks y hace commit en lote."""
    by_path = {t.file_path: t for t in tracks}
    for path, (music, camelot) in results.items():
        track = by_path.get(path)
        if track is None or not camelot:
            continue
        track.musical_key = music
        track.camelot_key = camelot
        track.has_error = False
        track.error_message = None
    db.commit()


def _run_reanalyze_keys(db: Session, job_id: int) -> None:
    job = _key_jobs[job_id]
    job["status"] = "running"
    try:
        tracks = db.query(Track).all()
        job["total"] = len(tracks)
        if not tracks:
            job["status"] = "done"
            job["message"] = "Sin tracks para re-analizar"
            return

        pool = _get_pool()
        futures = {pool.submit(_process_key_only, t.file_path): t.file_path for t in tracks}
        results: dict[str, tuple[str | None, str | None]] = {}
        processed = 0
        for fut in as_completed(futures):
            path = futures[fut]
            try:
                results[path] = fut.result()
            except Exception:  # noqa: BLE001
                results[path] = (None, None)
            processed += 1
            job["processed"] = processed
            if processed % DB_COMMIT_BATCH == 0:
                _flush_key_results(db, tracks, results)
                results = {}

        if results:
            _flush_key_results(db, tracks, results)
        job["status"] = "done"
        job["message"] = f"{processed} keys re-analizadas"
    except Exception as exc:  # noqa: BLE001
        logger.exception("Re-análisis de keys fallido")
        job["status"] = "error"
        job["message"] = str(exc)
    finally:
        db.close()


def start_reanalyze_keys(db: Session) -> int:
    """Lanza el re-análisis de Key en un hilo daemon y devuelve el job id."""
    global _key_job_seq
    with _key_jobs_lock:
        _key_job_seq += 1
        job_id = _key_job_seq
        _key_jobs[job_id] = {
            "status": "pending",
            "total": 0,
            "processed": 0,
            "message": "",
        }

    thread_db = Session(db.get_bind(), expire_on_commit=False)
    threading.Thread(
        target=_run_reanalyze_keys,
        args=(thread_db, job_id),
        daemon=True,
        name=f"reanalyze-keys-{job_id}",
    ).start()
    return job_id


def reanalyze_keys_status(job_id: int) -> dict | None:
    return _key_jobs.get(job_id)


# ---------------------------------------------------------------------------
# Importación individual de archivos de audio (sin carpeta completa)
# ---------------------------------------------------------------------------
# El botón "Cargar Audio" (desktop) selecciona uno o varios archivos sueltos
# mediante el diálogo nativo de Electron; estos se procesan y analizan de
# inmediato y se agregan a la tabla general (folder_id = NULL: no pertenecen a
# ninguna carpeta, pero sí son reproducibles y están indexados).
def import_single_files(db: Session, paths: list[str]) -> dict:
    """Importa y analiza archivos individuales. Devuelve un resumen.

    - `imported`: número de tracks nuevos insertados.
    - `skipped`: rutas ya indexadas (no se duplican).
    - `errors`: lista de {path, error} para archivos que no se pudieron leer.
    """
    normalized: list[str] = []
    for raw in paths:
        if not raw or not raw.strip():
            continue
        p = str(Path(raw.strip()).expanduser())
        if Path(p).is_file():
            normalized.append(p)

    if not normalized:
        return {"imported": 0, "skipped": 0, "errors": []}

    existing = {
        t.file_path
        for t in db.query(Track).filter(Track.file_path.in_(normalized)).all()
    }
    id3_enabled = _id3_enabled(db)

    imported = 0
    skipped = 0
    errors: list[dict] = []

    for path in normalized:
        if path in existing:
            skipped += 1
            continue
        try:
            meta = read_metadata(path)
            analysis = analyze_file(path, embedded_bpm=meta.embedded_bpm)
        except Exception as exc:  # noqa: BLE001
            errors.append({"path": path, "error": str(exc)})
            continue

        try:
            mtime = os.path.getmtime(path)
        except OSError:
            mtime = 0.0

        track = Track(
            file_path=path,
            folder_id=None,
            title=meta.title,
            artist=meta.artist,
            album=meta.album,
            duration_sec=meta.duration_sec,
            embedded_bpm=meta.embedded_bpm,
            embedded_key=meta.embedded_key,
            genre=meta.genre or "Archivos sueltos",
            file_modified_at=mtime,
        )

        if analysis is not None:
            if analysis.error:
                track.has_error = True
                track.error_message = analysis.error
                track.analyzed = True
            else:
                track.bpm = analysis.bpm
                track.musical_key = analysis.musical_key
                track.camelot_key = analysis.camelot_key
                if not track.camelot_key and track.embedded_key:
                    music, camelot = embedded_key_to_camelot(track.embedded_key)
                    track.musical_key = track.musical_key or music
                    track.camelot_key = camelot
                track.loudness_db = analysis.loudness_db
                track.spectral_centroid = analysis.spectral_centroid
                track.energy = analysis.energy
                track.analyzed = True
                if id3_enabled and path.lower().endswith(".mp3") and track.camelot_key:
                    write_camelot_id3(path, track.camelot_key)

        db.add(track)
        db.flush()
        imported += 1

        try:
            artwork = extract_embedded(path)
            if artwork is not None:
                data, mime = artwork
                store_embedded(path, data, mime)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Carátula de %s no cacheable: %s", path, exc)

    db.commit()
    return {"imported": imported, "skipped": skipped, "errors": errors}
