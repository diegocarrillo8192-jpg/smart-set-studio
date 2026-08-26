import { useEffect, useRef, useState } from "react";
import type { Track } from "../types";
import { cachedTrackArtwork, getTrackArtwork, subscribeArtwork } from "../api";
import { hexRgba } from "../lib/color";

/** Logo oficial de la marca como fallback limpio cuando el track no tiene
 *  portada (ID3 sin APIC) o mientras la extracción aún carga. */
const LOGO_URL = "logo.png";

interface Props {
  track: Track | null;
  /** Color de acento del deck (cian A / púrpura B) para el glow del marco. */
  accent: string;
  size?: number;
  /** Clave para remontar con animación al cambiar de track. */
  remountKey?: string | number;
}

/**
 * Data URL de la carátula vía caché en memoria (Base64):
 * undefined = aún cargando · null = sin portada (placeholder permanente) ·
 * string  = imagen lista. Un único request por track por sesión.
 */
function useArtworkDataUrl(track: Track | null): string | null | undefined {
  const [art, setArt] = useState<string | null | undefined>(() =>
    track ? cachedTrackArtwork(track) : null
  );
  useEffect(() => {
    if (!track) {
      setArt(null);
      return;
    }
    // Suscripción al caché: cuando la extracción web (ID3) de esta pista
    // termine, la portada aparece aquí de inmediato sin recargar la vista.
    const apply = () => setArt(cachedTrackArtwork(track));
    apply();
    let cancelled = false;
    // getTrackArtwork es barato: devuelve al instante el hit de caché, dedupe
    // las peticiones concurrentes y consulta el servidor solo cuando falta.
    void getTrackArtwork(track).then((a) => {
      if (!cancelled) setArt(a);
    });
    const unsubscribe = subscribeArtwork(apply);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track?.id]);
  return art;
}

/**
 * Carátula de alta fidelidad "premium": la extrae el backend de los metadatos
 * del propio archivo (ID3 APIC / FLAC PICTURE / M4A covr) o de la carpeta, y
 * viaja como Data URL cacheada en memoria. Fallback elegante profesional:
 * disco de vinilo girando sobre gradiente neón con el logo del app (nunca
 * cuadro vacío ni letra plana).
 */
export default function Artwork({ track, accent, size = 56, remountKey }: Props) {
  const art = useArtworkDataUrl(track);

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
          {art === null ? (
            <LogoFallback accent={accent} />
          ) : art ? (
            <img
              src={art}
              alt={track?.title ?? "carátula"}
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <LoadingPlaceholder accent={accent} />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Carga diferida con IntersectionObserver: el elemento NO se monta (ni se
 * decodifica ni se pide su carátula al backend) hasta que se acerca a la
 * viewport (rootMargin 250px). Así las tablas con cientos de filas solo
 * resuelven las miniaturas de las filas visibles al hacer scroll.
 */
function useInView(ref: React.RefObject<HTMLElement | null>, rootMargin = "250px"): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            obs.disconnect(); // una vez visto, se queda visto
          }
        }
      },
      { rootMargin }
    );
    obs.observe(el);
    return () => obs.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return inView;
}

/**
 * Miniatura cuadrada de carátula para tablas (biblioteca y sets): 24-32px,
 * con carga diferida (lazy + async) y placeholder elegante si no hay imagen.
 * Ligera pensando en cientos de filas: sin glow ni animaciones. Fuera de la
 * viewport NO se monta el <img> → cero decodificación y cero requests.
 */
export function CoverThumb({ track, size = 28, className }: { track: Track; size?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInView(ref);
  return (
    <span
      ref={ref}
      className={`relative inline-block shrink-0 overflow-hidden rounded-md border border-slate-700/60 bg-gradient-to-br from-slate-800 to-slate-950 ${className ?? ""}`}
      style={{ width: size, height: size }}
    >
      {inView ? <ThumbInner track={track} /> : <span className="absolute inset-0" />}
    </span>
  );
}

function ThumbInner({ track }: { track: Track }) {
  const art = useArtworkDataUrl(track);
  return (
    <>
      {art === null ? (
        <img
          src={LOGO_URL}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="absolute inset-0 m-auto h-[62%] w-[62%] rounded object-cover opacity-80"
        />
      ) : art ? (
        <img
          src={art}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 animate-pulse bg-slate-800/50" />
      )}
    </>
  );
}

/**
 * Estado "extrayendo": la petición al backend aún está en vuelo (pending) o
 * falló de forma transitoria. MUY importante: no es una confirmación de que
 * el track carezca de portada; por eso aquí jamás se muestra el logo (solo
 * un placeholder neutro que pulsa suavemente) para no "vestir" de sin-
 * portada un cover real que tarda unos milisegundos en llegar.
 */
function LoadingPlaceholder({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 animate-pulse">
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(circle at 50% 40%, ${hexRgba(
            accent,
            0.16
          )} 0%, rgba(10,13,20,0.8) 65%)`,
        }}
      />
    </div>
  );
}

/**
 * Fallback de marca: logo oficial de Smart Set Architect sobre el gradiente
 * de acento del deck (nunca cuadro negro ni letra plana). Se muestra solo
 * cuando el track realmente no tiene portada o aún está extrayéndose.
 */
function LogoFallback({ accent }: { accent: string }) {
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
      <img
        src={LOGO_URL}
        alt="Smart Set Architect"
        draggable={false}
        className="absolute inset-0 m-auto h-[70%] w-[70%] rounded-[18%] object-cover"
        style={{
          boxShadow: `0 0 16px ${hexRgba(accent, 0.35)}`,
        }}
      />
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