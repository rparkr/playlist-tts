"""Stateless article fetching — URL to Markdown via `trafilatura`.

No database: downloads the page, extracts readable Markdown, returns it.
The frontend persists the result in IndexedDB as a playlist item. Runs
fine on scale-to-zero hosts (Cloud Run) since nothing is stored server-side.

`trafilatura.fetch_url` has no timeout/size knobs, so the download uses
`httpx` directly (20s timeout, ~5MB cap, custom UA) and `trafilatura` only
for extraction.
"""

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx
import trafilatura
from trafilatura.metadata import extract_metadata

FETCH_TIMEOUT_SECONDS = 20
FETCH_MAX_BYTES = 5 * 1024 * 1024
FETCH_USER_AGENT = "OCR-TTS-Reader/1.0 (+https://github.com/anomalyco/ocr-tts)"

_BLOCKED_HOSTNAMES = {"localhost", "localhost.", "ip6-localhost"}


@dataclass
class ArticleResult:
    """Extracted article content and metadata."""

    markdown: str
    title: str | None
    author: str | None
    site: str | None
    date: str | None
    excerpt: str | None
    url: str
    domain: str


class ArticleFetchError(Exception):
    """Fetch failure with an HTTP status for the endpoint."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def _reject_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address, what: str) -> None:
    """Reject non-public IPs (SSRF guard for cloud metadata and LAN)."""
    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    ):
        raise ArticleFetchError(f"Refusing to fetch {what}: non-public address.", 400)


def validate_url(url: str) -> str:
    """Validate scheme/host and SSRF-guard the resolved address.

    Returns the normalized URL. Raises `ArticleFetchError` on rejection.
    """
    candidate = (url or "").strip()
    if not candidate:
        raise ArticleFetchError("Missing URL.", 400)
    if len(candidate) > 2048:
        raise ArticleFetchError("URL too long.", 400)
    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    if parsed.scheme not in ("http", "https"):
        raise ArticleFetchError("Only http/https URLs are supported.", 400)
    host = (parsed.hostname or "").lower()
    if not host or host in _BLOCKED_HOSTNAMES:
        raise ArticleFetchError(f"Refusing to fetch {host or 'empty host'}.", 400)
    try:
        literal = ipaddress.ip_address(host.strip("[]"))
        _reject_ip(literal, host)
    except ValueError:
        pass  # hostname — checked via DNS below
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise ArticleFetchError(f"Could not resolve {host}.", 400) from None
    for info in infos:
        try:
            _reject_ip(ipaddress.ip_address(info[4][0]), host)
        except ValueError:
            continue
    return parsed.geturl()


async def _download_html(url: str) -> str:
    """Download page HTML with timeout and size cap."""
    try:
        async with (
            httpx.AsyncClient(
                timeout=FETCH_TIMEOUT_SECONDS,
                follow_redirects=True,
                max_redirects=5,
                headers={"User-Agent": FETCH_USER_AGENT, "Accept": "text/html,*/*"},
            ) as client,
            client.stream("GET", url) as resp,
        ):
            if resp.status_code >= 400:
                raise ArticleFetchError(
                    f"Fetch failed with status {resp.status_code}.",
                    400 if resp.status_code < 500 else 502,
                )
            content_type = resp.headers.get("content-type", "")
            if "pdf" in content_type.lower() or url.lower().split("?")[0].endswith(".pdf"):
                raise ArticleFetchError(
                    "URL looks like a PDF — use the PDF-URL import path instead.", 422
                )
            length = resp.headers.get("content-length")
            if length is not None and length.isdigit() and int(length) > FETCH_MAX_BYTES:
                raise ArticleFetchError("Page exceeds the 5 MB fetch limit.", 413)
            chunks: list[bytes] = []
            total = 0
            async for chunk in resp.aiter_bytes(65536):
                total += len(chunk)
                if total > FETCH_MAX_BYTES:
                    raise ArticleFetchError("Page exceeds the 5 MB fetch limit.", 413)
                chunks.append(chunk)
            raw = b"".join(chunks)
    except ArticleFetchError:
        raise
    except httpx.TimeoutException:
        raise ArticleFetchError("Fetch timed out after 20s.", 504) from None
    except httpx.RequestError as e:
        raise ArticleFetchError(f"Fetch failed: {e}.", 502) from None
    charset = "utf-8"
    if "charset=" in content_type:
        charset = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


def _extract_markdown(html: str, url: str) -> ArticleResult:
    """Run `trafilatura` extraction and metadata parsing (sync, CPU-bound)."""
    markdown = trafilatura.extract(
        html,
        url=url,
        output_format="markdown",
        include_formatting=True,
        include_links=True,
        include_tables=True,
        include_images=True,
        with_metadata=False,
    )
    if not markdown or not markdown.strip():
        raise ArticleFetchError("No readable article content found at that URL.", 422)
    meta = None
    try:
        meta = extract_metadata(html, default_url=url)
    except Exception:
        meta = None
    domain = urlparse(url).hostname or ""
    excerpt_source = markdown.strip().replace("\n", " ")
    return ArticleResult(
        markdown=markdown.strip(),
        title=getattr(meta, "title", None) or None,
        author=getattr(meta, "author", None) or None,
        site=getattr(meta, "sitename", None) or None,
        date=getattr(meta, "date", None) or None,
        excerpt=excerpt_source[:280] if excerpt_source else None,
        url=url,
        domain=domain.lower(),
    )


async def fetch_article(url: str) -> ArticleResult:
    """Validate, download, and extract an article URL to Markdown."""
    normalized = validate_url(url)
    html = await _download_html(normalized)
    return _extract_markdown(html, normalized)
