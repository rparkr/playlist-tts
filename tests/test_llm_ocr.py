"""Unit tests for the LLM OCR engine (no LLM server needed).

`ocr_pdf_pages` accepts an injected client, so a fake stands in for
`AsyncOpenAI`; only `extract_pdf_pages` touches real PDFs.
"""

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.models.schemas import PostprocessOptions
from backend.app.services import llm_ocr_service as svc
from backend.app.services.llm_ocr_service import (
    LLMConfig,
    PDFPageContent,
    convert_pdf_with_llm,
    create_llm_ocr_job,
    get_llm_job,
    ocr_pdf_pages,
)

if TYPE_CHECKING:
    from openai import AsyncOpenAI

TEST_PDFS = Path("test-pdfs")
SMALL_BOOK = TEST_PDFS / "engineering-ch-8 - construction.pdf"


class FakeClient:
    """Minimal `AsyncOpenAI` stand-in driven by a per-call plan.

    Each plan entry is (delay_seconds, text | Exception). Calls beyond the
    plan reuse the last entry.
    """

    def __init__(self, plan: list[tuple[float, str | Exception]]):
        self.plan = plan
        self.calls = 0
        self.max_in_flight = 0
        self._in_flight = 0
        self.chat = SimpleNamespace(completions=self)

    async def create(self, **kwargs: Any) -> Any:
        idx = self.calls
        self.calls += 1
        delay, outcome = self.plan[min(idx, len(self.plan) - 1)]
        self._in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self._in_flight)
        try:
            await asyncio.sleep(delay)
        finally:
            self._in_flight -= 1
        if isinstance(outcome, Exception):
            raise outcome
        return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=outcome))])


def _image_contents(n: int) -> list[PDFPageContent]:
    """Fake scanned pages (contents are opaque to the fake client)."""
    return [PDFPageContent(images=[(f"img-{i}".encode(), "image/jpeg")]) for i in range(n)]


def _test_config(**overrides: Any) -> LLMConfig:
    config = LLMConfig(base_url="http://fake/v1", model="fake-model")
    for key, value in overrides.items():
        setattr(config, key, value)
    return config


def _write_digital_pdf(path: Path) -> None:
    """Write a minimal one-page digital-text PDF (no embedded images)."""
    content = b"BT /F1 12 Tf 72 720 Td (Hello digital world.) Tj ET"
    objs = [
        b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
        b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
        b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]"
        b"/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj",
        b"4 0 obj<</Length "
        + str(len(content)).encode()
        + b">>stream\n"
        + content
        + b"\nendstream\nendobj",
        b"5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj",
    ]
    pdf = b"%PDF-1.4\n"
    offsets = []
    for obj in objs:
        offsets.append(len(pdf))
        pdf += obj + b"\n"
    xref_pos = len(pdf)
    pdf += b"xref\n0 6\n0000000000 65535 f \n"
    for off in offsets:
        pdf += f"{off:010d} 00000 n \n".encode()
    pdf += b"trailer<</Size 6/Root 1 0 R>>\nstartxref\n" + str(xref_pos).encode() + b"\n%%EOF"
    path.write_bytes(pdf)


def test_page_order_survives_out_of_order_completion(monkeypatch: pytest.MonkeyPatch) -> None:
    """Results stay in PDF order even when page 1 finishes last."""
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(5))
    # First call (page 1) is slowest, so it completes last.
    client = FakeClient([(0.05, "TEXT-0"), (0.0, "TEXT rest")])
    pages = asyncio.run(
        ocr_pdf_pages(Path("fake.pdf"), _test_config(), client=cast("AsyncOpenAI", client))
    )
    assert pages[0] == "TEXT-0"
    assert pages[1:] == ["TEXT rest"] * 4
    assert client.calls == 5


