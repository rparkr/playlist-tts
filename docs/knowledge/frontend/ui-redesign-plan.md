---
type: plan
title: UI Redesign Plan — Desktop Wireframes
description: Plan to update the frontend to match low-fidelity desktop wireframes, incorporating Q&A decisions from 2026-09-05.
tags: [frontend, ui, sveltekit, tailwind, plan]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-09-05T00:00:00Z
---

# UI Redesign Plan — Desktop Wireframes

Source designs: `ui-design/*.png` (exports from `ui-design/desktop-ui.tldraw` — binary, PNGs are authoritative) plus logo `assets/tts-logo.svg`.

Wireframes are low-fidelity: match **layout** not pixel style.

## 1. Decisions from Q&A (2026-09-05)

1. **Top bar** — active filename only when document active, centered in header. Include **section breadcrumbs** (`frontend/src/lib/markdown/parse.ts:103` `getBreadcrumbs`) in the top bar when available. No breadcrumbs when no active doc.
2. **Postprocessing options** — move from inline `Import` checkboxes (`frontend/src/routes/+page.svelte:762` `optCombine/optPunct/optPageMarkers/optUppercase`) to a **gear at top-right of the Markdown pane**. Gear opens a **Postprocessing Settings modal** with checkboxes + info icons (tooltips) per option. Options remain `combine_columns`, `normalize_uppercase: off|title|lower_long`, `ensure_punctuation`, `insert_page_markers`. User can change any time after OCR extraction and Markdown will re-render via re-postprocessing (re-run pipeline client or server `/api/parse-markdown` or re-apply stored raw). If `markdownDraft` has been edited by user, show warning that re-applying may overwrite edits (confirm dialog).
3. **Library order** — keep fixed by `updatedAt` (`frontend/src/lib/stores/library.ts:88` `getAllDocs().sort(b.updatedAt - a.updatedAt)`). Defer drag-to-reorder to later stage. Modal still shows list without drag for now.
4. **Library rename** — inline editable text field per row (not `prompt()` as in `frontend/src/routes/+page.svelte:396`). Click pencil → input appears with focus + save on enter/blur, cancel on Esc. Persist via `saveDoc` (`frontend/src/lib/stores/library.ts:77`).
5. **Markdown viewer/editor toggle** — add **pencil icon** top-right of Markdown pane next to postprocessing gear. Default is **rendered Markdown viewer** (with active sentence highlight). Click pencil → switch to editable `textarea` (keep `frontend/src/routes/+page.svelte:822` + debounce `frontend/src/routes/+page.svelte:463` `onMarkdownInput`). In edit mode, pencil changes to **checkmark (save)** + **x-mark (cancel)**. Cancel reverts `markdownDraft` to `activeDoc.markdown`; save writes via `saveDoc` and re-parses sections (`frontend/src/lib/markdown/parse.ts:45`). Highlight applies to **rendered Markdown only**, styled to app theme (not bright yellow) — use theme accent (blue matching logo, e.g., `bg-sky-500/20` border).
6. **Logo behavior** — clicking `assets/tts-logo.svg` toggles **PDF viewer visibility**. If PDF viewer opened but no `pdfUrl`/`pdfDoc` in current session (`frontend/src/routes/+page.svelte:36` `pdfFile/pdfUrl`), PDF pane shows placeholder with **Upload PDF** button (reuses header upload flow).
7. **Remaining time heuristic** — based on `progress = globalIdx / totalSentences`, average seconds per sentence estimated from word count at **150 wpm at 1.0x**. Formula: `wordsPerSentence * (60/150) / synthRate`. Average across remaining sentences or precompute total estimated remaining: `sum(remainingWords) / (150/60 * rate)` → format `M:SS` with `-` prefix as in `markdown-view.png` (`-29:35`). Update derived in `PlayerBar`.
8. **Speech rate** — keep `0.5x–2.0x` step `0.1` (`frontend/src/routes/+page.svelte:898`). Both slider and numeric input synced, clamped `0.5–2.0`. Remove `4x` wireframe note for now. `synthRate` persisted in `localStorage tts_rate` (`frontend/src/routes/+page.svelte:153`).
9. **OCR ETA** — client estimates based on elapsed time and pages completed: `eta = elapsed / done * (total - done)` where `done/total` from `ocrProgress` (`frontend/src/routes/+page.svelte:41`). Show `79% | 16/20 pages | 0:12 left` as in `pdf-ocr-progress.png`. Use `performance.now()` at job start for elapsed.
10. **Overflow menu** — add per-pane or top-bar overflow (⋮ or `...`) with `Download .md` and `Save audio file (server)` (`frontend/src/routes/+page.svelte:902-929`). Grayed out (`disabled:opacity-50`) when no `activeDoc` (`frontend/src/routes/+page.svelte:801`).
11. **Aesthetic** — dark mode default, clean/modern, Tailwind slate neutrals (`slate-900/800/700`) with **blue accent matching logo** (`assets/tts-logo.svg:2` — use `#0ea5e9` sky-500 / `#0284c7` for buttons, `text-sky-400` for active). Retain `bg-[#121212]` migration but systematize via CSS vars or Tailwind `dark:`.
12. **Responsive** — keep `md:grid-cols-2` for PDF+Markdown side-by-side on desktop (`frontend/src/routes/+page.svelte:808`), stack PDF above Markdown on mobile (`flex-col`). Modals full-screen on mobile (`inset-0` + `max-w-none` on `<640px`, otherwise centered `max-w-lg`).

