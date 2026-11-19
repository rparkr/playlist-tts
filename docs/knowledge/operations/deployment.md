---
type: reference
title: Deployment
description: Local LAN and stateless Cloud Run deployment with CORS and GitHub Pages frontend.
tags: [operations, deployment, cors, cloud-run, pwa]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Deployment

## Environments

| Env | Frontend | Backend | Persistence |
|-----|----------|---------|-------------|
| **Dev/LAN** | `bun run dev` `localhost:5173` | `uv run app` (`0.0.0.0:8000`) | `storage/` gitignored on laptop |
| **Pages+Cloud Run** | `https://<user>.github.io/ocr-tts/` (`adapter-static` `base:/ocr-tts/` `fallback:index.html`) | `https://api.example.com` Cloud Run (stateless) | None — docs/voices/PDFs in browser IndexedDB |

No auth/multi-user/storage. The backend keeps no OCR state: PDF parsing runs in
the browser, and `/api/llm/ocr` handles one page image per request. Only TTS
file jobs keep short-lived in-memory state and a `storage/{id}.wav`.

## CORS

`CORSMiddleware(allow_origins=[frontendOrigin, "http://localhost:5173"], allow_credentials=False)` (was hardcoded `pocket_tts/main.py:32`). `PUBLIC_API_URL` (`$env/static/public`) empty → same-origin LAN, set to Cloud Run URL in `vite build` for Pages.

## Build

- Frontend `bun run build` → `build/` (static shell + `manifest.json` + `sw.js`).
  The LiteParse WASM (~7 MB) is emitted under `_app/immutable/workers/assets/`
  and precached by Workbox; Phonon runtime WASMs are excluded from precache.
- Backend Docker multi-stage: `python:3.14 + torch CPU + pocket-tts`; `pyav`
  optional layer only if `webm/mp3` downloads are enabled. No docling or GPU
  stack in the image.

## Git

`pyproject.toml` `uv.lock`, `docs/knowledge/log.md` tracked; `storage/`, `.venv/`,
`build/` ignored.
