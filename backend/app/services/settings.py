"""Acceso compartido a los ajustes de la aplicación (motor + preferencias)."""
from sqlalchemy.orm import Session

from ..config import DEFAULT_SETTINGS
from ..models import AppSetting


def get_all_settings(db: Session) -> dict:
    stored = {s.key: s.value for s in db.query(AppSetting).all()}
    result = dict(DEFAULT_SETTINGS)
    for key, value in stored.items():
        if key in result:
            try:
                if isinstance(result[key], bool):
                    result[key] = value.lower() == "true"
                elif isinstance(result[key], int):
                    result[key] = int(value)
                elif isinstance(result[key], float):
                    result[key] = float(value)
                else:
                    result[key] = value
            except (ValueError, TypeError):
                pass
    return result


def set_settings(db: Session, values: dict) -> dict:
    for key, value in values.items():
        if key not in DEFAULT_SETTINGS:
            continue
        row = db.get(AppSetting, key)
        if row:
            row.value = str(value)
        else:
            db.add(AppSetting(key=key, value=str(value)))
    db.commit()
    return get_all_settings(db)