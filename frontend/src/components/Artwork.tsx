import { useEffect, useState } from "react";
import { Disc3 } from "lucide-react";
import type { Track } from "../types";
import { api } from "../api";

interface Props {
  track: Track | null;
  /** Color de acento del deck (cian A / púrpura B) para el glow del marco. */
  accent: string;
  size?: number;
  /** Clave para remontar con animación al cambiar de track. */
  remountKey?: string | number;
}

export function hexRgba(hex: string, a: number): string {
  if (hex.startsWith("#")) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return hex;
}

/**
 * Carátula de alta fidelidad "premium": la extrae el backend de los metadatos
 * del propio archivo (ID3 APIC / FLAC PICTURE / M4A covr) o de la carpeta.
 * Fallback elegante profesional: disco de vinilo girando sobre gradiente neón
 * con el logo del app (nunca cuadro vacío ni letra plana).
 */
export default function Artwork({ track, accent, size = 56, remountKey }: Props) {
  const [loaded, setLoaded] = useState(false);
  // failed arranca en FALSE: la carátula real (ID3 APIC) debe intentarse
  // siempre; el vinilo es SOLO el fallback si el backend responde sin portada.
  const [failed, setFailed] = useState(false);

  // Al cambiar de track: reiniciar el intento de carga de la carátula
  useEffect(() => {
    setLoaded(false);
    setFailed(false);
  }, [remountKey]);

  const src = track ? api.artworkUrl(track) : null;

  return (
    <div className="shrink-0 animate-artwork-in" style={{ width: size, height: size }}>
      <div
        className="h-full w-full rounded-[10px] p-px"
        style={{
          background: `linear-gradient(150deg, ${hexRgba(accent, 0.75)} 0%, ${hexRgba(
            accent,
            0.15
          )} 45%, ${hexRgba(accent, 0.55)} 100%)`,
          boxShadow: `0 0 18px ${hexRgba(accent, 0.28)}`,
        }}
      >
        <div
          key={remountKey}
          className="animate-fade-in relative h-full w-full overflow-hidden rounded-[9px] bg-slate-950"
        >
          {src && !failed && (
            <img
              src={src}
              alt={track?.title ?? "carátula"}
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setFailed(true)}
              className={`h-full w-full object-cover transition-opacity duration-700 ease-out ${
                loaded ? "opacity-100" : "opacity-0"
              }`}
            />
          )}
          {(!src || failed) && (
            <VinylFallback accent={accent} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Disco de vinilo en rotación sobre gradiente neón (fallback sin portada). */
function VinylFallback({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at 30% 25%, ${hexRgba(accent, 0.35)} 0%, ${hexRgba(
            accent,
            0.08
          )} 40%, #0a0d14 100%)`,
        }}
      />
      {/* Disco girando */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <div className="animate-spin-slow relative h-[88%] w-[88%]">
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "repeating-radial-gradient(circle at center, #05060a 0px, #05060a 1px, #151b28 2px, #05060a 3px)",
              boxShadow: `0 0 12px ${hexRgba(accent, 0.35)}, inset 0 0 10px rgba(0,0,0,0.9)`,
            }}
          />
          {/* Etiqueta central */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
            style={{
              width: "34%",
              height: "34%",
              background: `radial-gradient(circle, ${hexRgba(accent, 0.85)} 0%, ${hexRgba(
                accent,
                0.4
              )} 100%)`,
              boxShadow: `0 0 10px ${hexRgba(accent, 0.8)}`,
            }}
          >
            <Disc3
              size={999}
              className="absolute left-1/2 top-1/2 h-[70%] w-[70%] -translate-x-1/2 -translate-y-1/2 text-black/80"
            />
          </div>
        </div>
      </div>
      {/* Brillo de gramófono */}
      <div
        className="pointer-events-none absolute inset-0 rounded-[9px]"
        style={{
          background: `linear-gradient(120deg, transparent 30%, ${hexRgba(accent, 0.12)} 50%, transparent 70%)`,
          backgroundSize: "200% 100%",
          animation: "shine 3.2s ease-in-out infinite",
        }}
      />
    </div>
  );
}