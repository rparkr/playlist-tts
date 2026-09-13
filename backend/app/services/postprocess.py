"""Post-processing pipeline for OCR Markdown — TTS readiness."""

import re
from collections.abc import Callable

from backend.app.models.schemas import PageMapItem, PostprocessOptions, Section

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$")
_CODE_FENCE_RE = re.compile(r"^\s*```")
_TABLE_RE = re.compile(r"^\s*\|.*\|\s*$")

# Terminal punctuation including optional closing quote/parens — used to decide
# whether a paragraph ends a sentence.  Handles:  .  ."  .'  ?"  .") etc.
_TERMINAL_RE = re.compile(r'[.!?…]["\'\)\]]*\s*$')
# For headers — same idea but without trailing whitespace concern
_HEADER_TERMINAL_RE = re.compile(r'[.!?…]["\'\)\]]*\s*$')

# Uppercase word detection
_UPPER_WORD_RE = re.compile(r"\b[A-Z]{2,}\b")

# Sentence split that respects closing quotes — e.g. 'end." Next'
_SENTENCE_SPLIT_RE = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"\'])')
# Stray leading quotes after split are stripped in post-cleanup; an optional
# closing quote stays with the prior sentence via _TERMINAL_RE detection

# Line-break hyphenation: a word split across lines/columns as `dete- rioration`
# or `dete-\nrioration`. Letters-only on both sides so digit ranges (`1990- 1995`)
# and spaced dashes (`word - word`) are left alone. `fiber-optic` (no space)
# is also untouched.
_DEHYPHEN_RE = re.compile(r"(?<=[A-Za-z])-\s+(?=[A-Za-z])")
# Soft hyphen (U+00AD) — invisible break hint; always drop, incl. trailing space.
_SOFT_HYPHEN_RE = re.compile(r"­\s*")


_IMAGE_COMMENT_RE = re.compile(r"^\s*<!--\s*image\s*-->\s*$", re.IGNORECASE)
_HTML_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)

#: Docling page-break placeholder emitted via `export_to_markdown(
#: page_break_placeholder=PAGE_BREAK_PLACEHOLDER)`. True page boundaries —
#: unlike the even-split fallback in `build_page_map`, these never fall
#: inside a two-column page.
PAGE_BREAK_PLACEHOLDER = "<!-- page break -->"
_PAGE_BREAK_LINE_RE = re.compile(r"^\s*<!--\s*page\s*break\s*-->\s*$", re.IGNORECASE)
# Inline occurrence (same line as text) — split around it.
_PAGE_BREAK_INLINE_RE = re.compile(r"<!--\s*page\s*break\s*-->", re.IGNORECASE)
_TERM_FORWARD_RE = re.compile(r'[.!?…]["\'\)\]]*(?=\s|$)')


def _strip_image_artifacts(markdown: str) -> str:
    """Remove Docling image placeholders and HTML comments.

    Docling emits `<!-- image -->` and often a stray `Other` on the next
    line as an artifact; both are removed. Inline `<!-- ... -->` comments
    are stripped but surrounding text is kept. Page-break placeholders
    (`<!-- page break -->`) are preserved — they carry true page
    boundaries needed to avoid numbering columns as pages.
    """
    lines = markdown.split("\n")
    out: list[str] = []
    skip_next_other = False
    for line in lines:
        stripped = line.strip()
        if _PAGE_BREAK_LINE_RE.match(line):
            if skip_next_other and stripped != "":
                skip_next_other = False
            out.append(PAGE_BREAK_PLACEHOLDER)
            continue
        if _IMAGE_COMMENT_RE.match(line):
            skip_next_other = True
            continue
        if skip_next_other and stripped == "Other":
            skip_next_other = False
            continue
        # Reset flag if next line is not Other (only skip immediate Other)
        if skip_next_other and stripped != "":
            skip_next_other = False
        if "<!--" in line and "-->" in line:
            if _PAGE_BREAK_INLINE_RE.search(line):
                # Keep page-break token, strip any other comments on the line.
                kept = _PAGE_BREAK_INLINE_RE.search(line)
                assert kept is not None
                before = _HTML_COMMENT_RE.sub("", line[: kept.start()]).strip()
                after = _HTML_COMMENT_RE.sub("", line[kept.end() :]).strip()
                if before:
                    out.append(before)
                out.append(PAGE_BREAK_PLACEHOLDER)
                if after:
                    out.append(after)
                continue
            cleaned = _HTML_COMMENT_RE.sub("", line).strip()
            if not cleaned:
                continue
            line = cleaned
        out.append(line)
    return "\n".join(out)


