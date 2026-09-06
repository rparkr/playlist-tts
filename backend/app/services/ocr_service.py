"""OCR service — granite-docling via docling with job + SSE progress."""

import asyncio
import tempfile
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.models.schemas import JobStatus, PostprocessOptions
from backend.app.services.postprocess import apply_postprocessing, build_page_map


@dataclass
class OCRJob:
    """Background OCR job state."""

    job_id: str
    filename: str
    status: JobStatus = JobStatus.queued
    progress_done: int = 0
    progress_total: int = 0
    result: dict | None = None
    error: str | None = None
    created_at: float = field(default_factory=time.time)
    # subscribers for SSE — queue of events
    event_queues: list[asyncio.Queue[dict]] = field(default_factory=list)


# In-memory registry — sufficient for <50 pp, single-user LAN
_jobs: dict[str, OCRJob] = {}


def get_job(job_id: str) -> OCRJob | None:
    """Retrieve job by id."""
    return _jobs.get(job_id)


def get_page_count(pdf_path: Path) -> int:
    """Quickly read total pages from PDF metadata via pypdf (pure Python)."""
    try:
        from pypdf import PdfReader

        reader = PdfReader(str(pdf_path))
        return len(reader.pages)
    except Exception:
        return 0


async def _run_ocr_job(
    job: OCRJob,
    pdf_path: Path,
    opts: PostprocessOptions,
) -> None:
    """Execute Docling OCR in threadpool and populate job result."""
    from rich.console import Console

    console = Console()
    console.print(
        f"[bold cyan]OCR job {job.job_id}[/bold cyan] started: "
        f"{job.filename} ({job.progress_total} pages)"
    )
    job.status = JobStatus.running

    # Notify subscribers
    for q in job.event_queues:
        await q.put({"type": "progress", "done": 0, "total": job.progress_total})

    def _do_ocr() -> tuple[str, int]:
        """Blocking OCR — runs in threadpool."""
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import VlmPipelineOptions, vlm_model_specs
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.pipeline.vlm_pipeline import VlmPipeline

        pipeline_options = VlmPipelineOptions(
            vlm_options=vlm_model_specs.GRANITEDOCLING_TRANSFORMERS
        )
        converter = DocumentConverter(
            format_options={
                InputFormat.PDF: PdfFormatOption(
                    pipeline_cls=VlmPipeline, pipeline_options=pipeline_options
                )
            }
        )
        result = converter.convert(pdf_path)
        md = result.document.export_to_markdown()
        return md, job.progress_total

    loop = asyncio.get_running_loop()
    try:
        ocr_task = loop.run_in_executor(None, _do_ocr)
        start = time.time()
        elapsed = 0
        # Emit progress every 1s (keepalive) and log to terminal
        while not ocr_task.done():
            await asyncio.sleep(1)
            elapsed = int(time.time() - start)
            for q in job.event_queues:
                await q.put(
                    {
                        "type": "keepalive",
                        "done": job.progress_done,
                        "total": job.progress_total,
                        "elapsed": elapsed,
                    }
                )
            if elapsed % 5 == 0:
                console.print(
                    f"  [dim]OCR {job.job_id} running... "
                    f"{elapsed}s ({job.progress_total} pages)[/dim]"
                )

        md_raw, total = await ocr_task
        console.print(f"[green]OCR {job.job_id} docling done, post-processing...[/green]")

        # Post-process
        page_map_fallback = build_page_map(md_raw, max(1, total))
        md, sections, page_map = apply_postprocessing(md_raw, opts, page_map_fallback)

        # Re-apply page markers if requested and we have real page count
        # (apply_postprocessing already handled insert_page_markers when opts flag set)

        job.progress_done = total
        sentence_count = sum(len(s.chunks) for s in sections)
        elapsed_s = int(time.time() - job.created_at)
        job.result = {
            "filename": job.filename,
            "markdown": md,
            "sections": [s.model_dump() for s in sections],
            "page_map": [p.model_dump() for p in page_map],
            "meta": {
                "pageCount": total,
                "processingMs": int((time.time() - job.created_at) * 1000),
            },
        }
        job.status = JobStatus.done
        console.print(
            f"[bold green]OCR {job.job_id} done: {total} pages, "
            f"{len(sections)} sections, {sentence_count} sentences "
            f"in {elapsed_s}s[/bold green]"
        )

        for q in job.event_queues:
            await q.put({"type": "progress", "done": total, "total": total})
            await q.put({"type": "done", "jobId": job.job_id})

    except Exception as e:
        import traceback

        traceback.print_exc()
        console.print(f"[red]OCR {job.job_id} failed: {e}[/red]")
        job.error = str(e)
        job.status = JobStatus.error
        for q in job.event_queues:
            await q.put({"type": "error", "error": str(e)})
    finally:
        # Cleanup temp file
        try:
            if pdf_path.exists():
                pdf_path.unlink()
        except Exception:
            pass


def create_ocr_job(
    filename: str,
    pdf_bytes: bytes,
    opts: PostprocessOptions,
) -> str:
    """Create a job, save PDF to temp, and schedule execution. Returns job_id."""
    job_id = uuid.uuid4().hex[:12]
    # Persist PDF to temp file
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
    _jobs[job_id] = job

    # Schedule background task — caller must be inside event loop
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run_ocr_job(job, tmp_path, opts))
    except RuntimeError:
        # No running loop (e.g., CLI) — run synchronously via asyncio.run
        # Fallback: mark queued; caller can await
        pass

    return job_id


async def sse_events(job_id: str) -> AsyncGenerator[dict]:
    """Yield SSE events for a job (progress, keepalive, done, error)."""
    job = _jobs.get(job_id)
    if job is None:
        yield {"type": "error", "error": "job not found"}
        return

    q: asyncio.Queue[dict] = asyncio.Queue()
    job.event_queues.append(q)

    # Send current state immediately
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
                # Send keepalive
                yield {"type": "keepalive", "done": job.progress_done, "total": job.progress_total}
                continue

            yield event

            if event.get("type") in ("done", "error"):
                break
                # Note: keep q removal in finally
    finally:
        if q in job.event_queues:
            job.event_queues.remove(q)
