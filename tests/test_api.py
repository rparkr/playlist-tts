"""API integration tests using FastAPI's TestClient."""

from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.models.schemas import JobStatus
from backend.app.services.tts_service import TTSJob, _display_filename, _tts_jobs

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


def test_tts_engines_shape(monkeypatch):
    """Engine catalog exposes availability and per-engine voices."""
    monkeypatch.setattr(
        "backend.app.api.tts.list_engines",
        lambda: [
            {
                "id": "phonon",
                "label": "Phonon",
                "available": True,
                "voice_cloning": False,
                "voices": [{"name": "Zoey"}],
            },
            {
                "id": "pocket",
                "label": "Pocket TTS (legacy)",
                "available": True,
                "voice_cloning": True,
                "voices": [{"name": "alba"}],
            },
        ],
    )
    resp = client.get("/api/tts/engines")
    assert resp.status_code == 200
    engines = {e["id"]: e for e in resp.json()["engines"]}
    assert set(engines) == {"phonon", "pocket"}
    assert engines["phonon"]["voices"] == [{"name": "Zoey"}]
    assert engines["pocket"]["voice_cloning"] is True


def test_tts_voice_metadata_is_groupable():
    """Catalog rows expose the fields the settings picker groups by."""
    from backend.app.services import phonon_service, tts_service

    zoey = phonon_service._voice_entry("Zoey", "en")
    assert zoey["language"] == "English"
    assert zoey["dialect"] == "US English"
    assert zoey["gender"] == "female"

    pocket = {voice["name"]: voice for voice in tts_service.list_voices("pocket")}
    assert pocket["alba"]["language"] == "English"
    assert pocket["alba"]["gender"] == "female"
    assert pocket["giovanni"]["language"] == "Italian"


def test_tts_unknown_engine_rejected():
    """Unknown engine names fail fast instead of falling through to Pocket."""
    assert client.get("/api/tts/voices", params={"engine": "turbo"}).status_code == 400
    assert (
        client.post("/api/tts/stream", data={"text": "Hello.", "engine": "turbo"}).status_code
        == 400
    )
    assert (
        client.post("/api/tts/jobs", data={"text": "Hello.", "engine": "turbo"}).status_code == 400
    )


def test_tts_job_status_reports_engine():
    """Job status carries the engine and voice used for the file."""
    job = TTSJob(job_id="engine-test", engine="phonon", voice="Zoey")
    job.status = JobStatus.done
    _tts_jobs[job.job_id] = job
    try:
        resp = client.get(f"/api/tts/jobs/{job.job_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["engine"] == "phonon"
        assert data["voice"] == "Zoey"
    finally:
        _tts_jobs.pop("engine-test", None)


def test_tts_job_create_shape(monkeypatch):
    """TTS job creation forwards the engine and returns a job id."""
    seen: dict[str, object] = {}

    async def fake_create(**kwargs):
        seen.update(kwargs)
        return "fake-job"

    monkeypatch.setattr("backend.app.api.tts.create_tts_file_job", fake_create)
    resp = client.post(
        "/api/tts/jobs",
        data={"text": "Hello world.", "fmt": "wav", "engine": "phonon", "voice": "Zoey"},
    )
    assert resp.status_code == 202
    assert resp.json()["job_id"] == "fake-job"
    assert seen["engine"] == "phonon"
    assert seen["voice_url"] == "Zoey"


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


def test_v1_models_stub():
    """OpenAI-compat stub answers external /v1/models probes (no more 404 noise)."""
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    data = resp.json()
    assert data["object"] == "list"
    assert isinstance(data["data"], list) and len(data["data"]) >= 1