def _is_special_block(line: str) -> bool:
    """Return True for lines that should never be merged or mutated."""
    stripped = line.strip()
    if not stripped:
        return False
    if _PAGE_BREAK_LINE_RE.match(line):
        # Page boundary — never merge columns across pages.
        return True
    if _CODE_FENCE_RE.match(line):
        return True
    if stripped.startswith(">"):
        return True
    return bool(_TABLE_RE.match(line))


def _ends_with_terminal(text: str) -> bool:
    """Check if text ends with terminal punctuation (quote-aware)."""
    return bool(_TERMINAL_RE.search(text.strip()))


def dehyphenate(markdown: str) -> str:
    """Join words split by line-break hyphenation.

    Fixes OCR artifacts like `dete- rioration` → `deterioration`,
    `combi- nation` → `combination`, and `dete-\\nrioration` (hyphen +
    newline inside a paragraph). Only the hyphen + whitespace between two
    letters is removed, so `fiber-optic`, `word - word`, and digit ranges
    are left alone.

    Code fences are left untouched; page-break placeholders are preserved.
    """

    def _fix_chunk(chunk: str) -> str:
        chunk = _SOFT_HYPHEN_RE.sub("", chunk)
        return _DEHYPHEN_RE.sub("", chunk)

    # Apply outside fenced code blocks (regex spans newlines, so a
    # line-wise map would miss `word-\\ncontinuation`).
    parts = markdown.split("```")
    for i in range(0, len(parts), 2):
        parts[i] = _fix_chunk(parts[i])
    return "```".join(parts)


# ---------------------------------------------------------------------------
# 1. Reflow columns / page-break sentence splits
# ---------------------------------------------------------------------------


def reflow_columns(markdown: str) -> str:
    """Merge trailing paragraphs where sentence continues across column/page.

    Heuristic: paragraph without terminal punctuation (.!?… plus optional
    closing quote/paren) and next paragraph starts with lowercase (or digit)
    without header/list marker → join with space, re-split into sentences.
    """
    # Preserve code fences — split while tracking fence state
    lines = markdown.split("\n")
    # First, split into paragraph blocks separated by blank lines
    paras: list[str] = []
    buf: list[str] = []
    in_fence = False

    def flush_buf() -> None:
        if buf:
            paras.append("\n".join(buf))
            buf.clear()

    for line in lines:
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            buf.append(line)
            if not in_fence:
                flush_buf()
            continue
        if in_fence:
            buf.append(line)
            continue
        if line.strip() == "":
            flush_buf()
        else:
            # Keep header lines as separate paras to avoid merging across headers
            if _HEADING_RE.match(line.strip()) or _is_special_block(line):
                flush_buf()
                paras.append(line)
            else:
                buf.append(line)
    flush_buf()

    if not paras:
        return markdown

    result_paras: list[str] = []
    i = 0
    while i < len(paras):
        cur = paras[i].strip()
        # Never merge headers / special blocks / code fences
        is_header = bool(_HEADING_RE.match(cur))
        is_special = _is_special_block(cur) or "```" in cur

        if is_header or is_special:
            result_paras.append(cur)
            i += 1
            continue

        # If not terminal (or ends with hyphen) and next exists
        ends_terminal = _ends_with_terminal(cur)
        ends_hyphen = cur.rstrip().endswith("-")
        if (not ends_terminal or ends_hyphen) and i + 1 < len(paras):
            nxt = paras[i + 1].strip()
            nxt_is_header = bool(_HEADING_RE.match(nxt))
            nxt_is_special = _is_special_block(nxt) or "```" in nxt
            if not nxt_is_header and not nxt_is_special:
                nxt_stripped = nxt.lstrip()
                should_merge = bool(
                    nxt_stripped
                    and (
                        ends_hyphen
                        or nxt_stripped[0].islower()
                        or nxt_stripped[0].isdigit()
                        or nxt_stripped[0] == "("
                    )
                )
                # A mid-sentence fragment can continue on the next page even if
                # the continuation starts uppercase (page break artefact).
                # Heuristic: `cur` lacks terminal punctuation and `nxt` does not
                # look like a new-sentence start — treat as continuation.
                # For hyphenated breaks, always merge.
                if should_merge:
                    if ends_hyphen:
                        merged = cur.rstrip()[:-1] + nxt_stripped
                    else:
                        merged = cur + " " + nxt_stripped
                    sentences = [s.strip() for s in _SENTENCE_SPLIT_RE.split(merged) if s.strip()]
                    if len(sentences) >= 2:
                        result_paras.append(sentences[0])
                        remainder = " ".join(sentences[1:])
                        paras[i + 1] = remainder
                    else:
                        result_paras.append(merged)
                        i += 2
                        continue
                    i += 1
                    continue

        result_paras.append(cur)
        i += 1

    # Re-assemble with double newline — headers already have single-line handling
    # Preserve original behaviour: headers separated by blank lines via flush logic
    return "\n\n".join(result_paras)


