"""Rueda Camelot: mapeo de tonalidades musicales (nota -> 1A-12B)."""

# Mapeo Camelot estándar (Mixed in Key / Rekordbox)
# Número -> (tonalidad menor, tonalidad mayor)
CAMELOT_WHEEL: dict[int, tuple[str, str]] = {
    1: ("Ab", "B"),
    2: ("Eb", "F#"),
    3: ("Bb", "C#"),
    4: ("F", "Ab"),
    5: ("C", "Eb"),
    6: ("G", "Bb"),
    7: ("D", "F"),
    8: ("A", "C"),
    9: ("E", "G"),
    10: ("B", "D"),
    11: ("F#", "A"),
    12: ("C#", "E"),
}

# Perfiles de Krumhansl-Schmuckler para detección de tonalidad (C..B)
KS_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
KS_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)

NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

# Alias: Ab == G#, Eb == D#, F# == Gb, C# == Db, Bb == A#
_ALIASES = {
    "G#": "Ab", "D#": "Eb", "G♯": "Ab", "D♯": "Eb", "F♯": "F#", "C♯": "C#",
    "B♭": "Bb", "E♭": "Eb", "A♭": "Ab", "A#": "Bb", "Db": "C#", "Gb": "F#",
}

# Inverso: tonalidad -> código Camelot
_MAJOR_TO_CODE = {major: f"{num}B" for num, (_min, major) in CAMELOT_WHEEL.items()}
_MINOR_TO_CODE = {minor: f"{num}A" for num, (minor, _maj) in CAMELOT_WHEEL.items()}


def note_to_camelot(note: str, mode: str = "minor") -> str:
    """Convierte una nota raíz + modo en código Camelot (ej: 'A', 'minor' -> '8A')."""
    note = note.strip().replace(" ", "")
    note = _ALIASES.get(note, note)
    table = _MINOR_TO_CODE if mode.lower() == "minor" else _MAJOR_TO_CODE
    code = table.get(note)
    if code is None:
        # Intenta con la otra rueda (modo desconocido)
        code = _MAJOR_TO_CODE.get(note) or _MINOR_TO_CODE.get(note)
    return code


def camelot_to_note(code: str) -> tuple[str, str]:
    """Inverso: '9A' -> ('E', 'minor'). Devuelve (nota, modo)."""
    code = code.strip().upper()
    mode = "minor" if code.endswith("A") else "major"
    try:
        number = int(code[:-1])
    except ValueError:
        raise ValueError(f"Código Camelot inválido: {code}")
    if number not in CAMELOT_WHEEL:
        raise ValueError(f"Número Camelot fuera de rango: {number}")
    minor, major = CAMELOT_WHEEL[number]
    return (minor if mode == "minor" else major, mode)


def normalize_camelot(code: str | None) -> str | None:
    """Valida y normaliza un código Camelot, o devuelve None si es inválido."""
    if not code:
        return None
    code = code.strip().upper()
    if len(code) < 2 or code[-1] not in ("A", "B"):
        return None
    try:
        number = int(code[:-1])
    except ValueError:
        return None
    if number not in CAMELOT_WHEEL:
        return None
    return f"{number}{code[-1]}"


def camelot_number(code: str) -> int:
    return int(code[:-1])


def camelot_mode(code: str) -> str:
    return code[-1]


def relation(current: str, nxt: str) -> tuple[str, str]:
    """Relación armónica entre dos códigos Camelot.

    Devuelve (relation_key, label_human):
      - "same":    XA -> XA / XB -> XB      (Perfect Match)
      - "mode":    XA <-> XB                (Cambio de modo)
      - "neighbor": XA -> (X±1)A            (Vecino armónico)
      - "boost":   XA -> (X+2)A             (Energy Boost)
      - None      sin relación válida
    """
    cur = normalize_camelot(current)
    nxt = normalize_camelot(nxt)
    if not cur or not nxt:
        return ("", "")

    c_num, c_mode = camelot_number(cur), camelot_mode(cur)
    n_num, n_mode = camelot_number(nxt), camelot_mode(nxt)

    if cur == nxt:
        return ("same", "Perfect Match")

    if c_num == n_num and c_mode != n_mode:
        return ("mode", "Cambio de Modo")

    diff = abs(c_num - n_num)
    if diff == 1 and c_mode == n_mode:
        return ("neighbor", f"{cur} ➔ {nxt} (Vecino)")

    if c_mode == n_mode and (n_num - c_num) % 12 == 2:
        return ("boost", f"{cur} ➔ {nxt} (+2 Energy Boost)")

    return ("", "")


def is_compatible(current: str, nxt: str, radius: int = 1, allow_mode: bool = True) -> bool:
    """Indica si `nxt` es una transición armónica válida desde `current`.

    Reglas (PRD §4): misma clave, cambio de modo, vecinos ±1 (radio configurable)
    y Energy Boost +2.
    """
    relation_key, _ = relation(current, nxt)
    if relation_key in ("same", "boost"):
        return True
    if relation_key == "mode":
        return allow_mode
    if relation_key == "neighbor":
        c_num = camelot_number(current)
        n_num = camelot_number(nxt)
        return abs(c_num - n_num) <= radius
    return False
