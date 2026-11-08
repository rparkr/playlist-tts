"""TTS service — engine selection, streaming, file jobs, and voice conversion.

Two server engines are available during the Phonon migration:

- `phonon`: the small Rust `ptts` runtime (preferred for new installs).
- `pocket`: the legacy PyTorch engine with local voice cloning.

The API sends the engine with each request; `pocket` remains the default for
older clients that do not send one.
"""

import asyncio
import importlib.util
import io
import json
import queue
import re
import tempfile
import threading
import time
import uuid
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.models.schemas import JobStatus
from backend.app.services import phonon_service

# Pocket TTS voice metadata (language, gender, type) from the model developers.
# Used by the frontend to group voices as Language → Dialect → Gender →
# Alphabetical. Keys are normalized so `bill_boerst` and "Bill Boerst" match.
_POCKET_VOICE_META: dict[str, dict] = {}
try:
    _pocket_meta_path = (
        Path(__file__).resolve().parents[2] / "data" / "pocket-tts-voice-associations.json"
    )
    if _pocket_meta_path.exists():
        with open(_pocket_meta_path) as _f:
            data = json.load(_f)
            _POCKET_VOICE_META = {
                re.sub(r"[^a-z0-9]+", "_", str(v["name"]).lower()).strip("_"): v
                for v in data.get("voices", [])
                if v.get("name")
            }
except Exception:
    pass


def _pocket_voice_key(name: str) -> str:
    """Normalize a Pocket voice name for metadata lookup."""
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")


TTS_ENGINES = ("pocket", "phonon")


@dataclass
class TTSJob:
    """Background TTS file generation job."""

    job_id: str
    status: JobStatus = JobStatus.queued
    engine: str = "pocket"
    voice: str | None = None
    progress_done: int = 0
    progress_total: int = 0
    error: str | None = None
    output_path: Path | None = None
    display_name: str = "output.wav"
    created_at: float = field(default_factory=time.time)


_tts_jobs: dict[str, TTSJob] = {}
_tts_model = None  # Lazy singleton


def get_tts_model():
    """Lazy-load TTSModel singleton (quantized)."""
    global _tts_model
    if _tts_model is None:
        from pocket_tts import TTSModel

        _tts_model = TTSModel.load_model(quantize=True)
    return _tts_model


def _check_engine(engine: str) -> str:
    """Validate and normalize an engine name."""
    if engine not in TTS_ENGINES:
        raise ValueError(f"Unknown TTS engine: {engine}")
    return engine


def engine_available(engine: str) -> bool:
    """Return whether `engine` can run in this process."""
    if engine == "phonon":
        return phonon_service.available()
    if engine == "pocket":
        # Keep `/engines` cheap: checking for the package must not import
        # PyTorch, which Pocket's package initializer loads eagerly.
        return importlib.util.find_spec("pocket_tts") is not None
    return False


def list_engines() -> list[dict]:
    """Return engine descriptors for the settings UI.

    Pocket's voice catalog is left out here because reading it imports
    PyTorch. The frontend fetches it from `/voices?engine=pocket` only when
    the user actually selects Pocket.
    """
    phonon_available = engine_available("phonon")
    return [
        {
            "id": "phonon",
            "label": "Phonon",
            "available": phonon_available,
            "voice_cloning": False,
            "voices": phonon_service.list_voices() if phonon_available else [],
        },
        {
            "id": "pocket",
            "label": "Pocket TTS (legacy)",
            "available": engine_available("pocket"),
            "voice_cloning": True,
            "voices": [],
        },
    ]


def list_voices(engine: str = "pocket") -> list[dict]:
    """Return the voice catalog for `engine`."""
    engine = _check_engine(engine)
    if engine == "phonon":
        return phonon_service.list_voices()
    try:
        from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES

        voices = []
        for name, origin in _ORIGINS_OF_PREDEFINED_VOICES.items():
            meta = _POCKET_VOICE_META.get(_pocket_voice_key(name), {})
            voices.append(
                {
                    "name": name,
                    "language": meta.get("language"),
                    "dialect": meta.get("dialect"),
                    "gender": meta.get("gender"),
                    "origin": origin,
                    "type": meta.get("type"),
                }
            )
        return voices
    except Exception:
        return [{"name": "alba"}, {"name": "marius"}]


