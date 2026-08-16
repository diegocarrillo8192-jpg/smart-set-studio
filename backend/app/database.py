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
