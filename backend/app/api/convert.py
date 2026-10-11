"""Document conversion endpoints — ePub to Markdown (stateless)."""

import base64

from fastapi import APIRouter, File, HTTPException, UploadFile

from backend.app.models.schemas import ConvertEpubResponse, EpubImage
from backend.app.services.epub_service import EpubConvertError, convert_epub

router = APIRouter(prefix="/api/convert", tags=["convert"])


def _is_epub_upload(filename: str | None, content_type: str | None, data: bytes) -> bool:
    """Check whether an upload looks like an ePub (extension, type, or content).

    Accept if *any* signal matches: `.epub` extension, the ePub content
    type, or zip magic bytes plus a `mimetype` entry starting with
    `application/epub` (checked without fully unzipping).
    """
    if filename and filename.lower().endswith(".epub"):
        return True
    if content_type and content_type.lower().split(";")[0].strip() in (
        "application/epub+zip",
        "application/epub",
    ):
        return True
    return data.startswith(b"PK\x03\x04") and b"mimetypeapplication/epub+zip" in data[:64]


@router.post("/epub", response_model=ConvertEpubResponse)
async def convert_epub_endpoint(file: UploadFile = File(...)) -> ConvertEpubResponse:
    """Convert an uploaded ePub book to Markdown plus image binaries.

    Stateless: nothing is stored server-side. The frontend persists the
    Markdown in IndexedDB (with the images as doc assets) as a playlist
    item with an ePub badge.
    """
    data = await file.read()
    if not _is_epub_upload(file.filename, file.content_type, data):
        raise HTTPException(status_code=400, detail="Only ePub files are supported.")
    try:
        result = convert_epub(data)
    except EpubConvertError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return ConvertEpubResponse(
        markdown=result.markdown,
        title=result.title,
        author=result.author,
        images=[
            EpubImage(
                path=img.path,
                media_type=img.media_type,
                data_b64=base64.b64encode(img.data).decode(),
            )
            for img in result.images
        ],
    )
