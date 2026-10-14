"""Stateless ePub conversion — book chapters to Markdown.

No database: unzips the ePub (stdlib `zipfile`), walks the OPF spine in
order, renders each chapter's XHTML with `markdownify`, and concatenates
the chapters under `##` headers.

Spine chapters skip `readability`: unlike web pages they contain no
boilerplate to remove — they *are* the content — and its stripping
heuristic can discard short lists, tables, or sparse chapters. Direct
rendering keeps full recall.

Images are kept, not dropped: `markdownify` renders each `<img>` as an
`![alt](src)` ref, whose `src` is resolved against the chapter location
and rewritten to the OPF-relative path. The referenced image binaries
are returned alongside the Markdown; the frontend persists them in
IndexedDB and resolves the relative refs at render time.

Stateless and Cloud Run-compatible (nothing stored server-side). Rejects
DRM-encrypted books (`META-INF/encryption.xml`) with 422.
"""

import io
import posixpath
import re
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

from backend.app.services.html_to_markdown import render_markdown

EPUB_MAX_BYTES = 100 * 1024 * 1024

_MD_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+\"[^\"]*\")?\s*\)")
_CHAPTER_PREAMBLE_RE = re.compile(r"<\?[^?]*\?>\s*|<!DOCTYPE[^>]*>\s*", re.IGNORECASE)
_HEADING_RE = re.compile(r"<h([1-3])\b[^>]*>(.*?)</h\1>", re.IGNORECASE | re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")


class EpubConvertError(Exception):
    """Conversion failure with an HTTP status for the endpoint."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class EpubImageData:
    """One image binary referenced from the book text."""

    path: str
    media_type: str
    data: bytes


@dataclass
class EpubResult:
    """Converted book content and metadata."""

    markdown: str
    title: str | None
    author: str | None
    images: list[EpubImageData] = field(default_factory=list)


def _local(tag: str) -> str:
    """Strip an XML namespace: `{ns}name` → `name`."""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _find_children(el: ET.Element, name: str) -> list[ET.Element]:
    """Namespace-tolerant child lookup by local tag name."""
    return [child for child in el if _local(child.tag) == name]


def _find_first(el: ET.Element, *path: str) -> ET.Element | None:
    """Namespace-tolerant descent along local tag names."""
    node: ET.Element | None = el
    for name in path:
        if node is None:
            return None
        node = next((c for c in node if _local(c.tag) == name), None)
    return node


def _text_of(el: ET.Element | None) -> str:
    """Concatenated text content of an element subtree."""
    if el is None:
        return ""
    return "".join(el.itertext()).strip()


def _opf_rootfile(data: bytes) -> str:
    """Locate the OPF package path via `META-INF/container.xml`."""
    try:
        root = ET.fromstring(data)
    except ET.ParseError as e:
        raise EpubConvertError("Invalid ePub: unreadable container.xml.", 400) from e
    for el in root.iter():
        if _local(el.tag) == "rootfile":
            path = el.get("full-path", "")
            if path:
                return path
    raise EpubConvertError("Invalid ePub: no OPF rootfile in container.xml.", 400)


def _ncx_labels(zf: zipfile.ZipFile, base: str) -> dict[str, str]:
    """Map chapter href (relative to OPF dir) → NCX nav label."""
    labels: dict[str, str] = {}
    for name in zf.namelist():
        if not name.lower().endswith(".ncx"):
            continue
        try:
            root = ET.fromstring(zf.read(name))
        except ET.ParseError:
            continue
        for el in root.iter():
            if _local(el.tag) != "navPoint":
                continue
            label_el = _find_first(el, "navLabel", "text")
            content_el = _find_first(el, "content")
            if label_el is None or content_el is None:
                continue
            src = content_el.get("src", "").split("#")[0]
            label = _text_of(label_el)
            if src and label:
                key = (
                    posixpath.normpath(posixpath.join(base, src))
                    if base
                    else posixpath.normpath(src)
                )
                labels.setdefault(
                    key[len(base) + 1 :] if base and key.startswith(base + "/") else key, label
                )
    return labels


def _chapter_title(raw_html: str, ncx_label: str | None, fallback: str) -> str:
    """Best chapter heading: NCX label, else first h1–h3, else filename stem."""
    if ncx_label:
        return ncx_label
    match = _HEADING_RE.search(raw_html)
    if match:
        text = _TAG_RE.sub("", match.group(2)).strip()
        text = re.sub(r"\s+", " ", text)
        if text:
            return text
    return fallback.replace("_", " ").replace("-", " ").strip().title() or fallback


def _resolve_chapter_path(src: str, chapter_dir: str, opf_dir: str) -> str | None:
    """Resolve an image `src` to a zip path, relative to the OPF directory."""
    if not src or src.startswith(("data:", "http://", "https://", "mailto:")):
        return None
    clean = src.split("#")[0].split("?")[0].strip()
    if not clean:
        return None
    abs_path = posixpath.normpath(posixpath.join(chapter_dir, clean))
    if opf_dir and abs_path.startswith(opf_dir + "/"):
        return abs_path[len(opf_dir) + 1 :]
    if not opf_dir:
        return abs_path.lstrip("/")
    return None


def _resolve_image_refs(
    markdown: str,
    zf: zipfile.ZipFile,
    chapter_dir: str,
    opf_dir: str,
    media_by_href: dict[str, str],
    images: dict[str, EpubImageData],
) -> str:
    """Resolve Markdown `![alt](src)` refs to OPF-relative paths.

    Collects each resolvable image binary into `images`; unresolvable
    refs (remote URLs, missing files) are dropped.
    """

    def _repl(match: re.Match[str]) -> str:
        alt, src = match.group(1), match.group(2).strip()
        if src.startswith("<") and src.endswith(">"):
            src = src[1:-1].strip()
        resolved = _resolve_chapter_path(src, chapter_dir, opf_dir)
        if resolved is None:
            return ""
        img_zip = (opf_dir + "/" + resolved) if opf_dir else resolved
        try:
            blob = zf.read(img_zip)
        except KeyError:
            return ""
        media = media_by_href.get(resolved, "")
        images.setdefault(
            resolved, EpubImageData(path=resolved, media_type=media or "image/png", data=blob)
        )
        alt_text = alt.strip() or posixpath.basename(resolved)
        return f"![{alt_text}]({resolved})"

    return _MD_IMAGE_RE.sub(_repl, markdown)


def _starts_with_heading(markdown: str, label: str) -> bool:
    """True when the text already opens with an equivalent `#` heading."""
    first = next((ln for ln in markdown.split("\n") if ln.strip()), "")
    if not first.lstrip().startswith("#"):
        return False
    heading = first.lstrip("#").strip().rstrip(":").lower()
    return bool(heading) and heading == label.strip().rstrip(":").lower()


def _strip_leading_heading(markdown: str) -> str:
    """Drop the first non-blank line (an ATX heading the caller matched)."""
    lines = markdown.split("\n")
    for i, line in enumerate(lines):
        if line.strip():
            return "\n".join(lines[i + 1 :]).strip()
    return ""


def convert_epub(data: bytes) -> EpubResult:
    """Convert ePub bytes to Markdown, metadata, and image binaries."""
    if len(data) > EPUB_MAX_BYTES:
        raise EpubConvertError("ePub exceeds the 100 MB convert limit.", 413)
    if not data.startswith(b"PK\x03\x04"):
        raise EpubConvertError("Not an ePub file (missing zip signature).", 400)
    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise EpubConvertError("Not a readable zip archive.", 400) from e

    names = zf.namelist()
    if any(n.upper() == "META-INF/ENCRYPTION.XML" for n in names):
        raise EpubConvertError("DRM-encrypted ePub is not supported.", 422)
    if "mimetype" not in names:
        raise EpubConvertError("Not an ePub file (missing mimetype).", 400)

    try:
        container = zf.read("META-INF/container.xml")
    except KeyError as e:
        raise EpubConvertError("Invalid ePub: missing META-INF/container.xml.", 400) from e
    opf_path = _opf_rootfile(container)
    opf_dir = posixpath.dirname(opf_path)

    def _rel(name: str) -> str:
        return name[len(opf_dir) + 1 :] if opf_dir and name.startswith(opf_dir + "/") else name

    try:
        opf = ET.fromstring(zf.read(opf_path))
    except (KeyError, ET.ParseError) as e:
        raise EpubConvertError("Invalid ePub: unreadable OPF package.", 400) from e

    metadata = _find_first(opf, "metadata")
    title = _text_of(_find_first(metadata, "title")) if metadata is not None else ""
    author = _text_of(_find_first(metadata, "creator")) if metadata is not None else ""

    manifest_el = _find_first(opf, "manifest")
    manifest: dict[str, tuple[str, str]] = {}
    media_by_href: dict[str, str] = {}
    if manifest_el is not None:
        for item in _find_children(manifest_el, "item"):
            item_id = item.get("id", "")
            href = item.get("href", "")
            media_type = item.get("media-type", "")
            if item_id and href:
                full = (
                    posixpath.normpath(posixpath.join(opf_dir, href))
                    if opf_dir
                    else posixpath.normpath(href)
                )
                rel = _rel(full)
                manifest[item_id] = (rel, media_type)
                if media_type:
                    media_by_href[rel] = media_type

    spine_el = _find_first(opf, "spine")
    spine: list[str] = []
    if spine_el is not None:
        spine = [
            ref.get("idref", "") for ref in _find_children(spine_el, "itemref") if ref.get("idref")
        ]
    if not spine:
        raise EpubConvertError("Invalid ePub: empty spine.", 400)

    labels = _ncx_labels(zf, opf_dir)
    images: dict[str, EpubImageData] = {}
    chapters: list[str] = []

    for idref in spine:
        entry = manifest.get(idref)
        if entry is None:
            continue
        rel_href, media_type = entry
        if "html" not in media_type and not rel_href.lower().endswith((".xhtml", ".html", ".htm")):
            continue
        zip_path = (opf_dir + "/" + rel_href) if opf_dir else rel_href
        try:
            raw_html = zf.read(zip_path).decode("utf-8", errors="replace")
        except KeyError:
            continue
        chapter_dir = posixpath.dirname(zip_path)
        chapter_key = _rel(zip_path)
        label = _chapter_title(raw_html, labels.get(chapter_key), posixpath.basename(rel_href))

        # Real-world chapters open with an XML declaration / DOCTYPE that
        # markdownify keeps as literal text (and that breaks chapter-heading
        # folding below, duplicating the heading). Strip it first.
        raw_html = _CHAPTER_PREAMBLE_RE.sub("", raw_html)
        try:
            markdown = render_markdown(raw_html)
        except Exception:
            markdown = ""
        seen_images = len(images)
        markdown = _resolve_image_refs(
            markdown, zf, chapter_dir, opf_dir, media_by_href, images
        ).strip()
        # Image-only pages (cover art): readability yields an empty body,
        # but the kept `<img>` refs still resolve above.
        if not markdown and len(images) == seen_images:
            continue
        if markdown and label != title and not _starts_with_heading(markdown, label):
            markdown = f"## {label}\n\n{markdown}"
        elif markdown and label != title:
            # `readability` keeps the chapter's own `<h1>` — fold it into
            # the `##` label header so chapters stay uniformly nested.
            rest = _strip_leading_heading(markdown)
            markdown = f"## {label}\n\n{rest}" if rest else f"## {label}"
        elif not markdown:
            markdown = f"## {label}" if label != title else ""
            if not markdown:
                continue
        chapters.append(markdown)

    if not chapters:
        raise EpubConvertError("No readable chapters found in ePub.", 422)

    body = "\n\n".join(chapters).strip()
    if title and not body.startswith(f"# {title}"):
        body = f"# {title}\n\n{body}"
    return EpubResult(
        markdown=re.sub(r"\n{3,}", "\n\n", body).strip(),
        title=title or None,
        author=author or None,
        images=list(images.values()),
    )
