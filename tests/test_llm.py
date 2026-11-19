"""Unit tests for the stateless LLM OCR proxy (no LLM server needed)."""

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api import llm as llm_api
from backend.app.main import app
from backend.app.services import llm_service as svc
from backend.app.services.llm_service import (
    LLMConfig,
    complete_with_images,
    model_supports_vision,
    normalize_ocr_markdown,
    ocr_page_image,
)

client = TestClient(app)


class CapturingClient:
    """Chat client that records kwargs and can fail once with a 400."""

    def __init__(self, fail_first: bool = False):
        self.calls: list[dict[str, Any]] = []
        self._fail_first = fail_first
        self.chat = SimpleNamespace(completions=self)

    async def create(self, **kwargs: Any) -> Any:
        """Record the request; optionally raise a 400 on the first call."""
        self.calls.append(kwargs)
        if self._fail_first and len(self.calls) == 1:
            error = RuntimeError("unknown field")
            error.status_code = 400
            raise error
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=" ok "))])


def test_from_env_resolves_key_and_prompts(monkeypatch: pytest.MonkeyPatch) -> None:
    """Environment values fill in unset config fields."""
    monkeypatch.setenv("LLM_OCR_BASE_URL", "http://env/v1")
    monkeypatch.setenv("LLM_OCR_MODEL", "env-model")
    monkeypatch.setenv("LLM_OCR_API_KEY", "env-key")
    monkeypatch.setenv("LLM_OCR_SYSTEM_MESSAGE", "env-system")
    monkeypatch.setenv("LLM_OCR_USER_MESSAGE", "env-user")
    monkeypatch.setenv("LLM_OCR_ENABLE_THINKING", "true")
    monkeypatch.setenv("LLM_OCR_CONCURRENCY", "4")

    config = LLMConfig.from_env()

    assert config.base_url == "http://env/v1"
    assert config.model == "env-model"
    assert config.api_key == "env-key"
    assert config.system_message == "env-system"
    assert config.user_message == "env-user"
    assert config.enable_thinking is True
    assert config.concurrency == 4


def test_model_supports_vision_reads_common_metadata() -> None:
    """Vision flags come from the varied shapes OpenAI-compatible servers use."""
    assert model_supports_vision({"architecture": {"input_modalities": ["text", "image"]}}) is True
    assert model_supports_vision({"architecture": {"input_modalities": ["text"]}}) is False
    assert model_supports_vision({"capabilities": {"vision": True}}) is True
    assert model_supports_vision({"capabilities": {"vision": False}}) is False
    assert model_supports_vision({"capabilities": ["completion", "multimodal"]}) is True
    assert model_supports_vision({"input_modalities": ["image"]}) is True
    assert model_supports_vision({"id": "llama"}) is None


def test_complete_with_images_forwards_prompts() -> None:
    """System/user prompts reach the LLM exactly as configured."""
    fake = CapturingClient()
    result = asyncio.run(
        complete_with_images(
            fake,  # type: ignore[arg-type]
            [(b"img", "image/png")],
            model="vision-model",
            system_message="SYS",
            user_message="USR",
        )
    )
    assert result == "ok"
    call = fake.calls[0]
    assert call["messages"][0]["content"] == "SYS"
    assert call["messages"][1]["content"][-1]["text"] == "USR"
    assert "extra_body" in call


def test_complete_with_images_retries_without_llama_extras() -> None:
    """Generic OpenAI servers that reject `chat_template_kwargs` still work."""
    fake = CapturingClient(fail_first=True)
    result = asyncio.run(
        complete_with_images(
            fake,  # type: ignore[arg-type]
            [(b"img", "image/png")],
            model="vision-model",
            system_message="SYS",
            user_message="USR",
        )
    )
    assert result == "ok"
    assert "extra_body" in fake.calls[0]
    assert "extra_body" not in fake.calls[1]


