---
type: reference
title: Tooling and Testing
description: Package management, linting, type checking, and test strategy for backend and frontend.
tags: [operations, tooling, testing, ruff, ty]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Tooling and Testing

## Conventions (AGENTS.md)

- **Python:** `uv`, `ruff` (lint+format), `ty` (type checker), `zensical` docs. All modules/classes/functions require docstrings (Google + Markdown, single backticks).
- **Frontend:** `bun`, `vite`, `vitest` (browser mode when applicable).

## Backend

- Deps in `pyproject.toml`: `fastapi`, `uvicorn`, `python-multipart`, `pydantic`,
  `httpx2` (successor to `httpx` per 2026), `pyav` optional, plus the TTS
  runtimes. `pypdf`, `docling`, and `typer` are no longer dependencies.
- Run `ty check` + `ruff check --fix` on edited files after each change.
- **Tests:** `pytest` + `httpx2` + `fastapi.testclient` for `/api/llm/*`
  (config, vision detection, prompt forwarding, image validation, error
  mapping), removed-route assertions, TTS streaming headers, and `Range`
  downloads. No network calls: LLM clients are stubbed.

## Frontend

- **Vitest** for unit tests (`vitest --run`), Node environment by default.
- `bun run check` (svelte-check) is the type gate for `.svelte` files.
- `liteparse.integration.spec.ts` loads the real WASM from the installed
  package and parses the committed two-page fixture in
  `frontend/src/lib/pdf/fixtures/`. It needs no network and no `test-pdfs/`.
- Routing and merge tests use synthetic `PageComplexityStats` and synthetic OCR
  result maps, so they stay fast and cover only the decision logic.
- **Playwright e2e** for true PDF sync: canvas pixel + `scrollTop` assertions,
  touch swipe, voice clone flow.

## Docs

`zensical` build from `docs/knowledge/` via `docs/index.md` if needed.
