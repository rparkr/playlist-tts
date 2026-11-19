---
type: plan
title: Implementation Phases
description: Phased roadmap from scaffolding through browser extraction and PWA polish.
tags: [roadmap, phases, plan, milestones]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Implementation Phases

## Phase 0 — Scaffolding (done)

- `uv add fastapi uvicorn python-multipart pydantic httpx2` (optional `pyav`), `ruff`/`ty` configs; `bun create svelte` + `adapter-static` + `Tailwind 4` + `shadcn-svelte`.
- Moved `src/app.py:19` → `backend/app/main.py`; stubbed `backend/app/{api,services,models}`; deleted `src/` after migration.

## Phase 1 — Backend (done)

1. Pydantic schemas for LLM OCR and TTS; `PostprocessOptions`, `PageMapItem`, `Section`.
2. Stateless `/api/llm/ocr` page proxy with magic-byte image validation, model discovery, prompt overrides, and a connection probe.
3. `tts_service` singleton `TTSModel(quantize=True)`, `/api/tts/stream` (`StreamingResponse` + tee to file), `/api/tts/voices/convert` transient, tokenizer chunker (`MAX_TOKEN_PER_CHUNK=50`).

Exit: no PDF parsing or OCR job state on the server; `pytest` covers LLM config,
image validation, prompt forwarding, and TTS paths.

## Phase 2 — Frontend (done)

1. `library` + `voices` IndexedDB stores + `tts_library_v1→v3` migration + `?doc&s&voice` `replaceState`.
2. `ImportCard` drag-drop/paste, `MarkdownPane` + `PdfPane` `pdfjs-dist` one-page canvas + `pageMap` bidirectional sync; conditional `{#if pageMap}`.
3. Player breadcrumbs `%` + `sec.chunks` + seeker + controls (`play/pause`, `±sentence`, `±section`), Web Speech loop + backend streaming toggle, voice selection, rate `0.5–2.0`.
4. Tailwind responsive polish (`md:grid-cols-2` / `flex-col`).

## Phase 3 — Browser PDF Extraction (done)

1. LiteParse WASM in a module worker: `isComplex()` analysis and `parse()` /
   `openBatchSession()` extraction to per-page Markdown.
2. Page-aligned storage (`rawPages`), `applyPostprocessingPages`, migration from
   `<!-- page break -->`, and the `Page N.` marker rendering.
3. Reason-aware OCR offer (`scanned`, `garbled`, `vector-text`,
   `annotation-text`), pdf.js page rasterization, and bounded-concurrency LLM
   OCR merged back into the page array.
4. Engines simplified to `auto`, `browser only`, and `OCR: LLM`; Docling,
   `pypdf`, server OCR jobs/SSE, the CLI, and backend postprocessing removed.
5. Workbox precaches the LiteParse WASM (~7 MB) while excluding Phonon runtimes.

## Phase 4 — Polish & Stretch

- Global `sentenceIdx/total` `%` + header breadcrumbs, download `?format=webm` via `pyav`, `Range` support, cancel, rate-limit.
- Optional pre-generation for a whole playlist, with per-item and overall ETA.
- Spike: `onnx` → `onnxruntime-web` WASM `pocket-tts` (100 M params, refs `kyutai-labs/pocket-tts#in-browser-implementations`), `CacheStorage` after first download — **deferred**, not blocking MVP.

## Risks

- A broken text layer can yield little usable Markdown; the OCR offer and the
  `OCR: LLM` engine are the escape hatch.
- Mid-sentence page markers → postpone marker until terminal punct (tested).
- Voice blob upload per TTS (+10–30 MB) — acceptable vs 10 min generation; future `voiceId` cache optional.
