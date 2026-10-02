"""Pipeline completo: analyze_file (WAV real) y analyze_structure (beatgrid)."""

import numpy as np
import pytest

from app.services.analysis import analyze_structure
from app.services.analyzer import analyze_file

SR = 44100


def _synthesize(bpm, seconds=30):
    """House + progresión C mayor, a 44100 Hz para forzar el resampleo."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from test_analyzer_key import CHORDS, make_tonal, _note_freq

    n = int(SR * seconds)
    y = np.zeros(n)
    rng = np.random.default_rng(21)
    beat = 60.0 / bpm
    for kt in np.arange(0, seconds, beat):
        i0 = int(kt * SR)
        dur = int(0.09 * SR)
        env = np.exp(-np.arange(dur) / (0.012 * SR))
        seg = 0.9 * np.sin(2 * np.pi * 55 * np.arange(dur) / SR) * env
        y[i0 : i0 + dur] += seg[: max(0, n - i0)]
    for ht in np.arange(beat / 2, seconds, beat):
        i0 = int(ht * SR)
        dur = int(0.02 * SR)
        env = np.exp(-np.arange(dur) / (0.003 * SR))
        seg = 0.25 * rng.standard_normal(dur) * env
        y[i0 : i0 + dur] += seg[: max(0, n - i0)]

    # capa armónica: C mayor resintetizada a 44100
    n_tones = int(SR * 2.0 * 4)
    tones = np.zeros(n_tones)
    t_axis = np.arange(n_tones) / SR
    for ci, chord in enumerate(CHORDS["C major"]):
        start = ci * 2.0
        seg = (t_axis >= start) & (t_axis < start + 2.0)
        seg_t = t_axis[seg] - start
        idx = np.where(seg)[0]
        for note in chord:
            for octave in (3, 4, 5):
                f = _note_freq(note, octave)
                tones[idx] += 0.2 * np.sin(2 * np.pi * f * seg_t)
        env = np.minimum(1.0, seg_t / 0.05) * np.exp(-seg_t * 0.15)
        tones[idx] *= env
    y[: n_tones] += tones * 0.5
    return y


def test_analyze_file_pipeline(tmp_path):
    import soundfile as sf

    y = _synthesize(124)
    wav = tmp_path / "track.wav"
    sf.write(str(wav), y.astype(np.float32), SR)
    result = analyze_file(str(wav), embedded_bpm=None)
    assert result.error is None
    assert result.bpm is not None
    err = abs(result.bpm - 124) / 124 * 100
    assert err < 4.0, f"BPM {result.bpm}"
    assert not (result.bpm > 124 * 1.4) and not (result.bpm < 124 * 0.6)
    assert result.musical_key == "C major"
    assert result.camelot_key == "8B"
    assert 1 <= result.energy <= 10


def test_analyze_file_embedded_bpm(tmp_path):
    import soundfile as sf

    y = _synthesize(124)
    wav = tmp_path / "track2.wav"
    sf.write(str(wav), y.astype(np.float32), SR)
    result = analyze_file(str(wav), embedded_bpm=128.0)
    assert result.bpm == 128.0


def test_analyze_structure_beatgrid(tmp_path):
    import soundfile as sf

    y = _synthesize(128, seconds=25)
    wav = tmp_path / "grid.wav"
    sf.write(str(wav), y.astype(np.float32), SR)
    result = analyze_structure(str(wav))
    assert result.get("bpm") is not None
    err = abs(result["bpm"] - 128) / 128 * 100
    assert err < 5.0, f"grid BPM {result['bpm']}"
    assert len(result["bars"]) > 0
    assert result["phrases"], "frases esperadas sobre el beatgrid"


def test_analyze_key_only_embedded_priority(tmp_path):
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from test_metadata import _write_id3

    from mutagen.id3 import TIT2, TKEY

    from app.services.analyzer import analyze_key_only

    # La key embebida (TKEY) debe ganar sin analizar el audio
    path = _write_id3(
        tmp_path,
        "keyed.wav",
        [TIT2(encoding=3, text=["X"]), TKEY(encoding=3, text=["5B"])],
    )
    music, camelot = analyze_key_only(path)
    assert camelot == "5B"
    assert music == "Eb major"


def test_analyze_key_only_fallback_analysis(tmp_path):
    import soundfile as sf

    from app.services.analyzer import analyze_key_only

    # Sin key embebida: cae al motor armónico sobre el audio
    y = _synthesize(124, seconds=8)
    wav = tmp_path / "nokey.wav"
    sf.write(str(wav), y.astype(np.float32), SR)
    music, camelot = analyze_key_only(str(wav))
    assert camelot == "8B"
    assert music == "C major"
