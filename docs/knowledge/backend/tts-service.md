---
type: system-component
title: TTS Service
description: Pocket-TTS streaming, file generation, and voice cloning with browser-persisted safetensors.
resource: backend/app/services/tts_service.py
tags: [backend, tts, pocket-tts, streaming, voice-cloning]
generated:
  by: muse-spark-1.2-contributor-free
  at: 2026-08-31T07:58:30Z
---

# TTS Service

## Model Singleton

```py
tts_model = TTSModel.load_model(quantize=True)  # warm at startup, ~10 s cold start
# 6× real-time CPU per  src/tts/__init__.py:1 notes; 4-6× per requirements
```

Expose `GET /api/tts/voices` → `list(_ORIGINS_OF_PREDEFINED_VOICES)` (`pocket_tts/utils/utils.py`).

## Endpoints

```
POST /api/tts/stream
  multipart: text: str (sentence-chunked markdown, already cleaned via clean_markdown_for_tts src/tts/__init__.py:27)
             voice_url?: str (builtin e.g. "alba") | voice_safetensors?: UploadFile (.safetensors blob)
             format?: "wav" (default) | "mp3" | "webm" (webm/opus preferred)
  → 200 StreamingResponse(audio/wav or audio/mpeg) Transfer-Encoding: chunked
     + optional X-Chunk-Index trailer; tee to temp file for download polling

POST /api/tts/jobs
  json: {markdown, voice_url|voice_safetensors_ref, output_name, postprocess{}}
  → 202 {jobId, status}
GET  /api/tts/jobs/{id}            → {status, progress:{done,total}, rtf}
GET  /api/tts/jobs/{id}/download   → 200 audio/*  (Range supported) or 206
POST /api/tts/jobs/{id}/cancel

POST /api/tts/voices/convert
  multipart: voice_wav: UploadFile (.wav/.mp3 ≤10 MB)  # no server persistence
  → 200 application/octet-stream  Content-Disposition: ...; filename="{name}.safetensors"
     + X-Voice-Bytes
```

Proxy alternative `TTS_PROXY_URL` → forward to `pocket_tts serve` sidecar (`pocket_tts/main.py:32` CORS); default is embedded.

## Streaming Details

Mirror `pocket_tts/main.py:63` `write_to_queue` + `generate_data_with_state`:

- Thread `tts_model.generate_audio_stream(model_state, text)` where `model_state = tts_model._cached_get_state_for_audio_prompt(voice_url)` or `_import_model_state(tmp_safetensors)` (`tts_model.py:1036`) for `voice_safetensors` bytes (write to `NamedTemporaryFile(suffix=".safetensors")`).
- `Queue` → `StreamingResponse(stream_audio_chunks(...))` (`pocket_tts/data/audio.py` `StreamingWAVWriter`).
- Chunking: `split_into_best_sentences(tokenizer, text, 50)` already inside `generate_audio_stream` (`tts_model.py:1015`); **do not** use `chunk_text_by_paragraphs` `src/tts/__init__.py:41`.
- Progress: streaming job estimates `buffered/totalChunks` locally; file job polls `done/total` from chunk loop.

**Pause/resume:** backend never pauses — `generate_audio_stream` runs to completion. Frontend `audio.pause()/AudioContext.suspend()` only; `fetch` continues buffering into `MediaSource SourceBuffer`; tee writes to `storage/{job}.wav` (or `pyav` muxer for mp3/webm). Seeking aborts and restarts from `sentenceIdx`.

## Voice Cloning

- Input: `voice_wav` → `NamedTemporaryFile` → `get_state_for_audio_prompt(Path, truncate=True)` — delegates 30 s truncate + mono 24 kHz `convert_audio` to pocket-tts per user revision (no custom resampling).
- Input: `.safetensors` blob from IndexedDB `voices` store (`IndexedDB voices: {id, name, blob, bytes, sourceWavName}`) — name defaults to wav basename without ext.
- Cache: `lru_cache(maxsize=2)` already in `tts_model.py:596` `_cached_get_state_for_audio_prompt`; disk cache optional for repeat `voice_url`.
- Client owns persistence; server stateless (Cloud Run friendly).

## Compression

- Default stream `audio/wav` (`pocket_tts/main.py:110`).
- Download `?format=webm` → `pyav` muxer `av.open(tmp, 'w', format='webm', codec='opus')` piping WAV chunks; `mp3` similarly `format='mp3'`. Guard `import av` so OCR-only deploy doesn't require it. Client `MediaRecorder` alternative is frontend-only fallback.

## Safety

- Rate-limit `/api/tts/stream`, limit upload 10 MB/30 s; `frames_after_eos` from `prepare_text_prompt` (`tts_model.py:1015`).

## CLI

`backend/app/cli/tts.py` `typer` `convert` `src/tts/__init__.py:66` now delegates to `tts_service`.
