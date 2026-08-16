# AI Smart Set Architect & DJ Library Manager

Aplicación de escritorio para DJs: indexa tu biblioteca musical local, analiza BPM / tonalidad (Rueda Camelot) / energía, y genera sets armónicos con progresión de energía perfecta usando un motor de curaduría. Incluye Dual Deck Player para probar transiciones.

## Stack

| Capa | Tecnología |
|------|-----------|
| Shell de escritorio | Electron |
| Backend | Python + FastAPI + SQLite (SQLAlchemy) |
| Análisis de audio | librosa (BPM, key, energía) + mutagen (tags/duración) |
| Frontend | React 19 + TypeScript + Tailwind CSS 4 + Lucide |

## Requisitos

- Python 3.11+
- Node.js 20+

## Instalación

```powershell
# 1. Entorno Python + dependencias del backend
python -m venv .venv
.\.venv\Scripts\pip install -r backend\requirements.txt

# 2. Dependencias del frontend
cd frontend
npm install
cd ..

# 3. Electron
cd electron
npm install
cd ..
```

## Ejecución en desarrollo

```powershell
npm run dev
```

Levanta los 3 procesos (backend :8765, frontend Vite :5173, Electron).

> Alternativa sin Electron: `npm run dev:backend` + `npm run dev:frontend` y abre `http://localhost:5173`.

## Arquitectura

```
smart-set-studio/
├── backend/
│   ├── app/
│   │   ├── main.py            # FastAPI (CORS, routers, health)
│   │   ├── models.py          # tracks, folders, playlists, sets, set_items, scan_jobs, settings
│   │   ├── api/               # folders, tracks, sets, settings
│   │   └── services/
│   │       ├── analyzer.py    # BPM (autocorrelación refinada), key (Krumhansl-Schmuckler), energía 1-10
│   │       ├── camelot.py     # Rueda Camelot: nota→1A-12B, relaciones armónicas
│   │       ├── scanner.py     # Escaneo en background con jobs de progreso
│   │       ├── set_generator.py  # Motor de curaduría (greedy + scoring)
│   │       └── exporters.py   # XML Rekordbox + copia a USB
│   └── requirements.txt
├── frontend/                  # React + Vite + Tailwind
│   └── src/
│       ├── components/        # Sidebar, LibraryTable, SetGenerator, DualDeck, Deck, Crossfader...
│       └── lib/audio.ts       # Motor Web Audio: 2 decks + crossfader equal-power
├── electron/                  # main.js (spawnea el backend) + preload.js (diálogos IPC)
└── package.json               # scripts dev
```

La base de datos SQLite vive en `~/.smart-set-studio/library.db`.

## Algoritmo de curaduría (Rueda Camelot)

Al elegir el siguiente track `Tₙ₊₁` desde `Tₙ`:

1. **Tonalidad** (esquema 1A–12B):
   - Misma clave `XA→XA` (Perfect Match)
   - Cambio de modo `XA↔XB`
   - Vecinos `XA→(X±1)A`
   - Energy Boost `XA→(X+2)A` (siempre permitido, priorizado en perfil explosivo)
2. **BPM**: variación máx. ±2.5% (configurable en Ajustes)
3. **Energía (1-10)**: derivada de loudness (70%) + brillo tímbrico/spectral centroid (30%), siguiendo la curva del perfil:
   - `warmup` — subida progresiva suave
   - `peak_hour` — subida rápida y meseta
   - `storytelling` — intro → subida → clímax → cierre
   - `energy_boost` — saltos +2 agresivos

Puntuación: 45% armónica + 30% BPM + 25% ajuste a la curva de energía, con variación aleatoria entre los top-5 para sets distintos en cada generación.

## API principal

| Endpoint | Descripción |
|----------|-------------|
| `POST /api/folders` | Importar carpeta |
| `POST /api/folders/{id}/scan?force=true` | Escanear/re-analizar (background) |
| `GET /api/tracks?q=&camelot=&compatible_with=&min_bpm=...` | Biblioteca con filtros |
| `GET /api/tracks/{id}/audio` | Streaming con soporte Range (seek) |
| `POST /api/sets/generate` | Generar Smart Set |
| `POST /api/sets/{id}/export/rekordbox` | XML Rekordbox |
| `POST /api/sets/{id}/export/usb` | Copia ordenada a USB |
| `GET/PUT /api/settings` | Ajustes del motor |
