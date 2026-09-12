"""CLI for OCR — reuses backend services."""

from pathlib import Path
from typing import Literal

import typer
from rich.console import Console

from backend.app.models.schemas import PostprocessOptions
from backend.app.services.postprocess import apply_postprocessing, build_page_map

console = Console()
app = typer.Typer(
    help="OCR PDF to Markdown via granite-docling (reuse backend services).",
    add_completion=False,
)


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
    normalize_uppercase: Literal["off", "title", "lower_long"] = typer.Option(
        "off", "--normalize-uppercase", help="Uppercase normalization mode."
    ),
    ensure_punctuation: bool = typer.Option(
        False, "--ensure-punctuation", help="Ensure headers end with punctuation."
    ),
    no_page_markers: bool = typer.Option(False, "--no-page-markers", help="Disable page markers."),
) -> None:
    """Run granite-docling OCR on a PDF and write Markdown."""
    output_path = output or input_pdf.with_suffix(".md")

    opts = PostprocessOptions(
        combine_columns=not no_reflow,
        normalize_uppercase=normalize_uppercase,
        ensure_punctuation=ensure_punctuation,
        insert_page_markers=not no_page_markers,
    )

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
