---
type: plan
title: Implementation Phases
description: Phased roadmap from scaffolding through PWA polish and future WASM stretch.
tags: [roadmap, phases, plan, milestones]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Implementation Phases

## Phase 0 — Scaffolding (1 day)

- `uv add fastapi uvicorn python-multipart pydantic pypdf httpx2 pyav` (optional), `ruff`/`ty` configs; `bun create svelte` + `adapter-static` + `Tailwind 4` + `shadcn-svelte`.
- Move `src/app.py:19` → `backend/app/main.py`; stub `backend/app/{api,services,models}`; `frontend/src/lib/*`; delete `src/` after migration (per 2.2) aside from CLIs reused in `backend/app/cli`.

## Phase 1 — Backend Hardening (3–4 days)

1. Pydantic `PostprocessOptions`, `PageMapItem`, `Section`; in-memory job dict + SSE `/api/ocr/jobs`.
2. `ocr_service` `pypdf` count, `ThreadPoolExecutor` `docling`, `postprocess` pipeline + unit tests (quote-edge, page-marker-after-boundary).
3. `tts_service` singleton `TTSModel(quantize=True)`, `/api/tts/stream` (`StreamingResponse` + tee to file), `/api/tts/voices/convert` transient, tokenizer chunker (`MAX_TOKEN_PER_CHUNK=50`).

Exit: `fixes-for-tts-from-line-length.txt:14` warnings eliminated; OCR progress events emitted.

## Phase 2 — Frontend Rebuild (5–7 days)

1. `library` + `voices` IndexedDB stores + `tts_library_v1→v3` migration + `?doc&s&voice` `replaceState`.
2. `ImportCard` drag-drop/paste, `EditorView` `textarea`/`CodeMirror` + `PdfPane` `pdfjs-dist` one-page canvas + `pageMap` one-way sync; conditional `{#if pageMap}`.
3. `PlayerView` breadcrumbs `%` + `sec.chunks` + seeker + controls (`play/pause`, `±sentence`, `±section` `src/static/index.html:236ff`), `Web Speech` loop + backend `MediaSource` toggle, voice `builtin|My voices`, rate `0.5–2.0`.
4. Tailwind responsive polish (`md:grid-cols-2` / `flex-col`).

## Phase 3 — Polish & Stretch (2–3 days)

- Global `sentenceIdx/total` `%` + header breadcrumbs, download `?format=webm` via `pyav`, `Range` support, cancel, rate-limit.
- `@vite-pwa/sveltekit` manifest + Workbox, offline fallback ("OCR requires server").
- Spike: `onnx` → `onnxruntime-web` WASM `pocket-tts` (100 M params, refs `kyutai-labs/pocket-tts#in-browser-implementations`), `CacheStorage` after first download — **deferred**, not blocking MVP.

## Risks

- Docling GPU OOM/timeout → CPU fallback + `≤50 pp` cap + keep-alive pings.
- Mid-sentence page markers → postpone marker until terminal punct (tested).
- Voice blob upload per TTS (+10–30 MB) — acceptable vs 10 min generation; future `voiceId` cache optional.
