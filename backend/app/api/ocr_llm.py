"""LLM OCR endpoints — job + SSE + sync alias.

Same contract as the Docling `/api/ocr` endpoints but backed by the vision-LLM
engine (`llm_ocr_service`), which often extracts text Docling cannot. Kept as a
separate router so the Docling path is untouched.
"""

import asyncio
import json
import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse, StreamingResponse

from backend.app.api.ocr import _parse_postprocess, _validate_pdf_upload
from backend.app.models.schemas import (
    JobStatus,
    LLMModelInfo,
    LLMModelsRequest,
    LLMModelsResponse,
    LLMOcrConfig,
    LLMOcrDefaults,
    LLMTestResponse,
    OCRDirectResponse,
    OCRJobCreateResponse,
    OCRJobStatusResponse,
)
from backend.app.services.llm_ocr_service import (
    LLM_SYNC_TIMEOUT_S,
    LLMConfig,
    create_llm_client,
    create_llm_ocr_job,
    get_llm_job,
    llm_sse_events,
    model_supports_vision,
    probe_llm,
)

router = APIRouter(prefix="/api/ocr/llm", tags=["ocr-llm"])


def _config_from_payload(payload: LLMOcrConfig) -> LLMConfig:
    """Map a validated settings payload to the service config."""
    return LLMConfig.from_env(
        base_url=payload.base_url,
        model=payload.model,
        api_key=payload.api_key.get_secret_value() if payload.api_key else None,
        system_message=payload.system_message,
        user_message=payload.user_message,
        enable_thinking=payload.enable_thinking,
        concurrency=payload.concurrency,
    )


def _config_from_form(raw: str | None) -> LLMConfig:
    """Parse optional LLM settings JSON from a multipart form field."""
    if not raw:
        return LLMConfig.from_env()
    try:
        payload = LLMOcrConfig.model_validate_json(raw)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"Invalid LLM settings: {e}") from e
    return _config_from_payload(payload)


def _llm_error_detail(exc: Exception, config: LLMConfig) -> str:
    """Return a user-facing LLM error without leaking the API key."""
    status = getattr(exc, "status_code", None)
    message = str(exc).strip() or exc.__class__.__name__
    if status == 401:
        detail = "Authentication failed (401). Check the API key."
    elif status == 404:
        detail = "The LLM server returned 404. Check the base URL (include /v1) and the model name."
    elif status == 429:
        detail = "The LLM server is rate-limiting requests (429). Try again shortly."
    elif status is not None:
        detail = f"LLM server error {status}: {message}"
    elif isinstance(exc, TimeoutError) or "timeout" in exc.__class__.__name__.lower():
        detail = f"The LLM server at {config.base_url} timed out."
    else:
        detail = f"Could not reach the LLM server at {config.base_url}: {message}"
    if config.api_key and len(config.api_key) >= 4:
        detail = detail.replace(config.api_key, "***")
    return detail[:1000]


@router.get("/options", response_model=LLMOcrDefaults)
async def llm_options() -> LLMOcrDefaults:
    """Return server-side LLM OCR defaults for the settings UI."""
    config = LLMConfig.from_env()
    return LLMOcrDefaults(
        base_url=config.base_url,
        model=config.model,
        system_message=config.system_message,
        user_message=config.user_message,
        concurrency=config.concurrency,
        enable_thinking=config.enable_thinking,
    )


@router.post("/models", response_model=LLMModelsResponse)
async def list_llm_models(payload: LLMModelsRequest) -> LLMModelsResponse:
    """List models from an OpenAI-compatible server, with vision hints.

    Vision capability is reported only when the server exposes it; models
    without metadata get `vision: null` so the UI can show "unverified"
    instead of hiding them.
    """
    config = LLMConfig.from_env(
        base_url=payload.base_url,
        api_key=payload.api_key.get_secret_value() if payload.api_key else None,
    )
    client = create_llm_client(config.base_url, config.api_key)
    try:
        page = await client.models.list(timeout=10.0)
    except Exception as e:
        raise HTTPException(status_code=502, detail=_llm_error_detail(e, config)) from e

    models: list[LLMModelInfo] = []
    for model in page.data:
        data = model.model_dump() if hasattr(model, "model_dump") else {}
        models.append(
            LLMModelInfo(
                id=model.id,
                name=data.get("name") or None,
                vision=model_supports_vision(data),
            )
        )
    models.sort(key=lambda m: m.id.lower())
    return LLMModelsResponse(base_url=config.base_url, models=models)


@router.post("/test", response_model=LLMTestResponse)
async def test_llm_connection(payload: LLMOcrConfig) -> LLMTestResponse:
    """Probe the configured server/model with a tiny image."""
    config = _config_from_payload(payload)
    started = time.monotonic()
    try:
        await probe_llm(config)
    except Exception as e:
        raise HTTPException(status_code=502, detail=_llm_error_detail(e, config)) from e
    elapsed_ms = int((time.monotonic() - started) * 1000)
    return LLMTestResponse(ok=True, model=config.model, latency_ms=elapsed_ms)


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
