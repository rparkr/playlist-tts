"""OpenAI-compatible stubs — silence external client probes.

Nothing in this repo calls `/v1/*`: the hits in uvicorn access logs come
from external OpenAI-client tooling pointed at this port (e.g. a harness
probing `GET /v1/models` to list models). Answer with a minimal
OpenAI-style payload instead of a 404 so the logs stay clean and probes
get a sane answer.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter(tags=["compat"])


@router.get("/v1/models")
async def list_models() -> JSONResponse:
    """List local models in OpenAI `GET /v1/models` shape."""
    return JSONResponse(
        {
            "object": "list",
            "data": [
                {
                    "id": "pocket-tts",
                    "object": "model",
                    "owned_by": "ocr-tts",
                },
            ],
        }
    )
