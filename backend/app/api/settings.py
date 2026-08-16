"""API de ajustes del motor de mezcla."""
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..schemas import SettingsUpdate
from ..services.settings import get_all_settings, set_settings

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("")
def read_settings(db: Session = Depends(get_db)):
    return get_all_settings(db)


@router.put("")
def update_settings(payload: SettingsUpdate, db: Session = Depends(get_db)):
    return set_settings(db, payload.model_dump())
