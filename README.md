# OCR-TTS Reader

Turn PDFs (books, course materials) into listenable audiobooks.

PDF extraction runs **in the browser**: [LiteParse](https://github.com/run-llama/liteparse)
runs as WASM in a worker and turns each page into Markdown. When a page looks
like a scan or otherwise has no usable text layer, the app offers LLM-based OCR
for just those pages. TTS runs **many times** — listen, re-listen, and follow
along with page-aware sync. Two speech engines are supported: the device's
built-in `SpeechSynthesis` (offline, instant) and server-side `pocket-tts`
(high-quality, voice cloning, 4–6× real-time on CPU).

Reading state (Markdown, sentence-level progress, rate, voice) lives in the
browser (IndexedDB + LocalStorage), so the app works offline after extraction.
The backend is a stateless FastAPI service that proxies page images to an
OpenAI-compatible vision server and handles TTS; there is no auth, job queue,
or server-persisted library. See `docs/knowledge/` for product, architecture,
and API details.

## Prerequisites

- Python 3.12+ and [`uv`](https://docs.astral.sh/uv/)
- [`bun`](https://bun.sh/) for the frontend
- An OpenAI-compatible vision model for scanned pages (optional; browser
  extraction handles digital-native PDFs without it)
- On Linux, prefer the CPU PyTorch index to avoid pulling the multi-GB CUDA
  build (`pocket-tts` runs on CPU):

```sh
uv pip install torch --index-url https://download.pytorch.org/whl/cpu
```

## Backend

```sh
uv sync
uv run app
```

`uv run app` starts the FastAPI server on port 8000. Check
`http://localhost:8000/health` →
`{"status": "healthy"}`. The root URL serves the built frontend when
`frontend/build/` exists.

Main endpoints:

| Endpoint | Description |
|---|---|
| `POST /api/llm/ocr` | OCR one browser-rendered page image → `{page, markdown}` |
| `GET /api/llm/options` | LLM OCR defaults (base URL, model, prompts, concurrency) |
| `POST /api/llm/models` | List models from the configured LLM server |
| `POST /api/llm/test` | Probe the LLM server/model with a tiny image |
| `POST /api/convert/epub` | Convert an ePub book to Markdown plus image binaries |
| `POST /api/fetch/article` | Fetch and convert an article URL to Markdown |
| `GET /api/tts/voices` | Built-in voice catalog |
| `POST /api/tts/stream` | Stream WAV audio for text (chunked) |
| `POST /api/tts/jobs` | Background audio-file job → `GET …/download` |
| `POST /api/tts/voices/convert` | Convert uploaded WAV to safetensors (transient) |

Generated audio files land in `storage/` (gitignored). The backend never
receives PDFs, parses documents, or keeps OCR job state.

### LLM OCR

The `OCR: LLM` engine talks to any OpenAI-compatible vision server. Configure
the base URL (include `/v1`), optional API key, model, and per-page prompts in
the pre-extraction staging bar under **LLM settings**. The API key stays in
session storage unless you opt in to remembering it on the device.

Server defaults come from `LLM_OCR_BASE_URL`, `LLM_OCR_API_KEY`,
`LLM_OCR_MODEL`, `LLM_OCR_SYSTEM_MESSAGE`, `LLM_OCR_USER_MESSAGE`,
`LLM_OCR_CONCURRENCY`, and `LLM_OCR_ENABLE_THINKING`. Model listing reports
vision support when the server exposes it; models without metadata are shown
as "vision unverified". Use **Test connection** to probe the model with a tiny
image before starting a long OCR run.

## Frontend

```sh
cd frontend
bun install
bun run dev      # http://localhost:5173
bun run build    # emits frontend/build/, served by the backend at /
```

Set `PUBLIC_API_URL` at build time when the API lives somewhere other than
same-origin (e.g. Cloud Run behind GitHub Pages).

The LiteParse WASM (~7 MB) is precached by the service worker, so browser
extraction works offline right after the first install.

### Extraction engines

- **auto** — parse in the browser, then offer LLM OCR for pages that look like
  scans or unreadable text. Only pages with `scanned`, `garbled`,
  `vector-text`, or `annotation-text` reasons are offered.
- **browser only** — LiteParse only; never calls the OCR server.
- **OCR: LLM** — render and OCR every page (useful for poor text layers).

## Testing and checks

```sh
uv run pytest
uvx ruff check backend tests
uvx ty check backend

cd frontend
bun run check
bun run test:unit -- --run
```

LiteParse integration tests use the committed two-page fixture in
`frontend/src/lib/pdf/fixtures/`, so they need no network or local PDFs.

## Docs

Start at `docs/knowledge/index.md`, then `product/overview.md` and
`architecture/system-overview.md`.
