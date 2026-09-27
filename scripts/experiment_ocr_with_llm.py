#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "openai",
#     "pypdf[image]",
#     "typer",
#     "rich",
# ]
# ///

import asyncio
import base64
import logging
import mimetypes
from pathlib import Path
from typing import Annotated, Any

import typer
from openai import AsyncOpenAI
from rich.progress import (
    BarColumn,
    Progress,
    SpinnerColumn,
    TaskID,
    TextColumn,
    TimeElapsedColumn,
    TimeRemainingColumn,
)

LLAMA_CPP_BASE_URL: str = "http://127.0.0.1:8080/v1"
DEFAULT_MODEL: str = "qwen3.5-4b"
DEFAULT_SYSTEM_MESSAGE = (
    "Extract text from the page in reading order. Do not include any preamble like: "
    '"Here\'s the extracted text:";  instead, begin directly with the text from the page.'
)
DEFAULT_USER_MESSAGE = (
    "Please extract all the English text from this page. "
    "When extracting text, include handwritten script as well as typed. "
    "Keep paragraphs together. For paragraphs that continue on the next column, keep "
    "the continuation with the paragraph it started in so the paragraph stays together. "
    "Collapse hyphenated word breaks at the end of lines, merging the word segments "
    "together.\n\n"
    "If there is no text to extract, say `<no text found>`, followed by a detailed "
    "description of the scene in the image."
)

app = typer.Typer(
    no_args_is_help=True,
    help="Extract text from a directory of images or a single PDF using an LLM.",
)

file_handler = logging.FileHandler("llm-ocr.log")
logger = logging.getLogger()
logger.addHandler(file_handler)


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


async def complete_with_images(
    client: AsyncOpenAI,
    images: list[tuple[bytes, str]],
    model: str = DEFAULT_MODEL,
    system_message: str = DEFAULT_SYSTEM_MESSAGE,
    user_message: str = DEFAULT_USER_MESSAGE,
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
        extra_body={
            "chat_template_kwargs": {"enable_thinking": enable_thinking},
        },
        temperature=0,
        messages=messages,
    )
    return (response.choices[0].message.content or "").strip()


async def process_one_image(
    client: AsyncOpenAI,
    image_path: Path,
    output_directory: Path,
    progress: Progress,
    task_id: TaskID,
    model: str = DEFAULT_MODEL,
    system_message: str = DEFAULT_SYSTEM_MESSAGE,
    user_message: str = DEFAULT_USER_MESSAGE,
    enable_thinking: bool = False,
) -> None:
    """
    Record the LLM's output from a single-turn conversation with one input image.

    The LLM's final response is saved to a `.md` file with the same name as the
    input image. The response excludes thinking tokens, regardless of the
    enabled_thinking setting.

    Args:
        client: the OpenAI client.
        image_path: path-like object to the image file.
        output_directory: path-like object to the directory where the output will be
            saved.
        progress: `rich.Progress` object for the progress bar.
        task_id: identifies the task for the progress bar updates.
        model: the name of the model to use.
        system_message: the system message for the chat conversation.
        usre_message: the user's prompt for the chat conversation.
        enable_thinking: whether to allow the model to emit `<think>` blocks prior
            to responding.

    Returns:
        None
    """
    try:
        image_path = Path(image_path)
        mime_type, _ = mimetypes.guess_type(image_path)
        if not mime_type:
            progress.update(
                task_id,
                description=f"[red]Skipped (unknown type): {image_path.name}[/red]",
                advance=1,
            )
            return None

        progress.update(task_id, description=f"Working on: {image_path.name}")

        # Read image bytes without blocking the event loop.
        loop = asyncio.get_running_loop()
        image_bytes = await loop.run_in_executor(None, image_path.read_bytes)

        text = await complete_with_images(
            client,
            [(image_bytes, mime_type)],
            model=model,
            system_message=system_message,
            user_message=user_message,
            enable_thinking=enable_thinking,
        )

        # Save the output
        output_path = (output_directory / image_path.stem).with_suffix(".md")
        output_path.write_text(text)
        progress.update(
            task_id, description=f"[green]Completed[/green] {image_path.name}", advance=1
        )
    except Exception as e:
        logger.debug(f"Failed to process {image_path.name}.", exc_info=True, stack_info=True)
        progress.update(
            task_id, description=f"[red]Failed: {image_path.name} ({str(e)})[/red]", advance=1
        )
    return None


