"""Calibración del detector de BPM: tempos de música electrónica, sin errores
de octava (double-time / half-time), con ritmos sincopados y variaciones."""

import numpy as np
import pytest

from app.services.analyzer import estimate_bpm

SR = 22050


def _house(bpm, seconds=45, with_hats=True, sr=SR):
    """Patrón four-on-the-floor: kick en cada beat + hi-hats en offbeats."""
    n = int(sr * seconds)
    y = np.zeros(n)
    beat = 60.0 / bpm
    rng = np.random.default_rng(7)
    for kt in np.arange(0, seconds, beat):
        i0 = int(kt * sr)
        dur = int(0.09 * sr)
        env = np.exp(-np.arange(dur) / (0.012 * sr))
        seg = 0.9 * np.sin(2 * np.pi * 55 * np.arange(dur) / sr) * env
        y[i0 : i0 + dur] += seg[: max(0, n - i0)]
    if with_hats:
        for ht in np.arange(beat / 2, seconds, beat):
            i0 = int(ht * sr)
            dur = int(0.025 * sr)
            env = np.exp(-np.arange(dur) / (0.003 * sr))
            seg = 0.3 * rng.standard_normal(dur) * env
            y[i0 : i0 + dur] += seg[: max(0, n - i0)]
    return y


def _breaky(bpm, seconds=45, sr=SR):
    """Ritmo sincopado tipo breaks: kick en 1 y 3.5, snare en 2 y 4, hats 8ths."""
    n = int(sr * seconds)
    y = np.zeros(n)
    beat = 60.0 / bpm
    rng = np.random.default_rng(11)
    for bt in np.arange(0, seconds, beat):
        i = int(bt * sr)
        pos = round((bt / beat) % 4, 2)
        if pos in (0.0, 3.5):
            dur = int(0.09 * sr)
            env = np.exp(-np.arange(dur) / (0.012 * sr))
            seg = 0.9 * np.sin(2 * np.pi * 55 * np.arange(dur) / sr) * env
            y[i : i + dur] += seg[: max(0, n - i)]
        elif pos in (1.0, 3.0):
            dur = int(0.08 * sr)
            env = np.exp(-np.arange(dur) / (0.015 * sr))
            seg = 0.4 * rng.standard_normal(dur) * env
            y[i : i + dur] += seg[: max(0, n - i)]
    for ht in np.arange(beat / 2, seconds, beat):
        i = int(ht * sr)
        dur = int(0.02 * sr)
        env = np.exp(-np.arange(dur) / (0.003 * sr))
        seg = 0.2 * rng.standard_normal(dur) * env
        y[i : i + dur] += seg[: max(0, n - i)]
    return y


def _drift(start_bpm, end_bpm, seconds=45, sr=SR):
    """Tempo con variación continua (aceleración constante)."""
    n = int(sr * seconds)
    y = np.zeros(n)
    t = 0.0
    k = (end_bpm - start_bpm) / seconds
    while t < seconds:
        bpm = start_bpm + k * t
        i = int(t * sr)
        dur = int(0.09 * sr)
        env = np.exp(-np.arange(dur) / (0.012 * sr))
        seg = 0.9 * np.sin(2 * np.pi * 55 * np.arange(dur) / sr) * env
        y[i : i + dur] += seg[: max(0, n - i)]
        t += 60.0 / bpm
    return y


def _assert_tempo(y, expected, tol_pct=4.0):
    got = estimate_bpm(y, SR)
    assert got is not None, f"BPM no detectado (esperado {expected})"
    err = abs(got - expected) / expected * 100
    assert err < tol_pct, f"BPM {got} fuera de {tol_pct}% de {expected}"
    # Rechazo explícito de octavas erróneas
    assert not (got > expected * 1.4), f"double-time: {got} vs {expected}"
    assert not (got < expected * 0.6), f"half-time: {got} vs {expected}"


@pytest.mark.parametrize("bpm", [86, 100, 124, 128, 140, 174])
def test_house_constant_tempo(bpm):
    _assert_tempo(_house(bpm, with_hats=False), bpm)
    _assert_tempo(_house(bpm, with_hats=True), bpm)


@pytest.mark.parametrize("bpm", [68, 75, 150])
def test_house_edges(bpm):
    _assert_tempo(_house(bpm), bpm)


def test_breakbeat_syncopation():
    _assert_tempo(_breaky(128), 128)


def test_tempo_drift():
    _assert_tempo(_drift(124, 127), 125.5, tol_pct=4.0)


def test_embedded_bpm_priority():
    y = _house(124)
    assert estimate_bpm(y, SR, embedded_bpm=86.0) == 86.0
    assert estimate_bpm(y, SR, embedded_bpm=10.0) is not None  # inválido: se detecta


def test_noise_returns_none():
    rng = np.random.default_rng(2)
    y = rng.standard_normal(SR * 10)
    assert estimate_bpm(y, SR) is None


def test_silence_returns_none():
    assert estimate_bpm(np.zeros(SR * 5), SR) is None


def test_short_audio_returns_none():
    assert estimate_bpm(np.zeros(SR // 2), SR) is None
