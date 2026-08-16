"""Punto de entrada del backend empaquetado (PyInstaller onedir).

La app de escritorio de producción ejecuta este binario dentro de sus
recursos (process.resourcesPath/backend) sin depender de Python instalado.
"""
import sys
import time

import uvicorn

import app.main  # noqa: F401  (import explícito: registra la app y permite a
# PyInstaller empaquetar todo el paquete `app` para uvicorn.run("app.main:app"))


def main() -> None:
    # El directorio de trabajo puede variar según dónde se lancen el binario:
    # no es necesario, uvicorn resuelve "app.main:app" contra sys.path del exe.
    import os

    port = int(os.environ.get("SSA_BACKEND_PORT", "8765"))
    try:
        uvicorn.run("app.main:app", host="127.0.0.1", port=port, log_level="info")
    except Exception as exc:  # noqa: BLE001
        import logging

        logging.getLogger(__name__).critical("Backend embebido falló: %s", exc)
        time.sleep(30)
        sys.exit(1)


if __name__ == "__main__":
    main()