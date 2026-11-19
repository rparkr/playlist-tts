# LiteParse test fixture

`sample-doc.pdf` is a small, two-page PDF used by the LiteParse integration
test. The content is original documentation for this project, so it carries the
repository's MIT license and has no third-party provenance.

- `sample-doc.html` — canonical source content and print styles.
- `sample-doc.pdf` — generated output committed for deterministic tests.
- `sample-doc.pdf` is about 55 KB and contains a real text layer (no scans).

## Regenerate

Requires Google Chrome (or Chromium) with headless printing:

```sh
cd frontend/src/lib/pdf/fixtures
google-chrome \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --no-pdf-header-footer \
  --print-to-pdf=sample-doc.pdf \
  sample-doc.html
```

Keep the document at two US Letter pages. Update the integration test only if
the expected headings or page count intentionally change.

## What it covers

- WASM initialization in the Vitest Node environment.
- `isComplex()` returning one entry per page with no scan/OCR verdict.
- `parse()` returning per-page Markdown in reading order.
- Headings, lists, a table, inline code, and a fenced code block.
- Page-array joining that preserves page alignment without page-break
  comments.

Assertions are intentionally loose (headings and key phrases, not exact
typography) so LiteParse upgrades do not make them brittle.
