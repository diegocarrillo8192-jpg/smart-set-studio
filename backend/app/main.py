"""Punto de entrada FastAPI: app, CORS, routers y arranque de BD."""
import logging
import os
import secrets
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .api import folders, sets, settings, tracks
from .database import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Token de bucle local (loopback): la app de escritorio genera un secreto
# aleatorio y lo comparte con el backend vía variable de entorno. Cuando está
# definido, TODA petición a /api/* (salvo el healthcheck) debe aportarlo en el
# header `X-SSA-Token` o el query param `token` (para <audio>/<img>, que no
# pueden enviar headers). Así, una página web arbitraria visitada por el
# usuario (localhost CSRF) no puede leer la biblioteca ni tocar el filesystem.
AUTH_TOKEN = os.environ.get("SMART_SET_TOKEN", "").strip()

# Healthcheck público: Electron lo usa para saber si el backend ya responde.
PUBLIC_PATHS = {"/api/health"}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="AI Smart Set Architect", version="1.0.0", lifespan=lifespan)


def _token_matches(value: str) -> bool:
    """Comparación segura (constant-time) tolerante a caracteres no ASCII."""
    try:
        return secrets.compare_digest(
            value.encode("utf-8", "strict"), AUTH_TOKEN.encode("utf-8", "strict")
        )
    except (UnicodeEncodeError, TypeError):
        return False


@app.middleware("http")
async def enforce_loopback_token(request: Request, call_next):
    if AUTH_TOKEN and request.url.path not in PUBLIC_PATHS:
        header = request.headers.get("x-ssa-token", "")
        query = request.query_params.get("token", "")
        if not (_token_matches(header) or _token_matches(query)):
            return JSONResponse(status_code=401, content={"detail": "No autorizado"})
    return await call_next(request)


# CORS abierto: la UI se sirve desde Vite (dev) o el protocolo local de Electron
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

app.include_router(folders.router)
app.include_router(tracks.router)
app.include_router(sets.router)
app.include_router(settings.router)


@app.get("/api/health")
def health():
    return {"status": "ok", "app": "AI Smart Set Architect"}
