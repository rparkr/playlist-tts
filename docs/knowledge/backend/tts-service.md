---
type: system-component
title: TTS Service
description: Engine-selected speech synthesis with Phonon streaming, Pocket legacy cloning, file jobs, and an in-browser WASM adapter.
resource: backend/app/services/tts_service.py
tags: [backend, frontend, tts, phonon, pocket-tts, streaming, voice-cloning, wasm]
generated:
  by: deepseek-v4.1-flash-free/1
  at: 2026-11-06T00:00:00Z
---

# TTS Service

## Engines

The frontend selects an engine per request. Device `SpeechSynthesis` never reaches the backend.

| Engine | Runs in | Status | Voice files |
|---|---|---|---|
| `device` | Browser `speechSynthesis` | Default | No (device voices only) |
| `phonon` | Backend `ptts` (Rust) | Preferred server engine | Precomputed `.safetensors` (e.g. Gradium Studio) |
| `phonon-browser` | Browser WASM worker | Opt-in, downloads once | Same Phonon `.safetensors` files |
| `pocket` | Backend PyTorch | Legacy, kept for cloned voices | Pocket `.safetensors` or audio upload |

`GET /api/tts/engines` reports availability and catalogues; older clients that send no engine are
still served by Pocket. The default stays `device` until Phonon is validated on the target devices.

## Backend services

`backend/app/services/tts_service.py` owns job state, engine validation, and the Pocket path.
`backend/app/services/phonon_service.py` wraps the `ptts` runtime:

```py
tts = ptts.TTS(lang="en", model="hf://gradium/phonon-31m-en")
pcm = tts.synth(sentence, voice="Zoey")     # 24 kHz float32
with tts.stream(text, voice="Zoey") as stream:
    for chunk in stream: ...
```

- The model is a lazy singleton behind a lock.
- `_generation_lock` serializes `ptts` requests because one runtime generates one stream at a time.
- Voices come from `ptts.catalog_voices()`; only English entries are exposed. A voice file is
  downloaded on first use and cached by the runtime.
- Catalog rows carry `language` (e.g. `English`), `dialect` (e.g. `US English`,
  `British English`, `Character voices`), and `gender`. The small
  `backend/data/phonon-voice-associations.json` mapping supplies the fields that
  `ptts.catalog_voices()` omits; the picker groups them as
  Language → Dialect → Gender → Alphabetical.
- Uploaded `.safetensors` voices are registered with `add_voice` under a content-hash name,
  reused across the per-sentence requests of one stream, and their temp file is deleted after
  the request. The runtime keeps the loaded embedding.
- `/engines` deliberately omits Pocket's voice list: importing it loads PyTorch. The frontend
  calls `/voices?engine=pocket` when Pocket is selected. Pocket rows use the same
  language/dialect/gender fields, sourced from
  `backend/data/pocket-tts-voice-associations.json`.
- The stream response starts with a WAV header whose data size is the open-ended `0xFFFFFFFF`
  sentinel, so the browser can play chunked PCM before the total length is known.
- File jobs split the text at sentence boundaries, call `synth` per sentence, and report
  `(done, total)` progress between sentences.

## Endpoints

```
GET  /api/tts/engines          → {engines:[{id,label,available,voice_cloning,voices[]}]}
GET  /api/tts/voices?engine=   → {voices:[{name,language,dialect,gender,origin,...}]}   # default engine=pocket
POST /api/tts/voices/convert   → safetensors bytes (Pocket voice encoder; audio upload)

POST /api/tts/stream           multipart:
  text: str
  engine?: "pocket"|"phonon"   # default pocket for old clients
  voice?: str                  # catalog voice name
  voice_safetensors?: UploadFile
  → 200 StreamingResponse(audio/wav, chunked)

POST /api/tts/jobs             multipart:
  text, engine, voice, fmt (wav|mp3|webm), output_name
  → 202 {job_id}
GET  /api/tts/jobs/{id}        → {status, progress:{done,total}, engine, voice, output, error}
GET  /api/tts/jobs/{id}/download
POST /api/tts/jobs/{id}/cancel
```

