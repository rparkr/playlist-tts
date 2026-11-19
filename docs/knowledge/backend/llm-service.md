---
type: system-component
title: LLM Service
description: Stateless vision-LLM page OCR with per-request credentials, model discovery, and editable prompts.
resource: backend/app/services/llm_service.py
tags: [backend, ocr, llm, vision, openai-compatible]
generated:
  by: opencode
  at: 2026-11-18T00:00:00Z
---

# LLM Service

## Contract

```
POST /api/llm/ocr
  multipart: image: UploadFile (PNG/JPEG/WebP/GIF)
             page: int (1-indexed physical PDF page)
             llm: JSON LLMOcrConfig (optional)
  → 200 {page, markdown}

GET  /api/llm/options  → {base_url, model, system_message, user_message,
                          concurrency, enable_thinking}
POST /api/llm/models   {base_url?, api_key?} → {base_url, models: [{id, name?, vision?}]}
POST /api/llm/test     LLMOcrConfig → {ok, model, latency_ms}
```

There are no OCR jobs, SSE streams, PDF uploads, temp files, or server-side
Markdown processing. The browser renders a page with pdf.js and sends the
image; the response is the model's Markdown for that page.

`LLMOcrConfig` fields are all optional; omitted/empty values fall back to
`LLM_OCR_*` environment variables and then to the built-in defaults:

```json
{
  "base_url": "http://127.0.0.1:9931/v1",
  "api_key": "…",
  "model": "qwen3.5-4b",
  "system_message": "…",
  "user_message": "…",
  "enable_thinking": false,
  "concurrency": 2
}
```

`concurrency` is a client-side hint: the browser reads it to cap in-flight page
requests. The server handles one image per request.

## Implementation

- **Image validation:** the upload header is not trusted. PNG, JPEG, WebP, and
  GIF are detected from magic bytes; anything else is a 400. Images over 25 MB
  are rejected with 413.
- **Blank pages:** the default prompt asks the model to answer
  `<no text found>`; `normalize_ocr_markdown` maps that to an empty string so
  the browser keeps the original page.
- **Credentials:** `create_llm_client(base_url, api_key)` passes the key to the
  OpenAI-compatible server; empty keys use a local placeholder. `LLMConfig`
  keeps the key out of `repr()`.
- **Prompts:** `LLMConfig.from_env()` resolves `LLM_OCR_SYSTEM_MESSAGE` and
  `LLM_OCR_USER_MESSAGE`; the UI can override both per request.
- **Model discovery:** `/models` queries the configured server, detects vision
  support from `architecture.input_modalities`, `capabilities.vision`, or
  `input_modalities`/`modalities`, and returns `vision: null` when the server
  does not report it. The UI shows unknown models as "vision unverified" rather
  than hiding them.
- **Connection probe:** `/test` sends a tiny 1×1 PNG and caps `max_tokens` so
  the user can validate the URL, key, model, and vision support before OCR.
- **Compatibility:** `chat_template_kwargs` is a llama.cpp/Qwen extension.
  Requests that get a 400 are retried once without `extra_body`.
- **Logging:** JSONL events record each page completion and its latency. The API
  key is never logged.

## Tests

`tests/test_llm.py` covers config parsing, vision detection, prompt forwarding,
the `extra_body` retry, blank-marker normalization, image validation, error
mapping, and the `/api/llm/*` endpoints.
