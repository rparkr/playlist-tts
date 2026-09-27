"""CLI for OCR — reuses backend services."""

import asyncio
from pathlib import Path

import typer
from rich.console import Console

from backend.app.models.schemas import PostprocessOptions
from backend.app.services.postprocess import apply_postprocessing, build_page_map

console = Console()
app = typer.Typer(
    help="OCR PDF to Markdown via granite-docling (reuse backend services).",
    add_completion=False,
)


def _convert_with_llm(
    input_pdf: Path,
    output_path: Path,
    opts: PostprocessOptions,
    base_url: str | None,
    model: str | None,
    concurrency: int | None,
    log_file: Path | None,
) -> None:
    """Run vision-LLM OCR on a PDF with real per-page progress.

    Args:
        input_pdf: path to the input PDF file.
        output_path: destination Markdown path.
        opts: post-processing flags.
        base_url: OpenAI-compatible base URL (None resolves from the environment).
        model: model name (None resolves from the environment).
        concurrency: max in-flight pages (None resolves from the environment).
        log_file: JSONL run-log destination (None resolves from the environment).
    """
    from rich.progress import (
        BarColumn,
        MofNCompleteColumn,
        Progress,
        SpinnerColumn,
        TextColumn,
        TimeRemainingColumn,
    )

    from backend.app.services.llm_logging import configure_llm_logging
    from backend.app.services.llm_ocr_service import LLMConfig, convert_pdf_with_llm
    from backend.app.services.ocr_service import get_page_count

    config = LLMConfig.from_env(base_url=base_url, model=model, concurrency=concurrency)
    log_path = configure_llm_logging(log_file)
    total = get_page_count(input_pdf)

    console.print(f"[bold cyan]Input:[/bold cyan] {input_pdf} ({total} pages)")
    console.print(f"[bold cyan]Output:[/bold cyan] {output_path}")
    console.print(f"[bold cyan]Engine:[/bold cyan] llm ({config.model} at {config.base_url})")
    console.print(f"[bold cyan]Run log:[/bold cyan] {log_path}")

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Processing LLM OCR...", total=total if total > 0 else None)

        def _on_page_done(_page_number: int) -> None:
            progress.update(task, advance=1)

        md, _, _ = asyncio.run(
            convert_pdf_with_llm(input_pdf, opts, config, on_page_done=_on_page_done)
        )
        if total > 0:
            progress.update(task, completed=total)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(md, encoding="utf-8")
    console.print(f"[bold green]✓ Done![/bold green] Saved to [bold]{output_path}[/bold]")


@app.command()
def convert(
    input_pdf: Path = typer.Argument(
        ...,
        exists=True,
        file_okay=True,
        dir_okay=False,
        readable=True,
        help="Path to input PDF.",
    ),
    output: Path | None = typer.Option(
        None, "--output", "-o", help="Output Markdown path (default: <input>.md)."
    ),
    no_reflow: bool = typer.Option(False, "--no-reflow", help="Disable column reflow."),
    normalize_uppercase: bool = typer.Option(
        False,
        "--normalize-uppercase/--no-normalize-uppercase",
        help="Normalize uppercase spans to Title Case for TTS.",
    ),
    ensure_punctuation: bool = typer.Option(
        False, "--ensure-punctuation", help="Ensure headers end with punctuation."
    ),
    no_page_markers: bool = typer.Option(False, "--no-page-markers", help="Disable page markers."),
    first_page_marker: bool = typer.Option(
        False, "--first-page-marker", help="Emit a Page 1. marker (LLM engine)."
    ),
    engine: str = typer.Option("docling", "--engine", help="OCR engine: docling or llm."),
    llm_base_url: str | None = typer.Option(
        None,
        "--llm-base-url",
        help="LLM server base URL.",
    ),
    llm_model: str | None = typer.Option(None, "--llm-model", help="LLM model name."),
    llm_concurrency: int | None = typer.Option(
        None,
        "--llm-concurrency",
        help="LLM max in-flight pages (0 = unbounded).",
    ),
    log_file: Path | None = typer.Option(
        None, "--log-file", help="Append JSONL run log here (default: llm-ocr.jsonl)."
    ),
) -> None:
    """Run OCR on a PDF and write Markdown (granite-docling or vision LLM)."""
    output_path = output or input_pdf.with_suffix(".md")

    opts = PostprocessOptions(
        combine_columns=not no_reflow,
        normalize_uppercase=normalize_uppercase,
        ensure_punctuation=ensure_punctuation,
        insert_page_markers=not no_page_markers,
        first_page_marker=first_page_marker,
    )

    if engine not in ("docling", "llm"):
        raise typer.BadParameter("--engine must be 'docling' or 'llm'.")
    if engine == "llm":
        _convert_with_llm(
            input_pdf, output_path, opts, llm_base_url, llm_model, llm_concurrency, log_file
        )
        return

    # Direct OCR without job layer (synchronous, for CLI)
    from pypdf import PdfReader

    try:
        total = len(PdfReader(str(input_pdf)).pages)
    except Exception:
        total = 0

    console.print(f"[bold cyan]Input:[/bold cyan] {input_pdf} ({total} pages)")
    console.print(f"[bold cyan]Output:[/bold cyan] {output_path}")
    console.print("[bold green]Initializing Granite VLM Pipeline...[/bold green]")

    # Reuse service logic directly (whole-doc convert, heuristic ETA bar)
    import threading
    import time

    from rich.progress import (
        BarColumn,
        MofNCompleteColumn,
        Progress,
        SpinnerColumn,
        TextColumn,
        TimeRemainingColumn,
    )

    from backend.app.services.ocr_service import (
        convert_one_pdf_to_markdown,
        create_document_converter,
        estimate_done_pages,
    )

    converter = create_document_converter()

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(
            "[cyan]Processing OCR & Layout...", total=total if total > 0 else None
        )

        # Ticker thread advances the bar along verified per-page timings
        # while the blocking whole-document convert runs.
        start = time.time()
        stop = threading.Event()
        ticker: threading.Thread | None = None
        if total > 0:

            def _tick() -> None:
                while not stop.wait(1):
                    progress.update(task, completed=estimate_done_pages(total, time.time() - start))

            ticker = threading.Thread(target=_tick, daemon=True)
            ticker.start()

        md_raw = convert_one_pdf_to_markdown(converter, input_pdf)

        if ticker is not None:
            stop.set()
            ticker.join()
            progress.update(task, completed=total)

        page_map = build_page_map(md_raw, max(1, total))
        md, _, _ = apply_postprocessing(md_raw, opts, page_map)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(md, encoding="utf-8")
        console.print(f"[bold green]✓ Done![/bold green] Saved to [bold]{output_path}[/bold]")


def main() -> None:
    """Run the OCR Typer application.

    Script entry point for the `ocr` console script (see `pyproject.toml`).
    """
    app()


if __name__ == "__main__":
    main()
