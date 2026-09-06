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

    # Reuse service logic directly

    # We need to run docling synchronously — replicate fewer layers
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import VlmPipelineOptions, vlm_model_specs
    from docling.document_converter import DocumentConverter, PdfFormatOption
    from docling.pipeline.vlm_pipeline import VlmPipeline
    from rich.progress import (
        BarColumn,
        MofNCompleteColumn,
        Progress,
        SpinnerColumn,
        TextColumn,
        TimeRemainingColumn,
    )

    pipeline_options = VlmPipelineOptions(vlm_options=vlm_model_specs.GRANITEDOCLING_TRANSFORMERS)
    converter = DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(
                pipeline_cls=VlmPipeline, pipeline_options=pipeline_options
            )
        }
    )

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
        result = converter.convert(input_pdf)
        if result.status.name != "SUCCESS":
            console.print(f"[bold red]Error:[/bold red] Conversion failed: {result.status}")
            raise typer.Exit(code=1)
        if total > 0:
            progress.update(task, completed=total)

        md_raw = result.document.export_to_markdown()
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
