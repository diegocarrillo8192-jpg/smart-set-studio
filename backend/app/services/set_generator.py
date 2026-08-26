"""Motor de curaduría: genera sets armónicos con progresión de energía (Rueda Camelot).

Reglas (PRD §4, optimización de calidad):
  1. Mezcla armónica: misma clave (> misma tonalidad), vecinos ±1, cambio de
     modo, y Energy Boost (+2) solo para subir intensidad. Los saltos
     disonantes se penalizan; como último recurso se acepta un "cruce de
     respaldo" (radio ±2) en vez de cortar el set.
  2. BPM: variación máxima ±2/±3 BPM absolutos entre tracks consecutivos;
     en perfiles de alta energía el tempo avanza en rampa acumulativa
     (+1 BPM cada 4 tracks en zona alta) sin saltos bruscos.
  3. Curvas de energía reales por estructura (Warm-Up 3→7, Peak constante
     8.6–9.8, Storytelling intro→clímax→outro).
   4. Sin duplicados (ni en el set ni en los sets recientes), diversificación de
      artistas y razón lógica de cada cruce en la playlist (ej.
      "Transición Armónica Directa 10A → 10A (+0 BPM)").
   5. Variedad entre generaciones: arranque aleatorio, pool Top-K (5..8) y
      jitter del 5-10% en la puntuación de compatibilidad.
"""
import math
import random
from collections import deque
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Folder, Set, SetItem, Track
from .camelot import (
    camelot_number,
    is_compatible,
    normalize_camelot,
    relation,
)

ENERGY_PROFILES = {
    "warmup": {
        "label": "Warm-Up (Progresivo y suave)",
        "description": "Subida gradual de energía, ideal para primeras horas.",
    },
    "peak_hour": {
        "label": "Peak Hour (Sube rápido y se mantiene)",
        "description": "Energía alta desde el inicio y mantenida en el clímax.",
    },
    "storytelling": {
        "label": "Storytelling / Journey (Intro → Clímax → Cierre)",
        "description": "Intro suave, subida constante, clímax y descenso final.",
    },
    "energy_boost": {
        "label": "Explosivo / Energy Boost (Saltos +2)",
        "description": "Transiciones agresivas con saltos de clave +2 para máxima tensión.",
    },
}


# Ventana de "sets recientes" cuyos tracks se evitan repetir salvo que no
# exista ninguna otra opción compatible en toda la colección.
RECENT_SETS_WINDOW = 3

# Tolerancia de energía (1..10) al anclar el track inicial a la curva.
START_ENERGY_TOL = 2.0

# Rango de candidatos Top-K entre los que se elige aleatoriamente.
TOP_K_MIN = 5
TOP_K_MAX = 8


def _clamp(v: float, lo: float = 1.0, hi: float = 10.0) -> float:
    return max(lo, min(hi, v))


# --- Curvas objetivo de energía: E(fracción de tiempo) -> 1..10 -----------------
def _curve_warmup(t: float) -> float:
    # Progresión constante y creciente: ~3 al inicio -> ~7 al final (ej. 3 -> 6)
    return _clamp(2.8 + 4.4 * t**1.25)


def _curve_peak_hour(t: float) -> float:
    if t < 0.15:
        # Entrada rápida a la zona alta
        return _clamp(6.5 + (10.0 - 6.5) * (t / 0.15) ** 1.2)
    # Energía alta constante (8.6..9.8) con fluctuaciones de tensión sutiles
    return _clamp(8.6 + 1.2 * math.sin(math.pi * (t - 0.15) / 0.85) ** 0.5)


def _curve_storytelling(t: float) -> float:
    # Intro atmosférica -> desarrollo progresivo -> clímax central -> outro
    if t < 0.10:
        return _clamp(1.2 + 10.0 * t)                      # 1.2 -> 2.2
    if t < 0.30:
        return _clamp(2.2 + 4.0 * ((t - 0.10) / 0.20))     # -> 4.2
    if t < 0.75:
        return _clamp(4.2 + 5.0 * ((t - 0.30) / 0.45) ** 1.2)  # -> 9.2 clímax
    if t < 0.90:
        return _clamp(9.2 - 0.4 * (t - 0.75) / 0.15)       # sostén del clímax
    return _clamp(8.8 - 4.8 * ((t - 0.90) / 0.10))         # outro de transición


def _curve_energy_boost(t: float) -> float:
    return _clamp(3.5 + 6.0 * t**1.1 + 1.5 * math.sin(t * math.pi * 3) * 0.4)


CURVES: dict[str, Callable[[float], float]] = {
    "warmup": _curve_warmup,
    "peak_hour": _curve_peak_hour,
    "storytelling": _curve_storytelling,
    "energy_boost": _curve_energy_boost,
}