def test_create_llm_client_uses_api_key() -> None:
    """The client receives the configured key and a normalized base URL."""
    created = svc.create_llm_client("http://example/v1/", "secret")
    assert created.api_key == "secret"
    assert str(created.base_url).rstrip("/") == "http://example/v1"


def test_normalize_ocr_markdown_maps_blank_marker() -> None:
    """The prompt's blank-page marker becomes an empty page."""
    assert normalize_ocr_markdown("<no text found>") == ""
    assert normalize_ocr_markdown("  <NO TEXT FOUND>  ") == ""
    assert normalize_ocr_markdown("Page text") == "Page text"


def test_ocr_page_image_logs_and_normalizes(monkeypatch: pytest.MonkeyPatch) -> None:
    """`ocr_page_image` wraps one chat call and normalizes its response."""

    async def _complete(*_args: Any, **_kwargs: Any) -> str:
        return "<no text found>"

    monkeypatch.setattr(svc, "complete_with_images", _complete)
    result = asyncio.run(
        ocr_page_image(b"img", "image/png", LLMConfig(base_url="http://fake/v1"), page=3)
    )
    assert result == ""


def test_options_endpoint_returns_defaults() -> None:
    """The UI can prefill/reset prompts without ever receiving the API key."""
    resp = client.get("/api/llm/options")
    assert resp.status_code == 200
    data = resp.json()
    assert set(data) == {
        "base_url",
        "model",
        "system_message",
        "user_message",
        "concurrency",
        "enable_thinking",
    }
    assert "api_key" not in data


class FakeModel:
    """Minimal `/models` entry with a Pydantic-style dump."""

    def __init__(self, model_id: str, data: dict[str, Any]):
        self.id = model_id
        self._data = data

    def model_dump(self) -> dict[str, Any]:
        """Return the model as a dict, like the OpenAI SDK model."""
        return {"id": self.id, **self._data}


class FakeModelsResource:
    """Async `/models` resource returning a canned list."""

    def __init__(self, models: list[FakeModel]):
        self._models = models

    async def list(self, timeout: float | None = None) -> Any:
        """Return the canned models regardless of the timeout."""
        return SimpleNamespace(data=self._models)


