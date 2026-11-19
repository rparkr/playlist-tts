---
type: interface-contract
title: API Contracts
description: REST endpoints, schemas, and error handling for LLM OCR and TTS.
tags: [backend, api, contracts, schemas]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# API Contracts

## Common

- Base: `PUBLIC_API_URL` or same-origin (LAN).
- Errors: `{detail: string}` with 400 validation, 413 size, 422 schema, 502
  upstream failure, 504 timeout.
- CORS allows local dev origins and `https://*.github.io`.

## OCR (stateless LLM)

```
GET  /api/llm/options  → {base_url, model, system_message, user_message,
                          concurrency, enable_thinking}  (never api_key)
POST /api/llm/models   {base_url?, api_key?} → {base_url, models:[{id,name?,vision?}]}
POST /api/llm/test     LLMOcrConfig → {ok, model, latency_ms}
POST /api/llm/ocr      multipart: image, page, llm? → {page, markdown}
```

`image` is a browser-rendered page raster (PNG, JPEG, WebP, or GIF, max 25 MB).
`page` is the 1-indexed physical PDF page. `llm` is a JSON-encoded
`LLMOcrConfig`:

```json
{"base_url":"http://host/v1","api_key":"…","model":"…",
 "system_message":"…","user_message":"…",
 "enable_thinking":false,"concurrency":2}
```

All fields are optional; omitted values fall back to `LLM_OCR_*` environment
variables and then built-in defaults. `vision` is `true`/`false` only when the
server reports capability metadata; `null` means unknown. Blank pages return an
empty `markdown` string.

### Removed OCR surface

`/api/ocr`, `/api/ocr/jobs*`, `/api/ocr/llm/jobs*`, and
`/api/parse-markdown` no longer exist. PDF parsing and Markdown rendering are
client-side; there are no upload or job endpoints to call.

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

`engine` defaults to `pocket` for clients that predate the field. Unknown values
are `400`; an uninstalled engine is `503` on job creation. The frontend sends
one sentence per stream request from `backendSentencePlayer.ts`, and the
backend serializes Phonon generation.

## Other

```
GET  /health               → {status: "healthy"}
POST /api/convert/epub     → {markdown, title?, author?, images[]}
POST /api/fetch/article    → {markdown, title?, author?, site?, date?, excerpt?, url, domain}
GET  /v1/models            → OpenAI-compatible stub for external probes
```
