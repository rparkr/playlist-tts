---
type: architecture
title: Frontend Architecture
description: SvelteKit static SPA structure, routing, and responsive layout for editor and player.
tags: [frontend, sveltekit, architecture, responsive]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# Frontend Architecture

## Stack (Chosen per `architecture/decisions.md`)

`SvelteKit + adapter-static (ssr=false, fallback:index.html) + Vite + Tailwind 4 + shadcn-svelte/bits-ui + lucide-svelte`. Bundle ~15–30 kB, no VDOM. Vite-only SPA rejected — loses `+page.svelte` routing, `page.url.searchParams`, `+layout`, and `@vite-pwa/sveltekit` / `base` for GitHub Pages.

## Layout

```
frontend/svelte.config.js → adapter-static({fallback:'index.html'})
src/routes/+layout.svelte   # LibraryDrawer (top on mobile, sidebar md)
src/routes/+page.svelte     # overview / library / playlist / editor / player state
src/lib/components/{ImportCard, PlaylistPane, PdfPane, MarkdownPane, OcrProgressPane, OcrOfferModal}.svelte
src/lib/stores/{library,player,settings}.ts
src/lib/pdf/{liteparse,liteparse.worker,render,extract}.ts
src/lib/markdown/{parse,postprocess,render}.ts
src/lib/tts/{webSpeech,backendStream,phononBrowser,offlinePlayer}.ts
tailwind.config.js (Tailwind 4 CSS-first)
```

## Routing / Bookmarkable State

- Single page with query `?doc=<id>&s=<globalSentenceIdx>&rate=1.2&voice=alba|voices:<uuid>`.
- `page.url.searchParams` on mount opens doc and seeks `globalSentenceIdx`; `history.replaceState` debounced 500 ms on `player` store change.
- `PlaylistPane` holds playlists and unassigned library items; `ImportCard` handles drag-drop PDF / paste textarea / `.md` / ePub / article URL.

## Extraction

Extraction is a client-side pipeline: `$lib/pdf/liteparse.ts` → worker → per-page
Markdown, optionally followed by pdf.js rasterization and LLM OCR for pages the
analysis flags. The staging bar exposes three choices — `auto`, `browser only`,
and `OCR: LLM` — and the OCR offer modal explains how many pages would be sent.
See [PDF Extraction](pdf-extraction.md) for the module contracts.

## Responsive Rules

- `PdfPane` (when `pageMap` exists) + `MarkdownPane` side-by-side `md:grid-cols-2` on `≥768px`; stacked `flex-col` (PDF first, editor below) on mobile. No `PdfPane` when doc originates from paste/upload (conditional `{#if doc.pageMap}`).
- Dark palette `--bg:#121212` `src/static/index.html:9` systematized via `dark:`.
- Touch targets ≥44 px; `aria-label` on controls.

## Markdown Parser (Mirror)

```ts
type Section = {id, titles:string[], level:number, chunks:string[] /* sentences */}
```

Derived from `src/app.py:33` but fixed `current_headers[:level-1]` edge and code-fence aware; shared `split_into_best_sentences` estimator for progress.

## PWA

`@vite-pwa/sveltekit` Workbox precaches `index.html`, `/_app/**`, the manifest,
and the LiteParse WASM. Phonon's multi-megabyte runtime WASM is excluded and
cached on first use. LLM OCR still requires the backend; browser extraction and
reading work offline.
