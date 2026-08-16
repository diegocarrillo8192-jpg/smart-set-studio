"""Escritura de la tonalidad Camelot detectada en los metadatos ID3v2 de MP3.

Exclusivo de la versión de escritorio (Electron): la operación solo se ejecuta
cuando `write_id3_keys` y `is_desktop` estén activos en Ajustes. En la versión
web los archivos del sistema jamás se modifican.

Seguridad de integridad: mutagen reescribe únicamente el bloque de etiquetas
ID3; el audio original no se toca. El fallo de escritura se registra y el
análisis continúa sin afectar a la base de datos.
"""
import logging

logger = logging.getLogger(__name__)


def write_camelot_id3(path: str, camelot_key: str) -> bool:
    """Escribe TKEY (Initial Key) y COMM (Comments) en el ID3v2 del MP3.

    Devuelve True si la etiqueta quedó escrita, False ante cualquier fallo
    (archivo no MP3, sin permisos, tag corrupto, etc.).
    """
    if not path.lower().endswith(".mp3"):
        return False
    try:
        from mutagen.id3 import COMM, ID3, ID3NoHeaderError, TKEY

        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            tags = ID3()

        tags.delall("TKEY")
        tags.add(TKEY(encoding=3, text=[camelot_key]))
        tags.delall("COMM")
        tags.add(
            COMM(
                encoding=3,
                lang="eng",
                desc="Smart Set Studio",
                text=[f"Key: {camelot_key}"],
            )
        )
        tags.save(path, v2_version=3)  # ID3v2.3: máxima compatibilidad de players
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("No se pudo etiquetar %s (TKEY=%s): %s", path, camelot_key, exc)
        return False