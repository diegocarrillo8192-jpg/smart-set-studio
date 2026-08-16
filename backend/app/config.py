"""Configuración global de la aplicación."""
from pathlib import Path

# Directorio raíz del backend
BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_ROOT = BACKEND_DIR.parent

# Rutas de datos locales
DATA_DIR = Path.home() / ".smart-set-studio"
DATA_DIR.mkdir(parents=True, exist_ok=True)

DB_PATH = DATA_DIR / "library.db"
EXPORTS_DIR = DATA_DIR / "exports"
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

# Caché persistente de carátulas: imágenes procesadas (sha1 como nombre)
ARTWORK_CACHE_DIR = DATA_DIR / "artwork_cache"
ARTWORK_CACHE_DIR.mkdir(parents=True, exist_ok=True)

# Extensiones de audio soportadas
AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".aiff", ".aif", ".ogg", ".m4a", ".opus"}

# Límites del motor de mezcla (por defecto, editables en Ajustes)
DEFAULT_SETTINGS = {
    "max_bpm_variation_pct": 2.5,
    "energy_boost_jump": 2,
    "harmonic_radius": 1,
    "allow_mode_change": True,
    "target_loudness_khz": 1.2,
    # Escritura de tonalidad en ID3 de los archivos originales (solo escritorio)
    "write_id3_keys": False,
    # La aplicación corre embebida en Electron (si es False: versión web)
    "is_desktop": False,
}
