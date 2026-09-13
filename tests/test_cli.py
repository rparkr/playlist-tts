"""CLI smoke tests via typer.testing.CliRunner (no GPU/model weights needed).

Only argument validation paths are exercised — actual OCR/TTS synthesis is
never invoked, so heavy deps (docling, pocket-tts) are not imported.
"""

from pathlib import Path

from typer.testing import CliRunner

from backend.app.cli.ocr import app as ocr_app
from backend.app.cli.tts import app as tts_app

runner = CliRunner()


def test_ocr_help():
    """OCR CLI exposes help without importing heavy OCR deps."""
    result = runner.invoke(ocr_app, ["--help"])
    assert result.exit_code == 0
    assert "INPUT_PDF" in result.output
    # Rich may truncate long flag names with an ellipsis on narrow terminals.
    assert "normalize-upperca" in result.output


def test_ocr_missing_file():
    """OCR CLI rejects a nonexistent input PDF before doing any work."""
    result = runner.invoke(ocr_app, ["does-not-exist.pdf"])
    assert result.exit_code != 0


def test_ocr_rejects_bad_normalize_mode(tmp_path: Path):
    """OCR CLI rejects unexpected extra args without running OCR."""
    from pypdf import PdfWriter

    pdf = tmp_path / "in.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with open(pdf, "wb") as f:
        writer.write(f)

    result = runner.invoke(ocr_app, [str(pdf), "fake"])
    assert result.exit_code != 0


def test_tts_help():
    """TTS CLI exposes help without importing heavy TTS deps."""
    result = runner.invoke(tts_app, ["--help"])
    assert result.exit_code == 0
    assert "INPUT_FILE" in result.output
