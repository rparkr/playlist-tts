---
type: architecture
title: System Overview
description: High-level architecture, components, and data flow of the OCR-to-audiobook system.
tags: [architecture, overview, components]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# System Overview

## Topology

```
Mobile/Desktop Browser (SvelteKit static on GitHub Pages or LAN)
  ├─ IndexedDB (docs + voices)  · LocalStorage (prefs)
  ├─ pdf.js worker (PDF preview, one-page canvas)
  ├─ Web Speech API (offline TTS)
  └─ fetch → FastAPI (LAN or Cloud Run, stateless)
             ├─ /api/ocr/jobs + /events (SSE) → docling + pypdf + postprocess
             ├─ /api/parse-markdown
             ├─ /api/tts/stream (StreamingResponse wav) + /api/tts/jobs/download (Range)
             └─ /api/tts/voices/convert (wav→safetensors, transient)
```

## Repositories / Layout

```
backend/app/main.py              FastAPI factory, CORS, mounts
backend/app/api/{ocr,tts,parse}.py
backend/app/services/{ocr_service,postprocess,tts_service}.py
backend/app/cli/{ocr,tts}.py     typer CLIs reusing services
backend/app/models/schemas.py    Pydantic
frontend/  svelte.config.js (adapter-static fallback:index.html, base:/ocr-tts/)
  src/routes/+layout.svelte, +page.svelte
  src/lib/stores/{library,player,voices}.ts
  src/lib/tts/{webSpeech,backendStream}.ts
  src/lib/pdf/viewer.ts
  src/lib/markdown/parse.ts (mirrors backend parser)
```

Provenance: current prototype `src/app.py:19` `FastAPI(title="Companion TTS Reader")` + `StaticFiles` `src/app.py:132`; `src/ocr/*` and `src/tts/__init__.py:21` CLIs validate model feasibility but lack paging/progress.

## Data Flow

1. Upload PDF → `POST /api/ocr/jobs {file, postprocess{…}}` → jobId → SSE progress `page/total` → done `{markdown, sections, pageMap}`.
2. Preview/edit: `pageMap[{page, charStart, charEnd, startLine}]` drives `PdfPane page → editor scrollTop`.
3. Save: `IndexedDB docs.put({id, title=basename|first H1, markdown, sections, pageMap})` + `?doc=id&s=…` bookmark.
4. Play (Web Speech): `player` store iterates `sections[].chunks[sentenceIdx]` via `SpeechSynthesisUtterance`; persist `globalSentenceIdx`.
5. Play (pocket-tts): `POST /api/tts/stream {text=sentences, voice_url|voice_safetensors Blob}` → `generate_audio_stream` thread → `stream_audio_chunks` → MSE `SourceBuffer` (pause = `audio.pause()` only, fetch continues, file teed to `storage/{job}.wav`).

## Cross-Cutting

- Tooling: `uv`, `ruff`, `ty` (AGENTS.md), `httpx2` for backend tests, `vitest browser` (unit) + `playwright` (e2e) for frontend.
- CORS: `CORSMiddleware` allow `frontendOrigin + http://localhost:5173`; `PUBLIC_API_URL` env selects LAN vs Cloud Run (see `operations/deployment.md`).
