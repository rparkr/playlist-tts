"""Tests for stateless article fetching (`POST /api/fetch/article`)."""

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services import article_service
from backend.app.services.article_service import ArticleFetchError, validate_url

client = TestClient(app)

ARTICLE_HTML = """<html><head><title>Wind Farms</title>
<meta name="author" content="Jane Doe">
<meta property="og:site_name" content="Energy Weekly">
</head><body><article>
<h1>Wind Farms</h1>
<p>Wind farms consist of multiple turbines that capture wind energy
and convert it into electricity.</p>
<p>Utility-scale turbines are usually rated around 1 to 2 megawatts each, but units as large as
10 megawatts have been installed in recent years across several offshore projects worldwide.</p>
<p>Every aspect of a turbine is intended to capture energy from the wind efficiently.</p>
</article></body></html>"""


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "ftp://example.com/x",
        "file:///etc/passwd",
        "http://localhost:8000/x",
        "http://127.0.0.1/x",
        "http://10.0.0.5/x",
        "http://192.168.1.10/x",
        "http://172.16.0.9/x",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/x",
    ],
)
def test_validate_url_rejects_nonpublic(bad):
    """SSRF guard: non-http(s) schemes, localhost, LAN, and cloud metadata IPs."""
    with pytest.raises(ArticleFetchError):
        validate_url(bad)


def test_fetch_article_endpoint(monkeypatch):
    """Article appears with Markdown, title, and domain (network mocked)."""
    monkeypatch.setattr(article_service, "validate_url", lambda url: url)

    async def fake_download(url: str) -> str:
        assert url == "https://example.com/wind-farms"
        return ARTICLE_HTML

    monkeypatch.setattr(article_service, "_download_html", fake_download)
    resp = client.post("/api/fetch/article", json={"url": "https://example.com/wind-farms"})
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "Wind farms consist of multiple turbines" in data["markdown"]
    assert data["title"] == "Wind Farms"
    assert data["domain"] == "example.com"


def test_article_markdown_leads_with_h1_title():
    """The title leads as `# h1` so listeners hear the article name first."""
    cleaned = article_service._clean_article_markdown(
        "Wind farms consist of turbines.\n\nMore text here.", "Wind Farms"
    )
    assert cleaned.startswith("# Wind Farms\n\n")
    assert "Wind farms consist of turbines." in cleaned


def test_article_markdown_drops_empty_headings_and_blank_runs():
    """Trafilatura's stray `#` + whitespace and 3+ newline runs are tidied."""
    cleaned = article_service._clean_article_markdown(
        "# \n\t\n\t\tWind Farms\n\n\n\nBody text here.", "Wind Farms"
    )
    assert "\n\n\n" not in cleaned
    assert not any(ln.startswith("#") and not ln[1:].strip() for ln in cleaned.split("\n"))
    assert cleaned.startswith("# Wind Farms\n\nBody text here.")


def test_fetch_article_endpoint_unreadable(monkeypatch):
    """Empty extraction surfaces as 422."""
    monkeypatch.setattr(article_service, "validate_url", lambda url: url)

    async def fake_download(url: str) -> str:
        return "<html><body></body></html>"

    monkeypatch.setattr(article_service, "_download_html", fake_download)
    resp = client.post("/api/fetch/article", json={"url": "https://example.com/empty"})
    assert resp.status_code == 422


def test_fetch_article_endpoint_blocked():
    """SSRF-blocked hosts surface as 400 without touching the network."""
    resp = client.post("/api/fetch/article", json={"url": "http://localhost:8000/x"})
    assert resp.status_code == 400