def test_failed_page_yields_empty_string_without_failing_document(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """One LLM failure blanks that page; the rest still complete in order."""
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(3))
    client = FakeClient([(0.0, "TEXT-0"), (0.0, RuntimeError("boom")), (0.0, "TEXT-2")])
    pages = asyncio.run(
        ocr_pdf_pages(Path("fake.pdf"), _test_config(), client=cast("AsyncOpenAI", client))
    )
    assert pages == ["TEXT-0", "", "TEXT-2"]


def test_imageless_page_uses_pypdf_text_without_llm_call(tmp_path: Path) -> None:
    """Born-digital pages never touch the LLM (real file, end to end)."""
    pdf = tmp_path / "digital.pdf"
    _write_digital_pdf(pdf)

    async def _fail_if_called(**kwargs: Any) -> Any:
        raise AssertionError("LLM must not be called for imageless pages")

    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=_fail_if_called))
    )
    pages = asyncio.run(ocr_pdf_pages(pdf, _test_config(), client=cast("AsyncOpenAI", client)))
    assert pages == ["Hello digital world."]


def test_concurrency_bound_limits_in_flight_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Semaphore caps simultaneous LLM calls (memory protection)."""
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(6))
    client = FakeClient([(0.02, "TEXT")])
    asyncio.run(
        ocr_pdf_pages(
            Path("fake.pdf"), _test_config(concurrency=2), client=cast("AsyncOpenAI", client)
        )
    )
    assert client.calls == 6
    assert client.max_in_flight <= 2


def test_convert_end_to_end_markers(monkeypatch: pytest.MonkeyPatch) -> None:
    """Full convert path emits `Page 2.` between pages with aligned numbering."""
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(2))
    client = FakeClient([(0.0, "First page."), (0.0, "Second page.")])
    md, sections, page_map = asyncio.run(
        convert_pdf_with_llm(
            Path("fake.pdf"),
            PostprocessOptions(),
            _test_config(),
            client=cast("AsyncOpenAI", client),
        )
    )
    assert "\n\nPage 2.\n\n" in md
    assert md.index("First page.") < md.index("Page 2.") < md.index("Second page.")
    assert [p.page for p in page_map] == [1, 2]
    assert sum(len(s.chunks) for s in sections) >= 3


def test_heading_stays_on_its_own_page(monkeypatch: pytest.MonkeyPatch) -> None:
    """End-to-end regression for the misplaced-marker report.

    Page 2 ends without terminal punctuation (map legend labels) while page 3
    opens with a heading: the heading must follow `Page 3.`, not precede it.
    """
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(3))
    client = FakeClient(
        [
            (0.0, "OUTER ISLAND\nDINOTOPIA\nSTATUTE MILES"),
            (
                0.0,
                "3 HOW I DISCOVERED THE SKETCHBOOK\n\nEARLY A YEAR has gone by "
                "since I first made the discovery.",
            ),
            (0.0, "It was purely by chance."),
        ]
    )
    md, _, page_map = asyncio.run(
        convert_pdf_with_llm(
            Path("fake.pdf"),
            PostprocessOptions(),
            _test_config(),
            client=cast("AsyncOpenAI", client),
        )
    )
    assert md.index("STATUTE MILES") < md.index("Page 2.") < md.index("HOW I DISCOVERED")
    assert md.index("discovery.") < md.index("Page 3.") < md.index("purely by chance")
    assert [p.page for p in page_map] == [1, 2, 3]


def test_convert_first_page_marker_opt_in(monkeypatch: pytest.MonkeyPatch) -> None:
    """`first_page_marker` prepends `Page 1.` without disturbing alignment."""
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(2))
    client = FakeClient([(0.0, "First page."), (0.0, "Second page.")])
    opts = PostprocessOptions(insert_page_markers=True, first_page_marker=True)
    md, _, page_map = asyncio.run(
        convert_pdf_with_llm(
            Path("fake.pdf"),
            opts,
            _test_config(),
            client=cast("AsyncOpenAI", client),
        )
    )
    assert md.index("Page 1.") < md.index("First page.") < md.index("Page 2.")
    assert md[page_map[0].char_start : page_map[0].char_end] == "First page."


def test_guess_image_mime_falls_back_to_magic_bytes() -> None:
    """Extensionless names still resolve via JPEG/PNG magic bytes."""
    assert svc._guess_image_mime("img0", b"\xff\xd8\xff\x00") == "image/jpeg"
    assert svc._guess_image_mime("img0", b"\x89PNG\r\n") == "image/png"
    assert svc._guess_image_mime("img0", b"junk") is None


def _read_jsonl(path: Path) -> list[dict]:
    """Parse a JSONL file, skipping blank lines."""
    import json

    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_jsonl_run_log_captures_phases_and_pages(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A run appends parseable JSONL: extract, per-page, and summary events."""
    from backend.app.services.llm_logging import configure_llm_logging

    log_file = tmp_path / "run.jsonl"
    configure_llm_logging(log_file)
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(2))
    client = FakeClient([(0.0, "Page one text."), (0.0, RuntimeError("nope"))])
    asyncio.run(
        ocr_pdf_pages(
            Path("fake.pdf"),
            _test_config(),
            client=cast("AsyncOpenAI", client),
            run_id="testrun1",
        )
    )
    records = _read_jsonl(log_file)
    assert records, "expected JSONL lines"
    assert {r["run"] for r in records} == {"testrun1"}
    events = [r["event"] for r in records]
    assert events[0] == "extracted"
    assert "page_completed" in events and "page_failed" in events
    assert events[-1] == "pages_done"
    assert all("ts" in r for r in records)
    completed = next(r for r in records if r["event"] == "page_completed")
    assert completed["method"] == "llm" and completed["page"] == 1
    assert isinstance(completed["llm_seconds"], float)
    summary = next(r for r in records if r["event"] == "pages_done")
    assert summary["pages"] == 2 and summary["pages_ok"] == 1
    assert summary["wall_seconds"] >= summary["llm_sum_seconds"] >= 0


