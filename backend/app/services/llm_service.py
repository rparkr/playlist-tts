"""Stateless vision-LLM proxy for OCR-ing a single page image.

The browser extracts text and renders pages; this module only owns the
OpenAI-compatible call that turns one page image into Markdown. There is no
job registry, no PDF handling, and no server-side post-processing.
"""

from __future__ import annotations

import base64
import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from backend.app.services.llm_logging import log_llm_event

if TYPE_CHECKING:
    from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

# llama.cpp default port, as of Oct. 2026
DEFAULT_BASE_URL: str = "http://127.0.0.1:9931/v1"
DEFAULT_MODEL: str = "qwen3.5-4b"
DEFAULT_SYSTEM_MESSAGE: str = (
    "Extract text from the page in reading order. Do not include any preamble like: "
    '"Here\'s the extracted text:"; instead, begin directly with the text from the page.'
)
DEFAULT_USER_MESSAGE: str = (
    "Please extract all the English text from this page in reading order. "
    "When extracting text, include handwritten script as well as typed. "
    "Keep paragraphs together. For paragraphs that continue on the next column, keep "
    "the continuation with the paragraph it started in so the paragraph stays together. "
    "Collapse hyphenated word breaks at the end of lines, merging the word segments "
    "together.\n\n"
    "If there is no text to extract, say `<no text found>`."
)

#: Marker the prompt asks the model to return for blank pages.
NO_TEXT_MARKER: str = "<no text found>"

#: Placeholder key for OpenAI-compatible servers that do not require auth.
NO_API_KEY: str = "local-no-key-required"

#: Tiny 1x1 transparent PNG used by the "test connection" probe. It is enough
#: for a vision-capable model to accept the multimodal request without paying
#: for a meaningful image.
TEST_IMAGE_PNG: bytes = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII="
)


def _bool(raw: str | None, default: bool) -> bool:
    """Parse a boolean environment value (`1/true/yes/on`)."""
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


@dataclass
class LLMConfig:
    """LLM connection, prompt, and client-concurrency settings."""

    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    #: API key for OpenAI-compatible servers. Empty means "no auth required"
    #: (llama.cpp and other local servers). Kept out of `repr()` so it cannot
    #: leak through logs or tracebacks.
    api_key: str = field(default="", repr=False)
    system_message: str = DEFAULT_SYSTEM_MESSAGE
    user_message: str = DEFAULT_USER_MESSAGE
    enable_thinking: bool = False
    #: Suggested number of in-flight page requests for the browser client.
    #: Defaults to 2, which bounds client memory and server-side queued
    #: multimodal contexts. 0 means unbounded.
    concurrency: int = 2

    @classmethod
    def from_env(
        cls,
        base_url: str | None = None,
        model: str | None = None,
        api_key: str | None = None,
        system_message: str | None = None,
        user_message: str | None = None,
        enable_thinking: bool | None = None,
        concurrency: int | None = None,
    ) -> LLMConfig:
        """Build config from explicit values with environment fallback.

        Empty strings are treated as "not provided" so the UI can send `null`
        or `""` to mean "use the server default".
        """

        def _int(raw: str | None, default: int) -> int:
            try:
                return int(raw) if raw is not None else default
            except ValueError:
                return default

        return cls(
            base_url=(base_url or os.getenv("LLM_OCR_BASE_URL", DEFAULT_BASE_URL)).rstrip("/"),
            model=model or os.getenv("LLM_OCR_MODEL", DEFAULT_MODEL),
            api_key=api_key or os.getenv("LLM_OCR_API_KEY", ""),
            system_message=(
                system_message or os.getenv("LLM_OCR_SYSTEM_MESSAGE") or DEFAULT_SYSTEM_MESSAGE
            ),
            user_message=(
                user_message or os.getenv("LLM_OCR_USER_MESSAGE") or DEFAULT_USER_MESSAGE
            ),
            enable_thinking=(
                enable_thinking
                if enable_thinking is not None
                else _bool(os.getenv("LLM_OCR_ENABLE_THINKING"), False)
            ),
            concurrency=_int(
                str(concurrency) if concurrency is not None else os.getenv("LLM_OCR_CONCURRENCY"),
                2,
            ),
        )


