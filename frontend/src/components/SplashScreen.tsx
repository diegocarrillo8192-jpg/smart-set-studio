/**
 * Splash de marca: presentación del logo con animación de entrada (ring,
 * logo neón y título). Es un timer PURO (2s + fade 700ms), totalmente
 * independiente del backend: mientras el logo se muestra, Python arranca en
 * silencio por debajo y la biblioteca se carga al desvanecerse — sin banners.
 *
 * El logo viaja como Data URL inline (ver ../assets/logo) con decoding="sync":
 * se decodifica durante el layout y pinta en el PRIMER fotograma junto con el
 * contenedor y su glow — jamás se ve el recuadro vacío esperando al PNG.
 */
import { LOGO_DATA_URL } from "../assets/logo";

interface Props {
  leaving: boolean;
}

export default function SplashScreen({ leaving }: Props) {
  return (
    <div
      className={`fixed inset-0 z-50 grid place-items-center bg-panel transition-opacity duration-700 ${
        leaving ? "pointer-events-none opacity-0" : "opacity-100"
      }`}
    >
      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          <div className="animate-splash-ring absolute inset-0 rounded-full border-2" />
          <img
            src={LOGO_DATA_URL}
            alt="Smart Set Architect"
            draggable="false"
            decoding="sync"
            className="animate-splash-logo relative z-[1] h-28 w-28 rounded-[26px] object-cover shadow-[0_0_40px_rgba(139,92,246,0.35)] md:h-32 md:w-32"
          />
        </div>
        <h1 className="animate-splash-title select-none text-sm font-bold uppercase text-slate-200">
          Smart Set Architect
        </h1>
        <p className="text-[10px] font-semibold uppercase tracking-[0.45em] text-violet-300/70">
          AI Set Builder
        </p>
      </div>
    </div>
  );
}
