"""LLM OCR endpoints — job + SSE + sync alias.

Same contract as the Docling `/api/ocr` endpoints but backed by the vision-LLM
engine (`llm_ocr_service`), which often extracts text Docling cannot. Kept as a
separate router so the Docling path is untouched.
"""

import asyncio
import json

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.app.api.ocr import _parse_postprocess, _validate_pdf_upload
from backend.app.models.schemas import (
    JobStatus,
    OCRDirectResponse,
    OCRJobCreateResponse,
    OCRJobStatusResponse,
)
from backend.app.services.llm_ocr_service import (
    LLM_SYNC_TIMEOUT_S,
    LLMConfig,
    create_llm_ocr_job,
    get_llm_job,
    llm_sse_events,
)

router = APIRouter(prefix="/api/ocr/llm", tags=["ocr-llm"])


def _config_from_form(raw: str | None) -> LLMConfig:
    """Parse optional LLM settings JSON from a multipart form field."""
    if not raw:
        return LLMConfig.from_env()
    try:
        data = json.loads(raw)
    except ValueError:
        data = {}
    if not isinstance(data, dict):
        data = {}
    raw_concurrency = data.get("concurrency")
    concurrency: int | None = None
    if raw_concurrency is not None:
        try:
            concurrency = int(raw_concurrency)
        except (TypeError, ValueError):
            concurrency = None
    return LLMConfig.from_env(
        base_url=data.get("base_url"),
        model=data.get("model"),
        concurrency=concurrency,
    )


@router.post("/jobs", response_model=OCRJobCreateResponse, status_code=202)
async def create_llm_job(
    file: UploadFile = File(...),
    postprocess: str | None = Form(None),
    llm: str | None = Form(None),
) -> OCRJobCreateResponse:
    """Create an LLM OCR job from an uploaded PDF."""
    opts = _parse_postprocess(postprocess)
    config = _config_from_form(llm)
    pdf_bytes = await file.read()

    _validate_pdf_upload(file, pdf_bytes)

    job_id = create_llm_ocr_job(file.filename or "upload.pdf", pdf_bytes, opts, config)
    return OCRJobCreateResponse(job_id=job_id)


@router.get("/jobs/{job_id}", response_model=OCRJobStatusResponse)
async def llm_job_status(job_id: str) -> OCRJobStatusResponse:
    """Return LLM job status, progress, and result if done."""
    job = get_llm_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")

    return OCRJobStatusResponse(
        status=job.status,
        progress={"done": job.progress_done, "total": job.progress_total},
        result=job.result,
        error=job.error,
    )


@router.get("/jobs/{job_id}/events")
async def llm_job_events(job_id: str) -> StreamingResponse:
    """SSE stream for LLM job progress (progress, keepalive, done, error)."""
    job = get_llm_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")

    async def event_gen():
        async for event in llm_sse_events(job_id):
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
async def llm_job_markdown(job_id: str) -> PlainTextResponse:
    """Download LLM markdown result as text/markdown."""
    job = get_llm_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found.")
    if job.status != JobStatus.done or job.result is None:
        raise HTTPException(status_code=409, detail="Job not completed.")
    return PlainTextResponse(job.result["markdown"], media_type="text/markdown")


@router.post("", response_model=OCRDirectResponse)
async def llm_ocr_sync(
    file: UploadFile = File(...),
    postprocess: str | None = Form(None),
    llm: str | None = Form(None),
) -> OCRDirectResponse:
    """Synchronous LLM OCR alias — creates job and polls until done."""
    opts = _parse_postprocess(postprocess)
    config = _config_from_form(llm)
    pdf_bytes = await file.read()

    _validate_pdf_upload(file, pdf_bytes)

    job_id = create_llm_ocr_job(file.filename or "upload.pdf", pdf_bytes, opts, config)

    for _ in range(LLM_SYNC_TIMEOUT_S):
        await asyncio.sleep(1)
        job = get_llm_job(job_id)
        if job is None:
            raise HTTPException(status_code=500, detail="Job disappeared.")
        if job.status == JobStatus.done and job.result is not None:
            return OCRDirectResponse.model_validate(job.result)
        if job.status == JobStatus.error:
            raise HTTPException(status_code=500, detail=job.error or "LLM OCR failed.")

    raise HTTPException(status_code=504, detail="LLM OCR timed out.")