## 2. Target Layout Summary

### Shared Chrome (all states)

- **Header** `sticky top-0 z-30`: `flex justify-between items-center` — left logo (click toggles PDF pane, `width ~110px`), center title + breadcrumbs (stacked: `engineering_textbook.md` bold, `Section > Subsection` `text-xs text-slate-400` below), right `Upload PDF` (primary `bg-sky-600`) + hamburger `☰` (opens Library modal). When no active doc, center empty. Breadcrumbs derived from `sections[currentSectionIdx]` (`frontend/src/routes/+page.svelte:171`).
- **Footer** `sticky bottom-0 z-30`: `PlayerBar` — left controls `<<` ` <` `▶/⏸` `>` `>>` (`PlayerBar.svelte`), center slider `input[type=range]` `accent-sky-500`, right `X / Y` + `-M:SS` + gear `⚙` (opens `TtsSettingsModal`). Slider bounds `0..totalSentences-1`, `oninput` updates `globalIdx` (`frontend/src/routes/+page.svelte:836`).
- **Main** `flex-1 overflow-auto`: conditional view.

### Main Views

- **Markdown-only** (no PDF): single centered column `max-w-3xl mx-auto w-full`. `MarkdownPane` with pane header: right side `✏️` edit toggle + `⚙` postprocess gear + overflow `⋮`. Viewer renders Markdown (simple `marked` or existing structure) with `yellow` → `bg-sky-500/20` highlight on current sentence (`globalIdx`). Use `getGlobalSentences(sections)` (`frontend/src/lib/markdown/parse.ts:98`).
- **PDF + Markdown** (when `activeDoc.pageMap && pdfVisible`): `grid md:grid-cols-2 gap-4` (`frontend/src/routes/+page.svelte:808` pattern). Left `PdfPane`: `canvas` (`frontend/src/routes/+page.svelte:257` `renderPdfPage`) + bottom controls `< >` + `Page N/M` (`frontend/src/routes/+page.svelte:812`). Right `MarkdownPane` as above. Mobile: `grid-cols-1` PDF first. PDF page change → `editor.scrollTo(pageMap)` one-way (`frontend/src/routes/+page.svelte:265-282`).
- **OCR Progress** (when `isOcrRunning`): split view as wireframe `pdf-ocr-progress.png` — left shows `Extracting text` + `progress bar` + `79% | 16/20 pages | 0:12 left` (derived from `ocrProgress` + ETA), right shows `Extracting text…` (or Markdown placeholder). Reuse `pdf-ocr-progress.png` layout; keep header/footer visible.