def extract_pdf_page_images(pdf_path: Path) -> list[list[tuple[bytes, str]]]:
    """Extract embedded images per page from a PDF using pypdf.

    Args:
        pdf_path: path to the input PDF file.

    Returns:
        One entry per PDF page; each entry is a list of
        (raw image bytes, MIME type) tuples in embedded order.
        Pages without extractable images yield an empty list.
    """
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    pages: list[list[tuple[bytes, str]]] = []
    for page in reader.pages:
        images: list[tuple[bytes, str]] = []
        for img in page.images:
            try:
                data: bytes = img.data
            except Exception:
                logger.debug(f"Skipping unreadable image {img.name}.", exc_info=True)
                continue
            if not data:
                continue
            mime_type = _guess_image_mime(img.name, data)
            if mime_type is None:
                logger.debug(f"Skipping image with unknown type: {img.name}.")
                continue
            images.append((data, mime_type))
        pages.append(images)
    return pages


async def process_one_pdf_page(
    client: AsyncOpenAI,
    page_number: int,
    images: list[tuple[bytes, str]],
    progress: Progress,
    task_id: TaskID,
    model: str = DEFAULT_MODEL,
    system_message: str = DEFAULT_SYSTEM_MESSAGE,
    user_message: str = DEFAULT_USER_MESSAGE,
    enable_thinking: bool = False,
) -> tuple[int, str]:
    """Run one LLM turn over a PDF page's embedded images.

    Args:
        client: the OpenAI client.
        page_number: 1-indexed PDF page number.
        images: (raw bytes, MIME type) tuples for this page.
        progress: `rich.Progress` object for the progress bar.
        task_id: identifies the task for the progress bar updates.
        model: the name of the model to use.
        system_message: the system message for the chat conversation.
        user_message: the user's prompt for the chat conversation.
        enable_thinking: whether to allow `<think>` blocks prior to responding.

    Returns:
        (page_number, stripped LLM response); empty string when the page
        has no extractable images or processing fails.
    """
    label = f"page {page_number}"
    try:
        if not images:
            progress.update(
                task_id,
                description=f"[yellow]No images on {label}, skipping[/yellow]",
                advance=1,
            )
            return page_number, ""
        progress.update(task_id, description=f"Working on: {label}")
        text = await complete_with_images(
            client,
            images,
            model=model,
            system_message=system_message,
            user_message=user_message,
            enable_thinking=enable_thinking,
        )
        progress.update(task_id, description=f"[green]Completed[/green] {label}", advance=1)
        return page_number, text
    except Exception as e:
        logger.debug(f"Failed to process {label}.", exc_info=True, stack_info=True)
        progress.update(task_id, description=f"[red]Failed: {label} ({str(e)})[/red]", advance=1)
        return page_number, ""


def join_page_texts(pages: list[str]) -> str:
    """Join per-page texts with standalone `Page N.` markers.

    Match the `Page N.` marker format used by `backend.app.services.postprocess`
    (`join_pages_with_markers`): page 1 has no leading marker; each later page
    is preceded by a standalone `Page N.` paragraph. Page numbers stay aligned
    with PDF pages, so empty pages are kept rather than dropped.

    Args:
        pages: per-page texts in PDF order.

    Returns:
        Single Markdown string.
    """
    stripped = [(p or "").strip() for p in pages]
    if not stripped:
        return ""
    parts: list[str] = [stripped[0]]
    for page_number, text in enumerate(stripped[1:], start=2):
        parts.append(f"\n\nPage {page_number}.\n\n")
        parts.append(text)
    return "".join(parts).strip() + "\n"


async def process_pdf(
    pdf_path: Path,
    output_file: Path | None,
    base_url: str = LLAMA_CPP_BASE_URL,
    model: str = DEFAULT_MODEL,
    system_message: str = DEFAULT_SYSTEM_MESSAGE,
    user_message: str = DEFAULT_USER_MESSAGE,
    enable_thinking: bool = False,
) -> None:
    """Extract embedded images from a PDF and OCR each page with the LLM.

    Write a single Markdown file (default: same name as the PDF with a `.md`
    extension) joining per-page results with `Page N.` markers.
    """
    pdf_path = pdf_path.expanduser()
    output_path = output_file.expanduser() if output_file else pdf_path.with_suffix(".md")

    client = AsyncOpenAI(base_url=base_url, api_key="local-no-key-required")

    loop = asyncio.get_running_loop()
    page_images = await loop.run_in_executor(None, extract_pdf_page_images, pdf_path)

    if not page_images:
        typer.echo(f"No pages found in {pdf_path}")
        return

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        transient=False,
    ) as progress:
        main_task_id = progress.add_task(
            description=f"[yellow]Processing PDF pages at {pdf_path.name}...[/yellow]",
            total=len(page_images),
        )
        tasks = [
            process_one_pdf_page(
                client=client,
                page_number=i + 1,
                images=images,
                progress=progress,
                task_id=main_task_id,
                model=model,
                system_message=system_message,
                user_message=user_message,
                enable_thinking=enable_thinking,
            )
            for i, images in enumerate(page_images)
        ]
        results = await asyncio.gather(*tasks)
        progress.update(main_task_id, description="[bold green]✔ Finished![/bold green]")

    ordered = [text for _, text in sorted(results, key=lambda r: r[0])]
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(join_page_texts(ordered), encoding="utf-8")
    typer.echo(f"Saved Markdown to {output_path}")