def test_models_endpoint_lists_and_flags_vision(monkeypatch: pytest.MonkeyPatch) -> None:
    """The endpoint returns sorted models with True/False/None vision hints."""
    fake = SimpleNamespace(
        models=FakeModelsResource(
            [
                FakeModel("qwen-vl", {"architecture": {"input_modalities": ["text", "image"]}}),
                FakeModel("text-only", {"architecture": {"input_modalities": ["text"]}}),
                FakeModel("mystery", {}),
            ]
        )
    )
    monkeypatch.setattr(llm_api, "create_llm_client", lambda *_a, **_k: fake)

    resp = client.post("/api/llm/models", json={"base_url": "http://fake/v1"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["base_url"] == "http://fake/v1"
    assert [(m["id"], m["vision"]) for m in data["models"]] == [
        ("mystery", None),
        ("qwen-vl", True),
        ("text-only", False),
    ]


def test_models_endpoint_maps_auth_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    """401s become a friendly message, not a raw SDK traceback."""

    class AuthError(Exception):
        status_code = 401

    class FailingModels:
        async def list(self, timeout: float | None = None) -> Any:
            raise AuthError("bad key")

    monkeypatch.setattr(
        llm_api,
        "create_llm_client",
        lambda *_a, **_k: SimpleNamespace(models=FailingModels()),
    )
    resp = client.post(
        "/api/llm/models",
        json={"base_url": "http://fake/v1", "api_key": "secret"},
    )
    assert resp.status_code == 502
    assert "Authentication failed" in resp.json()["detail"]


def test_models_endpoint_redacts_api_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """Generic error text never echoes the API key back to the client."""

    class FailingModels:
        async def list(self, timeout: float | None = None) -> Any:
            raise RuntimeError("upstream rejected secret")

    monkeypatch.setattr(
        llm_api,
        "create_llm_client",
        lambda *_a, **_k: SimpleNamespace(models=FailingModels()),
    )
    resp = client.post(
        "/api/llm/models",
        json={"base_url": "http://fake/v1", "api_key": "secret"},
    )
    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert "secret" not in detail
    assert "***" in detail


def test_test_endpoint_probes_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    """A successful probe returns ok plus the model and latency."""

    async def _ok(_config: LLMConfig) -> None:
        return None

    monkeypatch.setattr(llm_api, "probe_llm", _ok)
    resp = client.post(
        "/api/llm/test",
        json={"base_url": "http://fake/v1", "model": "vision-model", "api_key": "secret"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["model"] == "vision-model"
    assert isinstance(data["latency_ms"], int)


def test_test_endpoint_reports_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    """Probe failures surface as a 502 with a readable detail."""

    async def _boom(_config: LLMConfig) -> None:
        raise RuntimeError("no such model")

    monkeypatch.setattr(llm_api, "probe_llm", _boom)
    resp = client.post("/api/llm/test", json={"model": "missing"})
    assert resp.status_code == 502
    assert "no such model" in resp.json()["detail"]


def test_ocr_endpoint_returns_page_markdown(monkeypatch: pytest.MonkeyPatch) -> None:
    """One PNG upload becomes `{page, markdown}`."""

    async def _fake_ocr(
        _image: bytes, _mime: str, _config: LLMConfig, page: int | None = None
    ) -> str:
        assert page == 7
        return "# Page seven"

    monkeypatch.setattr(llm_api, "ocr_page_image", _fake_ocr)
    resp = client.post(
        "/api/llm/ocr",
        files={"image": ("page.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"page": "7"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"page": 7, "markdown": "# Page seven"}


def test_ocr_endpoint_accepts_octet_stream_png(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mobile clients may upload with a generic content type; magic bytes win."""

    async def _fake_ocr(
        _image: bytes, mime: str, _config: LLMConfig, page: int | None = None
    ) -> str:
        assert mime == "image/png"
        return "text"

    monkeypatch.setattr(llm_api, "ocr_page_image", _fake_ocr)
    resp = client.post(
        "/api/llm/ocr",
        files={"image": ("blob", b"\x89PNG\r\n\x1a\nfake", "application/octet-stream")},
        data={"page": "1"},
    )
    assert resp.status_code == 200


def test_ocr_endpoint_rejects_non_image() -> None:
    """Non-image uploads are rejected before any LLM call."""
    resp = client.post(
        "/api/llm/ocr",
        files={"image": ("page.png", b"not an image", "image/png")},
        data={"page": "1"},
    )
    assert resp.status_code == 400
    assert "Unsupported image type" in resp.json()["detail"]


def test_ocr_endpoint_rejects_empty_image() -> None:
    """An empty upload is a client bug, not an LLM error."""
    resp = client.post(
        "/api/llm/ocr",
        files={"image": ("page.png", b"", "image/png")},
        data={"page": "1"},
    )
    assert resp.status_code == 400
    assert "Empty page image" in resp.json()["detail"]


def test_ocr_endpoint_rejects_invalid_llm_json() -> None:
    """Malformed settings JSON is a 400 before reading the image."""
    resp = client.post(
        "/api/llm/ocr",
        files={"image": ("page.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"page": "1", "llm": "{"},
    )
    assert resp.status_code == 400
    assert "Invalid LLM settings" in resp.json()["detail"]


def test_ocr_endpoint_maps_llm_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    """Upstream failures surface as a 502 with a friendly detail."""

    async def _boom(*_args: Any, **_kwargs: Any) -> str:
        raise RuntimeError("server exploded")

    monkeypatch.setattr(llm_api, "ocr_page_image", _boom)
    resp = client.post(
        "/api/llm/ocr",
        files={"image": ("page.png", b"\x89PNG\r\n\x1a\nfake", "image/png")},
        data={"page": "1"},
    )
    assert resp.status_code == 502
    assert "server exploded" in resp.json()["detail"]
