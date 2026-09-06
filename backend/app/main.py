"""FastAPI application factory — OCR-TTS Reader."""

import socket
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from rich.console import Console

from backend.app.api.ocr import router as ocr_router
from backend.app.api.parse import router as parse_router
from backend.app.api.tts import router as tts_router

console = Console()

app = FastAPI(title="OCR-TTS Reader", version="0.1.0")

# CORS — allow LAN dev and GitHub Pages frontend (same-origin by default).
# Origins mirror pocket-tts defaults but expanded for local dev
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "http://127.0.0.1:3000",
        "https://*.github.io",
    ],
    allow_origin_regex=r"https://.*\.github\.io",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ocr_router)
app.include_router(parse_router)
app.include_router(tts_router)


@app.get("/health")
async def health() -> JSONResponse:
    """Health check."""
    return JSONResponse({"status": "healthy"})


@app.get("/", response_class=HTMLResponse)
async def serve_index() -> HTMLResponse:
    """Serve frontend entry point.

    Prefers ``frontend/build/index.html`` (SvelteKit static output), then
    ``frontend/static/index.html``, then ``static/index.html``.
    """
    candidates = [
        Path("frontend/build/index.html"),
        Path("frontend/build/200.html"),
        Path("frontend/static/index.html"),
        Path("static/index.html"),
    ]
    for p in candidates:
        if p.exists():
            return HTMLResponse(content=p.read_text(encoding="utf-8"))
    return HTMLResponse(
        "<h2>Frontend not built yet.</h2><p>Run <code>bun run build</code> in frontend/</p>"
    )


def _mount_static() -> None:
    """Mount frontend build (SvelteKit) if present.

    SvelteKit static adapter emits ``_app/`` at the site root
    (``/_app/immutable/...``), so ``frontend/build/_app`` must be at ``/_app``
    and the rest of ``frontend/build`` at ``/``. Mounts are added after API
    routers so ``/api/*`` takes precedence over the catch-all ``/``.
    """
    frontend_build = Path("frontend/build")
    if frontend_build.exists():
        app.mount(
            "/_app",
            StaticFiles(directory=str(frontend_build / "_app")),
            name="frontend_app",
        )
        app.mount("/", StaticFiles(directory=str(frontend_build), html=True), name="frontend")

    for static_dir in ["static", "frontend/static"]:
        p = Path(static_dir)
        if p.exists():
            app.mount(
                f"/{static_dir}",
                StaticFiles(directory=str(p)),
                name=static_dir.replace("/", "_"),
            )


_mount_static()


def get_local_ip() -> str:
    """Find primary local IP for mobile URL display."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return str(s.getsockname()[0])
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    ip = get_local_ip()
    port = 8000
    console.print("\n[bold green]🚀 OCR-TTS Reader Running![/bold green]")
    console.print(f"[bold cyan]Local:[/bold cyan] http://localhost:{port}")
    console.print(f"[bold gold1]📱 Mobile:[/bold gold1] http://{ip}:{port}\n")
    uvicorn.run("backend.app.main:app", host="0.0.0.0", port=port, reload=True)
