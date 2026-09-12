"""OCR service — granite-docling via docling with job + SSE progress."""

import asyncio
import tempfile
import time
import uuid
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from pathlib import Path

from backend.app.models.schemas import JobStatus, PageMapItem, PostprocessOptions
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


# ---------------------------------------------------------------------------
# Speed-tuned whole-document OCR + heuristic ETA.
#
# Docling's VLM pipeline handles page batching internally, so a single
# whole-document `convert()` is far faster than N per-page converts
# (~2.6 s/page vs ~12 s/page measured on RTX 4060 laptop GPU).
# Docling exposes no per-page progress for a single document, so progress
# is *estimated* from verified timings (see table below) and reconciled
# to real completion when the convert returns.
#
# Measured (granite-docling-258M, transformers engine, RTX 4060 8GB):
#   test-pdfs/engineering-ch-8 (10 pp): 31.6s @ scale 2.0  / 28.0s @ scale 1.5 + max_new 4096
#   test-pdfs/engineering-ch-1 (28 pp): 69.2s @ scale 2.0  / 66.5s @ scale 1.5 + max_new 4096
# Output parity: 28pp markdowns 98.7% similar (char-level OCR noise only,
# no truncation; lengths within 0.2%).
# ---------------------------------------------------------------------------

#: Seconds of VLM time budgeted per page for ETA estimates.
OCR_SECONDS_PER_PAGE = 2.6
#: Fixed overhead (model/pipeline init, post-processing) budgeted per job.
OCR_FIXED_OVERHEAD_S = 8.0


def create_document_converter():  # type: ignore[no-untyped-def]
    """Build the speed-tuned granite-docling converter.

    `scale=1.5` (vs default 2.0) halves VLM input pixels with no measured
    quality loss; `max_new_tokens=4096` (vs 8192) caps runaway generation —
    a full page of doctags is ~600 tokens, so headroom is ample.
    """
    import copy

    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import VlmPipelineOptions, vlm_model_specs
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.pipeline.vlm_pipeline import VlmPipeline

    vlm_opts = copy.deepcopy(vlm_model_specs.GRANITEDOCLING_TRANSFORMERS)
    vlm_opts.scale = 1.5
    vlm_opts.max_new_tokens = 4096
    pipeline_options = VlmPipelineOptions(vlm_options=vlm_opts)
    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_cls=VlmPipeline, pipeline_options=pipeline_options
            )
        }
    )


def estimate_total_seconds(total_pages: int) -> float:
    """Estimate whole-job seconds from verified per-page timings."""
    return total_pages * OCR_SECONDS_PER_PAGE + OCR_FIXED_OVERHEAD_S


def estimate_done_pages(total_pages: int, elapsed_s: float) -> int:
    """Estimate completed pages from elapsed time, reserving the last page.

    Caps at `total - 1` so the bar never shows 100% before real completion.
    """
    if total_pages <= 0:
        return 0
    return max(0, min(int(elapsed_s / OCR_SECONDS_PER_PAGE), total_pages - 1))


def convert_one_pdf_to_markdown(converter, pdf_path: Path) -> str:  # type: ignore[no-untyped-def]
    """Convert a single (possibly single-page) PDF to markdown."""
    result = converter.convert(pdf_path)
    return str(result.document.export_to_markdown())


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

    def _do_ocr() -> tuple[str, int, list[PageMapItem]]:
        """Blocking whole-document OCR — runs in threadpool.

        A single `convert()` lets Docling batch pages internally at maximum
        throughput (~2.6 s/page vs ~12 s/page for per-page converts).
        """
        total = job.progress_total if job.progress_total > 0 else get_page_count(pdf_path)
        total = total if total > 0 else 1
        converter = create_document_converter()
        md = convert_one_pdf_to_markdown(converter, pdf_path)
        job.progress_done = total
        return md, total, build_page_map(md, total)

    loop = asyncio.get_running_loop()
    try:
        ocr_task = loop.run_in_executor(None, _do_ocr)
        start = time.time()
        elapsed = 0
        last_done = -1
        estimate_total = estimate_total_seconds(max(job.progress_total, 1))
        # Heuristic progress: Docling reports nothing mid-document, so the
        # bar follows verified per-page timings until real completion lands.
        while not ocr_task.done():
            await asyncio.sleep(1)
            elapsed = int(time.time() - start)
            total = job.progress_total
            if total > 0:
                done = estimate_done_pages(total, time.time() - start)
                eta = max(0, int(estimate_total - (time.time() - start)))
            else:
                done, eta = job.progress_done, 0
            if done != last_done and total > 0:
                last_done = done
                # Mirror the estimate so polling clients see movement too;
                # the worker overwrites with the real total on completion.
                job.progress_done = done
                console.print(
                    f"  [cyan]OCR {job.job_id} progress (est): "
                    f"{done}/{total} pages ({elapsed}s, ETA {eta}s)[/cyan]"
                )
                for q in job.event_queues:
                    await q.put({"type": "progress", "done": done, "total": total, "eta": eta})
            else:
                for q in job.event_queues:
                    await q.put(
                        {
                            "type": "keepalive",
                            "done": done,
                            "total": total,
                            "elapsed": elapsed,
                            "eta": eta,
                        }
                    )
                if elapsed % 5 == 0:
                    console.print(
                        f"  [dim]OCR {job.job_id} running... "
                        f"{elapsed}s (~{done}/{total} pages, ETA {eta}s)[/dim]"
                    )

        md_raw, total, page_map_init = await ocr_task
        job.progress_done = total
        console.print(f"[green]OCR {job.job_id} docling done, post-processing...[/green]")

        # Post-process whole-document markdown (page map re-estimated post-mutation).
        md, sections, page_map = apply_postprocessing(md_raw, opts, page_map_init)

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