### Modals

- **LibraryModal**: triggered by hamburger, overlay `fixed inset-0 bg-black/60 backdrop-blur-sm`, card `bg-slate-800 rounded-xl p-4` (`max-w-lg w-full` desktop, `inset-0 rounded-none` mobile). Title `Library`, list `flex-col gap-2 max-h-[60vh] overflow-auto`. Each row `flex justify-between items-center bg-slate-700 px-3 py-2 rounded`: left tap selects (`openDoc` `frontend/src/routes/+page.svelte:428`), right `✏️` inline edit + `🗑️` delete (`deleteDocHandler` `frontend/src/routes/+page.svelte:446`). Close on backdrop click or `Esc`. Order by `updatedAt` for now.
- **TtsSettingsModal**: triggered by footer gear, same overlay. Fields: `TTS engine` dropdown (`Built in` vs `Pocket TTS` mapping to `useBackendTTS` `frontend/src/routes/+page.svelte:46`), `Voice` dropdown (filtered: `builtinVoices` `frontend/src/lib/stores/library.ts` + `customVoices` + `synthVoices` `frontend/src/routes/+page.svelte:477` depending on engine), `Speech rate` slider + numeric input synced `0.5–2.0 step 0.1` (`frontend/src/routes/+page.svelte:897`), `Voice cloning` file input inside modal (`accept .wav,.mp3,.flac,.m4a,.safetensors` `frontend/src/routes/+page.svelte:489` `onVoiceFile`). Allow typing `1.25` etc. clamped.
- **PostprocessingModal**: triggered by Markdown pane gear, same overlay. Checkboxes for `optCombine`, `optPunct`, `optPageMarkers`, select for `optUppercase`. Each has `ℹ` tooltip. Re-render `activeDoc.markdown` via reapply or server. Warning if dirty (`markdownDraft !== activeDoc.markdown`).

## 3. Component Breakdown and File Map

```
frontend/src/lib/components/
  Header.svelte              # logo, centered title+breadcrumbs, Upload PDF, menu
  PlayerBar.svelte           # controls, slider, X/Y -time, gear
  LibraryModal.svelte        # overlay, list, inline rename, delete
  TtsSettingsModal.svelte    # engine/voice/rate
  PostprocessingModal.svelte # postprocess options + tooltips
  MarkdownPane.svelte        # pane header (edit toggle + gear + overflow), viewer vs textarea, highlight
  PdfPane.svelte             # canvas, page controls, placeholder Upload PDF
  OcrProgressPane.svelte     # progress bar + stats
  OverflowMenu.svelte        # download md / save audio, disabled when no doc

frontend/src/lib/stores/
  library.ts                 # existing, keep updatedAt sort; add Rename helper if needed

frontend/src/lib/markdown/
  parse.ts                   # unchanged, used for breadcrumbs/highlight

frontend/src/lib/tts/
  backendStream.ts           # unchanged
  webSpeech.ts               # unchanged

frontend/src/routes/
  +page.svelte               # orchestrator, reduced to ~200 lines; imports components above
  layout.css                 # Tailwind base + slate/blue theme vars

frontend/static/
  tts-logo.svg               # copy of assets/tts-logo.svg for header
```

## 4. State and Logic Changes

- **New state in `+page.svelte`:**
  ```
  let showLibrary = $state(false)
  let showTtsSettings = $state(false)
  let showPostprocess = $state(false)
  let pdfVisible = $state(true)
  let isEditing = $state(false)
  let editDraft = $state('')
  let ocrStartAt = $state<number|null>(null) // for ETA
  ```
- **Derived:**
  ```
  let breadcrumbs = $derived(currentSection ? currentSection.titles.join(' > ') : '') // existing
  let remainingText = $derived(formatRemaining(getGlobalSentences(sections), globalIdx, synthRate))
  let ocrEta = $derived(estimateEta(ocrStartAt, ocrProgress))
  ```
