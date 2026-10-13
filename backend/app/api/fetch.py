"""URL fetching — stateless article extraction for playlist items."""

from fastapi import APIRouter, HTTPException

from backend.app.models.schemas import FetchArticleRequest, FetchArticleResponse
from backend.app.services.article_service import ArticleFetchError, fetch_article

router = APIRouter(prefix="/api/fetch", tags=["fetch"])


@router.post("/article", response_model=FetchArticleResponse)
async def fetch_article_endpoint(body: FetchArticleRequest) -> FetchArticleResponse:
    """Fetch a public article URL and return Markdown plus metadata.

    Stateless: nothing is stored server-side. The frontend persists the
    Markdown in IndexedDB as a playlist item with a domain badge.
    """
    try:
        result = await fetch_article(body.url)
    except ArticleFetchError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return FetchArticleResponse(
        markdown=result.markdown,
        title=result.title,
        author=result.author,
        site=result.site,
        date=result.date,
        excerpt=result.excerpt,
        url=result.url,
        domain=result.domain,
    )
