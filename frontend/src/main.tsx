import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { installContextRecovery } from "./lib/contextRecovery";
import "./index.css";
import "./mixi/mixi.css";

// Escritorio (Electron): la barra de título nativa está oculta (titleBarStyle
// "hidden"): el contenido debe dejar espacio para el overlay de controles de
// ventana y la topbar de la consola actúa como zona de arrastre.
if (typeof window !== "undefined" && window.smartSet?.isDesktop) {
  document.documentElement.classList.add("is-desktop");
}

// Recuperación ante pérdida de contexto de render (crash del proceso GPU):
// preventDefault() sobre contextlost permite la restauración en caliente.
installContextRecovery();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
