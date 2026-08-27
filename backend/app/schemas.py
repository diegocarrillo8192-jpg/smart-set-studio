"""Schemas Pydantic para la API."""
from datetime import datetime

from pydantic import BaseModel, Field


class FolderOut(BaseModel):
    id: int
    path: str
    name: str
    last_scanned_at: datetime | None = None
    track_count: int = 0

    class Config:
        from_attributes = True


class FolderCreate(BaseModel):
    path: str = Field(min_length=1)


class FolderRenameRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)


class TrackOut(BaseModel):
    id: int
    file_path: str
    folder_id: int | None = None
    folder_name: str | None = None
    title: str
    artist: str
    album: str
    duration_sec: float | None = None
    bpm: float | None = None
    embedded_bpm: float | None = None
    musical_key: str | None = None
    camelot_key: str | None = None
    embedded_key: str | None = None  # tonalidad original leída de las etiquetas
    genre: str | None = None  # género real (ID3/FLAC/M4A/APE) o carpeta contenedora
    energy: int | None = None
    loudness_db: float | None = None
    spectral_centroid: float | None = None
    analyzed: bool = False
    has_error: bool = False
    error_message: str | None = None

    class Config:
        from_attributes = True


class ScanJobOut(BaseModel):
    id: int
    folder_id: int | None = None
    status: str
    total_files: int
    processed_files: int
    message: str | None = None
    started_at: datetime
    finished_at: datetime | None = None

    class Config:
        from_attributes = True


class SetItemOut(BaseModel):
    id: int
    position: int
    transition_label: str | None = None
    transition_relation: str | None = None
    track: TrackOut


class SetOut(BaseModel):
    id: int
    name: str
    duration_min: float
    energy_profile: str
    folder_ids: str
    total_sec: float
    created_at: datetime
    items: list[SetItemOut]


class SetGenerateRequest(BaseModel):
    duration_min: float = Field(gt=0, le=720)
    folder_ids: list[int] = Field(default_factory=list)
    energy_profile: str = "storytelling"  # warmup | peak_hour | storytelling | energy_boost
    seed_track_id: int | None = None
    name: str | None = None


class SetUpdateRequest(BaseModel):
    name: str | None = None


class SettingsUpdate(BaseModel):
    max_bpm_variation_pct: float = Field(ge=0.5, le=20)
    energy_boost_jump: int = Field(ge=1, le=5)
    harmonic_radius: int = Field(ge=1, le=2)
    allow_mode_change: bool = True
    # Etiquetado ID3 en archivos originales (solo permitido en escritorio)
    write_id3_keys: bool = False
    is_desktop: bool = False


class ExportRequest(BaseModel):
    destination: str | None = None


class TrackKeyUpdate(BaseModel):
    """Edición manual de la tonalidad: Camelot ('8A'), nota+modo ('A minor')
    o acordes ('Am')."""

    key: str = Field(min_length=1, max_length=32)
