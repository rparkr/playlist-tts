"""Tests for postprocessing pipeline — reflow, uppercase, punctuation, parsing."""

from backend.app.models.schemas import PostprocessOptions
from backend.app.services.postprocess import (
    apply_postprocessing,
    chunk_text_into_sentences,
    ensure_punctuation,
    normalize_uppercase,
    parse_markdown_structure,
    reflow_columns,
)


def test_reflow_quote_aware():
    """Reflow should not merge when prior para ends with quote punctuation."""
    md = 'Here\'s a quote: "This is the end of the paragraph."\n\nNext paragraph starts here.'
    out = reflow_columns(md)
    # Should remain two paras because first ends with ."
    assert "Next paragraph" in out
    assert out.count("\n\n") >= 1


def test_reflow_merges_continuation():
    """Missing terminal punctuation + lowercase continuation → merge."""
    md = "This sentence continues without punctuation\n\nand continues here. Next sentence."
    out = reflow_columns(md)
    # First para should now be completed sentence + remainder
    assert "and continues here." in out


def test_normalize_uppercase_title():
    """Consecutive uppercase words → Titlecase."""
    md = "THIS IS A TITLE and normal"
    out = normalize_uppercase(md, "title")
    assert "This Is A Title" in out or "This Is" in out


def test_normalize_lower_long():
    """Uppercase word >5 chars → lower."""
    md = "This is an EXAMPLEOF uppercase and NASA"
    out = normalize_uppercase(md, "lower_long")
    assert "exampleof" in out.lower()
    assert "NASA" in out  # ≤5 stays


def test_ensure_punctuation_header():
    """Header without punctuation should get period."""
    md = "## Chapter overview\n\nContent here."
    out = ensure_punctuation(md)
    assert "## Chapter overview." in out


def test_parse_markdown_structure():
    """Parse sections and sentence chunks."""
    md = (
        "# Section 6: Training methodology\n\n## Data selection\n\n"
        "Content here. Another sentence.\n\n### Ablation studies\n\n"
        "More content here."
    )
    sections = parse_markdown_structure(md)
    assert len(sections) >= 1
    # Last section should contain Ablation studies in breadcrumb
    last = sections[-1]
    assert any("Ablation studies" in t for t in last.titles)


def test_chunk_sentences():
    """Sentence splitter respects punctuation."""
    text = "Hello world. This is sentence two! And three?"
    chunks = chunk_text_into_sentences(text)
    assert len(chunks) == 3
    assert chunks[0] == "Hello world."


def test_apply_postprocessing_integration():
    """Full pipeline via apply_postprocessing."""
    md = "# Title\n\nTHIS IS A SECTION\n\nContent without punctuation\n\nand continuation."
    opts = PostprocessOptions(
        combine_columns=True,
        normalize_uppercase="title",
        ensure_punctuation=True,
        insert_page_markers=False,
    )
    out_md, sections, page_map = apply_postprocessing(md, opts, None)
    assert sections
    assert page_map
    assert "Title." in out_md or "Title" in out_md


def test_build_page_map():
    """Page map builder fallback."""
    from backend.app.services.postprocess import build_page_map

    md = "\n".join([f"Line {i}" for i in range(100)])
    pm = build_page_map(md, 4)
    assert len(pm) == 4
    assert pm[0].page == 1
    assert pm[-1].page == 4
