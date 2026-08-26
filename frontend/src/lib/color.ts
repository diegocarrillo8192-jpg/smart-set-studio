/** Mezcla un color hexadecimal (#rrggbb) con un alpha (0..1) → rgba(). */
export function hexRgba(hex: string, a: number): string {
  if (hex.startsWith("#")) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return hex;
}
