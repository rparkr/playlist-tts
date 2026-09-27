#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "openai",
#     "typer",
#     "rich",
# ]
# ///

import asyncio
import base64
import logging
import mimetypes
from pathlib import Path
from typing import Annotated

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
    '"Here\'s is the extracted text:";  instead, begin directly with the text from the page.'
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
    no_args_is_help=True, help="Extract text from all images in a folder using an LLM."
)

file_handler = logging.FileHandler("llm-ocr.log")
logger = logging.getLogger()
logger.addHandler(file_handler)


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

        # Read and encode image asynchronously in a separate thread pool to prevent blocking the event loop
        loop = asyncio.get_running_loop()

        def read_and_encode():
            return base64.b64encode(image_path.read_bytes()).decode("utf-8")

        base64_image = await loop.run_in_executor(None, read_and_encode)

        response = await client.chat.completions.create(
            model=model,
            extra_body={
                "chat_template_kwargs": {"enable_thinking": enable_thinking},
            },
            temperature=0,
            messages=[
                {"role": "system", "content": system_message},
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:{mime_type};base64,{base64_image}",
                            },
                        },
                        {
                            "type": "text",
                            "text": user_message,
                        },
                    ],
                },
            ],
        )

        # Save the output
        output_path = (output_directory / image_path.stem).with_suffix(".md")
        output_path.write_text((response.choices[0].message.content or "").strip())
        progress.update(
            task_id, description=f"[green]Completed[/green] {image_path.name}", advance=1
        )
    except Exception as e:
        logger.debug(f"Failed to process {image_path.name}.", exc_info=True, stack_info=True)
        progress.update(
            task_id, description=f"[red]Failed: {image_path.name} ({str(e)})[/red]", advance=1
        )
    return None


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
    directory: Annotated[
        Path,
        typer.Argument(
            help="Path to the directory containing images",
            exists=True,
            file_okay=False,
            dir_okay=True,
            resolve_path=True,
        ),
    ],
    output_dir: Annotated[
        Path | None,
        typer.Option(
            help="Output directory. If not specified, `extracted_text` will be used.",
            file_okay=False,
            dir_okay=True,
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
    Process all supported image files in a folder concurrently using llama.cpp and view progress.
    """
    asyncio.run(
        process_all_images(
            image_directory=directory,
            output_directory=output_dir,
            base_url=server_url,
            model=model,
            system_message=system_message,
            user_message=user_message,
        )
    )


if __name__ == "__main__":
    app()
