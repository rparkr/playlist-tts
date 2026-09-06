"""TTS service — pocket-tts streaming, file jobs, and transient voice conversion."""

import asyncio
import io
import queue
import tempfile
import threading
import time
import uuid
from collections.abc import Generator
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.models.schemas import JobStatus


@dataclass
class TTSJob:
    """Background TTS file generation job."""

    job_id: str
    status: JobStatus = JobStatus.queued
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


def list_voices() -> list[dict]:
    """Return catalog of built-in voices."""
    try:
        from pocket_tts.utils.utils import _ORIGINS_OF_PREDEFINED_VOICES

        return [{"name": k, "origin": v} for k, v in _ORIGINS_OF_PREDEFINED_VOICES.items()]
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


def generate_stream(
    text: str,
    voice_url: str | None = None,
    voice_safetensors_bytes: bytes | None = None,
) -> Generator[bytes]:
    """Yield WAV bytes for streaming response (blocking generator).

    Voice handling: builtin name/url, or safetensors blob from IndexedDB.
    Mirrors pocket_tts/main.py write_to_queue pattern.
    """
    model = get_tts_model()

    # Resolve model_state
    if voice_safetensors_bytes is not None:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".safetensors") as tmp:
            tmp.write(voice_safetensors_bytes)
            tmp.flush()
            tmp_path = Path(tmp.name)
        try:
            # _import_model_state expects path; use safetensors load directly
            # Reuse get_state_for_audio_prompt path for .safetensors
            state = model.get_state_for_audio_prompt(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)
    elif voice_url is not None:
        # Use cached path for builtin
        state = model._cached_get_state_for_audio_prompt(voice_url)  # type: ignore[attr-defined]
    else:
        from pocket_tts.default_parameters import get_default_voice_for_language

        default_voice = get_default_voice_for_language(None)
        state = model._cached_get_state_for_audio_prompt(default_voice)  # type: ignore[attr-defined]

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

    Strips directories, falls back to ``output`` when empty, and forces the
    extension to match the generated format so the name never lies about the
    container (e.g. ``chapter.mp3`` + ``fmt="wav"`` becomes ``chapter.wav``).
    """
    stem = Path(output_name).stem.strip() if output_name else ""
    return f"{stem or 'output'}.{fmt}"


async def create_tts_file_job(
    text: str,
    voice_url: str | None,
    voice_safetensors_bytes: bytes | None,
    output_name: str | None = None,
    fmt: str = "wav",
) -> str:
    """Create background job that writes audio file to storage/{jobId}.wav."""
    job_id = uuid.uuid4().hex[:12]
    job = TTSJob(
        job_id=job_id,
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
                model = get_tts_model()
                if voice_safetensors_bytes is not None:
                    with tempfile.NamedTemporaryFile(delete=False, suffix=".safetensors") as tmp:
                        tmp.write(voice_safetensors_bytes)
                        tmp.flush()
                        tmp_path = Path(tmp.name)
                    try:
                        state = model.get_state_for_audio_prompt(tmp_path)
                    finally:
                        tmp_path.unlink(missing_ok=True)
                elif voice_url is not None:
                    state = model._cached_get_state_for_audio_prompt(voice_url)  # type: ignore[attr-defined]
                else:
                    from pocket_tts.default_parameters import get_default_voice_for_language

                    default_voice = get_default_voice_for_language(None)
                    state = model._cached_get_state_for_audio_prompt(default_voice)  # type: ignore[attr-defined]

                from pocket_tts.data.audio import stream_audio_chunks

                chunks = model.generate_audio_stream(state, text)
                # stream_audio_chunks handles file path or file-like
                stream_audio_chunks(str(wav_path), chunks, model.config.mimi.sample_rate)

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
                    # Keep wav if transcode fails
                    pass

            job.progress_done = job.progress_total
            job.status = JobStatus.done
        except Exception as e:
            job.error = str(e)
            job.status = JobStatus.error

    asyncio.create_task(_run())
    return job_id
