---
type: system-component
title: Player and Editor
description: Markdown editor with PDF sync and dual-engine TTS player controls.
tags: [frontend, editor, pdf, tts, player]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# Player and Editor

## Editor View

- **Markdown field:** `textarea` MVP or `CodeMirror 6` (markdown syntax). Debounced save to `IndexedDB` `docs` on input.
- **PdfPane** (`pdfjs-dist` + worker) renders one page `<canvas>` at a time. Controls: prev/next buttons, swipe `on:touch`/`on:swipe`, keyboard arrows, page number input. No continuous scroll — intentional per requirements.
- **Sync (one-way):** `GET /api/ocr/jobs/result.pageMap` → `pageMap[{page, charStart, charEnd, startLine}]`. On `pdfPageChange`, `editorRef.setScrollTop(markdown.slice(0, charStart).split('\n').length * lineHeight)` or `scrollIntoView(anchorSpan)`. Not bidirectional. Rendered markdown preview toggle via `marked` + `DOMPurify`.
- **Visibility:** `{#if doc.pageMap} <SplitPane> {:else} <EditorOnly> {/if}` — paste/upload docs show no PDF pane.

## Player View

- **Header:** breadcrumb `titles.join(' > ')` `src/static/index.html:448` + `globalSentenceIdx/totalSentences %` + `Section 6 > …` depth.
- **Chunk display:** `sec.chunks[chunkIdx]` with current sentence highlight (`min-height`, `border-left: accent` `src/static/index.html:166`).
- **Seekers:** section-local `range` (`max = chunks.length-1` `src/static/index.html:453`) + global sentence seeker derived from `globalSentenceIdx`.
- **Controls** (existing `src/static/index.html:236` extended):
  - Play/pause, ±1 sentence (skip), ±section (header boundaries), reset, rate `0.5–2.0` `src/static/index.html:249`, voice select (`populateVoices` `src/static/index.html:269` + custom `optgroup`).
- **Engines:**
  - **Web Speech (offline, default):** `synth = speechSynthesis` `src/static/index.html:265`, `speakCurrentChunk` `src/static/index.html:459` loop `utterance.onend → chunkIdx++ → speak`, `synth.pause/resume/cancel`. Persist `sentenceIdx` granularity in `player` store; handle `visibilitychange` and iOS user-gesture gate.
  - **Backend pocket-tts:** `fetch('/api/tts/stream')` → `ReadableStream.getReader()` → `MediaSource SourceBuffer` or `AudioContext`. Pause = `audio.pause()` only, fetch continues, file tees to disk. Seek aborts controller and restarts at sentence. Progress bar from `buffered/totalChunks` (tokenizer estimator).
- **State:** `player` store `{docId, globalSentenceIdx, sectionIdx, chunkIdx, rate, voiceId, isPlaying}` synced to `?s=&rate=&voice=` and `LocalStorage`.
