"""Pydantic schemas for LLM OCR, TTS, fetch, and conversion contracts."""

from enum import StrEnum

from pydantic import BaseModel, Field, SecretStr, field_validator


class _BaseUrlModel(BaseModel):
    """Shared base-URL normalization for LLM connection payloads."""

    base_url: str | None = None

    @field_validator("base_url")
    @classmethod
    def _normalize_base_url(cls, value: str | None) -> str | None:
        """Trim trailing slashes and require an http(s) scheme."""
        if value is None:
            return None
        cleaned = value.strip().rstrip("/")
        if not cleaned:
            return None
        if not cleaned.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        return cleaned


class LLMOcrConfig(_BaseUrlModel):
    """Optional overrides for one LLM page OCR call.

    Every field is optional: omitted/empty values fall back to the server's
    environment defaults (`LLM_OCR_*`) and then to the built-in defaults.
    """

    api_key: SecretStr | None = None
    model: str | None = None
    system_message: str | None = Field(default=None, max_length=20_000)
    user_message: str | None = Field(default=None, max_length=20_000)
    enable_thinking: bool | None = None
    concurrency: int | None = Field(default=None, ge=0)


class LLMModelsRequest(_BaseUrlModel):
    """Credentials for querying an OpenAI-compatible server's model list."""

    api_key: SecretStr | None = None


class LLMModelInfo(BaseModel):
    """One model advertised by an OpenAI-compatible server."""

    id: str
    name: str | None = None
    vision: bool | None = Field(
        default=None,
        description="True/False when the server reports vision support; None when unknown",
    )


class LLMModelsResponse(BaseModel):
    """Model list plus the base URL that was actually queried."""

    base_url: str
    models: list[LLMModelInfo]


class LLMOcrDefaults(BaseModel):
    """Server-side defaults shown in the LLM OCR settings UI."""

    base_url: str
    model: str
    system_message: str
    user_message: str
    concurrency: int
    enable_thinking: bool


class LLMTestResponse(BaseModel):
    """Result of a one-shot LLM connection/vision probe."""

    ok: bool
    model: str
    latency_ms: int


class LLMPageOcrResponse(BaseModel):
    """Markdown extracted from one page image."""

    page: int = Field(ge=1, description="1-indexed physical PDF page number")
    markdown: str


class JobStatus(StrEnum):
    """Background job status (used by TTS jobs)."""

    queued = "queued"
    running = "running"
    done = "done"
    error = "error"


class TTSVoicesResponse(BaseModel):
    """Response for GET /api/tts/voices."""

    voices: list[dict]


class TTSEngineInfo(BaseModel):
    """One server TTS engine and its capabilities."""

    id: str
    label: str
    available: bool
    voice_cloning: bool = False
    voices: list[dict] = Field(default_factory=list)


class TTSEnginesResponse(BaseModel):
    """Response for GET /api/tts/engines."""

    engines: list[TTSEngineInfo]


class TTSJobCreateResponse(BaseModel):
    """Response for POST /api/tts/jobs."""

    job_id: str


class TTSJobStatusResponse(BaseModel):
    """Response for GET /api/tts/jobs/{id}."""

    status: JobStatus
    progress: dict[str, int] = Field(default_factory=lambda: {"done": 0, "total": 0})
    engine: str | None = None
    voice: str | None = None
    error: str | None = None
    output: str | None = Field(default=None, description="Download filename once the job is done")


class FetchArticleRequest(BaseModel):
    """Request for POST /api/fetch/article."""

    url: str = Field(description="Article URL (http/https only)")


class FetchArticleResponse(BaseModel):
    """Extracted article Markdown plus metadata for playlist item cards."""

    markdown: str
    title: str | None = None
    author: str | None = None
    site: str | None = None
    date: str | None = None
    excerpt: str | None = None
    url: str
    domain: str


class EpubImage(BaseModel):
    """One image binary referenced from converted ePub Markdown (base64)."""

    path: str = Field(
        description="Image path relative to the OPF directory, as referenced in Markdown"
    )
    media_type: str = Field(default="image/png")
    data_b64: str = Field(description="Raw image bytes, base64-encoded")


class ConvertEpubResponse(BaseModel):
    """Response for POST /api/convert/epub."""

    markdown: str
    title: str | None = None
    author: str | None = None
    images: list[EpubImage] = Field(default_factory=list)
