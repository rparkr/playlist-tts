"""OCR via vision LLM over pypdf-extracted page images.

Alternative engine to the Docling pipeline in `ocr_service`. Each PDF page's
embedded images are sent to an OpenAI-compatible server (e.g. llama.cpp) in a
single chat turn; pages without embedded images fall back to pypdf text
extraction so born-digital PDFs keep working and page numbering stays aligned
with the PDF. Results flow through the same `postprocess` pipeline, so page
markers, page maps, and TTS chunks match the Docling engine.

pypdf image extraction needs Pillow (`pypdf[image]`), which is already present
transitively via docling.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import os
import tempfile
import time
import uuid
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from backend.app.models.schemas import JobStatus, PageMapItem, PostprocessOptions, Section
from backend.app.services.llm_logging import configure_llm_logging, log_llm_event
from backend.app.services.ocr_service import OCRJob, get_page_count
from backend.app.services.postprocess import (
    dehyphenate,
    ensure_punctuation,
    join_pages_strict,
    normalize_uppercase,
    parse_markdown_structure,
    reflow_columns,
)

if TYPE_CHECKING:
    from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL: str = "http://127.0.0.1:8080/v1"
DEFAULT_MODEL: str = "qwen3.5-4b"
DEFAULT_SYSTEM_MESSAGE: str = (
    "Extract text from the page in reading order. Do not include any preamble like: "
    '"Here\'s the extracted text:";  instead, begin directly with the text from the page.'
)
DEFAULT_USER_MESSAGE: str = (
    "Please extract all the English text from this page. "
    "When extracting text, include handwritten script as well as typed. "
    "Keep paragraphs together. For paragraphs that continue on the next column, keep "
    "the continuation with the paragraph it started in so the paragraph stays together. "
    "Collapse hyphenated word breaks at the end of lines, merging the word segments "
    "together.\n\n"
    "If there is no text to extract, say `<no text found>`, followed by a detailed "
    "description of the scene in the image."
)

#: Upper bound for the synchronous `POST /api/ocr/llm` poll loop. LLM jobs are
#: per-page and slower than Docling on long documents, so this is more generous
#: than the Docling alias.
LLM_SYNC_TIMEOUT_S: int = 1800


@dataclass
class LLMConfig:
    """Per-job LLM connection, prompt, and concurrency settings."""

    base_url: str = DEFAULT_BASE_URL
    model: str = DEFAULT_MODEL
    system_message: str = DEFAULT_SYSTEM_MESSAGE
    user_message: str = DEFAULT_USER_MESSAGE
    enable_thinking: bool = False
    #: Max in-flight LLM requests. Defaults to 2 (one processing, one queued),
    #: which bounds client memory and — more importantly — server-side queued
    #: multimodal contexts that otherwise grow with the whole document (a 157 MB
    #: PDF queued at once exceeded 43 GB RAM against a single-slot server).
    #: 0 means unbounded (fire everything at once).
    concurrency: int = 2

    @classmethod
    def from_env(
        cls,
        base_url: str | None = None,
        model: str | None = None,
        concurrency: int | None = None,
    ) -> LLMConfig:
        """Build config from explicit values with environment fallback."""

        def _int(raw: str | None, default: int) -> int:
            try:
                return int(raw) if raw is not None else default
            except ValueError:
                return default

        return cls(
            base_url=base_url or os.getenv("LLM_OCR_BASE_URL", DEFAULT_BASE_URL),
            model=model or os.getenv("LLM_OCR_MODEL", DEFAULT_MODEL),
            concurrency=_int(
                str(concurrency) if concurrency is not None else os.getenv("LLM_OCR_CONCURRENCY"),
                2,
            ),
        )


@dataclass
class PDFPageContent:
    """Source material extracted from a single PDF page."""

    images: list[tuple[bytes, str]] = field(default_factory=list)
    """(raw bytes, MIME type) tuples for embedded images, in embedded order."""
    text: str = ""
    """Digital text via pypdf (used when the page has no embedded images)."""


# In-memory registries — same single-user scope as `ocr_service._jobs`.
_llm_jobs: dict[str, OCRJob] = {}
_llm_configs: dict[str, LLMConfig] = {}


def get_llm_job(job_id: str) -> OCRJob | None:
    """Retrieve LLM OCR job by id."""
    return _llm_jobs.get(job_id)


def _guess_image_mime(name: str, data: bytes) -> str | None:
    """Guess an image MIME type from its name, falling back to magic bytes.

    Args:
        name: embedded image name (often carries an extension, e.g. `img0.jpg`).
        data: raw image bytes.

    Returns:
        MIME type string, or None when the type cannot be determined.
    """
    mime_type, _ = mimetypes.guess_type(name)
    if mime_type and mime_type.startswith("image/"):
        return mime_type
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG"):
        return "image/png"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    return None


def extract_pdf_pages(pdf_path: Path) -> list[PDFPageContent]:
    """Extract images and digital-text fallback per page in a single pass.

    Args:
        pdf_path: path to the input PDF file.

    Returns:
        One `PDFPageContent` per PDF page, in PDF order. Pages without
        extractable images carry an empty `images` list; `text` holds
        pypdf-extracted digital text (possibly empty) for those pages.
    """
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    pages: list[PDFPageContent] = []
    for page in reader.pages:
        images: list[tuple[bytes, str]] = []
        for img in page.images:
            try:
                data: bytes = img.data
            except Exception:
                logger.debug("Skipping unreadable image %s.", img.name, exc_info=True)
                continue
            if not data:
                continue
            mime_type = _guess_image_mime(img.name, data)
            if mime_type is None:
                logger.debug("Skipping image with unknown type: %s.", img.name)
                continue
            images.append((data, mime_type))
        try:
            text: str = page.extract_text() or ""
        except Exception:
            logger.debug("pypdf text extraction failed on a page.", exc_info=True)
            text = ""
        pages.append(PDFPageContent(images=images, text=text))
    return pages


def create_llm_client(base_url: str) -> AsyncOpenAI:
    """Build the async OpenAI-compatible client (import is lazy).

    Args:
        base_url: base URL of the OpenAI-compatible server (e.g. llama.cpp).

    Raises:
        RuntimeError: when the `openai` package is not installed.
    """
    try:
        from openai import AsyncOpenAI
    except ImportError as e:
        raise RuntimeError(
            "LLM OCR needs the 'openai' package. Install it with `uv sync --extra llm-ocr`."
        ) from e
    return AsyncOpenAI(base_url=base_url, api_key="local-no-key-required")


async def complete_with_images(
    client: AsyncOpenAI,
    images: list[tuple[bytes, str]],
    model: str,
    system_message: str,
    user_message: str,
    enable_thinking: bool = False,
) -> str:
    """Send one chat turn with image(s) and return the stripped text response.

    Args:
        client: the OpenAI client.
        images: list of (raw bytes, MIME type) tuples included in the prompt.
        model: the name of the model to use.
        system_message: the system message for the chat conversation.
        user_message: the user's prompt for the chat conversation.
        enable_thinking: whether to allow `<think>` blocks prior to responding.

    Returns:
        Stripped LLM response text.
    """
    content: list[Any] = []
    for raw, mime_type in images:
        base64_image = base64.b64encode(raw).decode("utf-8")
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:{mime_type};base64,{base64_image}"},
            }
        )
    content.append({"type": "text", "text": user_message})
    messages: Any = [
        {"role": "system", "content": system_message},
        {"role": "user", "content": content},
    ]
    response = await client.chat.completions.create(
        model=model,
        extra_body={"chat_template_kwargs": {"enable_thinking": enable_thinking}},
        temperature=0,
        messages=messages,
    )
    return (response.choices[0].message.content or "").strip()


async def ocr_pdf_pages(
    pdf_path: Path,
    config: LLMConfig,
    client: AsyncOpenAI | None = None,
    on_page_done: Callable[[int], None] | None = None,
    run_id: str | None = None,
) -> list[str]:
    """OCR every PDF page, returning per-page texts in PDF order.

    Pages with embedded images go to the LLM; pages without images use pypdf
    text extraction (no LLM call); pages with neither yield an empty string.
    Individual page failures never fail the whole document — they yield an
    empty string and are logged.

    Every phase is logged as JSONL events (see `llm_logging`) so a run can be
    traced afterwards: extraction totals, one line per page, and a summary
    with wall/extract/LLM-second breakdowns.

    Args:
        pdf_path: path to the input PDF file.
        config: LLM connection, prompt, and concurrency settings.
        client: optional pre-built client (used by tests to inject a fake).
        on_page_done: optional sync callback invoked with the 1-indexed page
            number as each page completes (completion order, not page order).
        run_id: ties all log lines of this run together (generated if omitted).

    Returns:
        Per-page texts in PDF order (index 0 == PDF page 1), so `Page N.`
        markers downstream stay aligned with PDF pages.
    """
    run = run_id or uuid.uuid4().hex[:12]
    loop = asyncio.get_running_loop()
    started = time.monotonic()
    contents = await loop.run_in_executor(None, extract_pdf_pages, pdf_path)
    extract_s = time.monotonic() - started
    total = len(contents)
    images_total = sum(len(content.images) for content in contents)
    bytes_total = sum(len(raw) for content in contents for raw, _ in content.images)
    log_llm_event(
        "extracted",
        run,
        f"LLM OCR {pdf_path.name}: {total} page(s), {images_total} image(s)",
        pdf=str(pdf_path),
        pages=total,
        images=images_total,
        bytes=bytes_total,
        seconds=round(extract_s, 3),
    )
    if total == 0:
        return []

    active_client = client
    sem = asyncio.Semaphore(config.concurrency) if config.concurrency > 0 else None

    def _client() -> AsyncOpenAI:
        """Build the client on first image page (imageless docs never import openai)."""
        nonlocal active_client
        created = active_client
        if created is None:
            created = active_client = create_llm_client(config.base_url)
        return created

    async def _one(page_number: int, content: PDFPageContent) -> tuple[int, str, float]:
        """OCR a single page, containing failures to an empty string."""
        label = f"page {page_number}/{total}"

        async def _run() -> tuple[str, float]:
            if content.images:
                page_started = time.monotonic()
                text = await complete_with_images(
                    _client(),
                    content.images,
                    model=config.model,
                    system_message=config.system_message,
                    user_message=config.user_message,
                    enable_thinking=config.enable_thinking,
                )
                llm_s = time.monotonic() - page_started
                log_llm_event(
                    "page_completed",
                    run,
                    f"LLM OCR {label}: LLM {llm_s:.1f}s",
                    page=page_number,
                    pages=total,
                    method="llm",
                    images=len(content.images),
                    bytes=sum(len(raw) for raw, _ in content.images),
                    llm_seconds=round(llm_s, 3),
                )
                return text, llm_s
            stripped = content.text.strip()
            if stripped:
                log_llm_event(
                    "page_completed",
                    run,
                    f"LLM OCR {label}: pypdf text, no LLM call",
                    page=page_number,
                    pages=total,
                    method="pypdf_text",
                    chars=len(stripped),
                )
                return stripped, 0.0
            log_llm_event(
                "page_completed",
                run,
                f"LLM OCR {label}: no images and no extractable text",
                page=page_number,
                pages=total,
                method="empty",
            )
            return "", 0.0

        try:
            if sem is not None:
                async with sem:
                    text, llm_s = await _run()
                    return page_number, text, llm_s
            text, llm_s = await _run()
            return page_number, text, llm_s
        except Exception as e:
            log_llm_event(
                "page_failed",
                run,
                f"LLM OCR {label} failed: {e}",
                page=page_number,
                pages=total,
                error=str(e)[:500],
            )
            logger.debug("LLM OCR %s failed.", label, exc_info=True)
            return page_number, "", 0.0

    pending = {
        asyncio.ensure_future(_one(i + 1, content)): i + 1 for i, content in enumerate(contents)
    }
    results: dict[int, str] = {}
    llm_total_s = 0.0
    for future in asyncio.as_completed(pending):
        page_number, text, llm_s = await future
        results[page_number] = text
        llm_total_s += llm_s
        # Release this page's image bytes now — with large documents the
        # extracted-images list is the dominant client-side memory cost, and
        # nothing downstream needs it once the page text is in hand.
        contents[page_number - 1].images.clear()
        if on_page_done is not None:
            on_page_done(page_number)
    ordered = [results[i] for i in range(1, total + 1)]
    wall_s = time.monotonic() - started
    empty = sum(1 for text in ordered if not text.strip())
    log_llm_event(
        "pages_done",
        run,
        f"LLM OCR {pdf_path.name}: {total} page(s) in {wall_s:.1f}s",
        pdf=str(pdf_path),
        pages=total,
        pages_ok=total - empty,
        pages_empty_or_failed=empty,
        wall_seconds=round(wall_s, 3),
        extract_seconds=round(extract_s, 3),
        llm_sum_seconds=round(llm_total_s, 3),
    )
    return ordered


async def convert_pdf_with_llm(
    pdf_path: Path,
    opts: PostprocessOptions,
    config: LLMConfig,
    client: AsyncOpenAI | None = None,
    on_page_done: Callable[[int], None] | None = None,
    run_id: str | None = None,
) -> tuple[str, list[Section], list[PageMapItem]]:
    """OCR a PDF with the LLM engine and post-process each page.

    Each page is processed independently with the same per-page steps the
    Docling pipeline applies, then pages are joined with strict `Page N.`
    markers (never deferred into the next page), keeping numbering aligned
    with the PDF for TTS follow-along.

    Args:
        pdf_path: path to the input PDF file.
        opts: post-processing flags (same contract as the Docling engine).
        config: LLM connection, prompt, and concurrency settings.
        client: optional pre-built client (used by tests to inject a fake).
        on_page_done: optional sync callback per completed page.
        run_id: ties all log lines of this run together (generated if omitted).

    Returns:
        (markdown, sections, page_map) with `Page N.` markers when
        `opts.insert_page_markers` is set.
    """
    run = run_id or uuid.uuid4().hex[:12]
    pages = await ocr_pdf_pages(
        pdf_path, config, client=client, on_page_done=on_page_done, run_id=run
    )
    started = time.monotonic()
    processed: list[str] = []
    for page in pages:
        text = page
        if opts.combine_columns:
            text = dehyphenate(text)
            text = reflow_columns(text)
        if opts.normalize_uppercase:
            text = normalize_uppercase(text)
        if opts.ensure_punctuation:
            text = ensure_punctuation(text)
        processed.append(text)
    md, page_map = join_pages_strict(processed, opts.insert_page_markers, opts.first_page_marker)
    if opts.combine_columns:
        # Catch hyphen breaks straddling a page boundary.
        md = dehyphenate(md)
    sections = parse_markdown_structure(md)
    post_s = time.monotonic() - started
    log_llm_event(
        "postprocessed",
        run,
        f"LLM OCR {pdf_path.name}: postprocess {post_s:.1f}s",
        pdf=str(pdf_path),
        pages=len(pages),
        sections=len(sections),
        markdown_chars=len(md),
        seconds=round(post_s, 3),
    )
    return md, sections, page_map


async def _run_llm_ocr_job(
    job: OCRJob,
    pdf_path: Path,
    opts: PostprocessOptions,
    config: LLMConfig,
) -> None:
    """Execute LLM OCR with real per-page progress and populate job result."""
    from rich.console import Console

    console = Console()
    console.print(
        f"[bold cyan]LLM OCR job {job.job_id}[/bold cyan] started: "
        f"{job.filename} ({job.progress_total} pages, model {config.model})"
    )
    job.status = JobStatus.running
    log_llm_event(
        "job_started",
        job.job_id,
        f"LLM OCR job {job.job_id} started: {job.filename}",
        filename=job.filename,
        pages_total=job.progress_total,
        model=config.model,
        base_url=config.base_url,
        concurrency=config.concurrency,
    )

    for q in job.event_queues:
        await q.put({"type": "progress", "done": 0, "total": job.progress_total})

    def _on_page_done(_page_number: int) -> None:
        """Record real (not estimated) progress and notify SSE subscribers."""
        job.progress_done += 1
        for q in job.event_queues:
            q.put_nowait(
                {
                    "type": "progress",
                    "done": job.progress_done,
                    "total": job.progress_total,
                }
            )

    try:
        md, sections, page_map = await convert_pdf_with_llm(
            pdf_path, opts, config, on_page_done=_on_page_done, run_id=job.job_id
        )
        total = job.progress_total if job.progress_total > 0 else len(page_map)
        total = total if total > 0 else 1
        job.progress_done = total
        sentence_count = sum(len(s.chunks) for s in sections)
        elapsed_s = int(time.time() - job.created_at)
        job.result = {
            "filename": job.filename,
            "markdown": md,
            "sections": [s.model_dump() for s in sections],
            "page_map": [p.model_dump() for p in page_map],
            "raw_markdown": None,
            "raw_page_map": None,
            "meta": {
                "pageCount": total,
                "processingMs": int((time.time() - job.created_at) * 1000),
                "engine": "llm-ocr",
                "model": config.model,
            },
        }
        job.status = JobStatus.done
        log_llm_event(
            "job_finished",
            job.job_id,
            f"LLM OCR {job.job_id} done: {total} pages in {elapsed_s}s",
            filename=job.filename,
            pages=total,
            sections=len(sections),
            sentences=sentence_count,
            seconds=elapsed_s,
        )
        console.print(
            f"[bold green]LLM OCR {job.job_id} done: {total} pages, "
            f"{len(sections)} sections, {sentence_count} sentences "
            f"in {elapsed_s}s[/bold green]"
        )

        for q in job.event_queues:
            await q.put({"type": "progress", "done": total, "total": total})
            await q.put({"type": "done", "jobId": job.job_id})

    except Exception as e:
        import traceback

        traceback.print_exc()
        console.print(f"[red]LLM OCR {job.job_id} failed: {e}[/red]")
        job.error = str(e)
        job.status = JobStatus.error
        log_llm_event(
            "job_failed",
            job.job_id,
            f"LLM OCR {job.job_id} failed: {e}",
            filename=job.filename,
            error=str(e)[:500],
        )
        for q in job.event_queues:
            await q.put({"type": "error", "error": str(e)})
    finally:
        _llm_configs.pop(job.job_id, None)
        try:
            if pdf_path.exists():
                pdf_path.unlink()
        except Exception:
            pass


def create_llm_ocr_job(
    filename: str,
    pdf_bytes: bytes,
    opts: PostprocessOptions,
    config: LLMConfig | None = None,
) -> str:
    """Create an LLM OCR job, save PDF to temp, and schedule execution.

    Args:
        filename: original upload filename (for display).
        pdf_bytes: raw PDF bytes.
        opts: post-processing flags.
        config: LLM settings (defaults resolve from the environment).

    Returns:
        The new job id.
    """
    configure_llm_logging()
    job_id = uuid.uuid4().hex[:12]
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        tmp.write(pdf_bytes)
        tmp.flush()
        tmp_path = Path(tmp.name)

    total = get_page_count(tmp_path)

    job = OCRJob(
        job_id=job_id,
        filename=filename,
        progress_total=total if total > 0 else 0,
    )
    _llm_jobs[job_id] = job
    _llm_configs[job_id] = config or LLMConfig.from_env()

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run_llm_ocr_job(job, tmp_path, opts, _llm_configs[job_id]))
    except RuntimeError:
        pass

    return job_id


async def llm_sse_events(job_id: str) -> AsyncGenerator[dict]:
    """Yield SSE events for an LLM OCR job (progress, keepalive, done, error)."""
    job = _llm_jobs.get(job_id)
    if job is None:
        yield {"type": "error", "error": "job not found"}
        return

    q: asyncio.Queue[dict] = asyncio.Queue()
    job.event_queues.append(q)

    yield {"type": "progress", "done": job.progress_done, "total": job.progress_total}

    if job.status in (JobStatus.done, JobStatus.error):
        if job.status == JobStatus.done:
            yield {"type": "done", "jobId": job_id}
        else:
            yield {"type": "error", "error": job.error or "unknown"}
        job.event_queues.remove(q)
        return

    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=15)
            except TimeoutError:
                yield {"type": "keepalive", "done": job.progress_done, "total": job.progress_total}
                continue

            yield event

            if event.get("type") in ("done", "error"):
                break
    finally:
        if q in job.event_queues:
            job.event_queues.remove(q)
