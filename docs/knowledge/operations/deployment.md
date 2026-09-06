---
type: reference
title: Deployment
description: Local LAN and stateless Cloud Run deployment with CORS and GitHub Pages frontend.
tags: [operations, deployment, cors, cloud-run, pwa]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Deployment

## Environments

| Env | Frontend | Backend | Persistence |
|-----|----------|---------|-------------|
| **Dev/LAN** | `bun run dev` `localhost:5173` | `uv run uvicorn backend.app.main:app --host 0.0.0.0 --port 8000 --reload` (`get_local_ip` `src/app.py:138`) | `storage/` gitignored on laptop |
| **Pages+Cloud Run** | `https://<user>.github.io/ocr-tts/` (`adapter-static` `base:/ocr-tts/` `fallback:index.html`) | `https://api.example.com` Cloud Run (stateless) | None — docs/voices in browser IndexedDB |

No auth/multi-user/storage (9.1); in-memory `dict[jobId, Job]` suffices for <50 pp (9.2).

## CORS

`CORSMiddleware(allow_origins=[frontendOrigin, "http://localhost:5173"], allow_credentials=False)` (was hardcoded `pocket_tts/main.py:32`). `PUBLIC_API_URL` (`$env/static/public`) empty → same-origin LAN, set to Cloud Run URL in `vite build` for Pages.

## Build

- Frontend `bun run build` → `build/` (static shell + `manifest.json` + `sw.js`).
- Backend Docker multi-stage: `python:3.14 + torch CPU + docling + pocket-tts`; `pyav` optional layer only if `webm/mp3` downloads enabled. `uv` layer cached.

## Git

`pyproject.toml` `uv.lock`, `docs/knowledge/log.md` tracked; `storage/`, `.venv/`, `build/` ignored.
