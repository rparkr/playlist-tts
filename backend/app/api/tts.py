"""TTS endpoints — streaming, file jobs, voice conversion, catalog."""

from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse

from backend.app.models.schemas import (
    JobStatus,
    TTSJobCreateResponse,
    TTSJobStatusResponse,
    TTSVoicesResponse,
)
from backend.app.services.tts_service import (
    convert_wav_to_safetensors,
    create_tts_file_job,
    generate_stream,
    get_tts_job,
    list_voices,
)

router = APIRouter(prefix="/api/tts", tags=["tts"])


@router.get("/voices", response_model=TTSVoicesResponse)
async def get_voices() -> TTSVoicesResponse:
    """Return catalog of built-in voices."""
    voices = list_voices()
    return TTSVoicesResponse(voices=voices)


@router.post("/voices/convert")
async def convert_voice(
    voice_wav: Annotated[UploadFile, File(...)],
) -> StreamingResponse:
    """Convert uploaded WAV to safetensors (transient — browser persists)."""
    if not voice_wav.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")
    data = await voice_wav.read()
    if len(data) == 0:
        raise HTTPException(status_code=400, detail="Empty file.")
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="WAV exceeds 10 MB limit.")

    # Delegate truncation/resample to pocket-tts
    try:
        safetensors_bytes = convert_wav_to_safetensors(data, voice_wav.filename)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Voice conversion failed: {e}") from e

    base = Path(voice_wav.filename).stem or "voice"
    return StreamingResponse(
        iter([safetensors_bytes]),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{base}.safetensors"',
            "X-Voice-Bytes": str(len(safetensors_bytes)),
        },
    )


@router.post("/stream")
async def tts_stream(
    request: Request,
    text: Annotated[str, Form()] = "",
    voice_url: Annotated[str | None, Form()] = None,
    voice_safetensors: Annotated[UploadFile | None, File()] = None,
) -> StreamingResponse:
    """Stream WAV audio for given text (chunked).

    The frontend sends one sentence (or a few) at a time so synthesis starts
    fast and seeking/pause does not re-process the whole document. Stop
    iterating (and free the worker) as soon as the client disconnects, e.g.
    after a seek to a different sentence.
    """
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    if voice_url and voice_safetensors:
        raise HTTPException(
            status_code=400, detail="Provide voice_url or voice_safetensors, not both."
        )

    safetensors_bytes: bytes | None = None
    if voice_safetensors is not None:
        safetensors_bytes = await voice_safetensors.read()
        if len(safetensors_bytes) == 0:
            raise HTTPException(status_code=400, detail="Empty safetensors file.")

    async def wav_gen():
        import asyncio

        loop = asyncio.get_running_loop()
        # Run the blocking pocket-tts generator in a worker thread and pump
        # its chunks back to the event loop, so disconnect checks still run.
        gen = generate_stream(text, voice_url, safetensors_bytes)
        while True:
            chunk = await loop.run_in_executor(None, lambda: next(gen, None))
            if chunk is None:
                break
            if await request.is_disconnected():
                break
            yield chunk

    return StreamingResponse(
        wav_gen(),
        media_type="audio/wav",
        headers={
            "Content-Disposition": 'attachment; filename="generated.wav"',
            "Transfer-Encoding": "chunked",
        },
    )


@router.post("/jobs", response_model=TTSJobCreateResponse, status_code=202)
async def create_job(
    text: Annotated[str, Form()] = "",
    voice_url: Annotated[str | None, Form()] = None,
    voice_safetensors: Annotated[UploadFile | None, File()] = None,
    fmt: Annotated[str, Form()] = "wav",
    output_name: Annotated[str | None, Form()] = None,
) -> TTSJobCreateResponse:
    """Create background file generation job (save for later)."""
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")
    if fmt not in ("wav", "mp3", "webm"):
        raise HTTPException(status_code=400, detail="fmt must be wav, mp3, or webm.")
    if voice_url and voice_safetensors:
        raise HTTPException(
            status_code=400, detail="Provide voice_url or voice_safetensors, not both."
        )

    safetensors_bytes: bytes | None = None
    if voice_safetensors is not None:
        safetensors_bytes = await voice_safetensors.read()

    job_id = await create_tts_file_job(
        text=text,
        voice_url=voice_url,
        voice_safetensors_bytes=safetensors_bytes,
        output_name=output_name,
        fmt=fmt,
    )
    return TTSJobCreateResponse(job_id=job_id)


@router.get("/jobs/{job_id}", response_model=TTSJobStatusResponse)
async def job_status(job_id: str) -> TTSJobStatusResponse:
    """Return TTS file job status."""
    job = get_tts_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    return TTSJobStatusResponse(
        status=job.status,
        progress={"done": job.progress_done, "total": job.progress_total},
        error=job.error,
        output=job.display_name if job.status == JobStatus.done else None,
    )


@router.get("/jobs/{job_id}/download")
async def job_download(job_id: str):
    """Download generated audio file (supports Range via FileResponse)."""
    from fastapi.responses import FileResponse

    job = get_tts_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status.value != "done" or job.output_path is None or not job.output_path.exists():
        raise HTTPException(status_code=409, detail="Job not completed.")
    return FileResponse(
        path=str(job.output_path),
        media_type="audio/wav"
        if job.output_path.suffix == ".wav"
        else f"audio/{job.output_path.suffix.lstrip('.')}",
        filename=job.display_name,
    )


@router.post("/jobs/{job_id}/cancel")
async def job_cancel(job_id: str) -> dict[str, str]:
    """Cancel job (best-effort — removes from registry and deletes file)."""
    job = get_tts_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    # For MVP, just mark error and delete file
    try:
        if job.output_path and job.output_path.exists():
            job.output_path.unlink()
    except Exception:
        pass
    job.error = "cancelled"
    job.status = JobStatus.error
    return {"status": "cancelled"}
