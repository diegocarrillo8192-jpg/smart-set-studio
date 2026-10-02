"""Extracción de metadatos: TKEY/INITIALKEY/TXXX, GEOBs de Serato y parsing
de notaciones de tonalidad a Camelot."""

import base64
import json

from app.services.analyzer import (
    SERATO_KEY_TO_CAMELOT,
    _serato_key,
    _serato_key_json,
    embedded_key_to_camelot,
    read_metadata,
)


class _Geo:
    def __init__(self, desc, data):
        self.desc = desc
        self.data = data


def _fake_audio(geobs):
    class FakeAudio:
        def getall(self, name):
            return list(geobs)

    return FakeAudio()


# ---------------------------------------------------------------------------
# embedded_key_to_camelot: notaciones soportadas
# ---------------------------------------------------------------------------
def test_camelot_direct():
    assert embedded_key_to_camelot("8A") == ("A minor", "8A")
    assert embedded_key_to_camelot(" 11B ") == ("A major", "11B")


def test_note_with_mode():
    assert embedded_key_to_camelot("A minor") == ("A minor", "8A")
    assert embedded_key_to_camelot("F major") == ("F major", "7B")


def test_abbreviations():
    assert embedded_key_to_camelot("Am") == ("A minor", "8A")
    assert embedded_key_to_camelot("F#m") == ("F# minor", "11A")
    assert embedded_key_to_camelot("Bbm") == ("Bb minor", "3A")
    assert embedded_key_to_camelot("Ebm") == ("Eb minor", "2A")
    assert embedded_key_to_camelot("C") == ("C major", "8B")


def test_open_key_notation():
    assert embedded_key_to_camelot("8m") == ("A minor", "8A")
    assert embedded_key_to_camelot("9d") == ("G major", "9B")


def test_invalid_keys():
    assert embedded_key_to_camelot("") == ("", None)
    assert embedded_key_to_camelot("garbage") == ("", None)
    assert embedded_key_to_camelot("13A") == ("", None)


# ---------------------------------------------------------------------------
# GEOB 'Key' JSON de Serato DJ Pro moderno
# ---------------------------------------------------------------------------
def test_serato_key_json():
    payload = base64.b64encode(
        json.dumps({"key": "9A", "source": "mixedinkey", "algorithm": 94}).encode()
    )
    audio = _fake_audio([_Geo(desc="Key", data=payload)])
    assert _serato_key_json(audio) == "9A"


def test_serato_key_json_not_key_desc():
    payload = base64.b64encode(json.dumps({"key": "1B"}).encode())
    audio = _fake_audio([_Geo(desc="Serato Analysis", data=payload)])
    assert _serato_key_json(audio) == ""


def test_serato_legacy_byte_fifths():
    # Campo KEY legacy: 4 bytes id ('KEY\0') + 4 bytes len BE + byte de key (0-23)
    for code, camelot in enumerate(SERATO_KEY_TO_CAMELOT):
        payload = b"KEY\x00" + len(bytes([code])).to_bytes(4, "big") + bytes([code])
        audio = _fake_audio([_Geo(desc="Serato Analysis", data=payload)])
        assert _serato_key(audio) == camelot, f"code {code} -> {camelot}"


def test_serato_legacy_byte_zlib():
    import zlib

    payload = b"KEY\x00" + (1).to_bytes(4, "big") + bytes([8])
    audio = _fake_audio([_Geo(desc="Serato Markers_", data=zlib.compress(payload))])
    assert _serato_key(audio) == SERATO_KEY_TO_CAMELOT[8]


# ---------------------------------------------------------------------------
# read_metadata sobre WAVs sintéticos con bloque de tags ID3 (chunk 'id3 ')
# ---------------------------------------------------------------------------
def _write_id3(tmp_path, name, frames):
    import io
    import struct

    from mutagen.id3 import ID3

    tags = ID3()
    for f in frames:
        tags.add(f)
    buf = io.BytesIO()
    tags.save(buf, v2_version=3)
    id3_bytes = buf.getvalue()

    fmt = struct.pack("<HHIIHH", 1, 1, 22050, 44100, 2, 16)
    fmt_chunk = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    data = b"\x00\x00" * 22050  # 1 s de silencio PCM 16-bit mono
    data_chunk = b"data" + struct.pack("<I", len(data)) + data
    pad = id3_bytes + b"\x00" * ((2 - len(id3_bytes) % 2) % 2)
    id3_chunk = b"id3 " + struct.pack("<I", len(id3_bytes)) + pad
    body = b"WAVE" + fmt_chunk + data_chunk + id3_chunk
    path = tmp_path / name
    path.write_bytes(b"RIFF" + struct.pack("<I", 4 + len(body)) + body)
    return str(path)


def test_read_metadata_tkey_priority(tmp_path):
    from mutagen.id3 import TBPM, TIT2, TKEY

    path = _write_id3(
        tmp_path,
        "tkey.mp3",
        [
            TIT2(encoding=3, text=["Track"]),
            TKEY(encoding=3, text=["8A"]),
            TBPM(encoding=3, text=["124"]),
        ],
    )
    meta = read_metadata(path)
    assert meta.embedded_key == "8A"
    assert meta.embedded_bpm == 124.0
    assert meta.title == "Track"


def test_read_metadata_serato_json_geob(tmp_path):
    from mutagen.id3 import GEOB, TIT2

    payload = base64.b64encode(json.dumps({"key": "9A", "source": "serato"}).encode())
    path = _write_id3(
        tmp_path,
        "serato_json.mp3",
        [
            TIT2(encoding=3, text=["X"]),
            GEOB(encoding=0, mime="application/json", filename="", desc="Key", data=payload),
        ],
    )
    meta = read_metadata(path)
    assert meta.embedded_key == "9A"


def test_read_metadata_txxx_initialkey(tmp_path):
    from mutagen.id3 import TIT2, TXXX

    path = _write_id3(
        tmp_path,
        "txxx.mp3",
        [TIT2(encoding=3, text=["X"]), TXXX(encoding=3, desc="InitialKey", text=["4A"])],
    )
    meta = read_metadata(path)
    assert meta.embedded_key == "4A"


def test_read_metadata_bpm_validation(tmp_path):
    from mutagen.id3 import TBPM, TIT2

    path = _write_id3(
        tmp_path,
        "bpm_bad.mp3",
        [TIT2(encoding=3, text=["X"]), TBPM(encoding=3, text=["9999"])],
    )
    meta = read_metadata(path)
    assert meta.embedded_bpm is None
