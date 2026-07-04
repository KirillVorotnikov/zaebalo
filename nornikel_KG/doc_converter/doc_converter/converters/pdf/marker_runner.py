"""marker-pdf wrapper."""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def run_marker_pdf(pdf_path: Path) -> str:
    """Convert *pdf_path* to markdown using marker-pdf."""
    try:
        from marker.converters.pdf import PdfConverter
        from marker.models import create_model_dict
        from marker.output import text_from_rendered
    except ImportError as exc:
        msg = "PDF support requires marker-pdf: pip install 'doc-converter[pdf]'"
        raise ImportError(msg) from exc

    logger.info("Running marker-pdf on %s", pdf_path.name)
    converter = PdfConverter(artifact_dict=create_model_dict())
    rendered = converter(str(pdf_path))
    markdown_text, _, _ = text_from_rendered(rendered)

    if not isinstance(markdown_text, str):
        msg = f"Unexpected marker output type: {type(markdown_text)}"
        raise TypeError(msg)

    return markdown_text
