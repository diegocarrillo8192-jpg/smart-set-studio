/** Formatea un BPM a 1 decimal (ej: 113.5). */
export function fmtBpm(bpm: number | null | undefined): string {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm)) return "-";
  return bpm.toFixed(1);
}

/** Segundos → "mm:ss" (con guarda para NaN/Infinito/negativos). */
export function fmtTime(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
