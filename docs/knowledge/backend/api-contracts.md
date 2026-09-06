---
type: interface-contract
title: API Contracts
description: REST endpoints, schemas, and error handling for OCR, parse, and TTS.
tags: [backend, api, contracts, schemas]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# API Contracts

## Common

- Base: `PUBLIC_API_URL` or same-origin (LAN).
- Errors: `{detail: string}` with 400 validation, 413 size, 422 schema, 504 timeout.
- CORS: `CORSMiddleware(allow_origins=[frontendOrigin,"http://localhost:5173"])` (was hardcoded `pocket_tts/main.py:32`).

## Schemas (Pydantic)

```py
class PostprocessOptions(BaseModel):
    combine_columns: bool = True
    normalize_uppercase: Literal["off","title","lower_long"]="off"
    ensure_punctuation: bool=False
    insert_page_markers: bool=True
class JobStatus(str, Enum): queued|running|done|error
class PageMapItem(BaseModel): page:int; charStart:int; charEnd:int; startLine:int
class Section(BaseModel): id:int; titles:list[str]; level:int; chunks:list[str]  # sentence = chunk
```

## OCR

```
POST /api/ocr/jobs         → 202 {jobId}
GET  /api/ocr/jobs/{id}    → {status, progress:{done,total}, result?:{filename, markdown, sections, pageMap, meta:{pageCount, ms}}}
GET  /api/ocr/jobs/{id}/events → SSE
GET  /api/ocr/jobs/{id}/markdown
POST /api/ocr  (alias, sync) → 200 {markdown, sections, pageMap} or 202 poll
```

## Parse

```
POST /api/parse-markdown   form: markdown: str → {markdown, sections}  (mirrors src/app.py:114)
```

## TTS

```
GET  /api/tts/voices       → {voices:[{name, lang}]}  # builtin catalog
POST /api/tts/voices/convert  → safetensors bytes
POST /api/tts/stream       → StreamingResponse
POST /api/tts/jobs         → {jobId}
GET  /api/tts/jobs/{id} /download /cancel
```

All POST text fields strip Markdown via `clean_markdown_for_tts` `src/tts/__init__.py:27` and `chunk_text_into_sentences` `src/app.py:22` replaced by tokenizer chunker.

## Versioning

IndexedDB versioned `v3` imports `localStorage["tts_library_v1"]` (`src/static/index.html:260`) once; API version `v1` implicit in paths.