# --- Puntuación de candidatos ----------------------------------------------------
def _bpm_delta(b1: float | None, b2: float | None) -> float | None:
    if not b1 or not b2:
        return None
    return round(b2 - b1, 1)


def _bpm_score(candidate_bpm: float | None, expected_bpm: float | None) -> float:
    if not candidate_bpm or not expected_bpm:
        return 50.0
    # Cercanía al BPM objetivo (incluye la rampa acumulativa de tempo)
    return max(0.0, 100.0 - abs(candidate_bpm - expected_bpm) * 12.0)


def _harmonic_score(current: str, candidate: str, profile: str) -> float:
    rel, _label = relation(current, candidate)
    if rel == "same":
        return 100.0
    if rel == "mode":
        return 85.0
    if rel == "neighbor":
        # Vecinos de segundo grado (respaldo) penalizados frente a ±1
        diff = abs(camelot_number(candidate) - camelot_number(current))
        return 78.0 if diff == 1 else 55.0
    if rel == "boost":
        # El perfil explosivo favorece los saltos +2 (subir intensidad)
        return 95.0 if profile == "energy_boost" else 62.0
    return 25.0  # cruce de respaldo: se acepta, pero muy penalizado


def _energy_score(candidate_energy: int | None, desired: float) -> float:
    if candidate_energy is None:
        return 50.0
    return max(0.0, 100.0 - abs(candidate_energy - desired) * 13.0)


def _transition_reason(
    current: str, nxt: str, prev_bpm: float | None, nxt_bpm: float | None
) -> tuple[str, str]:
    """(relation_key, razón lógica) del cruce:
    ej. "Transición Armónica Directa 10A → 10A (+0 BPM)"."""
    rel, _base = relation(current, nxt)
    delta = _bpm_delta(prev_bpm, nxt_bpm)
    if delta is None:
        delta_str = "BPM ·"
    elif delta == 0:
        delta_str = "+0 BPM"
    else:
        delta_str = f"{delta:+g} BPM"
    if rel == "same":
        return rel, f"Transición Armónica Directa {current} → {nxt} ({delta_str})"
    if rel == "mode":
        return rel, f"Cambio de Modo {current} → {nxt} ({delta_str})"
    if rel == "neighbor":
        diff = abs(camelot_number(nxt) - camelot_number(current))
        kind = "Vecino Armónico" if diff == 1 else "Vecino de Respaldo"
        return rel, f"{kind} {current} → {nxt} ({delta_str})"
    if rel == "boost":
        return rel, f"Energy Boost +2 {current} → {nxt} ({delta_str})"
    return "fallback", f"Cruce de Respaldo {current} → {nxt} ({delta_str})"


