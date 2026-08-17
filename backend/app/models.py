"""Modelos SQLAlchemy: tracks, folders, playlists, sets, jobs, settings."""
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Folder(Base):
    __tablename__ = "folders"

    id: Mapped[int] = mapped_column(primary_key=True)
    path: Mapped[str] = mapped_column(String(1024), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(255))
    last_scanned_at: Mapped[datetime | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)

    tracks: Mapped[list["Track"]] = relationship(back_populates="folder")


class Track(Base):
    __tablename__ = "tracks"

    id: Mapped[int] = mapped_column(primary_key=True)
    file_path: Mapped[str] = mapped_column(String(2048), unique=True, index=True)
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="SET NULL"), index=True
    )

    title: Mapped[str] = mapped_column(String(512))
    artist: Mapped[str] = mapped_column(String(512), default="")
    album: Mapped[str] = mapped_column(String(512), default="")

    duration_sec: Mapped[float | None] = mapped_column(Float)
    bpm: Mapped[float | None] = mapped_column(Float, index=True)
    embedded_bpm: Mapped[float | None] = mapped_column(Float)
    musical_key: Mapped[str | None] = mapped_column(String(16), index=True)
    camelot_key: Mapped[str | None] = mapped_column(String(4), index=True)
    embedded_key: Mapped[str | None] = mapped_column(String(16))
    energy: Mapped[int | None] = mapped_column(Integer, index=True)
    loudness_db: Mapped[float | None] = mapped_column(Float)
    spectral_centroid: Mapped[float | None] = mapped_column(Float)

    analyzed: Mapped[bool] = mapped_column(Boolean, default=False)
    has_error: Mapped[bool] = mapped_column(Boolean, default=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    file_modified_at: Mapped[float | None] = mapped_column(Float)
    analyzed_at: Mapped[datetime | None] = mapped_column(default=None)
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)
    genre: Mapped[str | None] = mapped_column(String(128), default=None)  # nuevo: género del archivo

    folder: Mapped[Folder | None] = relationship(back_populates="tracks")


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)


class Set(Base):
    __tablename__ = "sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    duration_min: Mapped[float] = mapped_column(Float)
    energy_profile: Mapped[str] = mapped_column(String(64))
    folder_ids: Mapped[str] = mapped_column(Text, default="")  # CSV de ids
    total_sec: Mapped[float] = mapped_column(Float, default=0)
    created_at: Mapped[datetime] = mapped_column(default=_utcnow)

    items: Mapped[list["SetItem"]] = relationship(
        back_populates="set",
        cascade="all, delete-orphan",
        order_by="SetItem.position",
    )


class SetItem(Base):
    __tablename__ = "set_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    set_id: Mapped[int] = mapped_column(
        ForeignKey("sets.id", ondelete="CASCADE"), index=True
    )
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id"))
    position: Mapped[int] = mapped_column(Integer)
    transition_label: Mapped[str | None] = mapped_column(String(64))
    transition_relation: Mapped[str | None] = mapped_column(String(32))  # ej: "same", "mode", "neighbor", "boost"

    set: Mapped[Set] = relationship(back_populates="items")
    track: Mapped[Track] = relationship()


class ScanJob(Base):
    __tablename__ = "scan_jobs"

    id: Mapped[int] = mapped_column(primary_key=True)
    folder_id: Mapped[int | None] = mapped_column(
        ForeignKey("folders.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending|running|done|error
    total_files: Mapped[int] = mapped_column(Integer, default=0)
    processed_files: Mapped[int] = mapped_column(Integer, default=0)
    message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(default=_utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(default=None)


class AppSetting(Base):
    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
