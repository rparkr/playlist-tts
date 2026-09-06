---
type: system-component
title: Storage and PWA
description: IndexedDB and LocalStorage persistence, versioning, and progressive web app caching.
resource: frontend/src/lib/stores/library.ts
tags: [frontend, storage, indexeddb, pwa]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Storage and PWA

## Store Design

```ts
// IndexedDB db: ocr-tts, version: 3
type Doc = { id:string, title:string, markdown:string, sections:Section[], pageMap?:PageMap[], createdAt:number, updatedAt:number }
type Voice = { id:string, name:string, blob:Blob, bytes:number, sourceWavName?:string, createdAt:number }
// prefs mirrored to LocalStorage for sync boot: activeDocId, rate, lastVoiceId
```

- **Why IndexedDB:** voices 10–30 MB each (`export_model_state` `tts_model.py:1015`) exceed `LocalStorage` 5 MB string limit; Markdown alone (40 kB/30 pp) fits `LocalStorage` but unified `IndexedDB` avoids two layers. Async via `idb-keyval` or `dexie`.
- **Docs:** `docs` store; `pageMap` omitted for paste/upload origins.
- **Voices:** `voices` store; name defaults to `wav basename` without ext, editable; cap 10, quota via `navigator.storage.estimate()`.

## Versioning / Migration

- Prior `localStorage["tts_library_v1"]` (`src/static/index.html:260`) + `tts_active_doc_id` `src/static/index.html:261`.
- Bump DB `v2→v3`; on first open `migrate()` imports `JSON.parse(localStorage[STORAGE_KEY])` into IndexedDB and bumps key to `tts_library_v3` marker. Clear old key after success.

## Name-to-Save Flow

- PDF OCR: prompt title default `basename` (`file.name.replace(/\.pdf$/i,'')` `src/static/index.html:355`) or first `H1` slice 30.
- Paste/upload `.md`: prompt title default `firstLine.replace(/^#+\s*/,'')` `src/static/index.html:377`.

## PWA

- `vite-plugin-pwa` (`@vite-pwa/sveltekit`) `manifest.json` (`name`, `display:standalone`), `sw.js` Workbox precaches `index.html`, `/_app/**`, `localStorage` docs already offline. `fetch` to `PUBLIC_API_URL` fails offline → UI toast "OCR requires server on LAN". `GET /` serves shell (`src/app.py:121` pattern retained as static fallback).
