# OCR-TTS Reader

Turn PDFs (books, course materials) into listenable audiobooks.

OCR runs **once** per PDF — `granite-docling` extracts Markdown at ~30 pages/min
on an RTX 4060 laptop GPU. TTS runs **many times** — listen, re-listen, and
follow along with page-aware sync. Two speech engines are supported: the
device's built-in `SpeechSynthesis` (offline, instant) and server-side
`pocket-tts` (high-quality, voice cloning, 4–6× real-time on CPU).

Reading state (Markdown, sentence-level progress, rate, voice) lives in the
browser (IndexedDB + LocalStorage), so the app works offline after OCR. The
backend is a stateless FastAPI service; there is no auth or server-persisted
library in the current scope. See `docs/knowledge/` for product, architecture,
and API details.

## Prerequisites

- Python 3.12+ and [`uv`](https://docs.astral.sh/uv/)
- [`bun`](https://bun.sh/) for the frontend
- A GPU for OCR (`granite-docling` is impractical in-browser);
  TTS runs fine on CPU
- On Linux, prefer the CPU PyTorch index to avoid pulling the multi-GB CUDA
  build (`pocket-tts` runs on CPU):

```sh
uv pip install torch --index-url https://download.pytorch.org/whl/cpu
```

## Backend

```sh
uv sync
uv run uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload
```

Check `http://localhost:8000/health` → `{"status": "healthy"}`. The root URL
serves the built frontend when `frontend/build/` exists.

Main endpoints:

| Endpoint | Description |
|---|---|
| `POST /api/ocr/jobs` | Upload a PDF → `202 {job_id}` background OCR job |
| `GET /api/ocr/jobs/{id}` | Job status, progress, and `{markdown, sections, pageMap}` result |
| `GET /api/ocr/jobs/{id}/events` | SSE progress stream |
| `GET /api/ocr/jobs/{id}/markdown` | Download result as Markdown |
| `POST /api/ocr` | Synchronous OCR alias (creates a job and polls) |
| `POST /api/parse-markdown` | Parse pasted/uploaded Markdown into sections |
| `GET /api/tts/voices` | Built-in voice catalog |
| `POST /api/tts/stream` | Stream WAV audio for text (chunked) |
| `POST /api/tts/jobs` | Background audio-file job → `GET …/download` |
| `POST /api/tts/voices/convert` | Convert uploaded WAV to safetensors (transient) |

Generated audio files land in `storage/` (gitignored).

## CLI

Both commands reuse the backend services and are installed as console scripts:

```sh
# PDF → Markdown via granite-docling
uv run ocr input.pdf -o out.md [--no-reflow] \
  [--normalize-uppercase off|title|lower_long] \
  [--ensure-punctuation] [--no-page-markers]

# Markdown → audio via pocket-tts
uv run tts input.md -v alba -o out.wav [--format wav|mp3|webm] [--quantize]
```

`--voice` accepts a built-in voice name or a path to a `.wav` / `.safetensors`
file. `mp3`/`webm` output requires the optional `av` dependency
(`uv sync --extra av`).

## Frontend

```sh
cd frontend
bun install
bun run dev      # http://localhost:5173
bun run build    # emits frontend/build/, served by the backend at /
```

Set `PUBLIC_API_URL` at build time when the API lives somewhere other than
same-origin (e.g. Cloud Run behind GitHub Pages).

## Testing and checks

```sh
uv run pytest
uvx ruff check backend tests
uvx ty check backend
```

## Docs

Start at `docs/knowledge/index.md`, then `product/overview.md` and
`architecture/system-overview.md`.