# ---------------------------------------------------------------------------
# 2. Uppercase normalization
# ---------------------------------------------------------------------------


def _map_lines_outside_fences(markdown: str, func: Callable[[str], str]) -> str:
    """Apply func to each line outside fenced code blocks."""
    lines = markdown.split("\n")
    out_lines: list[str] = []
    in_fence = False
    for line in lines:
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            out_lines.append(line)
            continue
        if in_fence:
            out_lines.append(line)
            continue
        out_lines.append(func(line))
    return "\n".join(out_lines)


def normalize_uppercase(markdown: str) -> str:
    """Normalize uppercase spans to Title Case for TTS.

    - Any isolated all-uppercase word with length >= 5 → Title Case
      (e.g. `WATER` → `Water`); shorter words stay as-is so acronyms
      like `NASA` are preserved.
    - Any run of ≥2 consecutive all-uppercase words → Title Case
      (e.g. `SAIL BOAT` → `Sail Boat`), regardless of word length.
    """

    def _normalize_line(line: str) -> str:
        # Tokenize preserving separators.
        tokens = re.split(r"(\W+)", line)
        is_upper = [bool(_UPPER_WORD_RE.fullmatch(t)) for t in tokens]
        i = 0
        while i < len(tokens):
            if is_upper[i]:
                j = i
                while j < len(tokens) and (
                    is_upper[j]
                    or (tokens[j].strip() == "" and j + 1 < len(tokens) and is_upper[j + 1])
                ):
                    # Skip spaces between uppers — include them in run
                    j += 1
                    if j < len(tokens) and tokens[j].strip() == "":
                        # include single space
                        if j + 1 < len(tokens) and is_upper[j + 1]:
                            j += 1
                            continue
                        else:
                            break
                # Count actual upper words in run
                run_uppers = sum(1 for k in range(i, j) if is_upper[k])
                if run_uppers >= 2:
                    for k in range(i, j):
                        if is_upper[k]:
                            tokens[k] = tokens[k].title()
                elif run_uppers == 1:
                    for k in range(i, j):
                        if is_upper[k] and len(tokens[k]) >= 5:
                            tokens[k] = tokens[k].title()
                i = j
            else:
                i += 1
        return "".join(tokens)

    return _map_lines_outside_fences(markdown, _normalize_line)


# ---------------------------------------------------------------------------
# 3. Ensure punctuation
# ---------------------------------------------------------------------------


def ensure_punctuation(markdown: str) -> str:
    """Ensure headers and paragraphs end with terminal punctuation."""
    lines = markdown.split("\n")
    out: list[str] = []
    in_fence = False

    for line in lines:
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence:
            out.append(line)
            continue

        m = _HEADING_RE.match(line.strip())
        if m:
            hashes, title = m.groups()
            title = title.strip()
            if title and not _HEADER_TERMINAL_RE.search(title) and not _TABLE_RE.match(title):
                title = title + "."
            out.append(f"{hashes} {title}")
        elif _TABLE_RE.match(line) or line.strip() == "" or _is_special_block(line):
            out.append(line)
        else:
            # Don't mutate list/table rows globally; handled per line above.
            out.append(line)

    return "\n".join(out)


# ---------------------------------------------------------------------------
# 4. Page markers
# ---------------------------------------------------------------------------


