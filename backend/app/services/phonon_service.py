"""Phonon TTS service — the `ptts` runtime, streamed as WAV.

Phonon is a small Rust runtime with no PyTorch dependency. This module keeps
one lazily-loaded `ptts.TTS` instance per language, streams PCM as WAV for the
HTTP layer, and writes sentence-by-sentence WAV files for background jobs so
progress can be reported without waiting for the whole document.
"""

from __future__ import annotations

import hashlib
import json
import struct
import tempfile
import threading
import wave
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np

DEFAULT_LANGUAGE = "en"
DEFAULT_MODEL = "hf://gradium/phonon-31m-en"

_model: Any | None = None
_model_lock = threading.Lock()
_generation_lock = threading.Lock()
_catalog: list[dict[str, Any]] | None = None
_catalog_lock = threading.Lock()
_voice_lock = threading.Lock()

# Voice metadata (language, gender) obtained from the model developers.
# Used by the frontend to group voices as Language → Gender → Alphabetical.
_VOICE_META: list[dict] = []
try:
    _meta_path = Path(__file__).resolve().parents[2] / "data" / "phonon-voice-associations.json"
    if _meta_path.exists():
        with open(_meta_path) as _f:
            data = json.load(_f)
            _VOICE_META = data.get("voices", [])
except Exception:
    pass


def available() -> bool:
    """Return True when the optional `ptts` package can be imported."""
    try:
        import ptts  # noqa: F401

        return True
    except Exception:
        return False


def get_model() -> Any:
    """Return the lazily-loaded Phonon model, loading it on first use."""
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                import ptts

                _model = ptts.TTS(lang=DEFAULT_LANGUAGE, model=DEFAULT_MODEL)
    return _model


def reset_model() -> None:
    """Drop the loaded model (used by tests and engine restarts)."""
    global _model
    with _model_lock:
        _model = None


def _extract_gender(description: str) -> str | None:
    """Infer gender from a voice description.

    Common cues: young/girly/girl → female; adult/low/mature → male;
    neutral terms (confident, friendly, warm, etc.) → None.
    """
    low = description.lower()
    if any(w in low for w in ("girly", "young", "girl")):
        return "female"
    if any(w in low for w in ("adult", "low", "mature")):
        return "male"
    return None


def list_voices() -> list[dict[str, Any]]:
    """Return the English voices from the Phonon catalog.

    Loading the model is avoided here: the catalog alone is enough for the
    settings picker, and voices are downloaded only when first used.

    Each voice includes ``gender`` (inferred from descriptive cues) to
    enable client-side grouping by gender (Female/Male), then alphabetically.
    """
    global _catalog
    if _catalog is None:
        with _catalog_lock:
            if _catalog is None:
                try:
                    import ptts

                    voices = ptts.catalog_voices()
                except Exception:
                    voices = []
                _catalog = [
                    {
                        "name": str(v.get("name", "")),
                        "gender": _extract_gender(str(v.get("description", ""))),
                        "origin": v.get("description"),
                    }
                    for v in voices
                    if v.get("name") and v.get("language") in (None, DEFAULT_LANGUAGE)
                ]
    return list(_catalog)


def _wav_header(sample_rate: int) -> bytes:
    """Return a streaming WAV header with an intentionally open data size."""
    # Browsers accept an open-ended data chunk for chunked responses. The
    # sentinel matches the maximum unsigned 32-bit size used by streaming WAV
    # writers, rather than a bogus zero that makes players stop immediately.
    data_size = 0xFFFFFFFF
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF",
        data_size,
        b"WAVE",
        b"fmt ",
        16,
        1,  # PCM
        1,  # mono
        sample_rate,
        sample_rate * 2,
        2,
        16,
        b"data",
        data_size,
    )


def _pcm16(chunk: np.ndarray) -> bytes:
    """Convert a float32 PCM chunk to little-endian signed 16-bit bytes."""
    clipped = np.clip(np.asarray(chunk, dtype=np.float32), -1.0, 1.0)
    return (clipped * 32767.0).astype("<i2").tobytes()


def _register_voice_blob(model: Any, blob: bytes | None) -> tuple[str | None, Path | None]:
    """Register an uploaded Phonon voice file and return its name and temp path.

    The name is derived from the file hash and already-registered voices are
    reused. Streaming sends the same blob once per sentence, so registering a
    fresh name each time would leak a voice into the runtime per sentence.
    """
    if not blob:
        return None, None
    name = f"upload-{hashlib.sha256(blob).hexdigest()[:12]}"
    with _voice_lock:
        if name in model.voices:
            return name, None
        with tempfile.NamedTemporaryFile(
            prefix="phonon-voice-", suffix=".safetensors", delete=False
        ) as handle:
            handle.write(blob)
            tmp = Path(handle.name)
        try:
            model.add_voice(name, tmp)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    return name, tmp


def generate_stream_wav(
    text: str,
    voice: str | None = None,
    voice_blob: bytes | None = None,
) -> Iterator[bytes]:
    """Yield a streaming WAV for `text` as Phonon produces PCM chunks."""
    model = get_model()
    name, tmp = _register_voice_blob(model, voice_blob)
    try:
        with _generation_lock:
            yield _wav_header(int(model.sample_rate))
            with model.stream(text, voice=name or voice) as stream:
                for chunk in stream:
                    yield _pcm16(chunk)
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def split_sentences(text: str) -> list[str]:
    """Split text into sentence-sized synthesis units.

    The frontend already sends one speakable chunk per request. Jobs receive
    the joined chunks, so this split keeps progress meaningful and bounds each
    `ptts.synth` call. Text with no terminal punctuation stays one unit.
    """
    import re

    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return parts or ([text.strip()] if text.strip() else [])


def synthesize_to_wav(
    text: str,
    voice: str | None,
    path: Path,
    voice_blob: bytes | None = None,
    on_progress: Any | None = None,
    cancel_event: threading.Event | None = None,
) -> None:
    """Write `text` to a mono 16-bit WAV file, reporting sentence progress.

    The callback signature is `(done, total)`. `cancel_event` is checked
    between sentences so a cancelled job stops reasonably promptly.
    """
    model = get_model()
    name, tmp = _register_voice_blob(model, voice_blob)
    sentences = split_sentences(text)
    total = max(1, len(sentences))
    try:
        with _generation_lock, wave.open(str(path), "wb") as writer:
            writer.setnchannels(1)
            writer.setsampwidth(2)
            writer.setframerate(int(model.sample_rate))
            for i, sentence in enumerate(sentences, start=1):
                if cancel_event is not None and cancel_event.is_set():
                    raise RuntimeError("TTS job cancelled")
                pcm = model.synth(sentence, voice=name or voice)
                writer.writeframes(_pcm16(pcm))
                if on_progress is not None:
                    on_progress(i, total)
            if not sentences:
                # Keep a valid, empty WAV rather than failing the job.
                writer.writeframes(b"")
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
