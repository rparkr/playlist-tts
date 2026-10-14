"""Digital-native PDF fast path — `pypdf` text extraction.

Scanned PDFs carry little or no embedded text (hidden OCR layers, headers,
watermarks yielding 50–150 junk chars), so a plain `extract_text` pass would
misroute them. Gate on both density and coverage: the median page must hold
more than `text_min_chars` (default 200) characters AND at least
`text_coverage_min` (default 0.6) of pages must pass that bar. Whole-document
routing for MVP; per-page hybrid is deferred (it complicates `pageMap`
continuity).
"""

from __future__ import annotations

import os
import statistics
from pathlib import Path

from backend.app.models.schemas import PageMapItem, PostprocessOptions, Section
from backend.app.services.postprocess import (
    dehyphenate,
    join_pages_strict,
    normalize_page_overrides,
    normalize_uppercase,
    parse_markdown_structure,
    reflow_columns,
    resolve_logical_page,
)


def text_extract_thresholds(opts: PostprocessOptions) -> tuple[int, float]:
    """Resolve text-routing thresholds with environment override for tuning.

    `OCR_TEXT_MIN_CHARS` / `OCR_TEXT_COVERAGE_MIN` win when set; otherwise
    the per-job `PostprocessOptions` values apply.
    """
    try:
        min_chars = int(os.getenv("OCR_TEXT_MIN_CHARS", str(opts.text_min_chars)))
    except ValueError:
        min_chars = opts.text_min_chars
    try:
        coverage = float(os.getenv("OCR_TEXT_COVERAGE_MIN", str(opts.text_coverage_min)))
    except ValueError:
        coverage = opts.text_coverage_min
    return max(0, min_chars), min(1.0, max(0.0, coverage))


def extract_pages_text(pdf_path: Path) -> list[str]:
    """Extract embedded text per PDF page in PDF order via `pypdf`.

    Args:
        pdf_path: path to the input PDF file.

    Returns:
        One string per PDF page (possibly empty), in PDF order.
    """
    import pypdf

    texts: list[str] = []
    reader = pypdf.PdfReader(pdf_path)
    for page in reader.pages:
        try:
            # `extraction_mode="plain"` extracts text in the order
            # in which it was saved in the document (the same order
            # that text is selected when clicking and dragging on
            # PDF text using a mouse cursor). This is better than "layout"
            # mode because it usually preserves reading order quite well,
            # rather than document structure (e.g., two-column layouts use
            # first-then-second-column reading order even though the
            # structural layout has the two side by side).
            texts.append(page.extract_text(extraction_mode="plain") or "")
        except Exception:
            texts.append("")
    return texts


def should_use_text(
    pages_chars: list[int],
    min_chars: int = 200,
    coverage_min: float = 0.6,
) -> bool:
    """Decide whether embedded text is dense enough to skip OCR.

    Args:
        pages_chars: per-page character counts.
        min_chars: per-page density bar.
        coverage_min: minimum fraction of pages passing the bar.

    Returns:
        True when `median(pages_chars) > min_chars` AND the fraction of
        pages with `chars > min_chars` exceeds `coverage_min`.
    """
    if not pages_chars:
        return False
    median_chars = statistics.median(pages_chars)
    passing = sum(1 for c in pages_chars if c > min_chars)
    coverage = passing / len(pages_chars)
    return median_chars > min_chars and coverage >= coverage_min


def analyze_pdf_text(pdf_path: Path) -> dict:
    """Extract text and report density metrics for routing decisions.

    Returns a dict with `pages`, `chars` (per-page counts), `median_chars`,
    `coverage` (fraction of pages with `chars > 200` at default threshold),
    and `texts`.
    """
    texts = extract_pages_text(pdf_path)
    chars = [len(t) for t in texts]
    median_chars = statistics.median(chars) if chars else 0
    coverage = sum(1 for c in chars if c > 200) / len(chars) if chars else 0.0
    return {
        "pages": len(texts),
        "chars": chars,
        "median_chars": median_chars,
        "coverage": coverage,
        "texts": texts,
    }


def convert_pdf_with_text(
    pdf_path: Path,
    opts: PostprocessOptions,
    page_texts: list[str] | None = None,
) -> tuple[str, list[Section], list[PageMapItem]]:
    """Build Markdown from embedded text with the standard post pipeline.

    Each page is processed independently (same per-page steps as the LLM
    engine), then joined with strict `Page N.` markers honouring
    `first_page_number` / `page_overrides` so numbering stays aligned.

    Args:
        pdf_path: path to the input PDF (used only for parity logging).
        opts: post-processing flags.
        page_texts: pre-extracted per-page texts (extracted when omitted).

    Returns:
        (markdown, sections, page_map) with logical page numbers.
    """
    _ = pdf_path
    pages = page_texts if page_texts is not None else extract_pages_text(pdf_path)
    processed: list[str] = []
    for page in pages:
        text = page or ""
        if opts.combine_columns:
            text = dehyphenate(text)
            text = reflow_columns(text)
        if opts.normalize_uppercase:
            text = normalize_uppercase(text)
        processed.append(text)
    md, page_map = join_pages_strict(
        processed,
        opts.insert_page_markers,
        opts.first_page_marker,
        opts.first_page_number,
        opts.page_overrides,
    )
    if opts.combine_columns:
        md = dehyphenate(md)
    sections = parse_markdown_structure(md)
    return md, sections, page_map


__all__ = [
    "analyze_pdf_text",
    "convert_pdf_with_text",
    "extract_pages_text",
    "normalize_page_overrides",
    "resolve_logical_page",
    "should_use_text",
    "text_extract_thresholds",
]
