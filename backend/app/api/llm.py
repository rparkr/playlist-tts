"""Stateless LLM endpoints — connection settings plus one-page OCR.

`POST /api/llm/ocr` accepts a single page image rendered by the browser and
returns its Markdown. There is no job registry, PDF upload, or server-side
Markdown processing.
"""

import time

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from backend.app.models.schemas import (
    LLMModelInfo,
    LLMModelsRequest,
    LLMModelsResponse,
    LLMOcrConfig,
    LLMOcrDefaults,
    LLMPageOcrResponse,
    LLMTestResponse,
)
from backend.app.services.llm_logging import configure_llm_logging
from backend.app.services.llm_service import (
    LLMConfig,
    create_llm_client,
    model_supports_vision,
    ocr_page_image,
    probe_llm,
)

router = APIRouter(prefix="/api/llm", tags=["llm"])

#: Upper bound for one rendered page image. A 300-DPI Letter page as PNG is
#: comfortably below this; anything larger is a client bug or abuse.
MAX_IMAGE_BYTES: int = 25 * 1024 * 1024


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


def _guess_image_mime(data: bytes) -> str | None:
    """Resolve an image MIME type from its magic bytes.

    The upload header is not trusted: mobile clients often send
    `application/octet-stream`, and a mislabelled body must not reach the
    vision model as a broken data URL.
    """
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return None


@router.get("/options", response_model=LLMOcrDefaults)
async def llm_options() -> LLMOcrDefaults:
    """Return server-side LLM defaults for the settings UI."""
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


@router.post("/ocr", response_model=LLMPageOcrResponse)
async def ocr_page(
    image: UploadFile = File(...),
    page: int = Form(..., ge=1),
    llm: str | None = Form(None),
) -> LLMPageOcrResponse:
    """OCR one rendered page image and return its Markdown.

    Args:
        image: page raster, PNG/JPEG/WebP/GIF.
        page: 1-indexed physical PDF page number, echoed back for merging.
        llm: optional JSON-encoded `LLMOcrConfig` overrides.

    Returns:
        `{page, markdown}` with blank pages as an empty string.
    """
    config = _config_from_form(llm)

    if image.size is not None and image.size > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Page image is too large (max 25 MB).")

    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty page image.")
    if len(data) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Page image is too large (max 25 MB).")

    mime_type = _guess_image_mime(data)
    if mime_type is None:
        raise HTTPException(
            status_code=400,
            detail="Unsupported image type. Use PNG, JPEG, WebP, or GIF.",
        )

    configure_llm_logging()
    try:
        markdown = await ocr_page_image(data, mime_type, config, page=page)
    except Exception as e:
        raise HTTPException(status_code=502, detail=_llm_error_detail(e, config)) from e

    return LLMPageOcrResponse(page=page, markdown=markdown)
