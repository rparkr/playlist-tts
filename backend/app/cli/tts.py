"""CLI for TTS — reuses pocket-tts and backend services."""

from pathlib import Path

import typer
from rich.console import Console
from rich.progress import (
    BarColumn,
    MofNCompleteColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeRemainingColumn,
)

console = Console()
app = typer.Typer(
    help="Convert Markdown to WAV via pocket-tts (reuse backend services).",
    add_completion=False,
)


def _clean_markdown_for_tts(text: str) -> str:
    """Strip Markdown syntax for speech."""
    import re

    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*>\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*[-*_]{3,}\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", text)
    text = re.sub(r"(\*\*|__|\*|_|~~)", "", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)
    return text.strip()


@app.command()
def convert(
    input_file: Path = typer.Argument(
        ..., exists=True, file_okay=True, dir_okay=False, readable=True, help="Markdown input file."
    ),
    voice: str = typer.Option(
        "alba", "--voice", "-v", help="Builtin voice name or path to WAV/safetensors."
    ),
    output_path: Path | None = typer.Option(
        None, "--output-path", "-o", help="Output WAV path (default: <input>.wav)."
    ),
    quantize: bool = typer.Option(False, "--quantize", help="Use int8 quantized weights."),
    lsd_decode_steps: int = typer.Option(1, "--lsd-decode-steps"),
    temperature: float = typer.Option(0.7, "--temperature"),
    output_format: str = typer.Option("wav", "--format", help="wav, mp3, webm"),
) -> None:
    """Synthesize Markdown to audio."""
    if output_path is None:
        output_path = input_file.with_suffix(
            ".wav" if output_format == "wav" else f".{output_format}"
        )

    raw = input_file.read_text(encoding="utf-8")
    cleaned = _clean_markdown_for_tts(raw)
    if not cleaned:
        console.print("[bold red]Error:[/bold red] No speakable text after cleaning.")
        raise typer.Exit(code=1)

    # Synthesize via TTSModel streaming straight to file (fast path).
    console.print(f"[bold cyan]Input:[/bold cyan] {input_file}")
    console.print(f"[bold cyan]Voice:[/bold cyan] {voice}")
    console.print(f"[bold cyan]Output:[/bold cyan] {output_path} (format={output_format})")

    # Delegate to TTSModel streaming to file (fast path)
    import tempfile

    from pocket_tts import TTSModel

    with console.status("[bold green]Loading Pocket TTS model...[/bold green]", spinner="dots"):
        tts_model = TTSModel.load_model(quantize=quantize)
        # Resolve voice state — handles .safetensors, .wav, builtin
        # For templating, use get_state_for_audio_prompt directly (handles all)
        if voice.endswith(".safetensors"):
            state = tts_model.get_state_for_audio_prompt(Path(voice))
        elif Path(voice).exists():
            state = tts_model.get_state_for_audio_prompt(Path(voice), truncate=True)
        else:
            # builtin
            try:
                state = tts_model._cached_get_state_for_audio_prompt(voice)  # type: ignore[attr-defined]
            except Exception:
                state = tts_model.get_state_for_audio_prompt(voice)

    # Chunk via tokenizer-aware split (inside generate_audio_stream)
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        MofNCompleteColumn(),
        TimeRemainingColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("[cyan]Synthesizing...", total=None)
        # Use file streaming path for efficiency
        from pocket_tts.data.audio import stream_audio_chunks

        # Use model's streaming to file directly (handles chunking)
        chunks = tts_model.generate_audio_stream(state, cleaned)
        # For progress, we approximate — no total
        tmp_wav = (
            output_path
            if output_format == "wav"
            else Path(tempfile.gettempdir()) / f"{output_path.stem}.wav"
        )
        stream_audio_chunks(str(tmp_wav), chunks, tts_model.config.mimi.sample_rate)
        progress.update(task, completed=1)

    # Transcode if needed
    if output_format in ("mp3", "webm") and tmp_wav != output_path:
        try:
            import av  # ty: ignore[unresolved-import]

            fmt_map = {"mp3": "mp3", "webm": "webm"}
            codec = "libmp3lame" if output_format == "mp3" else "libopus"
            container_in = av.open(str(tmp_wav))
            container_out = av.open(str(output_path), mode="w", format=fmt_map[output_format])
            stream_out = container_out.add_stream(codec, rate=24000)
            for frame in container_in.decode(audio=0):
                for packet in stream_out.encode(frame):
                    container_out.mux(packet)
            for packet in stream_out.encode():
                container_out.mux(packet)
            container_in.close()
            container_out.close()
            Path(tmp_wav).unlink(missing_ok=True)
        except Exception as e:
            console.print(f"[yellow]Warning:[/yellow] Transcode failed, keeping WAV: {e}")
            if tmp_wav.exists() and tmp_wav != output_path:
                tmp_wav.rename(output_path)

    console.print(f"[bold green]✓ Done![/bold green] Saved to [bold]{output_path}[/bold]")


def main() -> None:
    """Run the TTS Typer application.

    Script entry point for the `tts` console script (see `pyproject.toml`).
    """
    app()


if __name__ == "__main__":
    main()
