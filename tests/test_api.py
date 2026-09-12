"""API integration tests using FastAPI's TestClient."""

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services.tts_service import _display_filename

client = TestClient(app)


def test_health():
    """Health endpoint returns 200."""
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "healthy"


def test_parse_markdown():
    """Parse markdown into sections and sentence chunks."""
    resp = client.post(
        "/api/parse-markdown", data={"markdown": "# Title\n\nHello world. Second sentence."}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "sections" in data
    assert len(data["sections"]) >= 1
    # Section chunks should be sentence split
    first_sec = data["sections"][0]
    assert "Hello world." in first_sec["chunks"] or "Hello" in str(first_sec["chunks"])


def test_parse_empty():
    """Empty markdown yields no sections or single empty."""
    resp = client.post("/api/parse-markdown", data={"markdown": ""})
    assert resp.status_code == 200


def test_tts_voices():
    """Voice catalog returns list."""
    resp = client.get("/api/tts/voices")
    assert resp.status_code == 200
    data = resp.json()
    assert "voices" in data
    assert isinstance(data["voices"], list)


def test_ocr_jobs_requires_pdf():
    """OCR job creation rejects non-PDF."""
    resp = client.post("/api/ocr/jobs", files={"file": ("test.txt", b"not a pdf", "text/plain")})
    assert resp.status_code == 400


def test_ocr_job_create_shape():
    """OCR job creation returns a job id payload."""
    resp = client.post(
        "/api/ocr/jobs", files={"file": ("test.pdf", b"%PDF-1.4 fake", "application/pdf")}
    )
    assert resp.status_code == 202
    assert "job_id" in resp.json()


def test_ocr_jobs_accepts_pdf_without_extension():
    """Valid PDF bytes are accepted even without a .pdf filename.

    Regression test: mobile shares / drive downloads often arrive as
    `blob` or extensionless names with application/pdf content type.
    """
    resp = client.post(
        "/api/ocr/jobs", files={"file": ("blob", b"%PDF-1.4 fake", "application/pdf")}
    )
    assert resp.status_code == 202
    assert "job_id" in resp.json()


def test_ocr_jobs_accepts_pdf_magic_bytes():
    """Valid PDF magic bytes are accepted regardless of name/type."""
    resp = client.post(
        "/api/ocr/jobs",
        files={"file": ("scan", b"%PDF-1.7 content", "application/octet-stream")},
    )
    assert resp.status_code == 202


def test_tts_job_create_shape():
    """TTS job creation returns a job id payload."""
    resp = client.post("/api/tts/jobs", data={"text": "Hello world.", "fmt": "wav"})
    assert resp.status_code == 202
    assert "job_id" in resp.json()


def test_display_filename():
    """Download filenames are sanitized and match the output format."""
    assert _display_filename("chapter1.wav", "wav") == "chapter1.wav"
    assert _display_filename("a/b/chapter1.wav", "wav") == "chapter1.wav"
    assert _display_filename("chapter1.mp3", "wav") == "chapter1.wav"
    assert _display_filename(None, "mp3") == "output.mp3"
    assert _display_filename("", "webm") == "output.webm"


def test_tts_stream_rejects_empty():
    """TTS stream rejects empty text."""
    resp = client.post("/api/tts/stream", data={"text": ""})
    assert resp.status_code == 400


def test_ocr_sync_alias():
    """Synchronous OCR alias exists (will timeout on empty PDF but validates routing)."""
    # Use valid blank PDF
    import tempfile
    from pathlib import Path

    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        writer.write(tmp)
        tmp_path = Path(tmp.name)
    pdf_bytes = tmp_path.read_bytes()
    resp = client.post("/api/ocr", files={"file": ("test.pdf", pdf_bytes, "application/pdf")})
    # Blank PDF should succeed (maybe empty markdown) but not error 404/405
    assert resp.status_code in (200, 500, 504)  # allow docling failure on blank
    tmp_path.unlink(missing_ok=True)