- **Header upload:** hidden `<input type=file accept=application/pdf>` ref; `Upload PDF` click → `input.click()` → `onPdfSelected` → auto `runOcr()` (keep `pdfFile/pdfUrl` flow `frontend/src/routes/+page.svelte:212-377`). Keep `postprocess` JSON but defaults shown in Postprocessing modal.
- **Logo toggle:** `onclick={() => pdfVisible = !pdfVisible}`.
- **Edit toggle:** `isEditing` switch; entering saves `editDraft = markdownDraft`, exit save calls `onMarkdownInput` flush + `saveDoc`; cancel restores `markdownDraft = editDraft`.
- **Remaining time helper:**
  ```ts
  function formatRemaining(all:string[], idx:number, rate:number): string {
    const remaining = all.slice(idx).join(' ')
    const words = remaining.trim().split(/\s+/).filter(Boolean).length
    const secs = (words / (150/60)) / rate
    const m = Math.floor(secs/60), s = Math.round(secs%60)
    return `-${m}:${String(s).padStart(2,'0')}`
  }
  ```
- **ETA helper:** `elapsed = (Date.now()-ocrStartAt)/1000; perPage = elapsed / done; left = perPage*(total-done)` → `0:12` format.
- **Highlight:** in `MarkdownPane` viewer, split rendered sentences and wrap `globalIdx` sentence in `<mark class="bg-sky-500/20 ring-1 ring-sky-500/30 rounded">`.

## 5. Implementation Phases

### Phase 0 — Shell and Theme (no behavior change)
- Copy `assets/tts-logo.svg` to `frontend/src/lib/assets/tts-logo.svg` (or `static`) and import in `Header.svelte`.
- Create `Header.svelte` and `PlayerBar.svelte` shells with sticky layout, slate+sky theme via `layout.css`. Wire `+page.svelte` to render shell with placeholders.
- Extract existing header/footer inline markup (`frontend/src/routes/+page.svelte:722-729`, `828-931`) into components incrementally.
- Verify `svelte-check --tsconfig ./tsconfig.json` and `vite dev` builds.

### Phase 1 — Modals (Library, TTS Settings, Postprocessing)
- Move Library inline card (`frontend/src/routes/+page.svelte:732-749`) → `LibraryModal.svelte`. Add inline rename input + delete confirm. Keep `openDoc/deleteDocHandler`. Disable drag for now.
- Move TTS engine/voice/rate inline (`frontend/src/routes/+page.svelte:852-899`) → `TtsSettingsModal.svelte`. Extend numeric input sync.
- Create `PostprocessingModal.svelte` with tooltips; reuse `optCombine/optUppercase/optPunct/optPageMarkers` state (`frontend/src/routes/+page.svelte:58`) and re-render logic.
- Wire `showLibrary/showTtsSettings/showPostprocess` toggles; modals handle `Escape` + backdrop close + focus trap. Mobile full-screen (`md:rounded-xl`).

### Phase 2 — Main Content Refactor
- Extract `MarkdownPane.svelte`: pane header with `✏️/✓/✕`, `⚙` postprocess, `⋮` overflow. Inner: `{#if isEditing}` textarea (`bind:value={markdownDraft}` `oninput={onMarkdownInput}`) `{:else}` rendered Markdown with highlight (`currentSentence()` `frontend/src/routes/+page.svelte:531`).
- Extract `PdfPane.svelte`: canvas + page controls (`prevPdfPage/nextPdfPage` `frontend/src/routes/+page.svelte:282-293`), placeholder when `!pdfUrl`.
- Extract `OcrProgressPane.svelte`: use `isOcrRunning/ocrProgress` (`frontend/src/routes/+page.svelte:40`) + ETA.
- Update `+page.svelte` conditional rendering: `{#if isOcrRunning} <OcrProgressPane> {:else if activeDoc} <PdfPane>/<MarkdownPane> {:else} <EmptyState>`.

