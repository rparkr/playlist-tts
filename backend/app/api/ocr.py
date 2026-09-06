"""OCR endpoints — job + SSE + sync alias."""

import asyncio
import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.app.models.schemas import (
    JobStatus,
    OCRDirectResponse,
    OCRJobCreateResponse,
    OCRJobStatusResponse,
    PostprocessOptions,
)
from backend.app.services.ocr_service import create_ocr_job, get_job, sse_events

router = APIRouter(prefix="/api/ocr", tags=["ocr"])


def _parse_postprocess(raw: str | None) -> PostprocessOptions:
    """Parse postprocess JSON string from multipart form."""
    if not raw:
        return PostprocessOptions()
    try:
        return PostprocessOptions.model_validate_json(raw)
    except Exception:
        # Fallback: treat as already validated dict
        return PostprocessOptions.model_validate(json.loads(raw))


@router.post("/jobs", response_model=OCRJobCreateResponse, status_code=202)
async def create_job(
    file: UploadFile = File(...),
    postprocess: str | None = Form(None),
) -> OCRJobCreateResponse:
    """Create OCR job from uploaded PDF."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    opts = _parse_postprocess(postprocess)
    pdf_bytes = await file.read()

    # Enforce size limit (100 MB)
    from backend.app.core.config import settings

    max_bytes = settings.max_pdf_mb * 1024 * 1024
    if len(pdf_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"PDF exceeds {settings.max_pdf_mb} MB limit.")

    job_id = create_ocr_job(file.filename, pdf_bytes, opts)
    return OCRJobCreateResponse(job_id=job_id)


@router.get("/jobs/{job_id}", response_model=OCRJobStatusResponse)
async def job_status(job_id: str) -> OCRJobStatusResponse:
    """Return job status, progress, and result if done."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")

    return OCRJobStatusResponse(
        status=job.status,
        progress={"done": job.progress_done, "total": job.progress_total},
        result=job.result,
        error=job.error,
    )


@router.get("/jobs/{job_id}/events")
async def job_events(job_id: str) -> StreamingResponse:
    """SSE stream for job progress (progress, keepalive, done, error)."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")

    async def event_gen():
        async for event in sse_events(job_id):
            data = json.dumps(event)
            yield f"data: {data}\n\n"
            if event.get("type") in ("done", "error"):
                break
            await asyncio.sleep(0)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/jobs/{job_id}/markdown")
async def job_markdown(job_id: str) -> PlainTextResponse:
    """Download markdown result as text/markdown."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status != JobStatus.done or job.result is None:
        raise HTTPException(status_code=409, detail="Job not completed.")
    return PlainTextResponse(job.result["markdown"], media_type="text/markdown")


# ---------------------------------------------------------------------------
# Sync alias — POST /api/ocr (multipart PDF) → await job completion
# Used by the CLI and other single-shot clients.
# ---------------------------------------------------------------------------


@router.post("", response_model=OCRDirectResponse)
async def ocr_sync(
    file: UploadFile = File(...),
    postprocess: str | None = Form(None),
) -> OCRDirectResponse:
    """Synchronous OCR alias — creates job and polls until done (timeout 300s)."""
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")

    opts = _parse_postprocess(postprocess)
    pdf_bytes = await file.read()

    from backend.app.core.config import settings

    max_bytes = settings.max_pdf_mb * 1024 * 1024
    if len(pdf_bytes) > max_bytes:
        raise HTTPException(status_code=413, detail=f"PDF exceeds {settings.max_pdf_mb} MB limit.")

    job_id = create_ocr_job(file.filename, pdf_bytes, opts)

    # Poll until done
    for _ in range(300):
        await asyncio.sleep(1)
        job = get_job(job_id)
        if job is None:
            raise HTTPException(status_code=500, detail="Job disappeared.")
        if job.status == JobStatus.done and job.result is not None:
            return OCRDirectResponse.model_validate(job.result)
        if job.status == JobStatus.error:
            raise HTTPException(status_code=500, detail=job.error or "OCR failed.")

    raise HTTPException(status_code=504, detail="OCR timed out.")
