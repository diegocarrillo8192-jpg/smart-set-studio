"""API de sets generados + exportación."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Set, SetItem
from ..schemas import ExportRequest, SetGenerateRequest, SetOut, SetUpdateRequest
from ..services.exporters import _safe_name, build_rekordbox_xml, export_to_usb, tree_to_string
from ..services.set_generator import generate_set

from .settings import get_all_settings

router = APIRouter(prefix="/api/sets", tags=["sets"])


def _load_set(db: Session, set_id: int) -> Set:
    dj_set = (
        db.query(Set)
        .options(
            selectinload(Set.items).selectinload(SetItem.track),
        )
        .filter(Set.id == set_id)
        .first()
    )
    if not dj_set:
        raise HTTPException(404, "Set no encontrado")
    return dj_set


@router.post("/generate", response_model=SetOut)
def create_set(payload: SetGenerateRequest, db: Session = Depends(get_db)):
    try:
        settings = get_all_settings(db)
        dj_set = generate_set(
            db,
            duration_min=payload.duration_min,
            folder_ids=payload.folder_ids,
            energy_profile=payload.energy_profile,
            seed_track_id=payload.seed_track_id,
            name=payload.name,
            settings=settings,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    return _load_set(db, dj_set.id)


@router.get("", response_model=list[SetOut])
def list_sets(db: Session = Depends(get_db)):
    sets = (
        db.query(Set)
        .options(selectinload(Set.items).selectinload(SetItem.track))
        .order_by(Set.created_at.desc())
        .all()
    )
    return sets


@router.get("/{set_id}", response_model=SetOut)
def get_set(set_id: int, db: Session = Depends(get_db)):
    return _load_set(db, set_id)


@router.put("/{set_id}", response_model=SetOut)
def update_set(set_id: int, payload: SetUpdateRequest, db: Session = Depends(get_db)):
    if payload.name is None or not payload.name.strip():
        raise HTTPException(400, "Se requiere un nombre")
    name = payload.name.strip()
    dj_set = db.get(Set, set_id)
    if not dj_set:
        raise HTTPException(404, "Set no encontrado")
    dj_set.name = name
    db.commit()
    return _load_set(db, set_id)


@router.delete("/{set_id}")
def delete_set(set_id: int, db: Session = Depends(get_db)):
    dj_set = db.get(Set, set_id)
    if not dj_set:
        raise HTTPException(404, "Set no encontrado")
    db.delete(dj_set)
    db.commit()
    return {"ok": True}


@router.get("/{set_id}/export/rekordbox")
def export_xml(set_id: int, db: Session = Depends(get_db)):
    """Genera el XML Rekordbox 1.0.0 y lo devuelve como texto (el frontend
    descarga el archivo con un Blob URI)."""
    dj_set = _load_set(db, set_id)
    xml = tree_to_string(build_rekordbox_xml(dj_set))
    filename = f"{_safe_name(dj_set.name)}.xml"
    return Response(
        content=xml,
        media_type="application/xml; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/{set_id}/export/usb")
def export_usb(set_id: int, payload: ExportRequest, db: Session = Depends(get_db)):
    if not payload.destination:
        raise HTTPException(400, "Se requiere un destino (ruta de USB)")
    dj_set = _load_set(db, set_id)
    return export_to_usb(dj_set, payload.destination)
