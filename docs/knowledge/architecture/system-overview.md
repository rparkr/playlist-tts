---
type: architecture
title: System Overview
description: High-level architecture, components, and data flow of the OCR-to-audiobook system.
tags: [architecture, overview, components]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# System Overview

## Topology

```
Mobile/Desktop Browser (SvelteKit static on GitHub Pages or LAN)
  ├─ IndexedDB (docs, PDFs, voices, audio) · LocalStorage (prefs)
  ├─ LiteParse WASM worker (text extraction + page complexity)
  ├─ pdf.js worker (preview and OCR page rasterization)
  ├─ Web Speech / Phonon WASM (offline TTS)
  └─ fetch → FastAPI (LAN or Cloud Run, stateless)
             ├─ /api/llm/ocr (one page image → Markdown)
             ├─ /api/llm/{options,models,test} (LLM settings)
             ├─ /api/tts/stream + /api/tts/jobs/download (Range)
             └─ /api/tts/voices/convert (wav→safetensors, transient)
```

## Repositories / Layout

```
backend/app/main.py              FastAPI factory, CORS, static mounts
backend/app/api/{llm,tts,convert,fetch}.py
backend/app/services/{llm_service,llm_logging,tts_service}.py
backend/app/models/schemas.py    Pydantic
frontend/  svelte.config.js (adapter-static fallback:index.html)
  src/routes/+page.svelte
  src/lib/stores/library.ts      IndexedDB docs (rawPages + rendered markdown)
  src/lib/pdf/                   LiteParse worker, pdf.js rasterizer, LLM OCR loop
  src/lib/markdown/              parser, postprocessing, rendering
  src/lib/tts/                   Web Speech, server streaming, Phonon, offline audio
```

## Data Flow

1. Pick a PDF. `auto` runs LiteParse `isComplex()` and `parse()` in a worker,
   yielding per-page Markdown. Pages flagged `scanned`, `garbled`,
   `vector-text`, or `annotation-text` trigger an OCR offer.
2. If accepted, the browser renders only those pages with pdf.js and posts each
   image to `/api/llm/ocr`; returned Markdown replaces the page text.
3. The client applies postprocessing (dehyphenate, reflow, uppercase) to each
   page, joins with `Page N.` markers, and stores `rawPages` plus the rendered
   `markdown`, `sections`, and `pageMap` in IndexedDB.
4. Preview/edit: `pageMap[{page, char_start, char_end, start_line}]` drives
   `PdfPane page → editor scrollTop`.
5. Playback uses the existing TTS paths: Web Speech, server streaming, Phonon
   WASM, or pre-generated offline audio.

## Cross-Cutting

- Serverless-friendly: no OCR job state, PDF uploads, temp files, or GPU
  dependencies. LLM credentials can be supplied per request from the browser.
- Re-rendering is offline: stored `rawPages` plus user options reproduce the
  Markdown without the network.
- Tooling: `uv`, `ruff`, `ty`, `bun`, `vitest`. LiteParse integration tests use
  a committed two-page fixture rather than a local sample PDF.
