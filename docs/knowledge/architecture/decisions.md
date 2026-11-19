---
type: decision
title: Architecture Decisions
description: Key tradeoffs and rationale for framework, dependency, and TTS choices.
tags: [architecture, adr, decisions, tradeoffs]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Architecture Decisions

## 1. Frontend: SvelteKit (adapter-static) vs Vite+Svelte SPA vs React

| Option | Bundle | DX (Python team) | Needed Ergonomics |
|--------|--------|-----------------|------------------|
| **SvelteKit static (chosen)** | 15–30 kB, no VDOM | Easiest (single-file `.svelte`, compiled away) | `+page.svelte` routing, `page.url.searchParams` for `?doc&s&voice`, `+layout`, `@vite-pwa/sveltekit`, `base` for GitHub Pages |
| Vite+Svelte SPA | Same bundle | Slightly less | Must hand-roll history/query parsing, `base` manually |
| React | 45 kB+ | Most docs | Ecosystem not needed for hobby project |

**Rationale:** SvelteKit *is* Vite under the hood; `adapter-static({fallback:'index.html'})` + `ssr=false` gives SPA behavior with zero bundle cost and free file routing for bookmarkable progress. Tailwind 4 (CSS-first) over UnoCSS for simplicity — both supported. Solo developer, no React hires → SvelteKit optimal (`frontend/architecture.md`).

*Rejected:* Vanilla/HTMX — no component model for PDF sync.

## 2. PDF Extraction: Browser LiteParse WASM vs Server `pypdf`/Docling

**Chosen: LiteParse WASM in a browser worker.** It reads the PDF text layer in
spatial reading order, reports per-page complexity, and runs with no backend
dependency or GPU. pdf.js remains the preview renderer and provides page
rasters for OCR. The committed fixture in `frontend/src/lib/pdf/fixtures/`
covers the wasm path in Vitest.

*Rejected:* `pypdf` server extraction (no reading order, duplicates the
client parser), `pypdfium2` (large native wheel with no routing signal).

## 3. OCR: Vision LLM Only vs Docling

**Chosen: vision LLM as the only OCR engine.** Docling's `granite-docling`
pipeline is slow without a GPU and pulls torch/transformers plus a job system.
Modern small VLMs are at least as capable for page transcription, and the app
already targets an OpenAI-compatible server. The browser sends only the pages
that need OCR; accepted pages keep LiteParse's structure.

*Rejected:* Docling as a secondary engine (dependency weight, GPU requirement,
duplicate postprocessing), browser Tesseract (quality and model size).

## 4. OCR API: Stateless Page Proxy vs Job + SSE

**Chosen: `POST /api/llm/ocr` with one page image.** The browser owns page
order, concurrency, retries, and progress, so the server needs no job registry,
temp PDFs, SSE, or ETA heuristics. This is compatible with free-tier serverless
hosting and keeps the API surface small.

*Rejected:* job + SSE (stateful, PDF uploads, duplicated processing),
`pypdf`-extracted embedded images (misses page composition and annotations).

## 5. TTS Stream Handling

**Fetch continues on pause** — `audio.pause()/AudioContext.suspend()` only; `fetch` → `MediaSource SourceBuffer` drains in background, tee to `storage/{id}.wav`. Seeking aborts and restarts from sentence. No SSE for streaming progress; estimate `buffered/totalChunks` locally (`totalChunks` via shared tokenizer). File jobs expose pollable `%`.

## 6. Voice Cloning Persistence

Per-browser `IndexedDB` `voices` store (`{id, name, blob}`) with name default `wav basename`. Server is transient (`/api/tts/voices/convert`) — stateless Cloud Run. Blob re-uploaded per TTS call (10–30 MB, negligible vs 10 min generation). Download-and-reupload removed per user revision.

**Truncation:** delegate fully to `pocket-tts` — `get_state_for_audio_prompt(..., truncate=True)` handles 30 s + mono 24 kHz `convert_audio` (`tts_model.py:544`); no custom resampling.

## 7. In-Browser WASM `pocket-tts`

Deferred to Phase 3. 100 M params + Mimi + custom ops require `onnx`→`onnxruntime-web` (~50 MB wasm); no official build, community refs `kyutai-labs/pocket-tts#in-browser-implementations`. Track but not MVP.

## 8. Storage: IndexedDB vs LocalStorage

Markdown-only originally allowed `LocalStorage` (40 kB/30 pp), but voices (10–30 MB each) force `IndexedDB`. Unify both `docs` and `voices` in `IndexedDB`; mirror tiny prefs to `LocalStorage` for sync boot. Versioned DB `v2→v3` migration imports `tts_library_v1` (`src/static/index.html:260`).

## 9. Audio Compression

Browser-best is `webm/opus` (~6× vs wav), MP3 also fine. Server transcode via `pyav` (bundles FFmpeg, no host `ffmpeg` needed); optional `av` dep guarded. Streaming stays `wav` (`pocket_tts/main.py:110`); `?format=mp3|webm` for download. Alternative `imageio-ffmpeg` rejected — `pyav` supports streaming muxer.
