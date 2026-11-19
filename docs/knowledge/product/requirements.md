---
type: reference
title: Requirements
description: Consolidated functional and non-functional requirements for backend and frontend.
tags: [product, requirements, backend, frontend]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Requirements

## Backend (FastAPI, stateless)

1. **LLM OCR proxy — `/api/llm/ocr`**
   - Input: one browser-rendered page image (`png`, `jpeg`, `webp`, or `gif`,
     ≤25 MB), the 1-indexed physical page number, and optional
     `LLMOcrConfig` overrides.
   - Output: `{page, markdown}`. No job state, SSE, PDF uploads, or temp files.
   - Page order, retries, concurrency, and progress are client responsibilities.
   - `GET /api/llm/options`, `POST /api/llm/models`, and `POST /api/llm/test`
     expose defaults, model discovery, and a vision probe for the settings UI.
   - Image type is detected from magic bytes; the uploaded filename and content
     type are not trusted.

2. **TTS — `pocket-tts` and Phonon**
   - Singleton `TTSModel.load_model(quantize=True)` warm at startup.
   - Streaming `POST /api/tts/stream` → `StreamingResponse(audio/wav)` via `generate_audio_stream` + `stream_audio_chunks` (`pocket_tts/main.py:63` pattern). Voice via `voice_url` (builtin) or `voice_safetensors` upload; `voice_wav` upload → transient convert `get_state_for_audio_prompt(..., truncate=True)` (`pocket_tts/models/tts_model.py:544`) which handles 30 s truncate + mono 24 kHz `convert_audio` — no custom resampling.
   - File save `POST /api/tts/jobs` → `storage/{id}.wav` (tee to disk), `GET …/download` with `Range`.
   - Progress: local estimate `buffered/totalChunks` for streaming; poll `GET …/jobs/{id}` for file jobs.
   - Voice safetensors (`export_model_state` `tts_model.py:1015`) persisted **in browser** `IndexedDB` `voices` store, not on server; stateless backend.

3. **Markdown parsing stays client-side.** The frontend owns section parsing,
   postprocessing, and page mapping; there is no `/api/parse-markdown`.

## Frontend (SvelteKit static SPA)

1. **Responsive UI** — `SvelteKit + adapter-static + Vite + Tailwind 4 + shadcn-svelte` (see `frontend/architecture.md`).
2. **PDF extraction** — LiteParse WASM in a module worker:
   - `isComplex()` returns per-page `PageComplexityStats` (`pageNumber`,
     `textLength`, `needsOcr`, `reasons`).
   - `parse()` (or `openBatchSession()` above 200 pages) returns per-page
     Markdown in physical page order.
   - Pages flagged `scanned`, `garbled`, `vector-text`, or `annotation-text`
     trigger an OCR offer; `embedded-images`, `no-text`, and `sparse-text` do
     not, because OCR rarely improves them.
3. **OCR renderer** — `pdfjs-dist` opens the same bytes at ~2× scale (long edge
   capped at 2400 px), rasterizes selected pages as JPEG, and posts each one to
   `/api/llm/ocr` with bounded concurrency and one retry per page.
4. **Persistence** — IndexedDB `docs` + `voices`; `LocalStorage` mirror for
   `activeDocId/rate/lastVoiceId`; versioned DB `v2→v3` migration from `tts_library_v1` (`src/static/index.html:260`).
   - Docs store `rawPages: string[]` (one entry per physical page) plus rendered
     `markdown`, `sections`, and `pageMap`.
   - Legacy docs with `rawMarkdown`/`rawPageMap` and `<!-- page break -->`
     comments are migrated once on read.
5. **Editor** — Markdown `textarea` (or `CodeMirror 6`) continuously scrollable; `PdfPane` (`pdfjs-dist` canvas, one page at a time, swipe/arrows) only when `pageMap` exists; stacked on mobile, `md:grid-cols-2` on desktop; PDF page change → `editor.scrollTo(pageMap[page].charStart)` one-way.
6. **Device TTS** — `window.speechSynthesis` (`src/static/index.html:265`) with `utterance.onend` sentence loop, `pause/resume`, sentence-level persist.
7. **Controls:** play/pause, ±1 sentence, ±section (headers), voice dropdown (`builtin` + `My voices`), rate `0.5–2.0`, seeker per section + global `%`.
8. **Bookmarkable:** `?doc=<id>&s=<globalSentenceIdx>&rate=&voice=` → `history.replaceState` debounced 500 ms.
9. **PWA:** `vite-plugin-pwa` (`@vite-pwa/sveltekit`), Workbox caching, offline TTS fallback. LiteParse WASM is precached (~7 MB); Phonon runtimes are cached on first use.

## Constraints

- Typical PDFs <50 pp; the browser holds page arrays in memory. Documents over
  200 pages parse in 50-page batches to bound WASM memory.
- Window: `fixes-for-tts-from-line-length.txt` max 50 tokens per chunk must never be exceeded.