def insert_page_markers(markdown: str, page_map: list[PageMapItem]) -> str:
    """Insert 'Page N.' markers at page boundaries after sentence completion.

    Assumes `page_map` is sorted ascending. Each marker is inserted as a
    standalone paragraph **after** the sentence that straddles the page
    boundary.

    If a boundary offset lands mid-sentence, the insertion is deferred
    forward to the next sentence terminal (`.!?…` plus optional closing
    quotes/brackets). If already at a sentence boundary the marker is kept
    at that boundary. This ensures `Page N` never splits a sentence.
    """
    if not page_map or len(page_map) <= 1:
        return markdown

    page_map_sorted = sorted(page_map, key=lambda x: x.page)
    result = markdown
    # Terminator with optional closing quotes/parens/brackets, followed by
    # whitespace or end-of-string. Using lookahead so match ends right after
    # the punctuation block (excluding trailing whitespace).
    _term_re = re.compile(r'[.!?…]["\'\)\]]*(?=\s|$)')

    # Track the insertion point of the last (rightmost) marker to prevent
    # a deferred insertion from overtaking it and reversing marker order.
    next_marker_pos: int | None = None

    for item in reversed(page_map_sorted[:-1]):
        # Use original char_end directly — iterating reversed means later
        # insertions (higher indices) do not shift earlier prefix indices.
        insert_at = item.char_end
        insert_at = max(0, min(insert_at, len(result)))

        prefix = result[:insert_at]
        if _ends_with_terminal(prefix):
            # Already at sentence boundary — snap to end of stripped prefix
            # so marker follows punctuation directly (avoids "\n\nPage N.\n\n "
            # with a leading space on the next paragraph).
            stripped_len = len(prefix.rstrip())
            new_insert_at = stripped_len
        else:
            # Mid-sentence — defer to next sentence terminal.
            suffix = result[insert_at:]
            m = _term_re.search(suffix)
            if m:
                new_insert_at = insert_at + m.end()
            else:
                # No terminator found — avoid mid-word split as fallback.
                if (
                    0 < insert_at < len(result)
                    and result[insert_at - 1].isalnum()
                    and result[insert_at].isalnum()
                ):
                    nxt_space = result.find(" ", insert_at)
                    if nxt_space != -1 and nxt_space - insert_at < 80:
                        new_insert_at = nxt_space + 1
                    else:
                        nxt_nl = result.find("\n", insert_at)
                        if nxt_nl != -1 and nxt_nl - insert_at < 80:
                            new_insert_at = nxt_nl + 1
                        else:
                            new_insert_at = insert_at
                else:
                    # Try any punctuation as last resort
                    m2 = re.search(r"[.!?…]", suffix)
                    new_insert_at = insert_at + m2.end() if m2 else insert_at

        # Guard: avoid splitting mid-word at the deferred position.
        if (
            0 < new_insert_at < len(result)
            and result[new_insert_at - 1].isalnum()
            and result[new_insert_at].isalnum()
        ):
            nxt_space = result.find(" ", new_insert_at)
            if nxt_space != -1 and nxt_space - new_insert_at < 80:
                new_insert_at = nxt_space + 1

        new_insert_at = max(0, min(new_insert_at, len(result)))

        # Prevent overtaking the next (rightmost) marker.
        if next_marker_pos is not None and new_insert_at >= next_marker_pos:
            # Clamp before the next marker, preserving order.
            # If clamping would push back into mid-sentence, keep original.
            clamped = min(insert_at, next_marker_pos - 1)
            clamped = max(0, clamped)
            new_insert_at = clamped

        next_page = item.page + 1
        marker = f"\n\nPage {next_page}.\n\n"

        # Idempotency: skip if marker already present near insertion point.
        window_start = max(0, new_insert_at - 12)
        window_end = min(len(result), new_insert_at + 12 + len(marker))
        if f"Page {next_page}." in result[window_start:window_end]:
            next_marker_pos = new_insert_at
            continue

        result = result[:new_insert_at] + marker + result[new_insert_at:]
        next_marker_pos = new_insert_at

    return result


# ---------------------------------------------------------------------------
# Markdown section / sentence parsing (shared with frontend)
# ---------------------------------------------------------------------------