def create_llm_client(base_url: str, api_key: str | None = None) -> AsyncOpenAI:
    """Build the async OpenAI-compatible client (import is lazy).

    Args:
        base_url: base URL of the OpenAI-compatible server (e.g. llama.cpp).
        api_key: optional API key. Empty/None uses a placeholder, which local
            servers accept.

    Raises:
        RuntimeError: when the `openai` package is not installed.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError as e:
        raise RuntimeError(
            "LLM OCR needs the 'openai' package, which is part of the default dependencies. "
            "Run `uv sync`."
        ) from e
    return AsyncOpenAI(base_url=base_url.rstrip("/"), api_key=api_key or NO_API_KEY)


async def complete_with_images(
    client: AsyncOpenAI,
    images: list[tuple[bytes, str]],
    model: str,
    system_message: str,
    user_message: str,
    enable_thinking: bool = False,
    max_tokens: int | None = None,
) -> str:
    """Send one chat turn with image(s) and return the stripped text response.

    Args:
        client: the OpenAI client.
        images: list of (raw bytes, MIME type) tuples included in the prompt.
        model: the name of the model to use.
        system_message: the system message for the chat conversation.
        user_message: the user's prompt for the chat conversation.
        enable_thinking: whether to allow `<think>` blocks prior to responding.
        max_tokens: optional cap on generated tokens (used by the connection
            probe to keep the test cheap).

    Returns:
        Stripped LLM response text.
    """
    content: list[Any] = []
    for raw, mime_type in images:
        base64_image = base64.b64encode(raw).decode("utf-8")
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{base64_image}"},
            }
        )
    content.append({"type": "text", "text": user_message})
    messages: Any = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": content},
    ]
    kwargs: dict[str, Any] = {
        "model": model,
        "extra_body": {"chat_template_kwargs": {"enable_thinking": enable_thinking}},
        "temperature": 0,
        "messages": messages,
    }
    if max_tokens is not None:
        kwargs["max_tokens"] = max_tokens

    try:
        response = await client.chat.completions.create(**kwargs)
    except Exception as e:
        # `chat_template_kwargs` is a llama.cpp/Qwen extension. Generic
        # OpenAI-compatible servers reject unknown body fields with a 400;
        # retry once without the extension so the engine still works there.
        if getattr(e, "status_code", None) == 400 and "extra_body" in kwargs:
            kwargs.pop("extra_body")
            response = await client.chat.completions.create(**kwargs)
        else:
            raise
    return (response.choices[0].message.content or "").strip()


def model_supports_vision(data: dict[str, Any]) -> bool | None:
    """Best-effort vision capability detection from an OpenAI `/models` entry.

    OpenAI-compatible servers report capability metadata inconsistently:
    OpenRouter exposes `architecture.input_modalities`, some expose
    `capabilities.vision`, and llama.cpp/vLLM expose nothing. Return `None`
    when the server does not say, so the UI can show "vision unverified"
    instead of hiding a potentially usable model.

    Args:
        data: one model object from `GET /models` as a dict.

    Returns:
        True/False when the server reports the capability, otherwise None.
    """
    architecture = data.get("architecture")
    if isinstance(architecture, dict):
        modalities = architecture.get("input_modalities")
        if isinstance(modalities, list):
            return "image" in modalities

    capabilities = data.get("capabilities")
    if isinstance(capabilities, dict) and isinstance(capabilities.get("vision"), bool):
        return capabilities["vision"]
    if isinstance(capabilities, list) and "multimodal" in capabilities:
        return True

    for key in ("input_modalities", "modalities"):
        modalities = data.get(key)
        if isinstance(modalities, list):
            return "image" in modalities

    return None


async def probe_llm(config: LLMConfig) -> None:
    """Validate the connection, model, and vision support with one tiny image.

    Args:
        config: connection/model/prompt settings to test.

    Raises:
        Exception: whatever the OpenAI client raises, so the caller can map it
            to an HTTP error.
    """
    client = create_llm_client(config.base_url, config.api_key)
    await complete_with_images(
        client,
        [(TEST_IMAGE_PNG, "image/png")],
        model=config.model,
        system_message=config.system_message,
        user_message="Reply with the single word OK.",
        enable_thinking=config.enable_thinking,
        max_tokens=16,
    )


def normalize_ocr_markdown(text: str) -> str:
    """Normalize a model response, mapping the blank-page marker to `""`."""
    stripped = text.strip()
    if stripped.lower() == NO_TEXT_MARKER:
        return ""
    return stripped


async def ocr_page_image(
    image: bytes,
    mime_type: str,
    config: LLMConfig,
    page: int | None = None,
    run_id: str | None = None,
) -> str:
    """OCR one page image and return its Markdown.

    Args:
        image: raw image bytes (PNG, JPEG, WebP, or GIF).
        mime_type: MIME type matching `image`.
        config: LLM connection and prompt settings.
        page: optional 1-based page number for logging.
        run_id: ties log lines together (generated when omitted).

    Returns:
        The model's Markdown response, with the blank-page marker normalized
        to an empty string.
    """
    run = run_id or uuid.uuid4().hex[:12]
    client = create_llm_client(config.base_url, config.api_key)
    started = time.monotonic()
    text = await complete_with_images(
        client,
        [(image, mime_type)],
        model=config.model,
        system_message=config.system_message,
        user_message=config.user_message,
        enable_thinking=config.enable_thinking,
    )
    elapsed = time.monotonic() - started
    log_llm_event(
        "page_completed",
        run,
        f"LLM OCR page {page or '?'}: {elapsed:.1f}s",
        page=page,
        model=config.model,
        method="llm",
        bytes=len(image),
        llm_seconds=round(elapsed, 3),
    )
    return normalize_ocr_markdown(text)
