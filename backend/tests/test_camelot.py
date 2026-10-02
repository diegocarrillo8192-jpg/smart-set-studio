"""Integridad de la rueda Camelot y reglas de compatibilidad armónica."""

from app.services.camelot import (
    CAMELOT_WHEEL,
    KS_MAJOR,
    KS_MINOR,
    NOTE_NAMES,
    camelot_number,
    camelot_to_note,
    is_compatible,
    normalize_camelot,
    note_to_camelot,
    relation,
    wheel_step,
)


def test_wheel_entries_match_standard():
    expected = {
        1: ("Ab", "B"), 2: ("Eb", "F#"), 3: ("Bb", "C#"), 4: ("F", "Ab"),
        5: ("C", "Eb"), 6: ("G", "Bb"), 7: ("D", "F"), 8: ("A", "C"),
        9: ("E", "G"), 10: ("B", "D"), 11: ("F#", "A"), 12: ("C#", "E"),
    }
    assert CAMELOT_WHEEL == expected


def test_ks_profiles_shape():
    assert len(KS_MAJOR) == 12
    assert len(KS_MINOR) == 12


def test_note_to_camelot_all_24_round_trip():
    for num, (minor, major) in CAMELOT_WHEEL.items():
        assert note_to_camelot(minor, "minor") == f"{num}A"
        assert note_to_camelot(major, "major") == f"{num}B"
        assert camelot_to_note(f"{num}A") == (minor, "minor")
        assert camelot_to_note(f"{num}B") == (major, "major")


def test_note_aliases():
    assert note_to_camelot("G#", "minor") == "1A"    # G# == Ab
    assert note_to_camelot("D#", "minor") == "2A"    # D# == Eb
    assert note_to_camelot("Gb", "major") == "2B"    # Gb == F#
    assert note_to_camelot("Db", "major") == "3B"    # Db == C#
    assert note_to_camelot("A#", "major") == "6B"    # A# == Bb


def test_normalize_camelot():
    assert normalize_camelot("8a") == "8A"
    assert normalize_camelot(" 12B ") == "12B"
    assert normalize_camelot("13A") is None
    assert normalize_camelot("XC") is None
    assert normalize_camelot("8") is None
    assert normalize_camelot("") is None
    assert normalize_camelot(None) is None


def test_camelot_number_and_wheel_step_edges():
    assert camelot_number("12A") == 12
    assert wheel_step(12, 1) == 1     # borde circular ascendente
    assert wheel_step(1, 12) == -1    # borde circular descendente
    assert wheel_step(8, 8) == 0
    assert wheel_step(8, 10) == 2
    assert wheel_step(10, 8) == -2
    assert wheel_step(1, 7) == 6      # nunca |11| por el otro lado


def test_relation_rules():
    assert relation("8A", "8A")[0] == "same"
    assert relation("8A", "8B")[0] == "mode"
    assert relation("8B", "8A")[0] == "mode"
    assert relation("8A", "9A")[0] == "neighbor"
    assert relation("12A", "1A")[0] == "neighbor"
    assert relation("1A", "12A")[0] == "neighbor"
    assert relation("8A", "10A")[0] == "boost"
    assert relation("10A", "8A") == ("", "")
    assert relation("8A", "9B") == ("", "")     # cruzar de cara no es armónico
    assert relation("basura", "8A") == ("", "")


def test_is_compatible_rules():
    assert is_compatible("8A", "8A")
    assert is_compatible("8A", "8B")
    assert is_compatible("8A", "9A")
    assert is_compatible("12A", "1A")
    assert is_compatible("8A", "10A")           # Energy Boost +2 ascendente
    assert not is_compatible("10A", "8A")       # descendente: solo con radius=2
    assert is_compatible("10A", "8A", radius=2)
    assert not is_compatible("8A", "9B")        # cruz de cara
    assert not is_compatible("8A", "8B", allow_mode=False)


def test_pitch_class_consistency_with_profiles():
    # NOTE_NAMES debe alinearse 1:1 con los bins del cromagrama (C..B)
    assert NOTE_NAMES == ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]