async def process_all_images(
    image_directory: Path,
    output_directory: Path | None,
    base_url: str = LLAMA_CPP_BASE_URL,
    model: str = DEFAULT_MODEL,
    system_message: str = DEFAULT_SYSTEM_MESSAGE,
    user_message: str = DEFAULT_USER_MESSAGE,
    enable_thinking: bool = False,
) -> None:
    """Concurrently processes all images in a directory."""
    # Initialize the Async Client
    client = AsyncOpenAI(base_url=base_url, api_key="local-no-key-required")

    # Filter files using pathlib
    image_extensions = {".jpg", ".jpeg", ".png", ".webp"}
    image_files = sorted(
        [
            p
            for p in image_directory.expanduser().iterdir()
            if p.is_file() and p.suffix.lower() in image_extensions
        ]
    )

    if not image_files:
        typer.echo(f"No matching images found in {image_directory}")
        return

    if not output_directory:
        output_directory = image_directory / "extracted_text"

    output_directory.mkdir(parents=True, exist_ok=True)

    # Set up multi-progress tracker tracking each individual file asynchronously
    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        transient=False,
    ) as progress:
        tasks = []
        main_task_id = progress.add_task(
            description=f"[yellow]Processing files at {image_directory}...[/yellow]",
            total=len(image_files),
        )
        for img_path in image_files:
            # Create a localized progress bar slot for each file
            # task_id = progress.add_task(
            #     description=f"[yellow]Processing: {img_path.name}[/yellow]", total=1
            # )

            # Queue the async coroutine
            tasks.append(
                process_one_image(
                    client=client,
                    image_path=img_path,
                    output_directory=output_directory,
                    progress=progress,
                    task_id=main_task_id,
                    model=model,
                    system_message=system_message,
                    user_message=user_message,
                    enable_thinking=enable_thinking,
                )
            )

        # Run all scheduled API execution contexts concurrently
        await asyncio.gather(*tasks)

        progress.update(main_task_id, description="[bold green]✔ Finished![/bold green]")


@app.command(no_args_is_help=True)
def process(
    input_path: Annotated[
        Path,
        typer.Argument(
            help="Path to a directory of images or a single PDF file.",
            exists=True,
            file_okay=True,
            dir_okay=True,
            resolve_path=True,
        ),
    ],
    output_dir: Annotated[
        Path | None,
        typer.Option(
            help="Output directory for image-folder mode. "
            "If not specified, `extracted_text` under the input will be used. "
            "In PDF mode, used as the parent directory when --output is omitted.",
            file_okay=False,
            dir_okay=True,
            resolve_path=True,
        ),
    ] = None,
    output_file: Annotated[
        Path | None,
        typer.Option(
            "--output",
            "-o",
            help="Output Markdown file for PDF mode. "
            "Defaults to the PDF path with a `.md` extension.",
            file_okay=True,
            dir_okay=False,
            resolve_path=True,
        ),
    ] = None,
    server_url: Annotated[
        str, typer.Option("--base-url", help="Base URL of your local llama.cpp server")
    ] = LLAMA_CPP_BASE_URL,
    model: Annotated[
        str, typer.Option("--model", help="Model name identifier loaded in your local server")
    ] = DEFAULT_MODEL,
    system_message: Annotated[
        str,
        typer.Option(
            "--system",
            help="System prompt with each conversation.",
        ),
    ] = DEFAULT_SYSTEM_MESSAGE,
    user_message: Annotated[
        str,
        typer.Option(
            "--user",
            help="User prompt for each image.",
        ),
    ] = DEFAULT_USER_MESSAGE,
):
    """
    Process a folder of images or a single PDF concurrently using llama.cpp.

    Directory input writes one `.md` file per image; PDF input extracts
    embedded images with pypdf and writes a single `.md` file with
    `Page N.` markers between pages.
    """
    resolved = input_path.expanduser()
    if resolved.is_dir():
        asyncio.run(
            process_all_images(
                image_directory=resolved,
                output_directory=output_dir,
                base_url=server_url,
                model=model,
                system_message=system_message,
                user_message=user_message,
            )
        )
        return
    if resolved.is_file() and resolved.suffix.lower() == ".pdf":
        if output_file is None and output_dir is not None:
            output_path = (output_dir.expanduser() / resolved.stem).with_suffix(".md")
        else:
            output_path = output_file
        asyncio.run(
            process_pdf(
                pdf_path=resolved,
                output_file=output_path,
                base_url=server_url,
                model=model,
                system_message=system_message,
                user_message=user_message,
            )
        )
        return
    typer.echo(f"Unsupported input: {input_path}. Provide an image directory or a .pdf file.")
    raise typer.Exit(code=2)


if __name__ == "__main__":
    app()