def _clean_for_sentences(text: str) -> str:
    """Strip Markdown syntax for sentence chunking, preserving prose."""
    # Remove code fences
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^\s*>\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    text = re.sub(r"(\*\*|__|\*|_|~~)", "", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    return text.strip()


def chunk_text_into_sentences(text: str) -> list[str]:
    """Split prose into speech-ready sentence chunks."""
    clean = _clean_for_sentences(text)
    # Split on terminal punctuation — quote attached to prior sentence via _SENTENCE_SPLIT_RE
    parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+(?=[A-Z0-9\"'])", clean) if s.strip()]
    # Handle case where next char is lowercase (continuation) — fallback to simple split
    if len(parts) == 1 and clean:
        parts = [s.strip() for s in re.split(r"(?<=[.!?])\s+", clean) if s.strip()]
    return parts


def _split_paragraph_blocks(lines: list[str]) -> list[str]:
    """Split body lines into blank-line-separated paragraph blocks."""
    blocks: list[str] = []
    buf: list[str] = []
    for line in lines:
        if line.strip() == "":
            text = "\n".join(buf).strip()
            if text:
                blocks.append(text)
            buf = []
        else:
            buf.append(line)
    text = "\n".join(buf).strip()
    if text:
        blocks.append(text)
    return blocks


def parse_markdown_structure(md_text: str) -> list[Section]:
    """Parse Markdown into sections with sentence-level chunks.

    Section headings are included as the first sentence(s) of their section
    so TTS playback reads them aloud. Paragraph breaks are preserved via
    `Section.paragraphs` (paragraphs[0] holds heading sentences when set).
    """
    lines = md_text.splitlines()
    heading_pat = re.compile(r"^(#{1,6})\s+(.+)$")

    sections: list[Section] = []
    current_level = 0
    current_lines: list[str] = []
    pending_heading: str | None = None
    # Stack for breadcrumb correction — maintain header at each depth
    header_stack: list[str] = []

    def flush_section() -> None:
        nonlocal current_lines, pending_heading
        if not pending_heading and not "".join(current_lines).strip():
            return
        paragraphs: list[list[str]] = []
        if pending_heading:
            heading_sentences = chunk_text_into_sentences(pending_heading)
            if heading_sentences:
                paragraphs.append(heading_sentences)
            elif pending_heading.strip():
                paragraphs.append([pending_heading.strip()])
        for block in _split_paragraph_blocks(current_lines):
            sentences = chunk_text_into_sentences(block)
            if sentences:
                paragraphs.append(sentences)
        chunks = [s for para in paragraphs for s in para]
        if not chunks:
            current_lines = []
            pending_heading = None
            return
        # Titles = breadcrumb copy
        titles = list(header_stack) if header_stack else ["Document"]
        sections.append(
            Section(
                id=len(sections),
                titles=titles,
                level=current_level if current_level else 1,
                chunks=chunks,
                paragraphs=paragraphs,
                heading=pending_heading,
            )
        )
        current_lines = []
        pending_heading = None

    in_fence = False
    for line in lines:
        if _CODE_FENCE_RE.match(line):
            in_fence = not in_fence
            current_lines.append(line)
            continue
        if in_fence:
            current_lines.append(line)
            continue

        m = heading_pat.match(line.strip())
        if m:
            flush_section()
            current_lines = []
            hashes, title = m.groups()
            level = len(hashes)
            current_level = level
            title = title.strip()
            # Maintain stack: truncate to level-1 then append
            if level <= len(header_stack):
                header_stack = header_stack[: level - 1]
            # Pad if jumping levels (e.g., h1 → h3)
            while len(header_stack) < level - 1:
                header_stack.append("")
            header_stack.append(title)
            # Remove empty pads for display
            header_stack = [h for h in header_stack if h]
            # Note: need to handle display vs stack length — re-derive on next iteration
            # Keep actual stack with empties for level tracking
            # Simpler: rebuild from stored levels — use dict.
            # For MVP keep header_stack as clean list; level check is
            # approximate but preserves ordered breadcrumbs.
            pending_heading = title
        else:
            current_lines.append(line)

    flush_section()
    return sections


def has_page_breaks(markdown: str) -> bool:
    """Return True when Docling page-break placeholders are present."""
    return bool(_PAGE_BREAK_INLINE_RE.search(markdown))


def split_on_page_breaks(markdown: str) -> list[str]:
    """Split markdown into per-page texts on page-break placeholders."""
    parts = _PAGE_BREAK_INLINE_RE.split(markdown)
    return [p.strip("\n") for p in parts]


def _first_sentence_end(text: str) -> int | None:
    """Return end offset (exclusive) of first sentence terminal, if any."""
    m = _TERM_FORWARD_RE.search(text)
    return m.end() if m else None


def join_pages_with_markers(
    pages: list[str], insert_markers: bool
) -> tuple[str, list[PageMapItem]]:
    """Join per-page texts with `Page N.` markers, tracking exact offsets.

    When a page ends mid-sentence (no terminal punctuation) and the next
    page begins with a continuation, the boundary sentence is kept together
    and the marker is deferred to after that sentence — so `Page N` never
    splits a sentence, but also never lands mid-page inside a column.
    Returns (markdown, page_map) with exact char offsets.
    """
    # Strip empty pages from Docling artefacts (e.g. leading/trailing breaks)
    # while keeping at least one page.
    non_empty = [p for p in pages if p.strip()]
    effective = non_empty if non_empty else pages
    total = len(effective)
    if total <= 1:
        md = effective[0].strip() if effective else ""
        return md, [PageMapItem(page=1, char_start=0, char_end=len(md), start_line=1)]

    if not insert_markers:
        md_parts: list[str] = []
        page_map: list[PageMapItem] = []
        offset = 0
        for i, page in enumerate(effective):
            body = page.strip()
            if i > 0:
                md_parts.append("\n\n")
                offset += 2
            cs = offset
            md_parts.append(body)
            offset += len(body)
            ce = offset
            start_line = "".join(md_parts)[:cs].count("\n") + 1 if cs else 1
            page_map.append(
                PageMapItem(page=i + 1, char_start=cs, char_end=ce, start_line=start_line)
            )
        return "".join(md_parts), page_map

    out_parts: list[str] = []
    page_map_out: list[PageMapItem] = []
    offset_out = 0

    def _emit(text: str) -> None:
        nonlocal offset_out
        out_parts.append(text)
        offset_out += len(text)

    first_body = effective[0].strip()
    _emit(first_body)
    # Page 1 spans from 0 to current offset.
    page_map_out.append(PageMapItem(page=1, char_start=0, char_end=offset_out, start_line=1))

    for idx in range(1, total):
        next_page_num = idx + 1
        remainder = effective[idx].strip()
        prefix_so_far = "".join(out_parts)
        if _ends_with_terminal(prefix_so_far) or not remainder:
            marker = f"\n\nPage {next_page_num}.\n\n"
            _emit(marker)
            cs = offset_out
            _emit(remainder)
            ce = offset_out
            start_line = (
                prefix_so_far.count("\n") + 1 if False else "".join(out_parts)[:cs].count("\n") + 1
            )
            page_map_out.append(
                PageMapItem(page=next_page_num, char_start=cs, char_end=ce, start_line=start_line)
            )
            continue
        # Mid-sentence boundary — carry the first sentence of the next page
        # before the marker so the sentence stays intact.
        end = _first_sentence_end(remainder)
        if end is None:
            # No terminal ahead: whole remainder is a continuation fragment.
            # Keep it with the prior page, then mark the boundary after it.
            _emit(" " + remainder.lstrip())
            # Extend previous page's end to include carried text.
            page_map_out[-1].char_end = offset_out
            marker = f"\n\nPage {next_page_num}.\n\n"
            _emit(marker)
            # Next page contributes nothing beyond the carried fragment.
            cs = ce = offset_out
            start_line = "".join(out_parts)[:cs].count("\n") + 1
            page_map_out.append(
                PageMapItem(page=next_page_num, char_start=cs, char_end=ce, start_line=start_line)
            )
        else:
            first_sent = remainder[:end].strip()
            rest = remainder[end:].strip()
            _emit(" " + first_sent.lstrip())
            page_map_out[-1].char_end = offset_out
            marker = f"\n\nPage {next_page_num}.\n\n"
            _emit(marker)
            cs = offset_out
            if rest:
                _emit(rest)
            ce = offset_out
            start_line = "".join(out_parts)[:cs].count("\n") + 1
            page_map_out.append(
                PageMapItem(page=next_page_num, char_start=cs, char_end=ce, start_line=start_line)
            )

    return "".join(out_parts), page_map_out


def build_page_map(markdown: str, total_pages: int) -> list[PageMapItem]:
    """Build pageMap, preferring Docling page-break placeholders when present.

    When `markdown` contains `<!-- page break -->` tokens (emitted via
    `export_to_markdown(page_break_placeholder=...)`), boundaries are exact
    per-page offsets. Otherwise falls back to evenly splitting lines.
    """
    if _PAGE_BREAK_INLINE_RE.search(markdown):
        raw_pages = _PAGE_BREAK_INLINE_RE.split(markdown)
        # Number of pages implied by breaks; tolerate mismatch with total_pages
        # (e.g. blank leading/trailing segments) by dropping empties.
        # If caller knows a larger total (e.g. PDF page count with blank
        # pages), keep segment count — blank pages carry no text to map.
        page_map: list[PageMapItem] = []
        cursor = 0
        for seg in raw_pages:
            seg_start = markdown.find(seg, cursor)
            if seg_start == -1:
                seg_start = cursor
            seg_end = seg_start + len(seg)
            # Only record non-empty segments as pages; placeholders advance cursor.
            if seg.strip():
                page_no = len(page_map) + 1
                # start_line computed on text up to segment start.
                start_line = markdown[:seg_start].count("\n") + 1
                page_map.append(
                    PageMapItem(
                        page=page_no, char_start=seg_start, char_end=seg_end, start_line=start_line
                    )
                )
            m = _PAGE_BREAK_INLINE_RE.search(markdown, seg_end)
            cursor = m.end() if m else seg_end
            if not m:
                break
        if page_map:
            return page_map
        # Fall through to estimator if splitting yielded nothing usable.
    if total_pages <= 1:
        return [PageMapItem(page=1, char_start=0, char_end=len(markdown), start_line=1)]

    lines = markdown.split("\n")
    per_page = max(1, len(lines) // total_pages)
    page_map: list[PageMapItem] = []
    char_offset = 0
    for page in range(1, total_pages + 1):
        start_line = (page - 1) * per_page + 1
        end_line = per_page * page if page < total_pages else len(lines)
        # Compute char offsets for this slice
        slice_lines = lines[start_line - 1 : end_line]
        slice_text = "\n".join(slice_lines)
        # Include inter-page newlines (2) except first
        cs = char_offset
        ce = cs + len(slice_text)
        page_map.append(PageMapItem(page=page, char_start=cs, char_end=ce, start_line=start_line))
        # +2 for the "\n\n" separator that join will add (approx)
        char_offset = ce + (2 if page < total_pages else 0)

    return page_map


def apply_postprocessing(
    markdown: str,
    opts: PostprocessOptions,
    page_map: list[PageMapItem] | None = None,
) -> tuple[str, list[Section], list[PageMapItem]]:
    """Apply configured post-processing and return (markdown, sections, page_map)."""
    md = markdown
    # Always strip Docling image placeholders (non-configurable cleanup).
    # Page-break placeholders are preserved by _strip_image_artifacts.
    md = _strip_image_artifacts(md)

    if has_page_breaks(md):
        # True page boundaries available — process each page independently
        # so columns merge within a page but markers never land mid-page.
        pages = split_on_page_breaks(md)
        processed: list[str] = []
        for page in pages:
            p = page
            if opts.combine_columns:
                p = dehyphenate(p)
                p = reflow_columns(p)
            if opts.normalize_uppercase:
                p = normalize_uppercase(p)
            if opts.ensure_punctuation:
                p = ensure_punctuation(p)
            processed.append(p)
        md, new_map = join_pages_with_markers(processed, opts.insert_page_markers)
        if opts.combine_columns:
            # Catch hyphen breaks straddling a page boundary
            # (`dete-` at end of one page + `rioration` at start of next).
            md = dehyphenate(md)
        sections = parse_markdown_structure(md)
        return md, sections, new_map

    if opts.combine_columns:
        md = dehyphenate(md)
        md = reflow_columns(md)

    if opts.normalize_uppercase:
        md = normalize_uppercase(md)

    if opts.ensure_punctuation:
        md = ensure_punctuation(md)

    sections = parse_markdown_structure(md)

    # Rebuild page_map after mutations (char offsets shift) — fallback estimator
    # If caller provided accurate page_map, remap proportionally; else estimate.
    if page_map is None:
        # No prior map — build from sections count fallback of 1 page
        new_map = build_page_map(md, 1)
    else:
        if opts.insert_page_markers and len(page_map) > 1:
            md = insert_page_markers(md, page_map)
            # Recompute page_map to reflect inserted markers
            # Keep original page count but re-split
            new_map = build_page_map(md, len(page_map))
            # Re-parse sections after marker insertion
            sections = parse_markdown_structure(md)
        else:
            # Page map offsets are stale after reflow — re-estimate for sync
            # Preserve page count but recompute line-based offsets
            new_map = build_page_map(md, len(page_map))

    return md, sections, new_map
