"""Punto de entrada FastAPI: app, CORS, routers y arranque de BD."""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import folders, sets, settings, tracks
from .database import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    init_db()
    yield


app = FastAPI(title="AI Smart Set Architect", version="1.0.0", lifespan=lifespan)

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
