"""Pydantic schemas for OCR, parse, and TTS contracts."""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class PostprocessOptions(BaseModel):
    """User-configurable post-processing flags."""

    combine_columns: bool = True
    normalize_uppercase: bool = False
    ensure_punctuation: bool = False
    insert_page_markers: bool = True
    # Emit a `Page N.` marker for the first page too (default on: the PDF
    # viewer needs it for back-navigation to page 1).
    first_page_marker: bool = True
    # Extraction engine override for `/api/ocr/jobs`: `auto` keeps the
    # text-fast-path/Docling routing, `text` forces `pypdf` extraction,
    # `docling` forces Docling OCR. The LLM engine lives on `/api/ocr/llm`.
    engine: Literal["auto", "text", "docling"] = "auto"
    # Logical number of physical PDF page 1 (chapter-by-chapter scans).
    first_page_number: int = Field(default=1, ge=1)
    # Physical (1-indexed) → logical page overrides (skipped illustrations).
    page_overrides: dict[int, int] | None = Field(default=None)
    # Digital-native text fast path (pypdf) tuning.
    use_text_extract: bool = True
    text_min_chars: int = Field(default=200, ge=0)
    text_coverage_min: float = Field(default=0.6, ge=0.0, le=1.0)

    @field_validator("normalize_uppercase", mode="before")
    @classmethod
    def _coerce_uppercase(cls, v: object) -> bool:
        """Accept legacy string modes for backward compatibility."""
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            return v.lower() not in ("off", "false", "0", "")
        return bool(v)


class JobStatus(StrEnum):
    """Background job status."""

    queued = "queued"
    running = "running"
    done = "done"
    error = "error"


class PageMapItem(BaseModel):
    """Mapping from PDF page to markdown offsets."""

    page: int = Field(description="1-indexed page number")
    char_start: int = Field(description="Inclusive char offset in markdown")
    char_end: int = Field(description="Exclusive char offset in markdown")
    start_line: int = Field(description="1-indexed line number")


class Section(BaseModel):
    """Markdown section with sentence-level chunks."""

    id: int
    titles: list[str] = Field(description="Hierarchical breadcrumb titles")
    level: int = Field(ge=1, le=6, description="Header level (1-6)")
    chunks: list[str] = Field(description="Sentence-level chunks for TTS")
    paragraphs: list[list[str]] | None = Field(
        default=None,
        description="Sentence groups per paragraph; [0] holds heading sentences",
    )
    heading: str | None = Field(
        default=None, description="Own heading text for this section, if any"
    )


class OCRJobCreateResponse(BaseModel):
    """Response for POST /api/ocr/jobs."""

    job_id: str


class OCRJobStatusResponse(BaseModel):
    """Response for GET /api/ocr/jobs/{id}."""

    status: JobStatus
    progress: dict[str, int] = Field(default_factory=lambda: {"done": 0, "total": 0})
    result: dict | None = None
    error: str | None = None


class OCRDirectResponse(BaseModel):
    """Response for synchronous OCR (alias)."""

    filename: str
    markdown: str
    sections: list[Section]
    page_map: list[PageMapItem]
    meta: dict
    raw_markdown: str | None = Field(
        default=None, description="Unprocessed OCR markdown for client-side re-render"
    )
    raw_page_map: list[PageMapItem] | None = Field(
        default=None, description="Page map aligned to raw_markdown"
    )


class ParseMarkdownResponse(BaseModel):
    """Response for markdown parsing."""

    markdown: str
    sections: list[Section]


class TTSVoicesResponse(BaseModel):
    """Response for GET /api/tts/voices."""

    voices: list[dict]


class TTSJobCreateResponse(BaseModel):
    """Response for POST /api/tts/jobs."""

    job_id: str


class TTSJobStatusResponse(BaseModel):
    """Response for GET /api/tts/jobs/{id}."""

    status: JobStatus
    progress: dict[str, int] = Field(default_factory=lambda: {"done": 0, "total": 0})
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
