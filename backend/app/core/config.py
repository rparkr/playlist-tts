"""Application configuration."""

from pathlib import Path


class Settings:
    """Application settings."""

    app_name: str = "OCR-TTS Reader"
    storage_dir: Path = Path("storage")
    max_pdf_mb: int = 100
    max_wav_mb: int = 20


settings = Settings()
