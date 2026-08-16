/** Formatea un BPM a 1 decimal (ej: 113.5). */
export function fmtBpm(bpm: number | null | undefined): string {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm)) return "-";
  return bpm.toFixed(1);
}
