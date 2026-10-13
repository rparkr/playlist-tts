"""HTML → Markdown via `readability-lxml` + `markdownify`.

Shared extraction used by article fetching and ePub chapter conversion:
`readability` isolates the readable article content (keeping images on
request) and `markdownify` renders that fragment as Markdown with a
consistent shape (ATX headings, `-` bullets).
"""

import re
from html import escape

import markdownify
import readability

_BODY_TAG_RE = re.compile(r"<body[^>]*>", re.IGNORECASE)
_HEAD_RE = re.compile(r"<head\b[^>]*>.*?</head\s*>", re.IGNORECASE | re.DOTALL)
_SCRIPT_STYLE_RE = re.compile(r"<(script|style)\b[^>]*>.*?</\1\s*>", re.IGNORECASE | re.DOTALL)

_NO_TITLE = "[no-title]"

_MARKDOWNIFY_OPTIONS: dict = {
    # Single hyphen for bullets, to simplify parsing and reading.
    "bullets": "-",
    # `#`-style headings rather than underlined style.
    "heading_style": "ATX",
    # Keep images nested in common content wrappers.
    "keep_inline_images_in": [
        "div",
        "p",
        "tr",
        "td",
        "th",
        "body",
        "span",
        "img",
        "a",
        "figure",
        "source",
        "picture",
    ],
    "sub_symbol": "<sub>",
    "sup_symbol": "<sup>",
}


def _readable_title(doc: readability.Document) -> str | None:
    """Best-effort document title (`None` when readability has none)."""
    try:
        title = doc.title()
    except Exception:
        return None
    if not title:
        return None
    title = title.strip()
    if not title or title == _NO_TITLE:
        return None
    return title


def html_to_markdown(
    html: str,
    url: str | None = None,
    *,
    prepend_title: bool = True,
    keep_images: bool = True,
) -> tuple[str, str | None]:
    """Extract readable content from `html` and render it as Markdown.

    Returns the `(markdown, title)` pair; `markdown` may be empty when
    nothing readable survives (callers decide how to surface that).
    Raises on unparseable input (e.g. empty documents).
    """
    doc = readability.Document(html, url=url) if url else readability.Document(html)
    title = _readable_title(doc)
    summary = doc.summary(keep_all_images=keep_images)
    if prepend_title and title:
        heading = f"<h1>{escape(title)}</h1>"
        match = _BODY_TAG_RE.search(summary)
        summary = (
            f"{summary[: match.end()]}{heading}{summary[match.end() :]}"
            if match
            else f"{heading}{summary}"
        )
    markdown = markdownify.markdownify(html=summary, **_MARKDOWNIFY_OPTIONS)
    return (markdown.strip() if markdown else "", title)


def render_markdown(html: str) -> str:
    """Render already-clean HTML straight to Markdown (no boilerplate removal).

    For inputs that *are* the content (e.g. ePub spine chapters), skipping
    `readability` preserves full recall: its boilerplate heuristic can
    discard short lists, tables, or sparse chapters. Drops `<head>`,
    `<script>`, and `<style>` first so metadata never leaks into the text.
    """
    text = _HEAD_RE.sub("", html)
    text = _SCRIPT_STYLE_RE.sub("", text)
    markdown = markdownify.markdownify(html=text, **_MARKDOWNIFY_OPTIONS)
    return markdown.strip() if markdown else ""
