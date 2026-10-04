/**
 * Motor de SYNC portado de MIXI
 * (github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 *
 * Matemática PURA del Phase Lock (sin estado, sin relojes):
 *
 *   1) Tempo: syncPlaybackRate() = rate base del esclavo =
 *      BPM_Master_efectivo / BPM_Original_del_deck (1:1 exacto, sin ratios
 *      armónicos). Es la base sobre la que el servo de fase del motor
 *      (lib/audio.ts · servoTick) aplica sus trims de corrección continua.
 *
 *   2) Fase: hardAlignShift() calcula la diferencia EXACTA de fase (Beat
 *      Offset, en segundos de tiempo de fuente) entre el esclavo y el
 *      maestro: el desplazamiento que deja ambas marcas de beat al 100%
 *      superpuestas (0 ms de desfasaje). El motor lo usa en dos puntos:
 *        · Enganche (SYNC/PLAY): seek rígido único cuantizado al beat del
 *          maestro (Absolute Beatgrid Snap).
 *        · Mantenida (servo, cada 200 ms): medición del error de fase
 *          para recortar el rate del esclavo (±0.15% en lock) hasta
 *          congelar la fase en 0 ms — nunca se acumula tiempo: siempre
 *          se mide posición vs posición.
 *
 * La fase se mide SIEMPRE en TIEMPO DE FUENTE con el periodo original
 * (60 / BPM_Original): la rejilla (gridOffset) vive en tiempo de fuente,
 * de modo que dos fases de fuente iguales con BPM efectivos iguales
 * significan grids superpuestos — exactamente el estándar de
 * Rekordbox/Traktor.
 */

/** Periodo de beat en tiempo de fuente (segundos) de un deck. */
export function sourceBeatPeriod(originalBpm: number): number {
  return originalBpm > 0 ? 60 / originalBpm : 0;
}

/** Fase 0..1 dentro del beat para un tiempo de fuente y su periodo. */
export function beatPhase(timeSec: number, periodSec: number, offsetSec: number): number {
  if (periodSec <= 0) return 0;
  return ((((timeSec - offsetSec) / periodSec) % 1) + 1) % 1;
}

/** Diferencia de fase más corta dentro de un beat, en el rango [-0.5, 0.5]. */
export function wrapPhaseDelta(delta: number): number {
  if (delta > 0.5) return delta - 1;
  if (delta < -0.5) return delta + 1;
  return delta;
}

/**
 * Hard Alignment: desplazamiento EXACTO (segundos de tiempo de fuente) que
 * debe aplicarse a la aguja del esclavo para que su línea de beat quede 100%
 * superpuesta (0 ms) sobre la rejilla del maestro. Función PURA y sin estado:
 * en el enganche define el Hard Snap único; en el servo de fase del motor
 * (servoTick) mide el error de fase vivo en cada tick. Signo: > 0 ⇒ el
 * esclavo va retrasado respecto a la rejilla del maestro.
 */
export function hardAlignShift(
  masterTimeSec: number,
  masterOriginalBpm: number,
  masterGridOffsetSec: number,
  slaveTimeSec: number,
  slaveOriginalBpm: number,
  slaveGridOffsetSec: number,
): number {
  const masterPeriod = sourceBeatPeriod(masterOriginalBpm);
  const slavePeriod = sourceBeatPeriod(slaveOriginalBpm);
  if (masterPeriod <= 0 || slavePeriod <= 0) return 0;
  const masterFrac = beatPhase(masterTimeSec, masterPeriod, masterGridOffsetSec);
  const slaveFrac = beatPhase(slaveTimeSec, slavePeriod, slaveGridOffsetSec);
  const delta = wrapPhaseDelta(masterFrac - slaveFrac);
  return delta * slavePeriod;
}

/**
 * playbackRate BASE del esclavo bajo SYNC 1:1 exacto:
 * rate = BPM_Master_efectivo / BPM_Original_del_esclavo.
 * El servo de fase del motor aplica sus trims de corrección continua
 * SOBRE esta base (rate_final = base × (1 + trim)).
 */
export function syncPlaybackRate(masterEffectiveBpm: number, slaveOriginalBpm: number): number {
  if (masterEffectiveBpm <= 0 || slaveOriginalBpm <= 0) return 1;
  return Math.max(0.5, Math.min(2, masterEffectiveBpm / slaveOriginalBpm));
}
