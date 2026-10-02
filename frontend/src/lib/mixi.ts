/**
 * Motor de SYNC portado de MIXI
 * (github.com/fabriziosalmi/mixi · PolyForm Noncommercial 1.0.0).
 *
 * SYNC ESTÁTICO DE UN SOLO DISPARO (Hard Phase Lock, sin PLL):
 *
 *   1) Tempo: playbackRate = BPM_Master_efectivo / BPM_Original_del_deck,
 *      calculado UNA vez y FIJO para siempre durante el Play. NO existe
 *      ninguna corrección periódica posterior: sin PLL, sin watchdog, sin
 *      micro-nudges, sin rampas, sin setInterval/requestAnimationFrame que
 *      toquen el rate o la posición del audio durante la reproducción.
 *
 *   2) Fase: hardAlignShift() calcula la diferencia EXACTA de fase (Beat
 *      Offset, en segundos de tiempo de fuente) entre el esclavo y el
 *      maestro y devuelve el desplazamiento único que deja ambas marcas de
 *      beat al 100% superpuestas (0 ms de desfasaje). El motor aplica ese
 *      seek UNA sola vez en el SYNC/PLAY y deja que el audio fluya libre a
 *      velocidad fija: con el mismo BPM efectivo y la misma rejilla, la
 *      alineación permanece clavada (Match 1:1) durante todo el track,
 *      exactamente como Rekordbox/Traktor.
 *
 * La fase se mide SIEMPRE en TIEMPO DE FUENTE con el periodo original
 * (60 / BPM_Original): la rejilla (gridOffset) vive en tiempo de fuente y
 * ambos <audio> avanzan sobre el mismo reloj del AudioContext, de modo que
 * dos fases de fuente iguales con BPM efectivos iguales permanecen iguales
 * para siempre, sin deriva ni oscilación.
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
 * superpuesta (0 ms) sobre la rejilla del maestro. Función PURA y estática:
 * se calcula UNA vez en el SYNC/PLAY y nunca se re-modula en bucle.
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
 * playbackRate FIJO del esclavo bajo SYNC 1:1 exacto:
 * rate = BPM_Master_efectivo / BPM_Original_del_esclavo.
 * Constante: se escribe UNA vez y queda clavado, sin variación dinámica
 * posterior de ningún tipo.
 */
export function syncPlaybackRate(masterEffectiveBpm: number, slaveOriginalBpm: number): number {
  if (masterEffectiveBpm <= 0 || slaveOriginalBpm <= 0) return 1;
  return Math.max(0.5, Math.min(2, masterEffectiveBpm / slaveOriginalBpm));
}