def _pick_start(
    pool: list[Track],
    rng: random.Random,
    start_desired: float,
    legacy_pct: float,
    max_bpm_diff: float | None,
    recently_used: set[int],
) -> Track:
    """Elige el track inicial (slot 0) al azar entre todos los que encajan con
    el BPM dominante de la biblioteca y el nivel de energía inicial de la curva.

    Nunca devuelve siempre el mismo track: filtra las opciones válidas y sortea.
    """
    def _bpm_limit(ref: float) -> float:
        return max_bpm_diff if max_bpm_diff else (ref * (legacy_pct or 2.5) / 100.0)

    def _bpm_near(t: Track, ref: float) -> bool:
        if not t.bpm:
            return True
        return abs(t.bpm - ref) <= _bpm_limit(ref)

    bpms = sorted(t.bpm for t in pool if t.bpm)
    median_bpm = bpms[len(bpms) // 2] if bpms else None

    def _energy_near(t: Track) -> bool:
        return t.energy is None or abs((t.energy or 5) - start_desired) <= START_ENERGY_TOL

    # Nivel 1: BPM cercano al dominante + energía cercana al inicio de la curva.
    if median_bpm:
        candidates = [t for t in pool if _bpm_near(t, median_bpm) and _energy_near(t)]
    else:
        candidates = [t for t in pool if _energy_near(t)]
    # Nivel 2: relaja la energía (mantiene solo el BPM dominante).
    if not candidates and median_bpm:
        candidates = [t for t in pool if _bpm_near(t, median_bpm)]
    # Nivel 3: último recurso, toda la biblioteca.
    if not candidates:
        candidates = pool

    # Evita tracks ya usados en sets recientes salvo que no quede alternativa.
    fresh = [t for t in candidates if t.id not in recently_used]
    if fresh:
        candidates = fresh

    return rng.choice(candidates)


def generate_set(
    db: Session,
    *,
    duration_min: float,
    folder_ids: list[int],
    energy_profile: str,
    seed_track_id: int | None = None,
    name: str | None = None,
    settings: dict | None = None,
) -> Set:
    """Genera y persiste un set inteligente. Devuelve la entidad Set."""
    settings = settings or {}
    # Variación de BPM: ±3 BPM absolutos por defecto (o porcentaje legacy)
    legacy_pct = float(settings.get("max_bpm_variation_pct", 0.0))
    max_bpm_diff: float | None = float(settings["max_bpm_diff_bpm"]) if "max_bpm_diff_bpm" in settings else None
    allow_mode = bool(settings.get("allow_mode_change", True))

    if energy_profile not in CURVES:
        raise ValueError(f"Perfil de energía desconocido: {energy_profile}")
    curve = CURVES[energy_profile]
    target_secs = duration_min * 60.0

    # --- Pool de candidatos ---
    stmt = select(Track).where(Track.analyzed.is_(True), Track.camelot_key.is_not(None))
    if folder_ids:
        stmt = stmt.where(Track.folder_id.in_(folder_ids))
    pool: list[Track] = list(db.execute(stmt).scalars())
    if not pool:
        raise ValueError(
            "No hay tracks analizados disponibles. Escanea una carpeta primero."
        )

    rng = random.Random()

    # Tracks ya seleccionados en sets recientes: se evitan para maximizar el
    # uso de toda la colección, salvo que no quede ninguna alternativa válida.
    recently_used: set[int] = set()
    try:
        recent_sets = (
            db.query(Set)
            .order_by(Set.created_at.desc())
            .limit(RECENT_SETS_WINDOW)
            .all()
        )
        for rs in recent_sets:
            recently_used.update(item.track_id for item in rs.items)
    except Exception:
        recently_used = set()

    # --- Track inicial (semilla o arranque aleatorio entre los compatibles) ---
    used: set[int] = set()
    if seed_track_id and any(t.id == seed_track_id for t in pool):
        current = next(t for t in pool if t.id == seed_track_id)
    else:
        current = _pick_start(
            pool,
            rng,
            curve(0.0),
            legacy_pct,
            max_bpm_diff,
            recently_used,
        )
    used.add(current.id)

    sequence: list[Track] = [current]
    total_sec = current.duration_sec or 180.0
    start_bpm = current.bpm or 120.0

    # --- Selección greedy con rampa de tempo acumulativa ---
    bpm_ramp = 0.0          # aumento acumulativo en zona de alta energía
    RAMP_PER_TRACK = 1.0 / 4  # +1 BPM cada 4 tracks en zona alta (perfil pro)
    pos = 1
    last_was_fallback = False   # anti-disonancia: nunca encadenar cruces de respaldo
    recent_artists: deque[str] = deque(maxlen=3)  # ventana para diversificar
    if current.artist:
        recent_artists.append(current.artist.strip().lower())
    prev_prev_key: str | None = None  # para penalizar alternancias de modo 8A→8B→8A
    while total_sec < target_secs:
        fraction = min(1.0, total_sec / max(target_secs, 1.0))
        desired = curve(fraction)
        cur_key = normalize_camelot(current.camelot_key)
        cur_bpm = current.bpm

        # Rampa progresiva: en perfiles de aceleración, si la curva exige
        # energía alta (>= 8), el tempo esperado sube de forma acumulativa.
        if energy_profile in ("peak_hour", "energy_boost") and desired >= 8.0:
            bpm_ramp += RAMP_PER_TRACK
        expected_bpm = round(start_bpm + bpm_ramp, 1)

        # Filtro duro: transición fluida de BPM (máx ±2/±3 BPM absolutos).
        def _bpm_ok(t: Track) -> bool:
            if not cur_bpm or not t.bpm:
                return True
            diff = abs(t.bpm - cur_bpm)
            limit = max_bpm_diff if max_bpm_diff else (cur_bpm * (legacy_pct or 2.5) / 100.0)
            return diff <= limit

        def _gather(exclude_ids: set[int]) -> list[Track]:
            out: list[Track] = []
            for t in pool:
                if t.id in exclude_ids or not t.camelot_key or not _bpm_ok(t):
                    continue
                # Anti-alternancia de modo (8A→8B→8A): excluir el vaivén armónico
                if (
                    prev_prev_key
                    and normalize_camelot(prev_prev_key) == normalize_camelot(t.camelot_key)
                    and relation(normalize_camelot(t.camelot_key), cur_key)[0] == "mode"
                ):
                    continue
                out.append(t)
            return out

        # Evita repetir tracks de sets recientes; solo como último recurso (si no
        # queda ninguna otra opción compatible) se permite repetir uno reciente.
        candidates = _gather(used | recently_used)
        if not candidates and recently_used:
            candidates = _gather(used)
        if not candidates:
            break

        # Paso 1: solo transiciones armónicas estrictas (radio 1, modo si permitido)
        strict = [
            t
            for t in candidates
            if is_compatible(
                cur_key, t.camelot_key,
                radius=1,
                allow_mode=allow_mode or energy_profile == "energy_boost",
            )
        ]

        # Anti-disonancia: tras un cruce de respaldo, el siguiente DEBE ser
        # estricto (volver a la zona armónica segura); si no hay, se corta antes
        # de encadenar choques de tonalidad.
        if last_was_fallback:
            if not strict:
                break
            best_pool = strict
        else:
            # Paso 2 (respaldo): vecinos de radio 2 — sin romper aún el set
            if not strict:
                strict = [
                    t for t in candidates
                    if is_compatible(cur_key, t.camelot_key, radius=2, allow_mode=True)
                ]
            # Paso 3: última opción única: cualquier track sin usar (nunca 2 seguidos)
            best_pool = strict or candidates

        def _score(t: Track) -> float:
            harmonic = _harmonic_score(cur_key, t.camelot_key, energy_profile)
            bpm_s = _bpm_score(t.bpm, expected_bpm)
            energy_s = _energy_score(t.energy, desired)
            # Diversificar artistas: ventana de los 3 últimos (impedir patrones)
            artist_l = (t.artist or "").strip().lower()
            if artist_l:
                if recent_artists and artist_l == recent_artists[-1]:
                    artist_s = -45.0
                elif artist_l in recent_artists:
                    artist_s = -25.0
                else:
                    artist_s = 0.0
            else:
                artist_s = 0.0
            # Anti-alternancia de modo: 8A→8B→8A ya fue EXCLUIDO en el filtro duro
            base = 0.40 * harmonic + 0.30 * bpm_s + 0.24 * energy_s + 0.06 * artist_s
            # Jitter del 5-10%: fluctuación aleatoria del ranking para que cada
            # generación varíe sin romper la jerarquía de compatibilidad.
            jitter = rng.uniform(0.05, 0.10) * rng.choice((-1, 1))
            return base * (1.0 + jitter)

        # Pool Top-K (5..8): elige aleatoriamente entre los mejores candidatos
        # compatibles (BPM, key armónica y energía) en vez del #1 absoluto.
        k = rng.randint(TOP_K_MIN, TOP_K_MAX)
        ranked = sorted(best_pool, key=_score, reverse=True)[:k]
        nxt = rng.choice(ranked) if len(ranked) > 1 else ranked[0]

        sequence.append(nxt)
        used.add(nxt.id)
        total_sec += nxt.duration_sec or 180.0
        current = nxt
        pos += 1
        if (nxt.artist or "").strip().lower():
            recent_artists.append(nxt.artist.strip().lower())
        # ¿Este cruce fue un respaldo? (no estricto ni radio-1)
        allowed_strict = is_compatible(
            cur_key, nxt.camelot_key,
            radius=1,
            allow_mode=allow_mode or energy_profile == "energy_boost",
        )
        last_was_fallback = not allowed_strict
        # prev_prev para el siguiente cruce: el track de hace 2 posiciones
        # (protect también el patrón inicial 8A→8B→8A en posiciones 1-3)
        prev_prev_key = normalize_camelot(sequence[pos - 2].camelot_key) if pos >= 2 else None

    # --- Persistir ---
    set_name = name or _auto_name(energy_profile, duration_min)
    dj_set = Set(
        name=set_name,
        duration_min=duration_min,
        energy_profile=energy_profile,
        folder_ids=",".join(str(f) for f in folder_ids),
        total_sec=total_sec,
        created_at=datetime.now(timezone.utc),
    )
    db.add(dj_set)
    db.flush()

    for position, track in enumerate(sequence, start=1):
        if position == 1:
            rel, label = "start", f"Intro armónica {track.camelot_key}"
        else:
            prev = sequence[position - 2]
            rel, label = _transition_reason(
                normalize_camelot(prev.camelot_key),
                normalize_camelot(track.camelot_key),
                prev.bpm,
                track.bpm,
            )
        db.add(
            SetItem(
                set_id=dj_set.id,
                track_id=track.id,
                position=position,
                transition_label=label,
                transition_relation=rel or "start",
            )
        )

    db.commit()
    db.refresh(dj_set)
    return dj_set


def _auto_name(profile: str, duration_min: float) -> str:
    label = ENERGY_PROFILES.get(profile, {}).get("label", profile)
    short = label.split(" (")[0]
    return f"Smart Set · {short} · {_fmt_duration(duration_min)}"


def _fmt_duration(minutes: float) -> str:
    if minutes < 60:
        return f"{int(minutes)} min"
    h = int(minutes // 60)
    m = int(minutes % 60)
    return f"{h}h{m:02d}m" if m else f"{h}h"