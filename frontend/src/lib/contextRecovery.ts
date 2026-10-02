/**
 * Recuperación de contextos de render (WebGL / Canvas2D) tras una pérdida
 * de contexto por un crash del proceso GPU (Electron).
 *
 * La clave está en llamar preventDefault() sobre `contextlost`: sin él,
 * Chromium abandona el contexto para siempre y la superficie queda en
 * blanco/negra. Con él, el navegador lo restaura y dispara
 * `contextrestored`; los canvas de la consola se redibujan solos porque sus
 * bucles RAF siguen vivos, así que la UI se repinta sin congelarse ni
 * reiniciarse (la ventana ni se recarga).
 */

let installed = false;

export function installContextRecovery(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const onLost = (e: Event) => {
    // Pedir la restauración en vez de dejar el contexto muerto.
    e.preventDefault();
    // eslint-disable-next-line no-console
    console.warn("[render] Contexto de render perdido — a la espera de restauración");
  };
  const onRestored = () => {
    // Los componentes con RAF se repintan solos en el siguiente frame.
    // eslint-disable-next-line no-console
    console.info("[render] Contexto de render restaurado — repintando");
  };

  document.addEventListener("contextlost", onLost, true); // Canvas2D (Chromium)
  document.addEventListener("webglcontextlost", onLost, true); // WebGL
  document.addEventListener("contextrestored", onRestored, true);
  document.addEventListener("webglcontextrestored", onRestored, true);
}