def get_tts_job(job_id: str) -> TTSJob | None:
    """Retrieve TTS job by id."""
    return _tts_jobs.get(job_id)


def _estimate_total_chunks(text: str) -> int:
    """Rough chunk estimate for progress (sentence split)."""
    import re

    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", text) if s.strip()]
    return max(1, len(parts))


def convert_wav_to_safetensors(wav_bytes: bytes, filename: str) -> bytes:
    """Convert uploaded WAV bytes to safetensors bytes via pocket-tts.

    Delegates truncate/resample to pocket-tts (30s + mono 24kHz).
    """
    model = get_tts_model()
    suffix = Path(filename).suffix or ".wav"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_in:
        tmp_in.write(wav_bytes)
        tmp_in.flush()
        tmp_in_path = Path(tmp_in.name)
    try:
        state = model.get_state_for_audio_prompt(tmp_in_path, truncate=True)

        # Export to temp safetensors file then read bytes
        with tempfile.NamedTemporaryFile(delete=False, suffix=".safetensors") as tmp_out:
            tmp_out_path = tmp_out.name
        from pocket_tts.models.tts_model import export_model_state

        export_model_state(state, tmp_out_path)
        data = Path(tmp_out_path).read_bytes()
        Path(tmp_out_path).unlink(missing_ok=True)
        return data
    finally:
        tmp_in_path.unlink(missing_ok=True)


def _pocket_state(model, voice_url: str | None, voice_safetensors_bytes: bytes | None):
    """Resolve a Pocket voice state from a builtin name or safetensors blob."""
    if voice_safetensors_bytes is not None:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".safetensors") as tmp:
            tmp.write(voice_safetensors_bytes)
            tmp.flush()
            tmp_path = Path(tmp.name)
        try:
            return model.get_state_for_audio_prompt(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)
    if voice_url is not None:
        return model._cached_get_state_for_audio_prompt(voice_url)  # type: ignore[attr-defined]
    from pocket_tts.default_parameters import get_default_voice_for_language

    default_voice = get_default_voice_for_language(None)
    return model._cached_get_state_for_audio_prompt(default_voice)  # type: ignore[attr-defined]


def generate_stream(
    text: str,
    voice_url: str | None = None,
    voice_safetensors_bytes: bytes | None = None,
    engine: str = "pocket",
) -> Generator[bytes]:
    """Yield WAV bytes for streaming response (blocking generator).

    Voice handling: builtin name/url, or safetensors blob from IndexedDB.
    Mirrors pocket_tts/main.py write_to_queue pattern for Pocket and uses the
    native `ptts` stream for Phonon.
    """
    engine = _check_engine(engine)
    if engine == "phonon":
        yield from phonon_service.generate_stream_wav(
            text,
            voice=voice_url,
            voice_blob=voice_safetensors_bytes,
        )
        return

    model = get_tts_model()
    state = _pocket_state(model, voice_url, voice_safetensors_bytes)

    # Stream via pocket-tts internals — queue + thread like main.py
    from pocket_tts.data.audio import stream_audio_chunks

    q: queue.Queue[object] = queue.Queue()

    class QueueWriter(io.RawIOBase):
        def write(self, data) -> int:  # type: ignore[override]
            q.put(bytes(data))
            return len(data)

        def close(self) -> None:
            q.put(None)

    def _worker() -> None:
        try:
            chunks = model.generate_audio_stream(state, text)
            stream_audio_chunks(QueueWriter(), chunks, model.config.mimi.sample_rate)  # type: ignore[arg-type]
        except Exception as e:
            q.put(e)
            q.put(None)

    thread = threading.Thread(target=_worker, daemon=True)
    thread.start()

    while True:
        item = q.get()
        if item is None:
            break
        if isinstance(item, Exception):
            raise item
        assert isinstance(item, bytes)
        yield item

    thread.join()