Unknown engine names return `400`. A requested engine that is not installed returns `503` when a
job is created. The streaming endpoint validates before loading a model.

## Frontend playback

`frontend/src/lib/tts/backendSentencePlayer.ts` requests one sentence at a time and prefetches the
next. It accepts an injected `FetchAudioFn`, so server and browser engines share pause, resume,
seek, cache, ETA, and media-session behaviour.

- `backendStream.ts` posts to `/api/tts/stream` and `/api/tts/jobs`, forwarding the engine and
  returning a WAV blob URL.
- `phononBrowser.ts` lazy-loads `phonon-tts` on first use (`q8`, `device: 'auto'`, `threads: 'auto'`,
  `cache: true`), registers catalog voices with `addVoice`, synthesizes one sentence, and returns
  a WAV object URL. Custom Phonon voice files are registered from the IndexedDB blob under their
  stable custom-voice ID.
- Browser model status (download progress, WebGPU/CPU, thread count, failure reason) is exposed to
  the settings modal through `subscribePhononStatus`.
- Voice pickers group Device, Pocket, and Phonon entries by language → dialect → gender →
  alphabetically. Device locales are mapped (`en-US` → English / US English) in `settings.ts`.
- Stored clone records are tagged `engine: 'pocket' | 'phonon'`; untagged legacy records are
  treated as Pocket. The picker only shows clones whose format matches the selected engine.

### Browser model constraints

- The package supports only Phonon 31M from Hugging Face. The 40M models are gated and
  CC BY-NC.
- First load downloads roughly 65 MB (q8 weights, tokenizer, config, default voice) plus the
  package's WASM runtime. The Cache API keeps it across visits.
- Multi-threaded WASM requires cross-origin isolation (`COOP: same-origin` and
  `COEP: require-corp`). The app does not send those headers because they can block remote
  Markdown images, so the runtime falls back to one CPU thread. `threads: 'auto'` still gives
  three threads on an isolated deployment, and WebGPU needs no isolation.
- The Cache API and WASM threads need a secure context (`https` or `localhost`). Plain HTTP on a
  LAN address may re-download the model and stays single-threaded.
- Voice cloning from an audio sample is not in the browser build.

## Offline chapter audio

Pre-generated files use the server (`phonon`, or `pocket` when that engine is selected). The
IndexedDB key is `docId::engine::voiceKey::fmt` so Pocket and Phonon files with the same voice name
cannot collide. Database version 9 rewrites pre-existing records as `engine: "pocket"`.

`generateOfflineAudioBlob` polls `POST /api/tts/jobs` until done, then downloads the file. The
playlist UI resolves the same engine/voice key when showing, playing, or deleting a file.

## Voice-file compatibility

Pocket and Phonon `.safetensors` files are **not** interchangeable:

- Pocket's `export-voice` writes a full transformer KV-cache state dictionary
  (`transformer.layers.*.self_attn/cache` plus `offset` tensors).
- Phonon's `add_voice` expects a precomputed speaker embedding (`speaker_wavs`, shape
  `[1, 512, T]`, or an `emb` tensor). The 31M English checkpoint reports
  `supports_voice_cloning == False`, so Phonon cannot convert an audio recording directly; use a
  Gradium Studio voice file instead.
- Loading a Pocket file with `ptts.add_voice` fails with a tensor-shape error, and Phonon files
  do not satisfy Pocket's state loader. The frontend inspects the safetensors header before
  saving (`frontend/src/lib/tts/voiceFile.ts`) and explains the mismatch.

`convert_wav_to_safetensors` still uses Pocket's voice encoder (`get_state_for_audio_prompt` with
`truncate=True`), and `_pocket_state` resolves cloned or built-in voices for streaming and jobs.
Keep this path until cloned voices have a replacement, then remove `pocket-tts`; PyTorch remains a
dependency of the Pocket and Phonon speech runtimes.
