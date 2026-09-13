"""Tests for postprocessing pipeline — reflow, uppercase, punctuation, parsing."""

from backend.app.models.schemas import PostprocessOptions
from backend.app.services.postprocess import (
    apply_postprocessing,
    build_page_map,
    chunk_text_into_sentences,
    dehyphenate,
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


def test_normalize_uppercase_single_long_word():
    """Single uppercase word >=5 chars → Title Case."""
    assert normalize_uppercase("WATER") == "Water"
    assert "Exampleof" in normalize_uppercase("This is an EXAMPLEOF word")


def test_normalize_uppercase_preserves_short_acronym():
    """Isolated short uppercase words stay as-is."""
    out = normalize_uppercase("This is NASA here")
    assert "NASA" in out


def test_normalize_uppercase_runs():
    """Two or more consecutive uppercase words → Title Case."""
    out = normalize_uppercase("SAIL BOAT and normal")
    assert "Sail Boat" in out


def test_normalize_uppercase_skips_code_fences():
    """Code fences are left untouched."""
    md = "```\nTHIS IS CODE\n```\nSAIL BOAT"
    out = normalize_uppercase(md)
    assert "THIS IS CODE" in out
    assert "Sail Boat" in out


def test_postprocess_options_uppercase_back_compat():
    """Legacy string modes coerce to bool."""
    assert PostprocessOptions(normalize_uppercase="off").normalize_uppercase is False  # type: ignore[arg-type]
    assert PostprocessOptions(normalize_uppercase="title").normalize_uppercase is True  # type: ignore[arg-type]


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
        normalize_uppercase=True,
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


def test_page_markers_use_true_breaks_not_columns():
    """Page markers follow true page breaks, not mid-page column splits."""
    raw = (
        "Depending on how it is harnessed, stored, distributed, and used, energy can"
        "\n\ntake many forms. On the Earth, we can trace nearly all our energy back to the sun."
        "\n\n<!-- page break -->\n\nSecond page content starts here. More text on page two."
    )
    opts = PostprocessOptions(combine_columns=True, insert_page_markers=True)
    md, _, pm = apply_postprocessing(raw, opts, build_page_map(raw, 2))
    assert "energy can take many forms." in md
    assert md.index("take many forms.") < md.index("Page 2.")
    assert md.index("Page 2.") < md.index("Second page")
    assert len(pm) == 2


def test_page_break_placeholders_preserved_through_strip():
    """Image cleanup must not eat page-break tokens."""
    from backend.app.services.postprocess import _strip_image_artifacts, has_page_breaks

    raw = "Page one.\n\n<!-- page break -->\n\n<!-- image -->\nOther\nPage two."
    cleaned = _strip_image_artifacts(raw)
    assert has_page_breaks(cleaned)
    assert "<!-- image -->" not in cleaned


def test_dehyphenate_inline_breaks():
    """Hyphen + space/newline between letters joins to one word."""
    assert (
        dehyphenate("stresses and dete- rioration and even")
        == "stresses and deterioration and even"
    )
    assert dehyphenate("cables in combi- nation with") == "cables in combination with"
    assert dehyphenate("more reli- able signals") == "more reliable signals"
    assert (
        dehyphenate("immune to electromag- netic interference")
        == "immune to electromagnetic interference"
    )
    assert dehyphenate("easy to dis- tinguish from") == "easy to distinguish from"
    assert dehyphenate("stresses and dete-\nrioration and") == "stresses and deterioration and"


def test_dehyphenate_preserves_legitimate_hyphens():
    """Real hyphens, spaced dashes, and digit ranges are untouched."""
    assert dehyphenate("fiber-optic cables") == "fiber-optic cables"
    assert dehyphenate("word - word stays") == "word - word stays"
    assert dehyphenate("pages 1990- 1995 here") == "pages 1990- 1995 here"
    out = dehyphenate("```\nCODE- WITH space\n```\nnormal dete- rioration")
    assert "CODE- WITH" in out
    assert "deterioration" in out


def test_apply_postprocessing_dehyphenates():
    """Full pipeline joins hyphen breaks when combine_columns is on."""
    md = "they can suffer undue stresses and dete- rioration and even pull."
    opts = PostprocessOptions(combine_columns=True, insert_page_markers=False)
    out_md, _, _ = apply_postprocessing(md, opts, None)
    assert "deterioration" in out_md
    assert "dete- rioration" not in out_md
