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

## OCR (LLM)

```
POST /api/ocr/llm/jobs     multipart: file, postprocess?, llm? → 202 {job_id}
GET  /api/ocr/llm/jobs/{id}
GET  /api/ocr/llm/jobs/{id}/events
GET  /api/ocr/llm/jobs/{id}/markdown
POST /api/ocr/llm          (sync alias)

GET  /api/ocr/llm/options  → {base_url, model, system_message, user_message,
                              concurrency, enable_thinking}  (never api_key)
POST /api/ocr/llm/models   {base_url?, api_key?} → {base_url, models:[{id,name?,vision?}]}
POST /api/ocr/llm/test     LLMOcrConfig → {ok, model, latency_ms}
```

`llm` is a JSON-encoded `LLMOcrConfig`:

```json
{"base_url":"http://host/v1","api_key":"…","model":"…",
 "system_message":"…","user_message":"…",
 "enable_thinking":false,"concurrency":2}
```

All fields are optional; omitted values fall back to `LLM_OCR_*` environment
variables and then built-in defaults. `vision` is `true`/`false` only when the
server reports capability metadata; `null` means unknown.

## Parse

```
POST /api/parse-markdown   form: markdown: str → {markdown, sections}  (mirrors src/app.py:114)
```

## TTS

```
GET  /api/tts/engines      → {engines:[{id,label,available,voice_cloning,voices[]}]}
GET  /api/tts/voices?engine=pocket|phonon → {voices:[{name, language?, dialect?, gender?, origin?}]}
POST /api/tts/voices/convert  → safetensors bytes (Pocket voice encoder)
POST /api/tts/stream       multipart: text, engine?, voice?, voice_safetensors?
                           → StreamingResponse(audio/wav, chunked)
POST /api/tts/jobs         multipart: text, engine?, voice?, fmt, output_name
                           → 202 {job_id}
GET  /api/tts/jobs/{id}    → {status, progress, engine, voice, output?, error?}
GET  /api/tts/jobs/{id}/download /cancel
```

`engine` defaults to `pocket` for clients that predate the field. Unknown values are `400`; an
uninstalled engine is `503` on job creation. The frontend sends one sentence per stream request
from `backendSentencePlayer.ts`, and the backend serializes Phonon generation.

## Versioning

IndexedDB versioned `v3` imports `localStorage["tts_library_v1"]` (`src/static/index.html:260`) once; API version `v1` implicit in paths.