### Phase 3 — Header Behaviors and PDF Toggle
- Header `Upload PDF` auto-starts OCR (`onPdfSelected → runOcr` chain `frontend/src/routes/+page.svelte:212+296`), set `ocrStartAt = Date.now()`.
- Logo click toggles `pdfVisible`; `MarkdownPane` expands to `max-w-3xl` centered when PDF hidden.
- Title + breadcrumbs in header (`activeDoc.title` + `breadcrumbs`).

### Phase 4 — Player Polish and Overflow
- `PlayerBar` implements `remainingText` derived, slider `max={Math.max(0,totalSentences-1)}` (`frontend/src/routes/+page.svelte:836`), `<< < ▶ > >>` wiring (`prevSection/skipSentence/handleToggle` `frontend/src/routes/+page.svelte:655-713`).
- `OverflowMenu` implements `Download .md` blob (`frontend/src/routes/+page.svelte:903-911`) and `Save audio file` job poll (`frontend/src/routes/+page.svelte:913-929`), disabled when `!activeDoc`.
- Normalize controls: remove standalone `↺` reset (`frontend/src/routes/+page.svelte:849`) unless re-added to overflow.

### Phase 5 — Verification
- `cd frontend && bun run check` — 0 errors.
- `bun run test:unit` — existing `greet.spec.ts` passes; add new component tests after Phase 1.
- Manual matrix: no doc (header empty, footer disabled), active doc Markdown-only, OCR progress → ETA, PDF split desktop vs stacked mobile, Library open/select/rename/delete, edit toggle save/cancel + dirty warning on postprocess, logo toggle PDF, footer play/pause + sentence/section seeks + highlight follows, rate input slider↔text synced, overflow disabled/enabled, dark slate+blue visual.

## 6. Risks and Mitigations

- **Highlight in rendered Markdown** — word offset search (`frontend/src/routes/+page.svelte:178` `highlightInEditor`) is fragile with Markdown syntax; mitigate by mapping `getGlobalSentences` chunks to rendered spans via same `parseMarkdownStructure` output, wrapping exact chunk string in rendered DOM.
- **OCR re-postprocessing overwriting user edits** — add `hasUnsavedEdits = markdownDraft !== activeDoc.markdown` check before reapply; confirm dialog "You have edited the Markdown. Re-applying postprocessing will overwrite your changes. Continue?".
- **pdfjs worker** — keep dynamic import pattern (`frontend/src/routes/+page.svelte:219-229`, `238-243`) to avoid CORS/build issues with `pdfjs-dist/build/pdf.worker.mjs?url`.
- **Tailwind slate + blue** — define in `layout.css` as `@theme { --color-accent: var(--color-sky-500); }` or use `bg-slate-900 text-slate-100 accent-sky-500`; verify contrast AA.
- **Modal a11y** — trap focus, `aria-modal`, `Escape` handling, prevent body scroll when open.
- **State URL sync** — preserve `?doc=&s=&rate=&voice=` (`frontend/src/routes/+page.svelte:149-165`) after refactor; ensure component extraction doesn't break `$effect` URL persistence.

## 7. Out of Scope (deferred)

- Drag-to-reorder in Library (keep `updatedAt` sort).
- Virtualized Markdown rendering for >500 sentences.
- Direct `pocket-tts` WASM in-browser (still server streaming via `backendStream.ts:3`).
- Shadcn/bits-ui primitives — use plain Tailwind + `lucide-svelte` icons for now to minimize churn; can adopt later.

## 8. References

- Designs: `ui-design/markdown-view.png`, `ui-design/menu-modal.png`, `ui-design/pdf-markdown-editor-view.png`, `ui-design/pdf-ocr-progress.png`, `ui-design/tts-settings-modal.png`
- Current UI: `frontend/src/routes/+page.svelte:720-936`
- Stores: `frontend/src/lib/stores/library.ts:1`, `frontend/src/lib/markdown/parse.ts:45`, `frontend/src/lib/tts/backendStream.ts:3`
- Logo: `assets/tts-logo.svg:1`
- Decisions: this doc §1
