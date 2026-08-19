/**
 * Portrait Lock (solo móvil en landscape).
 *
 * Overlay a pantalla completa que pide girar el dispositivo a vertical.
 * Su visibilidad se controla EXCLUSIVAMENTE por CSS en index.css:
 *   @media (max-width: 768px) and (orientation: landscape)
 * Por defecto está oculto (display: none); desktop/laptops (>768px) nunca
 * cumplen ambas condiciones y jamás lo ven.
 */
export default function PortraitLock() {
  return (
    <div className="portrait-lock fixed inset-0 z-[9999] hidden items-center justify-center bg-slate-950/95 p-8 backdrop-blur-md">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <span className="text-6xl" aria-hidden="true">
          📱
        </span>
        <p className="text-base font-semibold leading-relaxed text-slate-100">
          Por favor, gira tu dispositivo a modo vertical para usar la aplicación.
        </p>
        <span className="text-3xl" aria-hidden="true">
          🔄
        </span>
      </div>
    </div>
  );
}