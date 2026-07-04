"""Optional GROBID academic metadata extraction."""

from __future__ import annotations

import logging
import re
import xml.etree.ElementTree as ET
from pathlib import Path

from doc_converter.ir import DocElement

logger = logging.getLogger(__name__)

_TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


def is_academic_document(markdown_text: str) -> bool:
    """Heuristic: document contains Abstract and References sections."""
    lowered = markdown_text.lower()
    has_abstract = "abstract" in lowered or "аннотация" in lowered
    has_references = "references" in lowered or "литература" in lowered or "bibliography" in lowered
    return has_abstract and has_references


def _parse_tei_header(tei_xml: str) -> str:
    root = ET.fromstring(tei_xml)
    title = root.find(".//tei:titleStmt/tei:title", _TEI_NS)
    authors = root.find(".//tei:sourceDesc//tei:author", _TEI_NS)
    doi = root.find(".//tei:idno[@type='DOI']", _TEI_NS)

    parts: list[str] = []
    if title is not None and title.text:
        parts.append(f"Title: {title.text.strip()}")
    if authors is not None and authors.text:
        parts.append(f"Author: {authors.text.strip()}")
    if doi is not None and doi.text:
        parts.append(f"DOI: {doi.text.strip()}")

    if not parts:
        plain = re.sub(r"\s+", " ", tei_xml)
        snippet = plain[:500]
        return f"GROBID metadata (raw snippet): {snippet}"
    return " | ".join(parts)


def extract_grobid_metadata(pdf_path: Path, server_url: str) -> list[DocElement]:
    """Fetch header metadata via GROBID; returns empty list when unavailable."""
    try:
        from grobid_client.grobid_client import GrobidClient
    except ImportError:
        logger.info("grobid-client-python not installed, skipping GROBID")
        return []

    try:
        client = GrobidClient(grobid_server=server_url)
        _, status, tei = client.process_pdf(
            "processHeaderDocument",
            str(pdf_path),
            generateIDs=False,
            consolidate_header=True,
            tei_coordinates=False,
        )
    except Exception:
        logger.exception("GROBID request failed for %s", pdf_path.name)
        return []

    if status != 200 or not tei:
        logger.warning("GROBID returned status %s for %s", status, pdf_path.name)
        return []

    metadata_text = _parse_tei_header(tei)
    return [
        DocElement(
            type="paragraph",
            content=metadata_text,
            extraction_method="grobid",
            confidence=0.9,
        )
    ]
