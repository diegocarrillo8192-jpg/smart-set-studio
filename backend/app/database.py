"""Conexión y sesión SQLite con SQLAlchemy."""
from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from .config import DB_PATH

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    echo=False,
)


@event.listens_for(engine, "connect")
def _enable_foreign_keys(dbapi_connection, _):
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    from . import models  # noqa: F401  (registra los modelos)

    Base.metadata.create_all(bind=engine)

    # Migraciones incrementales: columnas añadidas a modelos existentes
    _ensure_column("tracks", "embedded_key", "VARCHAR(16)")

    # Datos heredados: rutas con mojibake (ver repair_legacy_mojibake)
    repair_legacy_mojibake()


def repair_legacy_mojibake() -> int:
    """Corrige rutas heredadas escritas con codificación rota: 'MÃºsica' en la
    BD cuando el disco tiene 'Música' (el nombre UTF-8 fue leído como cp1252
    al indexar). Solo reescribe filas cuya versión corregida existe en disco y
    la original no; idempotente. Devuelve cuántas filas se repararon."""
    import logging
    from pathlib import Path

    def repaired(raw: str) -> str | None:
        p = Path(raw.strip()).expanduser()
        if p.exists():
            return None  # ruta sana
        try:
            fixed = raw.encode("cp1252").decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            return None
        q = Path(fixed).expanduser()
        if q != p and q.exists():
            return str(q)
        return None

    fixed = 0
    try:
        with engine.begin() as conn:
            for table, column in (("folders", "path"), ("tracks", "file_path")):
                rows = conn.exec_driver_sql(f"SELECT id, {column} FROM {table}").fetchall()
                for row_id, raw in rows:
                    if not raw or not isinstance(raw, str):
                        continue
                    good = repaired(raw)
                    if good:
                        conn.exec_driver_sql(
                            f"UPDATE {table} SET {column} = ? WHERE id = ?", (good, row_id)
                        )
                        fixed += 1
    except Exception as exc:  # noqa: BLE001
        logging.getLogger(__name__).warning("Reparación de rutas fallida: %s", exc)
        return 0
    if fixed:
        logging.getLogger(__name__).info("Reparadas %d rutas con mojibake heredado", fixed)
    return fixed


def _ensure_column(table: str, column: str, definition: str) -> None:
    """Agrega una columna a una tabla SQLite existente si falta (ALTER TABLE)."""
    try:
        with engine.connect() as conn:
            cols = {row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            if column not in cols:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
                conn.commit()
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).warning("Migración %s.%s fallida: %s", table, column, exc)
