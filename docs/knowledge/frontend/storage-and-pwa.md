---
type: system-component
title: Storage and PWA
description: IndexedDB and LocalStorage persistence, page-aligned doc storage, versioning, and progressive web app caching.
resource: frontend/src/lib/stores/library.ts
tags: [frontend, storage, indexeddb, pwa]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Storage and PWA

## Store Design

```ts
// IndexedDB db: ocr-tts, version: 9
type Doc = {
  id: string;
  title: string;
  slug?: string;              // human-readable ?doc= value
  markdown: string;           // rendered output (what the reader shows)
  rawPages?: string[];        // per-page source, physical PDF order
  pageCount?: number;
  rawMarkdown?: string;       // legacy: pageless raw source
  rawPageMap?: PageMapItem[]; // legacy: page map for rawMarkdown
  postprocess?: PostprocessOptions;
  sections: Section[];
  pageMap?: PageMapItem[];
  createdAt: number;
  updatedAt: number;
};
type Voice = { id:string, name:string, blob:Blob, bytes:number, sourceWavName?:string, createdAt:number }
// prefs mirrored to LocalStorage for sync boot: activeDocId, rate, lastVoiceId
```

- **Why IndexedDB:** voices 10–30 MB each (`export_model_state` `tts_model.py:1015`) exceed `LocalStorage` 5 MB string limit; Markdown alone (40 kB/30 pp) fits `LocalStorage` but unified `IndexedDB` avoids two layers.
- **Docs:** `docs` store. PDF imports store `rawPages` (one entry per physical
  page, empty string for a blank page) and `pageCount`. Paste/Markdown/ePub
  imports keep `rawMarkdown` because they have no physical pages.
- **Re-rendering:** `reapplyPostprocessing` reads `rawPages` when present and
  runs `applyPostprocessingPages`; edited drafts are pageless and render from
  the edited string. Legacy docs are read via `rawMarkdown`/`rawPageMap`.
- **Page-break migration:** `<!-- page break -->` is retired. On read,
  `migrateLegacyPageBreaks` splits a legacy document once into `rawPages`, so
  page markers and `pageMap` align with physical pages without parsing the
  comment syntax again.
- **Voices:** `voices` store; name defaults to `wav basename` without ext, editable; cap 10, quota via `navigator.storage.estimate()`.

## Versioning / Migration

- Prior `localStorage["tts_library_v1"]` (`src/static/index.html:260`) + `tts_active_doc_id` `src/static/index.html:261`.
- `migrateFromLocalStorage()` imports `JSON.parse(localStorage[STORAGE_KEY])` into IndexedDB and bumps the key marker. Old keys are cleared after success.
- DB upgrades create `docs`, `voices`, `pdfs`, `assets`, `audio`, `playlists`,
  and `items`; page fields are additive, so no schema bump was needed for
  `rawPages`/`pageCount`.

## Name-to-Save Flow

- PDF extraction: prompt title default `basename` (`file.name.replace(/\.pdf$/i,'')` `src/static/index.html:355`) or first `H1` slice 30.
- Paste/upload `.md`: prompt title default `firstLine.replace(/^#+\s*/,'')` `src/static/index.html:377`.

## PWA

- `vite-plugin-pwa` (`@vite-pwa/sveltekit`) `manifest.json` (`name`, `display:standalone`), `sw.js` Workbox precaches `index.html`, `/_app/**`, and the
  LiteParse WASM so extraction works offline immediately after install.
- `globIgnores: ['**/phonon_tts*']` keeps Phonon's several ~4.4 MB runtimes out
  of the install payload; they are cached on first use.
- `fetch` to `PUBLIC_API_URL` fails offline → LLM OCR shows a toast and keeps
  browser-extracted text. Reading, browser extraction, and Device TTS remain
  available offline.
