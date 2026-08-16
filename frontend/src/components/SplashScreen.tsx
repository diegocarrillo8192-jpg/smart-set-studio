interface Props {
  /** true → animación de salida (fade-out) antes de desmontar. */
  leaving: boolean;
}

/**
 * Splash screen de bienvenida: logo oficial animado (fade-in + zoom + brillo
 * neón) sobre fondo oscuro, con anillo de pulso. Corta (~1.5-2s), no bloquea
 * la carga de la UI (solo es una capa visual) y se desvanece con fade-out.
 */
export default function SplashScreen({ leaving }: Props) {
  return (
    <div
      className={`pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-[#0a0c12] transition-opacity duration-500 ${
        leaving ? "opacity-0" : "opacity-100"
      }`}
      aria-hidden="true"
    >
      <div className="flex flex-col items-center gap-6">
        <div className="relative">
          {/* Anillo de pulso */}
          <div className="animate-splash-ring absolute inset-0 rounded-full border-2" />
          <img
            src="logo.png"
            alt="Smart Set Architect"
            className="animate-splash-logo relative h-28 w-28 rounded-[26px] object-cover shadow-[0_0_40px_rgba(139,92,246,0.35)] md:h-32 md:w-32"
            draggable={false}
          />
        </div>
        <p className="animate-splash-title select-none text-sm font-bold uppercase text-slate-200">
          Smart Set Architect
        </p>
        <p className="animate-fade-in select-none text-[10px] uppercase tracking-[0.45em] text-violet-400/70">
          AI Set Builder
        </p>
      </div>
    </div>
  );
}