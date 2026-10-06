"""Tests for digital-native PDF fast path (`pypdf` text routing)."""

from pathlib import Path

from backend.app.models.schemas import PostprocessOptions
from backend.app.services.text_extract import (
    analyze_pdf_text,
    convert_pdf_with_text,
    should_use_text,
)

SCANNED_CH8 = Path("test-pdfs/engineering-ch-8 - construction.pdf")


def test_should_use_text_gates_junk_layers():
    """Scanned PDFs with hidden OCR junk (50-150 chars) must NOT route to text."""
    assert should_use_text([0] * 10) is False
    assert should_use_text([80, 120, 60, 90, 110]) is False
    assert should_use_text([0] * 9 + [5000]) is False  # low coverage


def test_should_use_text_accepts_digital():
    """Dense text on most pages routes to the fast path."""
    assert should_use_text([1200] * 10) is True
    assert should_use_text([50] + [1500] * 9) is True


def test_scanned_pdf_calibration_stays_on_ocr():
    """Calibrated on real scans: ch-8 has no embedded text → OCR path."""
    if not SCANNED_CH8.exists():
        return
    report = analyze_pdf_text(SCANNED_CH8)
    assert report["pages"] == 10
    assert report["median_chars"] <= 200
    assert should_use_text(report["chars"]) is False


def test_convert_pdf_with_text_uses_logical_numbering():
    """Text path honours first-page offset and per-page overrides."""
    opts = PostprocessOptions(
        insert_page_markers=True,
        first_page_number=5,
        page_overrides={3: 9},
    )
    pages = [
        "First page content here. More words to fill.",
        "Second page content here. Another sentence.",
        "Illustration page with no text appeal.",
    ]
    md, sections, page_map = convert_pdf_with_text(Path("dummy.pdf"), opts, pages)
    assert "Page 6." in md
    assert "Page 9." in md
    assert [p.page for p in page_map] == [5, 6, 9]
    assert sections
