"""Tests for stateless ePub conversion (`POST /api/convert/epub`)."""

import io
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend.app.main import app
from backend.app.services.epub_service import EpubConvertError, convert_epub

client = TestClient(app)

CONTAINER_XML = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""

CONTENT_OPF = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item href="Text/ch1.xhtml" id="ch1" media-type="application/xhtml+xml"/>
    <item href="Text/ch2.xhtml" id="ch2" media-type="application/xhtml+xml"/>
    <item href="Images/pic.png" id="pic" media-type="image/png"/>
    <item href="toc.ncx" id="ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>"""

TOC_NCX = """<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1">
      <navLabel><text>First Steps</text></navLabel><content src="Text/ch1.xhtml"/>
    </navPoint>
    <navPoint id="n2">
      <navLabel><text>Next Moves</text></navLabel><content src="Text/ch2.xhtml"/>
    </navPoint>
  </navMap>
</ncx>"""

CH1 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch1</title></head><body>
<h1>First Steps</h1>
<p>One morning Norah cheerfully said that reading books aloud is a joyful habit worth keeping.</p>
<div><img alt="A red diagram" src="../Images/pic.png"/></div>
<p>She then explained the plan in detail so everyone listening could follow along with ease.</p>
</body></html>"""

CH2 = """<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>ch2</title></head><body>
<h1>Next Moves</h1>
<ul><li>Pack the notebooks for the trip</li><li>Charge every reader before dawn</li></ul>
</body></html>"""

# 1x1 transparent PNG.
PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def build_epub(
    ch1: str = CH1,
    ch2: str = CH2,
    *,
    with_encryption: bool = False,
    with_ncx: bool = True,
) -> bytes:
    """Assemble a minimal two-chapter ePub in memory."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("META-INF/container.xml", CONTAINER_XML)
        if with_encryption:
            zf.writestr("META-INF/encryption.xml", "<encryption/>")
        zf.writestr("OEBPS/content.opf", CONTENT_OPF)
        if with_ncx:
            zf.writestr("OEBPS/toc.ncx", TOC_NCX)
        zf.writestr("OEBPS/Text/ch1.xhtml", ch1)
        zf.writestr("OEBPS/Text/ch2.xhtml", ch2)
        zf.writestr("OEBPS/Images/pic.png", PNG)
    return buf.getvalue()


def test_convert_chapters_in_spine_order_with_headers():
    """Chapters concatenate in spine order under `##` NCX headers."""
    result = convert_epub(build_epub())
    assert result.title == "Test Book"
    assert result.author == "Test Author"
    assert result.markdown.startswith("# Test Book")
    ch1_pos = result.markdown.index("## First Steps")
    ch2_pos = result.markdown.index("## Next Moves")
    assert ch1_pos < ch2_pos
    assert "Norah cheerfully said" in result.markdown[ch1_pos:ch2_pos]
    assert "Pack the notebooks" in result.markdown[ch2_pos:]


def test_convert_keeps_image_ref_and_binary():
    """Chapter `<img>` survives as a relative Markdown ref with its bytes."""
    result = convert_epub(build_epub())
    assert len(result.images) == 1
    img = result.images[0]
    assert img.path == "Images/pic.png"
    assert img.media_type == "image/png"
    assert img.data == PNG
    assert "![A red diagram](Images/pic.png)" in result.markdown


def test_convert_rejects_non_epub():
    """Garbage bytes fail with 400, not an unhandled traceback."""
    with pytest.raises(EpubConvertError) as exc:
        convert_epub(b"this is not an epub")
    assert exc.value.status_code == 400


def test_convert_rejects_drm():
    """DRM marker (`encryption.xml`) fails with 422."""
    with pytest.raises(EpubConvertError) as exc:
        convert_epub(build_epub(with_encryption=True))
    assert exc.value.status_code == 422


def test_convert_endpoint_round_trip():
    """Multipart upload returns Markdown, title, and base64 images."""
    import base64

    resp = client.post(
        "/api/convert/epub",
        files={"file": ("test-book.epub", build_epub(), "application/epub+zip")},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["title"] == "Test Book"
    assert data["author"] == "Test Author"
    assert "## First Steps" in data["markdown"]
    assert len(data["images"]) == 1
    assert data["images"][0]["path"] == "Images/pic.png"
    assert base64.b64decode(data["images"][0]["data_b64"]) == PNG


def test_convert_endpoint_rejects_pdf():
    """A PDF uploaded to the ePub endpoint fails with 400."""
    resp = client.post(
        "/api/convert/epub",
        files={"file": ("doc.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )
    assert resp.status_code == 400


def test_convert_strips_xml_preamble_and_folds_heading():
    """XML declarations/DOCTYPE never leak as chapter text or duplicate headings."""
    ch = (
        '<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html>'
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head>'
        "<body><h1>First Steps</h1><p>Body text here for listening.</p></body></html>"
    )
    result = convert_epub(build_epub(ch1=ch))
    assert "xml version" not in result.markdown
    assert "DOCTYPE" not in result.markdown
    assert result.markdown.count("First Steps") == 1