def _display_filename(output_name: str | None, fmt: str) -> str:
    """Sanitize a client-provided name into a safe download filename.

    Strips directories, falls back to `output` when empty, and forces the
    extension to match the generated format so the name never lies about the
    container (e.g. `chapter.mp3` + `fmt="wav"` becomes `chapter.wav`).
    """
    stem = Path(output_name).stem.strip() if output_name else ""
    return f"{stem or 'output'}.{fmt}"


async def create_tts_file_job(
    text: str,
    voice_url: str | None,
    voice_safetensors_bytes: bytes | None,
    output_name: str | None = None,
    fmt: str = "wav",
    engine: str = "pocket",
) -> str:
    """Create background job that writes audio file to storage/{jobId}.wav."""
    engine = _check_engine(engine)
    if not engine_available(engine):
        raise RuntimeError(f"TTS engine is not available: {engine}")
    job_id = uuid.uuid4().hex[:12]
    job = TTSJob(
        job_id=job_id,
        engine=engine,
        voice=voice_url,
        progress_total=_estimate_total_chunks(text),
        display_name=_display_filename(output_name, fmt),
    )
    _tts_jobs[job_id] = job

    # Ensure storage dir
    from backend.app.core.config import settings

    settings.storage_dir.mkdir(parents=True, exist_ok=True)
    # Determine output path — always write wav; transcode after if fmt != wav
    wav_path = settings.storage_dir / f"{job_id}.wav"
    job.output_path = wav_path

    async def _run() -> None:
        job.status = JobStatus.running
        try:
            loop = asyncio.get_running_loop()

            # Stream synthesis directly to the storage WAV file.
            def _direct_to_file() -> None:
                if engine == "phonon":
                    phonon_service.synthesize_to_wav(
                        text,
                        voice=voice_url,
                        path=wav_path,
                        voice_blob=voice_safetensors_bytes,
                        on_progress=_set_job_progress,
                    )
                    return

                model = get_tts_model()
                state = _pocket_state(model, voice_url, voice_safetensors_bytes)
                from pocket_tts.data.audio import stream_audio_chunks

                chunks = model.generate_audio_stream(state, text)
                # stream_audio_chunks handles file path or file-like
                stream_audio_chunks(str(wav_path), chunks, model.config.mimi.sample_rate)

            def _set_job_progress(done: int, total: int) -> None:
                """Update job progress from the synthesis worker thread."""
                job.progress_done = done
                job.progress_total = max(1, total)

            await loop.run_in_executor(None, _direct_to_file)

            # Transcode if needed
            if fmt in ("mp3", "webm"):
                try:
                    import av  # type: ignore

                    # Transcode wav → fmt via pyav — simplified: read wav, write fmt
                    fmt_map = {"mp3": "mp3", "webm": "webm"}
                    out_path = settings.storage_dir / f"{job_id}.{fmt_map[fmt]}"
                    # Lazy transcode using pyav or fallback to copy wav
                    # For MVP, use av to read wav and write compressed
                    container_in = av.open(str(wav_path))
                    container_out = av.open(str(out_path), mode="w", format=fmt_map[fmt])
                    # Copy via re-encode — minimal: use passthrough if available
                    # Fallback if av fails, keep wav
                    stream_out = container_out.add_stream(
                        "libmp3lame" if fmt == "mp3" else "libopus", rate=24000
                    )
                    for frame in container_in.decode(audio=0):
                        for packet in stream_out.encode(frame):
                            container_out.mux(packet)
                    for packet in stream_out.encode():
                        container_out.mux(packet)
                    container_in.close()
                    container_out.close()
                    job.output_path = out_path
                except Exception:
                    # Keep the WAV when transcode fails, and make the download
                    # name tell the truth about the actual container.
                    job.display_name = _display_filename(output_name, "wav")

            job.progress_done = job.progress_total
            job.status = JobStatus.done
        except Exception as e:
            job.error = str(e)
            job.status = JobStatus.error

    asyncio.create_task(_run())
    return job_id
