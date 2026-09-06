---
type: reference
title: Tooling and Testing
description: Package management, linting, type checking, and test strategy for backend and frontend.
tags: [operations, tooling, testing, ruff, ty]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Tooling and Testing

## Conventions (AGENTS.md)

- **Python:** `uv`, `ruff` (lint+format), `ty` (type checker), `zensical` docs. All modules/classes/functions require docstrings (Google + Markdown, single backticks).
- **Frontend:** `bun`, `vite`, `vitest` (browser mode when applicable).

## Backend

- Deps in `pyproject.toml`: add `fastapi`, `uvicorn`, `python-multipart`, `pydantic`, `pypdf`, `httpx2` (successor to `httpx` per 2026), `pyav` optional, `pytest`, `ty`, `ruff`.
- Run `ty check` + `ruff check --fix` on edited files after each change.
- **Tests (`httpx2`):** `pytest` + `httpx2` + `fastapi.testclient` for `POST /api/ocr/jobs` lifecycle, SSE progress, `postprocess` pure functions (fixtures for column reflow with quotes, uppercase, page markers), `/api/tts/stream` streaming header + `Range` download. No test copies without `httpx2`.

## Frontend

- **Vitest browser mode** for component/unit tests (`@testing-library/svelte`) — uses `playwright` provider under the hood, simplifies DOM tests (parser, `library` store, editor `scrollTo` mocked).
- **Playwright e2e** for true PDF sync: canvas pixel + `editor scrollTop` assertions, touch swipe, voice clone flow. Keep both: `vitest browser` for TDD fast (<2 s), `playwright` for nightly sync regression.

## CLI

`backend/app/cli/{ocr,tts}.py` `typer` wrappers tested via `typer.testing.CliRunner`.

## Docs

`zensical` build from `docs/knowledge/` via `docs/index.md` if needed.
