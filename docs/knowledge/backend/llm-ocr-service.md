---
type: system-component
title: LLM OCR Service
description: Vision-LLM OCR over pypdf page images with per-job credentials, model discovery, editable prompts, and real per-page progress.
resource: backend/app/services/llm_ocr_service.py
tags: [backend, ocr, llm, vision, openai-compatible]
generated:
  by: opencode
  at: 2026-11-11T00:00:00Z
---

# LLM OCR Service

## Contract

```
POST /api/ocr/llm/jobs
  multipart: file: UploadFile (.pdf)
             postprocess: JSON PostprocessOptions
             llm: JSON LLMOcrConfig
  → 202 {job_id}

GET  /api/ocr/llm/jobs/{id}          → {status, progress, result?, error?}
GET  /api/ocr/llm/jobs/{id}/events   → SSE progress/keepalive/done/error
GET  /api/ocr/llm/jobs/{id}/markdown → text/markdown
POST /api/ocr/llm                    → synchronous alias

GET  /api/ocr/llm/options            → {base_url, model, system_message,
                                         user_message, concurrency, enable_thinking}
POST /api/ocr/llm/models             → {base_url, models: [{id, name?, vision?}]}
POST /api/ocr/llm/test               → {ok, model, latency_ms}
```

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

## Implementation

- **Per-page routing:** pages with embedded images go to the vision LLM; pages
  without images use `pypdf` text extraction; pages with neither yield an empty
  string. Page numbering stays aligned with the PDF.
- **Credentials:** `create_llm_client(base_url, api_key)` passes the key to the
  OpenAI-compatible server; empty keys use a local placeholder. `LLMConfig`
  keeps the key out of `repr()`.
- **Prompts:** `LLMConfig.from_env()` resolves `LLM_OCR_SYSTEM_MESSAGE` and
  `LLM_OCR_USER_MESSAGE`; the UI can override both per job.
- **Model discovery:** `/models` queries the configured server, detects vision
  support from `architecture.input_modalities`, `capabilities.vision`, or
  `input_modalities`/`modalities`, and returns `vision: null` when the server
  does not report it. The UI shows unknown models as "vision unverified" rather
  than hiding them.
- **Connection probe:** `/test` sends a tiny 1×1 PNG and caps `max_tokens` so
  the user can validate the URL, key, model, and vision support before a long
  OCR run.
- **Compatibility:** `chat_template_kwargs` is a llama.cpp/Qwen extension.
  Requests that get a 400 are retried once without `extra_body`.
- **Concurrency:** a semaphore caps in-flight page requests (default 2) to bound
  client memory and server-side queued multimodal contexts.
- **Logging:** JSONL events record extraction, per-page completion, and a
  summary. The API key is never logged.

## Tests

- `tests/test_llm_ocr.py` covers page ordering, failure containment, concurrency,
  marker alignment, config parsing, model listing/vision detection, the
  connection probe, prompt forwarding, and the `extra_body` retry.
