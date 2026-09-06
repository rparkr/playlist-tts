"""Pydantic schemas for OCR, parse, and TTS contracts."""

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class PostprocessOptions(BaseModel):
    """User-configurable post-processing flags."""

    combine_columns: bool = True
    normalize_uppercase: Literal["off", "title", "lower_long"] = "off"
    ensure_punctuation: bool = False
    insert_page_markers: bool = True


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
