import { useEffect, useState } from "react";
import { RotateCw, X } from "lucide-react";

const DISMISS_KEY = "smartset.orientation_hint_dismissed";

/**
 * Sugerencia discreta para smartphones en posición VERTICAL (portrait):
 * recomienda girar el teléfono para ver mejor el gráfico de energía.
 * Solo aparece en pantallas táctiles pequeñas, se auto-oculta al girar a
 * horizontal y se descarta con su botón (o al girar) durante la sesión.
 */
export default function OrientationHint() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      const coarse = window.matchMedia?.("(pointer: coarse)").matches;
      if (!coarse) return; // no es pantalla táctil (desktop/pantalla táctil grande)
      if (sessionStorage.getItem(DISMISS_KEY)) return;
      const isMobile = window.matchMedia("(max-width: 767px)");
      const portrait = window.matchMedia("(orientation: portrait)");
      const update = () => {
        setShow(isMobile.matches && portrait.matches);
      };
      update();
      isMobile.addEventListener("change", update);
      portrait.addEventListener("change", update);
      window.addEventListener("orientationchange", update);
      return () => {
        isMobile.removeEventListener("change", update);
        portrait.removeEventListener("change", update);
        window.removeEventListener("orientationchange", update);
      };
    } catch {
      /* matchMedia no disponible: no mostrar sugerencia */
    }
  }, []);

  if (!show) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* sesión sin almacenamiento: solo se oculta este render */
    }
    setShow(false);
  };

  return (
    <div className="flex items-center gap-2 border-b border-amber-900/50 bg-amber-950/40 px-3 py-2">
      <RotateCw size={13} className="shrink-0 text-amber-300" />
      <p className="min-w-0 flex-1 text-[11px] font-medium leading-snug text-amber-200">
        Para una mejor visualización del gráfico de energía, te sugerimos girar tu teléfono en
        modo horizontal 🔄
      </p>
      <button
        onClick={dismiss}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-amber-300/70 transition hover:bg-amber-500/20 hover:text-amber-100"
        title="Ocultar sugerencia"
        aria-label="Ocultar sugerencia"
      >
        <X size={12} />
      </button>
    </div>
  );
}