def test_configure_llm_logging_is_idempotent(tmp_path: Path) -> None:
    """Repeated setup for the same file attaches exactly one handler."""
    from backend.app.services.llm_logging import (
        configure_llm_logging,
        configured_log_files,
    )

    first = configure_llm_logging(tmp_path / "a.jsonl")
    second = configure_llm_logging(tmp_path / "a.jsonl")
    assert first == second
    assert configured_log_files().count(first.resolve()) == 1


def test_configure_llm_logging_env_default(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """No path resolves from LLM_OCR_LOG_FILE."""
    from backend.app.services.llm_logging import configure_llm_logging

    monkeypatch.setenv("LLM_OCR_LOG_FILE", str(tmp_path / "env.jsonl"))
    assert configure_llm_logging() == tmp_path / "env.jsonl"


def test_extract_real_pdf_images() -> None:
    """Smoke test: real extraction finds one image per page on the sample book."""
    contents = svc.extract_pdf_pages(SMALL_BOOK)
    assert len(contents) == 10
    assert all(len(c.images) == 1 for c in contents)
    assert all(mime == "image/jpeg" for c in contents for _, mime in c.images)


# ---------------------------------------------------------------------------
# API tests (fake LLM, real HTTP routing)
# ---------------------------------------------------------------------------

llm_api_client = TestClient(app)


def _run_job_to_completion(filename: str, pdf_bytes: bytes, timeout_s: float = 60.0) -> str:
    """Drive an LLM job on a real event loop (TestClient never runs `create_task` work).

    HTTP is still used for all status/result assertions — only completion is
    driven here.
    """

    async def _drive() -> str:
        job_id = create_llm_ocr_job(filename, pdf_bytes, PostprocessOptions(), LLMConfig.from_env())
        deadline = asyncio.get_running_loop().time() + timeout_s
        while asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
            job = get_llm_job(job_id)
            assert job is not None
            if job.status in ("done", "error"):
                return job_id
        raise TimeoutError(f"LLM job {job_id} did not finish in {timeout_s}s")

    return asyncio.run(_drive())


def _wait_llm_done(job_id: str, timeout_s: float = 30.0) -> dict:
    """Poll an LLM job over HTTP until terminal state; return the payload."""
    import time

    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        resp = llm_api_client.get(f"/api/ocr/llm/jobs/{job_id}")
        assert resp.status_code == 200
        data = resp.json()
        if data["status"] in ("done", "error"):
            return data
        time.sleep(0.2)
    raise TimeoutError(f"LLM job {job_id} did not finish in {timeout_s}s")


def _blank_pdf_bytes(pages: int = 3) -> bytes:
    """Build a small image-less PDF in memory."""
    import io

    from pypdf import PdfWriter

    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=100, height=100)
    buf = io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


