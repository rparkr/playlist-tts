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


def _is_pdf_upload(filename: str | None, content_type: str | None, pdf_bytes: bytes) -> bool:
    """Check whether an upload looks like a PDF.

    Accept if *any* signal matches, so valid PDFs with missing/odd
    filenames (e.g. `blob`, extensionless mobile shares) are not rejected:
    - `.pdf` filename extension, or
    - `application/pdf` content type, or
    - `%PDF-` magic bytes at the start of the file.
    """
    if filename and filename.lower().endswith(".pdf"):
        return True
    if content_type and content_type.lower().split(";")[0].strip() == "application/pdf":
        return True
    # Strip leading whitespace/BOM — PDFs must start with %PDF-
    stripped = pdf_bytes.lstrip(b"\x00 \t\r\n\xef\xbb\xbf")
    return bool(stripped.startswith(b"%PDF-"))


def _validate_pdf_upload(file: UploadFile, pdf_bytes: bytes) -> None:
    """Raise 400 unless the upload is recognizably a PDF."""
    if not _is_pdf_upload(file.filename, file.content_type, pdf_bytes):
        raise HTTPException(status_code=400, detail="Only PDF files are supported.")


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
    opts = _parse_postprocess(postprocess)
    pdf_bytes = await file.read()

    _validate_pdf_upload(file, pdf_bytes)

    job_id = create_ocr_job(file.filename or "upload.pdf", pdf_bytes, opts)
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
    opts = _parse_postprocess(postprocess)
    pdf_bytes = await file.read()

    _validate_pdf_upload(file, pdf_bytes)

    job_id = create_ocr_job(file.filename or "upload.pdf", pdf_bytes, opts)

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
