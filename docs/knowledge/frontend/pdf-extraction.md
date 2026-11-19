---
type: system-component
title: PDF Extraction
description: Browser-side LiteParse extraction, per-page complexity routing, and LLM OCR fallback.
resource: frontend/src/lib/pdf
tags: [frontend, pdf, liteparse, wasm, ocr, pdfjs]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# PDF Extraction

PDF parsing happens entirely in the browser. The backend never receives the
PDF; it only answers one page image at a time when the user accepts an OCR
offer.

## Modules

```
src/lib/pdf/liteparse.worker.ts   module worker: init WASM, isComplex(), parse()
src/lib/pdf/liteparse.ts          main-thread client, request ids, routing helpers
src/lib/pdf/render.ts             pdfjs-dist page rasterizer (JPEG, ~144 DPI)
src/lib/pdf/extract.ts            bounded-concurrency page OCR + merge
src/lib/pdf/fixtures/             committed two-page PDF and its HTML source
```

## Extraction Flow

1. `analyzePdf(bytes)` calls LiteParse `isComplex()` and returns
   `{totalPages, pages: PageComplexityStats[]}`. This is a cheap text-layer
   pass, not a full parse.
2. `ocrWorthyPages(stats)` keeps pages where `needsOcr` is true **and** at least
   one reason is `scanned`, `garbled`, `vector-text`, or `annotation-text`.
   `embedded-images`, `no-text`, and `sparse-text` are ignored.
3. `extractPdfPages(bytes, totalPages, onProgress)` parses the document:
   - ≤200 pages: one `parse()` call.
   - >200 pages: `openBatchSession(bytes, 50)` to bound WASM memory; each batch
     reports progress and the session is always freed.
4. The UI offers OCR only when flagged pages exist: “N of M pages need OCR”.
   Accepting runs `ocrPdfPages()` for exactly those pages; declining keeps the
   browser text. If analysis or parsing throws, the offer instead proposes
   whole-document OCR.
5. `mergeOcrResults(pages, result)` replaces a page only when the OCR Markdown
   is non-empty, so blank/failed pages keep their original text.

## LiteParse Configuration

```ts
new LiteParse({
  outputFormat: 'markdown',
  imageMode: 'off',
  extractLinks: true,
  keepHeadersFooters: false,
  skipDiagonalText: true,
  preserveVerySmallText: false,
  quiet: true,
  maxPages: 10000
});
```

The worker imports the wasm URL
(`@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm?url`) so Vite emits the
~7 MB asset, which Workbox precaches. `optimizeDeps.exclude` keeps Vite from
rewriting the package's module paths.

## OCR Rendering

`openPdfRenderer(bytes)` loads `pdfjs-dist` lazily, points
`GlobalWorkerOptions.workerSrc` at the bundled worker, and copies the bytes
because pdf.js may detach the source buffer. `renderPage(n)`:

- scales 2× (≈144 DPI), capped so the long edge stays at 2400 px;
- draws into an offscreen canvas and encodes JPEG at quality 0.9;
- calls `page.cleanup()` and eventually `doc.destroy()`.

`ocrPdfPages()` uses a small worker pool (default 2, capped at 8), retries each
page once, reports `done/total`, and returns `{pages: Map<number, string>,
failed: number[]}`. A failure is surfaced as a toast count, never as a failed
document.

## Page Model

Extraction produces `rawPages: string[]` in physical order. Postprocessing
(`applyPostprocessingPages`) renders each page independently, then joins them
with `Page N.` markers according to `first_page_number` and `page_overrides`.
This replaces the old `<!-- page break -->` placeholder: page ownership is
explicit, so markers and `pageMap` offsets stay correct even for empty pages.

## Tests

- `liteparse.spec.ts` — reason-aware page selection and reason counts.
- `extract.spec.ts` — OCR merge keeps browser text for blank/failed pages.
- `liteparse.integration.spec.ts` — real WASM against the committed fixture:
  two pages, no scan flags, headings/lists/table retained, markers aligned.
- `postprocess.spec.ts` — page-aligned rendering, offsets, overrides.
