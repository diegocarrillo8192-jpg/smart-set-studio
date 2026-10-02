"""Calibración del detector de tonalidad Camelot: raíz y modo correctos,
discriminación mayor/menor relativo y rechazo de audio sin pitch claro."""

import numpy as np
import pytest

from app.services.analyzer import estimate_key

SR = 22050

NOTE_FREQS = {
    "C": 261.63, "C#": 277.18, "D": 293.66, "Eb": 311.13, "E": 329.63,
    "F": 349.23, "F#": 369.99, "G": 392.00, "Ab": 415.30, "A": 440.00,
    "Bb": 466.16, "B": 493.88,
    "Db": 277.18, "D#": 311.13, "Gb": 369.99, "G#": 415.30, "A#": 466.16,
}


def _note_freq(note, octave):
    return NOTE_FREQS[note] * (2.0 ** (octave - 4))


def make_tonal(chords, seconds_per_chord=2.0, sr=SR, seed=5):
    """Progresión de acordes (raíz-tercera-quinta) con bajo en la raíz."""
    n = int(sr * seconds_per_chord * len(chords))
    y = np.zeros(n)
    rng = np.random.default_rng(seed)
    t_axis = np.arange(n) / sr
    for ci, chord in enumerate(chords):
        start = ci * seconds_per_chord
        seg = (t_axis >= start) & (t_axis < start + seconds_per_chord)
        seg_t = t_axis[seg] - start
        idx = np.where(seg)[0]
        for note in chord:
            for octave in (3, 4, 5):
                f = _note_freq(note, octave)
                for det in (0.997, 1.0, 1.003):
                    a = rng.uniform(0.16, 0.2)
                    y[idx] += a * np.sin(2 * np.pi * f * det * seg_t)
        f = _note_freq(chord[0], 2)
        y[idx] += 0.5 * np.sin(2 * np.pi * f * seg_t)
        env = np.minimum(1.0, seg_t / 0.05) * np.exp(-seg_t * 0.15)
        y[idx] *= env
    y += 0.004 * rng.standard_normal(n)
    return y


CHORDS = {
    "C major": [["C", "E", "G"], ["F", "A", "C"], ["G", "B", "D"], ["C", "E", "G"]],
    "A minor": [["A", "C", "E"], ["D", "F", "A"], ["E", "G", "B"], ["A", "C", "E"]],
    "F# minor": [["F#", "A", "C#"], ["B", "D", "F#"], ["C#", "E", "G#"], ["F#", "A", "C#"]],
    "Eb major": [["Eb", "G", "Bb"], ["Ab", "C", "Eb"], ["Bb", "D", "F"], ["Eb", "G", "Bb"]],
    "D minor": [["D", "F", "A"], ["G", "Bb", "D"], ["A", "C#", "E"], ["D", "F", "A"]],
    "G major": [["G", "B", "D"], ["C", "E", "G"], ["D", "F#", "A"], ["G", "B", "D"]],
    "B minor": [["B", "D", "F#"], ["E", "G", "B"], ["F#", "A#", "C#"], ["B", "D", "F#"]],
}


@pytest.mark.parametrize(
    "key,camelot",
    [
        ("C major", "8B"),
        ("A minor", "8A"),
        ("F# minor", "11A"),
        ("Eb major", "5B"),
        ("D minor", "7A"),
        ("G major", "9B"),
        ("B minor", "10A"),
    ],
)
def test_key_detection(key, camelot):
    y = make_tonal(CHORDS[key])
    note, code = estimate_key(y, SR)
    assert note == key, f"esperado {key}, detectado {note}"
    assert code == camelot


def test_relative_major_minor_discrimination():
    # C mayor y A menor comparten pitch-classes; el tercer grado debe decidir
    y = make_tonal(CHORDS["C major"])
    note, code = estimate_key(y, SR)
    assert note == "C major" and code == "8B"
    y = make_tonal(CHORDS["A minor"])
    note, code = estimate_key(y, SR)
    assert note == "A minor" and code == "8A"


def test_key_with_percussion():
    rng = np.random.default_rng(0)
    y = make_tonal(CHORDS["A minor"])
    noise = np.zeros_like(y)
    t = 0.0
    while t < len(y) / SR:
        i0 = int(t * SR)
        dur = int(0.05 * SR)
        env = np.exp(-np.arange(dur) / (0.008 * SR))
        noise[i0 : i0 + dur] += rng.standard_normal(dur) * env * 0.8
        t += 0.4
    note, code = estimate_key(y + noise, SR)
    assert note == "A minor" and code == "8A"


def test_silence_returns_none():
    assert estimate_key(np.zeros(SR * 4), SR) == (None, None)


def test_noise_returns_none():
    rng = np.random.default_rng(1)
    assert estimate_key(rng.standard_normal(SR * 8), SR) == (None, None)


def test_short_audio_returns_none():
    assert estimate_key(np.zeros(SR // 2), SR) == (None, None)
