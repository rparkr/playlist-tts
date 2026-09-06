---
type: reference
title: Requirements
description: Consolidated functional and non-functional requirements for backend and frontend.
tags: [product, requirements, backend, frontend]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Requirements

## Backend (FastAPI)

1. **OCR — `granite-docling` via `docling`**
   - Input PDF → Markdown via `DocumentConverter` + `VlmPipeline` + `vlm_model_specs.GRANITEDOCLING_TRANSFORMERS` (proven in `src/app.py:89`, `src/ocr/__init__.py:51`).
   - `/api/ocr/jobs` background job + SSE progress (replaces blocking `converter.convert` that jumps 0→100%).
   - Per-page char/line offsets (`pageMap`) for editor sync.
   - `pypdf` (pure Python, ~200 kB) for page count; prefer over `pypdfium2` binary (~15 MB).

2. **Post-processing pipeline** `backend/app/services/postprocess.py` (all unit-tested, user-configurable flags):
   - **Reflow:** merge trailing paragraphs continuing across column/page — heuristic `![.!?"')]?$` + next para lowercase; handle quote-terminated `."` as terminal; insert `Page N.` *after* sentence boundary, not mid-sentence.
   - **Normalize uppercase** (`off | title | lower_long`): consecutive uppercase words → titlecase / words >5 chars all-upper → lower (preserve acronyms ≤5).
   - **Ensure punctuation:** headers without terminal `.!?` + closing quote → append `.` (skip code fences/tables).
   - **Page markers** (`insert_page_markers` bool).
   - **Tokenizer-aware chunking:** `split_into_best_sentences(tokenizer, 50)` (`pocket-tts/default_parameters.py: MAX_TOKEN_PER_CHUNK=50`) — fixes `fixes-for-tts-from-line-length.txt:14` skipped words.

3. **TTS — `pocket-tts`**
   - Singleton `TTSModel.load_model(quantize=True)` warm at startup.
   - Streaming `POST /api/tts/stream` → `StreamingResponse(audio/wav)` via `generate_audio_stream` + `stream_audio_chunks` (`pocket_tts/main.py:63` pattern). Voice via `voice_url` (builtin) or `voice_safetensors` upload; `voice_wav` upload → transient convert `get_state_for_audio_prompt(..., truncate=True)` (`pocket_tts/models/tts_model.py:544`) which handles 30 s truncate + mono 24 kHz `convert_audio` — no custom resampling.
   - File save `POST /api/tts/jobs` → `storage/{id}.wav` (tee to disk), `GET …/download` with `Range`.
   - Progress: local estimate `buffered/totalChunks` for streaming; poll `GET …/jobs/{id}` for file jobs.
   - Voice safetensors (`export_model_state` `tts_model.py:1015`) persisted **in browser** `IndexedDB` `voices` store, not on server; stateless backend.

4. **Shared parser:** `/api/parse-markdown` returns `{markdown, sections: [{id, titles, level, chunks: sentence[]}]}` mirrored in frontend.

## Frontend (SvelteKit static SPA)

1. **Responsive UI** — `SvelteKit + adapter-static + Vite + Tailwind 4 + shadcn-svelte` (see `frontend/architecture.md`).
2. **Persistence** — IndexedDB `docs` + `voices`; `LocalStorage` mirror for `activeDocId/rate/lastVoiceId`; versioned DB `v2→v3` migration from `tts_library_v1` (`src/static/index.html:260`).
3. **Editor** — Markdown `textarea` (or `CodeMirror 6`) continuously scrollable; `PdfPane` (`pdfjs-dist` canvas, one page at a time, swipe/arrows) only when `pageMap` exists; stacked on mobile, `md:grid-cols-2` on desktop; PDF page change → `editor.scrollTo(pageMap[page].charStart)` one-way.
4. **Device TTS** — `window.speechSynthesis` (`src/static/index.html:265`) with `utterance.onend` sentence loop, `pause/resume`, sentence-level persist.
5. **Controls:** play/pause, ±1 sentence, ±section (headers), voice dropdown (`builtin` + `My voices`), rate `0.5–2.0`, seeker per section + global `%`.
6. **Bookmarkable:** `?doc=<id>&s=<globalSentenceIdx>&rate=&voice=` → `history.replaceState` debounced 500 ms.
7. **PWA:** `vite-plugin-pwa` (`@vite-pwa/sveltekit`), Workbox caching, offline TTS fallback.

## CLI (Add-on, Post-Refactor)

```
ocr input.pdf -o out.md [--postprocess flags]
tts input.md -v alba|path.wav|path.safetensors -o out.wav [--format wav|mp3|webm]
```

Wrappers in `backend/app/cli/` reusing `backend/app/services/*`; `src/` deleted after migration.

## Constraints

- Typical PDFs <50 pp — in-memory job dict, no Redis/queue for MVP.
- Window: `fixes-for-tts-from-line-length.txt` max 50 tokens per chunk must never be exceeded.
