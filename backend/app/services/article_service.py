"""Stateless article fetching — URL to Markdown via `readability` + `markdownify`.

No database: downloads the page, extracts readable Markdown, returns it.
The frontend persists the result in IndexedDB as a playlist item. Runs
fine on scale-to-zero hosts (Cloud Run) since nothing is stored server-side.

The download uses `httpx2` directly (20s timeout, ~5MB cap, custom UA);
extraction is `readability-lxml` (content isolation) followed by
`markdownify` (HTML → Markdown). Page metadata (author/site/date) comes
from the page's own `<meta>` tags via stdlib parsing.
"""

import ipaddress
import re
import socket
from contextlib import suppress
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlparse

import httpx2

from backend.app.services.html_to_markdown import html_to_markdown

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
            httpx2.AsyncClient(
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
    except httpx2.TimeoutException:
        raise ArticleFetchError("Fetch timed out after 20s.", 504) from None
    except httpx2.RequestError as e:
        raise ArticleFetchError(f"Fetch failed: {e}.", 502) from None
    charset = "utf-8"
    if "charset=" in content_type:
        charset = content_type.split("charset=")[-1].split(";")[0].strip() or "utf-8"
    try:
        return raw.decode(charset, errors="replace")
    except LookupError:
        return raw.decode("utf-8", errors="replace")


class _MetaParser(HTMLParser):
    """Collect `<meta>` content by name/property plus the `<title>` text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.values: dict[str, str] = {}
        self._in_title = False
        self._title_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        name = tag.lower()
        if name == "title":
            self._in_title = True
            return
        if name != "meta":
            return
        lookup = {k.lower(): (v or "") for k, v in attrs}
        key = lookup.get("name") or lookup.get("property") or lookup.get("itemprop")
        content = lookup.get("content", "").strip()
        if key and content and key.strip().lower() not in self.values:
            self.values[key.strip().lower()] = content

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self._title_parts.append(data)

    @property
    def title(self) -> str | None:
        """Raw `<title>` text, if any."""
        text = "".join(self._title_parts).strip()
        return text or None


def _first_meta(values: dict[str, str], *keys: str) -> str | None:
    """First present metadata value across candidate key names."""
    for key in keys:
        value = values.get(key)
        if value:
            return value
    return None


def _extract_meta(html: str) -> dict[str, str | None]:
    """Pull title/author/site/date/excerpt hints from the page's meta tags."""
    parser = _MetaParser()
    with suppress(Exception):
        parser.feed(html[:1_000_000])
    values = parser.values
    return {
        "title": _first_meta(values, "og:title", "twitter:title") or parser.title,
        "author": _first_meta(
            values, "author", "article:author", "og:author", "twitter:creator", "byl"
        ),
        "site": _first_meta(values, "og:site_name", "application-name"),
        "date": _first_meta(
            values,
            "article:published_time",
            "article:modified_time",
            "og:published_time",
            "datepublished",
            "date",
            "publish_date",
            "dc.date.issued",
        ),
        "excerpt": _first_meta(values, "description", "og:description", "twitter:description"),
    }


def _clean_article_markdown(markdown: str, title: str | None) -> str:
    """Tidy extracted Markdown for the reader.

    - Drop empty ATX headings (`#` followed by whitespace only).
    - Collapse 3+ newlines to a paragraph break.
    - Ensure the article title leads as an `# h1` so listeners hear the
      article name when it starts (and to tell consecutive items apart).
    - Drop a leading body line that duplicates the title.
    """
    lines = [ln for ln in markdown.split("\n") if not _EMPTY_HEADING_RE.match(ln)]
    text = _BLANK_RUN_RE.sub("\n\n", "\n".join(lines)).strip()
    if title:
        first, _, rest = text.partition("\n")
        if first.strip().strip("#").strip().lower() == title.strip().lower():
            text = rest.strip()
        if not text.startswith(f"# {title}"):
            text = f"# {title}\n\n{text}" if text else f"# {title}"
    return text


_EMPTY_HEADING_RE = re.compile(r"^#{1,6}\s*$")
_BLANK_RUN_RE = re.compile(r"\n{3,}")


def _extract_markdown(html: str, url: str) -> ArticleResult:
    """Run `readability` + `markdownify` extraction and metadata parsing."""
    try:
        markdown, readable_title = html_to_markdown(html, url=url)
    except Exception:
        raise ArticleFetchError("No readable article content found at that URL.", 422) from None
    if not markdown or not markdown.strip():
        raise ArticleFetchError("No readable article content found at that URL.", 422)
    meta = _extract_meta(html)
    title = readable_title or meta["title"]
    cleaned = _clean_article_markdown(markdown, title)
    if not cleaned:
        raise ArticleFetchError("No readable article content found at that URL.", 422)
    domain = urlparse(url).hostname or ""
    excerpt_source = cleaned.replace("\n", " ")
    return ArticleResult(
        markdown=cleaned,
        title=title,
        author=meta["author"],
        site=meta["site"],
        date=meta["date"],
        excerpt=excerpt_source[:280] if excerpt_source else None,
        url=url,
        domain=domain.lower(),
    )


async def fetch_article(url: str) -> ArticleResult:
    """Validate, download, and extract an article URL to Markdown."""
    normalized = validate_url(url)
    html = await _download_html(normalized)
    return _extract_markdown(html, normalized)
