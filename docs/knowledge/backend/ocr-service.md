---
type: system-component
title: OCR Service
description: FastAPI OCR job lifecycle using docling granite-docling with progress and page mapping.
resource: backend/app/services/ocr_service.py
tags: [backend, ocr, docling, granite-docling, sse]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# OCR Service

## Contract

```
POST /api/ocr/jobs
  multipart: file: UploadFile (.pdf, ≤100 MB) | postprocess: JSON PostprocessOptions
         {combine_columns:true, normalize_uppercase:"off"|"title"|"lower_long",
          ensure_punctuation:bool, insert_page_markers:bool}
  → 202 {jobId}  (also sync alias POST /api/ocr awaits job with poll fallback for CLI)

GET  /api/ocr/jobs/{id}       → {status: queued|running|done|error, progress:{done,total}, result?:{markdown, sections, pageMap, meta:{pageCount, ms}}}
GET  /api/ocr/jobs/{id}/events→ text/event-stream  data: {type:"progress", page, total} | {type:"done", jobId}
GET  /api/ocr/jobs/{id}/markdown → text/markdown
```

## Implementation

- **Validation:** `filename.lower().endswith(.pdf)` `src/app.py:81`, size check 400; `NamedTemporaryFile` `src/app.py:84`.
- **Page count:** `pypdf.PdfReader(tmp).pages` (replaces `pypdfium2` `src/ocr/__init__.py:13`).
- **Model:** `VlmPipelineOptions(vlm_options=vlm_model_specs.GRANITEDOCLING_TRANSFORMERS)` `src/app.py:89`; run in `ThreadPoolExecutor` via `run_in_threadpool` to avoid blocking event loop; optional `generate_page_images`.
- **Progress:** in-memory `dict[jobId, Job]` (`<50 pp`, no Redis). Single whole-document `convert()` (max Docling batching, ~2.6 s/page on RTX 4060) yields no mid-run signal, so progress is heuristic: `done ≈ elapsed / 2.6 s/page` capped at `total - 1` with ETA from verified timings, reconciled to real completion when convert returns.
- **Markdown + pageMap:** `result.document.export_to_markdown()` `src/app.py:103`; build per-page offsets. If docling lacks per-page export, loop page-by-page (slower but exact `charStart/charEnd` for editor sync). Apply `postprocess` then compute `pageMap: [{page, charStart, charEnd, startLine}]`.
- **Shared parser:** call `parse_markdown_structure` (fixed `current_headers[:level-1]` bug `src/app.py:65`, code-fence aware).

## Tests

- Fixtures from real PDFs; assert two-column reading order, `pageMap` monotonic, SSE event count.

## Migration

- Preserve `src/ocr/rich_cli.py:1` UX as `backend/app/cli/ocr.py` wrapping `ocr_service`.
