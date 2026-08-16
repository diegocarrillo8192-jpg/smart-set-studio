"""Arranque del backend: uvicorn en 127.0.0.1:8765."""
import uvicorn

from app.config import BACKEND_DIR

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8765,
        reload=True,
        app_dir=str(BACKEND_DIR),
    )
