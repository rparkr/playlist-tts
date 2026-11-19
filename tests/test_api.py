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


def test_removed_ocr_routes_are_gone():
    """The old OCR job/parse surface no longer exists (OCR is client-driven)."""
    removed = [
        ("post", "/api/ocr"),
        ("post", "/api/ocr/jobs"),
        ("get", "/api/ocr/jobs/abc"),
        ("post", "/api/ocr/llm/jobs"),
        ("get", "/api/ocr/llm/jobs/abc"),
        ("post", "/api/parse-markdown"),
    ]
    for method, path in removed:
        resp = getattr(client, method)(path)
        assert resp.status_code in (404, 405), f"{method.upper()} {path} still routed"


def test_tts_voices():
    """Voice catalog returns list."""
    resp = client.get("/api/tts/voices")
    assert resp.status_code == 200
    data = resp.json()
    assert "voices" in data
    assert isinstance(data["voices"], list)


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
    assert pocket["alba"]["gender"] == "male"
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


def test_v1_models_stub():
    """OpenAI-compat stub answers external /v1/models probes (no more 404 noise)."""
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    data = resp.json()
    assert data["object"] == "list"
    assert isinstance(data["data"], list) and len(data["data"]) >= 1
