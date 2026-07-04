"""Split marker paginated markdown into per-page blocks."""

from __future__ import annotations

import re

_PAGE_MARKER = re.compile(r"\n\n\{(\d+)\}\n-{48}\n\n")


def split_marker_pages(markdown: str) -> list[tuple[int, str]]:
    """Split marker output using ``{N}`` + 48-dash page separators."""
    matches = list(_PAGE_MARKER.finditer(markdown))
    if not matches:
        stripped = markdown.strip()
        return [(0, stripped)] if stripped else []

    pages: list[tuple[int, str]] = []

    preamble = markdown[: matches[0].start()].strip()
    if preamble:
        pages.append((0, preamble))

    for index, match in enumerate(matches):
        page_num = int(match.group(1))
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        content = markdown[start:end].strip()
        if content:
            pages.append((page_num, content))

    return pages
