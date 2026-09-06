---
type: architecture
title: Frontend Architecture
description: SvelteKit static SPA structure, routing, and responsive layout for editor and player.
tags: [frontend, sveltekit, architecture, responsive]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Frontend Architecture

## Stack (Chosen per `architecture/decisions.md`)

`SvelteKit + adapter-static (ssr=false, fallback:index.html) + Vite + Tailwind 4 + shadcn-svelte/bits-ui + lucide-svelte`. Bundle ~15–30 kB, no VDOM. Vite-only SPA rejected — loses `+page.svelte` routing, `page.url.searchParams`, `+layout`, and `@vite-pwa/sveltekit` / `base` for GitHub Pages.

## Layout

```
frontend/svelte.config.js → adapter-static({fallback:'index.html'})
src/routes/+layout.svelte   # LibraryDrawer (top on mobile, sidebar md)
src/routes/+page.svelte     # state machine: view = 'import'|'editor'|'player'
src/lib/components/{ImportCard, EditorView, PdfPane, PlayerView}.svelte
src/lib/stores/{library,player,voices}.ts
src/lib/tts/{webSpeech,backendStream}.ts
src/lib/pdf/viewer.ts       # pdfjs-dist + worker
src/lib/markdown/parse.ts   # mirrors backend sections parser
tailwind.config.js (Tailwind 4 CSS-first)
```

## Routing / Bookmarkable State

- Single page with query `?doc=<id>&s=<globalSentenceIdx>&rate=1.2&voice=alba|voices:<uuid>`.
- `page.url.searchParams` on mount opens doc and seeks `globalSentenceIdx`; `history.replaceState` debounced 500 ms on `player` store change.
- `LibraryDrawer` holds all docs; `ImportCard` handles drag-drop PDF / paste textarea / `.md` upload.

## Responsive Rules

- `PdfPane` (when `pageMap` exists) + `EditorView` side-by-side `md:grid-cols-2` on `≥768px`; stacked `flex-col` (PDF first, editor below) on mobile. No `PdfPane` when doc originates from paste/upload (conditional `{#if doc.pageMap}`).
- Dark palette `--bg:#121212` `src/static/index.html:9` systematized via `dark:`.
- Touch targets ≥44 px; `aria-label` on controls.

## Markdown Parser (Mirror)

```ts
type Section = {id, titles:string[], level:number, chunks:string[] /* sentences */}
```

Derived from `src/app.py:33` but fixed `current_headers[:level-1]` edge and code-fence aware; shared `split_into_best_sentences` estimator for progress.

## PWA

`@vite-pwa/sveltekit` Workbox caching `/_app/**`, `manifest.json`, `sw.js`; OCR gracefully degrades offline (`fetch` fail → "OCR requires server").
