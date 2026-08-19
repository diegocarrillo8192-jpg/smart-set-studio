"""API de carpetas importadas."""
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Folder, ScanJob, SetItem, Track
from ..schemas import FolderCreate, FolderOut, FolderRenameRequest, ScanJobOut
from ..services.scanner import discover_audio_files, start_scan

router = APIRouter(prefix="/api/folders", tags=["folders"])


def _serialize_folder(folder: Folder, track_count: int) -> FolderOut:
    return FolderOut(
        id=folder.id,
        path=folder.path,
        name=folder.name,
        last_scanned_at=folder.last_scanned_at,
        track_count=track_count,
    )


@router.get("", response_model=list[FolderOut])
def list_folders(db: Session = Depends(get_db)):
    counts = dict(
        db.query(Track.folder_id, func.count(Track.id))
        .group_by(Track.folder_id)
        .all()
    )
    folders = db.query(Folder).order_by(Folder.name).all()
    return [_serialize_folder(f, counts.get(f.id, 0)) for f in folders]


@router.post("", response_model=FolderOut)
def add_folder(payload: FolderCreate, db: Session = Depends(get_db)):
    path = Path(payload.path).expanduser().resolve()
    if not path.exists() or not path.is_dir():
        raise HTTPException(400, f"La carpeta no existe o no es un directorio: {path}")
    existing = db.query(Folder).filter_by(path=str(path)).one_or_none()
    if existing:
        raise HTTPException(409, "La carpeta ya está importada")

    folder = Folder(path=str(path), name=path.name)
    db.add(folder)
    db.flush()

    # LISTADO INSTANTÁNEO (igual que la web): se registran TODOS los archivos
    # de audio de golpe, SIN procesar audio — solo el walk del filesystem.
    # Cada fila queda con analyzed=False y metadatos derivados del nombre de
    # archivo; la UI renderiza la lista completa al instante con el badge
    # "ANALIZANDO…". El hilo de escaneo rellena luego los datos reales
    # (etiquetas ID3 + BPM/Key) fila a fila, sin bloquear nada.
    files = discover_audio_files(str(path))
    db.add_all(
        Track(
            file_path=str(f),
            folder_id=folder.id,
            title=Path(f).stem,
            artist="",
            album="",
            duration_sec=0.0,
            genre=folder.name,
            # None fuerza la re-lectura de metadatos reales en el primer scan.
            file_modified_at=None,
        )
        for f in files
    )
    db.commit()
    db.refresh(folder)
    return _serialize_folder(folder, len(files))


@router.put("/{folder_id}", response_model=FolderOut)
def rename_folder(folder_id: int, payload: FolderRenameRequest, db: Session = Depends(get_db)):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Se requiere un nombre")
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(404, "Carpeta no encontrada")
    folder.name = name
    db.commit()
    db.refresh(folder)
    count = db.query(Track).filter(Track.folder_id == folder_id).count()
    return _serialize_folder(folder, count)


@router.delete("/{folder_id}")
def remove_folder(folder_id: int, db: Session = Depends(get_db)):
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(404, "Carpeta no encontrada")

    # Eliminar dependencias explícitamente (FK enforcement en SQLite)
    track_ids = [tid for (tid,) in db.query(Track.id).filter(Track.folder_id == folder_id).all()]
    db.query(ScanJob).filter(ScanJob.folder_id == folder_id).delete()
    db.query(SetItem).filter(SetItem.track_id.in_(track_ids)).delete(synchronize_session=False)
    db.query(Track).filter(Track.folder_id == folder_id).delete()
    db.delete(folder)
    db.commit()
    return {"ok": True, "removed_tracks": len(track_ids)}


@router.post("/{folder_id}/scan", response_model=ScanJobOut)
def scan_folder(folder_id: int, force: bool = False, db: Session = Depends(get_db)):
    folder = db.get(Folder, folder_id)
    if not folder:
        raise HTTPException(404, "Carpeta no encontrada")
    job = start_scan(db, folder, force=force)
    return ScanJobOut.model_validate(job)


@router.get("/{folder_id}/scan/status", response_model=ScanJobOut | None)
def scan_status(folder_id: int, db: Session = Depends(get_db)):
    job = (
        db.query(ScanJob)
        .filter_by(folder_id=folder_id)
        .order_by(ScanJob.id.desc())
        .first()
    )
    if not job:
        return None
    return ScanJobOut.model_validate(job)