def test_llm_jobs_reject_non_pdf() -> None:
    """LLM job creation rejects non-PDF uploads like the Docling endpoint."""
    resp = llm_api_client.post(
        "/api/ocr/llm/jobs", files={"file": ("test.txt", b"not a pdf", "text/plain")}
    )
    assert resp.status_code == 400


def test_llm_job_unknown_id_404() -> None:
    """Unknown LLM job ids return 404."""
    assert llm_api_client.get("/api/ocr/llm/jobs/nope").status_code == 404


def test_llm_job_blank_pdf_needs_no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    """Image-less PDF completes without any LLM traffic, markers included."""

    def _fail_if_created(_base_url: str) -> Any:
        raise AssertionError("no LLM client should be needed without images")

    monkeypatch.setattr(svc, "create_llm_client", _fail_if_created)
    job_id = _run_job_to_completion("blank.pdf", _blank_pdf_bytes())
    data = _wait_llm_done(job_id)
    assert data["status"] == "done"
    assert data["result"]["meta"]["engine"] == "llm-ocr"
    assert data["result"]["meta"]["pageCount"] == 3
    assert "\n\nPage 2.\n\n" in data["result"]["markdown"]


def test_llm_job_orders_pages_and_marks(monkeypatch: pytest.MonkeyPatch) -> None:
    """LLM job joins page texts in order with `Page N.` markers."""

    def _fast_pages(_pdf_path: Path) -> list[PDFPageContent]:
        return _image_contents(3)

    monkeypatch.setattr(svc, "extract_pdf_pages", _fast_pages)
    monkeypatch.setattr(
        svc,
        "create_llm_client",
        lambda _base_url: cast(
            "AsyncOpenAI", FakeClient([(0.0, "Alpha."), (0.0, "Beta."), (0.0, "Gamma.")])
        ),
    )
    resp = llm_api_client.post(
        "/api/ocr/llm/jobs",
        files={"file": ("scan.pdf", _blank_pdf_bytes(3), "application/pdf")},
    )
    assert resp.status_code == 202
    assert "job_id" in resp.json()
    job_id = _run_job_to_completion("scan.pdf", _blank_pdf_bytes(3))
    data = _wait_llm_done(job_id)
    assert data["status"] == "done"
    md = data["result"]["markdown"]
    assert md.index("Alpha.") < md.index("Page 2.") < md.index("Beta.")
    assert "Page 3." in md
    assert [p["page"] for p in data["result"]["page_map"]] == [1, 2, 3]

    md_resp = llm_api_client.get(f"/api/ocr/llm/jobs/{job_id}/markdown")
    assert md_resp.status_code == 200
    assert "Alpha." in md_resp.text


def test_llm_sync_alias(monkeypatch: pytest.MonkeyPatch) -> None:
    """Synchronous LLM alias returns OCR output directly."""
    monkeypatch.setattr(svc, "extract_pdf_pages", lambda _p: _image_contents(1))
    monkeypatch.setattr(
        svc,
        "create_llm_client",
        lambda _base_url: cast("AsyncOpenAI", FakeClient([(0.0, "Solo.")])),
    )
    resp = llm_api_client.post(
        "/api/ocr/llm", files={"file": ("scan.pdf", _blank_pdf_bytes(1), "application/pdf")}
    )
    assert resp.status_code == 200
    assert "Solo." in resp.json()["markdown"]
