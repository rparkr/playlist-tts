"""Structured JSONL logging for the LLM OCR engine.

Each line is one self-contained JSON object::

    {"ts": "2026-09-27T04:00:00+00:00", "run": "a4ab20d85bc3",
     "event": "page_completed", "page": 2, "method": "llm", ...}

`run` ties every line of one document run together (the API job id for
server jobs, a generated id for CLI runs). Configure once per process with
`configure_llm_logging`; all later `log_llm_event` calls append. Setup is
idempotent, so API job creation and the CLI can both call it safely.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
from pathlib import Path

LLM_LOGGER_NAME: str = "ocr_tts.llm_ocr"
LLM_LOG_FILE_ENV: str = "LLM_OCR_LOG_FILE"
DEFAULT_LOG_FILE: str = "llm-ocr.jsonl"


class JSONLFormatter(logging.Formatter):
    """Render the attached `llm_record` dict as one JSON object per line."""

    def format(self, record: logging.LogRecord) -> str:
        """Format a log record as a single JSON line."""
        payload = getattr(record, "llm_record", None)
        if not isinstance(payload, dict):
            payload = {"message": record.getMessage()}
        return json.dumps(payload, default=str)


def configured_log_files() -> list[Path]:
    """List JSONL files currently attached to the LLM OCR logger."""
    return [
        Path(handler.baseFilename).resolve()
        for handler in logging.getLogger(LLM_LOGGER_NAME).handlers
        if isinstance(handler, logging.FileHandler)
    ]


def configure_llm_logging(path: str | Path | None = None) -> Path:
    """Attach a JSONL file handler to the LLM OCR logger (idempotent).

    Args:
        path: destination file (appended, parents created). None resolves
            from the `LLM_OCR_LOG_FILE` env var, defaulting to `llm-ocr.jsonl`
            in the working directory.

    Returns:
        Resolved log path.
    """
    resolved = Path(path if path is not None else os.getenv(LLM_LOG_FILE_ENV, DEFAULT_LOG_FILE))
    resolved.parent.mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger(LLM_LOGGER_NAME)
    logger.setLevel(logging.INFO)
    if resolved.resolve() not in configured_log_files():
        logger.addHandler(logging.FileHandler(resolved, encoding="utf-8"))
        logger.handlers[-1].setFormatter(JSONLFormatter())
    return resolved


def log_llm_event(event: str, run_id: str, message: str = "", **fields: object) -> None:
    """Append one structured record to the JSONL log (if configured).

    Also emits `message` (or the event name) through normal logging, so the
    record stays human-readable on the console even without a file handler.

    Args:
        event: machine-readable event name (e.g. `page_completed`).
        run_id: ties all lines of one document run together.
        message: human-readable console message.
        fields: additional JSON-serializable record fields.
    """
    record = {
        "ts": datetime.datetime.now(datetime.UTC).isoformat(),
        "run": run_id,
        "event": event,
        **fields,
    }
    logging.getLogger(LLM_LOGGER_NAME).info(message or event, extra={"llm_record": record})
