# Knowledge Log

## 2026-08-31

- Implemented Phase 0–2: FastAPI backend (`backend/app/main.py`, `api/{ocr,parse,tts}`, `services/{ocr_service,postprocess,tts_service}`, `models/schemas`, `cli/{ocr,tts}`) with pypdf pageMap, job+SSE progress, quote-aware reflow, page-marker-after-boundary, tokenizer-aware chunking (50), transient voice convert (`truncate=True`), streaming + file jobs, `httpx2` tests (16 passed), SvelteKit static SPA (`frontend/` via `bunx sv` + `adapter-static fallback:index.html`, Tailwind 4, `@vite-pwa/sveltekit`, `idb` docs/voices, `pdfjs-dist` one-page canvas, dual-engine player, `?doc&s&rate&voice` bookmark), `vite.config.ts` fixed, `svelte-check` 0 errors, `vite build` success.
- Created OKF bundle `docs/knowledge` (okf_version 0.2) documenting OCR-to-audiobook plan — 11 concepts across product, architecture, backend, frontend, operations, roadmap — per user clarifications 2.1–9.6 (SvelteKit static SPA, IndexedDB voices with name defaulting to wav basename, pypdf, job+SSE progress, delegated 30s truncate/mono to pocket-tts, httpx2, vitest browser+playwright, pyav webm/opus, stateless Cloud Run/GitHub Pages).
- Deferred `src/` experimental files deletion until after refactor; CLIs `backend/app/cli/{ocr,tts}.py` retain `typer` wrappers (`src/ocr/__init__.py:22`, `src/tts/__init__.py:66`) reusing services.
