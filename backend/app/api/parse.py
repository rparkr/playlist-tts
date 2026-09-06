"""Markdown parse endpoint — shared parser for offline use."""

from fastapi import APIRouter, Form

from backend.app.models.schemas import ParseMarkdownResponse
from backend.app.services.postprocess import parse_markdown_structure

router = APIRouter(prefix="/api", tags=["parse"])


@router.post("/parse-markdown", response_model=ParseMarkdownResponse)
async def parse_raw_markdown(markdown: str = Form("")) -> ParseMarkdownResponse:
    """Parse directly pasted or uploaded Markdown text."""
    sections = parse_markdown_structure(markdown)
    return ParseMarkdownResponse(markdown=markdown, sections=sections)
