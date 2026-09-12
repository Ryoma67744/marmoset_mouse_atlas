#!/usr/bin/env python3
"""Render USER_GUIDE.md as the repository's user-facing A4 PDF.

The renderer intentionally supports only the Markdown constructs used by the guide:
headings, paragraphs, links, emphasis, inline code, lists, quotes, fenced code,
horizontal rules, and pipe tables.  It keeps Japanese text searchable/selectable.
"""

from __future__ import annotations

import argparse
import glob
import html
import os
import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / "USER_GUIDE.md"
DEFAULT_OUTPUT = ROOT / "USER_GUIDE.pdf"
VERSION_RE = re.compile(r"const APP_VERSION = ['\"]([^'\"]+)['\"]")
HEADING_RE = re.compile(r"^(#{1,4})\s+(.+?)\s*$")
LIST_RE = re.compile(r"^(\s*)([-*+] |(\d+)\. )(.*)$")
TABLE_RULE_RE = re.compile(r"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$")


def find_font() -> tuple[str, str]:
    """Register an available CJK font, with ReportLab's Japanese CID font fallback."""
    candidates: list[str] = []
    if os.environ.get("MARMOST_ATLAS_JA_FONT"):
        candidates.append(os.environ["MARMOST_ATLAS_JA_FONT"])
    candidates.extend(
        [
            str(ROOT / "assets" / "fonts" / "wqy-zenhei.ttc"),
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
        ]
    )
    candidates.extend(sorted(glob.glob("/tmp/wqy-font.*/wqy-zenhei.ttc")))
    for path in candidates:
        if not path or not Path(path).is_file():
            continue
        try:
            pdfmetrics.registerFont(TTFont("GuideJP", path, subfontIndex=0))
            pdfmetrics.registerFontFamily(
                "GuideJP", normal="GuideJP", bold="GuideJP", italic="GuideJP", boldItalic="GuideJP"
            )
            return "GuideJP", path
        except Exception:
            continue
    pdfmetrics.registerFont(UnicodeCIDFont("HeiseiKakuGo-W5"))
    pdfmetrics.registerFontFamily(
        "HeiseiKakuGo-W5",
        normal="HeiseiKakuGo-W5",
        bold="HeiseiKakuGo-W5",
        italic="HeiseiKakuGo-W5",
        boldItalic="HeiseiKakuGo-W5",
    )
    return "HeiseiKakuGo-W5", "ReportLab Japanese CID fallback"


def clean_symbols(text: str) -> str:
    # Color emoji fonts are not reliably embeddable in PDFs. Preserve their meaning in text.
    return (
        text.replace("📚", "[全体]")
        .replace("📁", "[フォルダ]")
        .replace("⚠️", "注意:")
        .replace("⚠", "注意:")
        .replace("☑", "[x]")
        .replace("☐", "[ ]")
        .replace("✅", "[OK]")
    )


def inline_markup(text: str, font_name: str) -> str:
    value = html.escape(clean_symbols(text), quote=False)
    value = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", value)
    value = re.sub(r"\[([^\]]+)\]\(([^)]*)\)", r"\1", value)
    value = re.sub(r"`([^`]+)`", rf'<font name="{font_name}" color="#7c2d12">\1</font>', value)
    value = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", value)
    value = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<i>\1</i>", value)
    return value


def table_cells(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.strip() for cell in value.split("|")]


def display_width(value: str) -> int:
    return sum(2 if ord(char) > 0xFF else 1 for char in re.sub(r"[*_`]", "", value))


class GuideDocument(BaseDocTemplate):
    def __init__(self, filename: str, *, font_name: str, version: str):
        self.font_name = font_name
        self.version = version
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=18 * mm,
            rightMargin=18 * mm,
            topMargin=18 * mm,
            bottomMargin=17 * mm,
            title="Marmoset Brain Atlas Viewer 利用者ガイド",
            author="Marmoset Brain Atlas Viewer",
            subject=f"利用者ガイド v{version}",
        )
        frame = Frame(self.leftMargin, self.bottomMargin, self.width, self.height, id="normal")
        self.addPageTemplates(PageTemplate(id="guide", frames=[frame], onPage=self.draw_page))
        self._outline_count = 0

    def draw_page(self, canvas, doc) -> None:
        canvas.saveState()
        canvas.setStrokeColor(colors.HexColor("#cbd5e1"))
        canvas.setLineWidth(0.35)
        canvas.line(self.leftMargin, A4[1] - 11 * mm, A4[0] - self.rightMargin, A4[1] - 11 * mm)
        canvas.setFont(self.font_name, 7.5)
        canvas.setFillColor(colors.HexColor("#475569"))
        canvas.drawString(self.leftMargin, A4[1] - 9 * mm, "Marmoset Brain Atlas Viewer 利用者ガイド")
        canvas.drawRightString(A4[0] - self.rightMargin, A4[1] - 9 * mm, f"v{self.version}")
        canvas.line(self.leftMargin, 11 * mm, A4[0] - self.rightMargin, 11 * mm)
        canvas.drawString(self.leftMargin, 7.5 * mm, "研究利用者向け")
        canvas.drawRightString(A4[0] - self.rightMargin, 7.5 * mm, str(doc.page))
        canvas.restoreState()

    def afterFlowable(self, flowable) -> None:
        if not isinstance(flowable, Paragraph) or not flowable.style.name.startswith("Heading"):
            return
        # The guide's outline starts at Markdown h2; map that to PDF outline level 0.
        level = max(0, int(flowable.style.name[-1]) - 2)
        text = re.sub(r"<[^>]+>", "", flowable.getPlainText())
        key = f"heading-{self._outline_count}"
        self._outline_count += 1
        self.canv.bookmarkPage(key)
        self.canv.addOutlineEntry(text, key, level, closed=False)


def make_styles(font_name: str) -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    styles: dict[str, ParagraphStyle] = {}
    styles["Title"] = ParagraphStyle(
        "Title", parent=base["Title"], fontName=font_name, fontSize=23, leading=30,
        textColor=colors.HexColor("#123b57"), alignment=TA_CENTER, spaceAfter=10 * mm,
    )
    for level, size, leading, before, after, color in [
        (1, 18, 24, 3, 6, "#123b57"),
        (2, 15, 20, 2, 5, "#0f4c5c"),
        (3, 11.5, 16, 5, 3, "#155e75"),
        (4, 9.8, 14, 4, 2, "#334155"),
    ]:
        styles[f"Heading{level}"] = ParagraphStyle(
            f"Heading{level}", parent=base[f"Heading{min(level, 4)}"], fontName=font_name,
            fontSize=size, leading=leading, textColor=colors.HexColor(color),
            spaceBefore=before * mm, spaceAfter=after * mm, keepWithNext=True,
            wordWrap="CJK",
        )
    styles["Body"] = ParagraphStyle(
        "Body", parent=base["BodyText"], fontName=font_name, fontSize=8.7, leading=13.2,
        textColor=colors.HexColor("#1f2937"), spaceAfter=2.4 * mm, wordWrap="CJK",
        splitLongWords=True,
    )
    styles["List"] = ParagraphStyle(
        "List", parent=styles["Body"], leftIndent=7 * mm, firstLineIndent=0,
        bulletIndent=1 * mm, spaceAfter=1.2 * mm,
    )
    styles["Quote"] = ParagraphStyle(
        "Quote", parent=styles["Body"], fontSize=8.1, leading=12.3,
        leftIndent=2 * mm, rightIndent=2 * mm, textColor=colors.HexColor("#334155"),
        spaceAfter=0,
    )
    styles["Table"] = ParagraphStyle(
        "Table", parent=styles["Body"], fontSize=7.1, leading=10.2, spaceAfter=0,
    )
    styles["TableHeader"] = ParagraphStyle(
        "TableHeader", parent=styles["Table"], textColor=colors.white, alignment=TA_LEFT,
    )
    styles["Code"] = ParagraphStyle(
        "Code", parent=styles["Body"], fontName=font_name, fontSize=7.4, leading=10.5,
        leftIndent=2 * mm, rightIndent=2 * mm, spaceAfter=0,
    )
    return styles


def quote_flowable(lines: list[str], styles, font_name):
    paragraphs: list = []
    current: list[str] = []
    for line in lines:
        value = re.sub(r"^\s*>\s?", "", line)
        if value:
            current.append(value.strip())
        elif current:
            paragraphs.append(Paragraph(inline_markup(" ".join(current), font_name), styles["Quote"]))
            paragraphs.append(Spacer(1, 1.2 * mm))
            current = []
    if current:
        paragraphs.append(Paragraph(inline_markup(" ".join(current), font_name), styles["Quote"]))
    box = Table([[paragraphs]], colWidths=[174 * mm], hAlign="LEFT")
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f8fafc")),
        ("BOX", (0, 0), (-1, -1), 0.4, colors.HexColor("#94a3b8")),
        ("LINEBEFORE", (0, 0), (0, -1), 2.1, colors.HexColor("#f59e0b")),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return box


def table_flowable(raw_rows: list[list[str]], styles, font_name):
    width = 174 * mm
    columns = max(len(row) for row in raw_rows)
    rows = [row + [""] * (columns - len(row)) for row in raw_rows]
    weights = []
    for column in range(columns):
        longest = max(display_width(row[column]) for row in rows)
        weights.append(max(7, min(44, longest)))
    total = sum(weights)
    col_widths = [width * value / total for value in weights]
    rendered = []
    for row_index, row in enumerate(rows):
        style = styles["TableHeader"] if row_index == 0 else styles["Table"]
        rendered.append([Paragraph(inline_markup(cell, font_name), style) for cell in row])
    table = Table(rendered, colWidths=col_widths, repeatRows=1, hAlign="LEFT", splitByRow=1)
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#155e75")),
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#94a3b8")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
    ]))
    return table


def markdown_story(source: str, styles, font_name: str):
    lines = source.splitlines()
    story: list = [NextPageTemplate("guide")]
    i = 0
    seen_h2 = False
    while i < len(lines):
        line = lines[i]
        if not line.strip():
            i += 1
            continue
        heading = HEADING_RE.match(line)
        if heading:
            level = len(heading.group(1))
            if level == 2:
                if seen_h2 or story:
                    story.append(PageBreak())
                seen_h2 = True
            style = styles["Title"] if level == 1 else styles[f"Heading{level}"]
            story.append(Paragraph(inline_markup(heading.group(2), font_name), style))
            i += 1
            continue
        if line.strip() == "---":
            # Chapter h2 headings already start a fresh page. Ignoring the Markdown
            # divider avoids an orphaned rule on an otherwise blank page.
            i += 1
            continue
        if line.startswith("```"):
            language = line[3:].strip()
            i += 1
            code: list[str] = []
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(clean_symbols(lines[i]))
                i += 1
            if i < len(lines):
                i += 1
            if language:
                code.insert(0, f"[{language}]")
            pre = Preformatted("\n".join(code), styles["Code"], maxLineLength=110)
            box = Table([[pre]], colWidths=[174 * mm], hAlign="LEFT")
            box.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f1f5f9")),
                ("BOX", (0, 0), (-1, -1), 0.35, colors.HexColor("#cbd5e1")),
                ("LEFTPADDING", (0, 0), (-1, -1), 7),
                ("RIGHTPADDING", (0, 0), (-1, -1), 7),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]))
            story.extend([box, Spacer(1, 2 * mm)])
            continue
        if line.lstrip().startswith(">"):
            quote_lines: list[str] = []
            while i < len(lines) and (lines[i].lstrip().startswith(">") or not lines[i].strip()):
                quote_lines.append(lines[i])
                i += 1
            story.extend([quote_flowable(quote_lines, styles, font_name), Spacer(1, 2 * mm)])
            continue
        if line.lstrip().startswith("|") and i + 1 < len(lines) and TABLE_RULE_RE.match(lines[i + 1]):
            raw_rows = [table_cells(line)]
            i += 2
            while i < len(lines) and lines[i].lstrip().startswith("|"):
                raw_rows.append(table_cells(lines[i]))
                i += 1
            story.extend([table_flowable(raw_rows, styles, font_name), Spacer(1, 2.5 * mm)])
            continue
        list_match = LIST_RE.match(line)
        if list_match:
            indent = len(list_match.group(1).replace("\t", "    "))
            marker = list_match.group(3)
            text_parts = [list_match.group(4).strip()]
            i += 1
            while i < len(lines):
                continuation = lines[i]
                if not continuation.strip():
                    i += 1
                    break
                if HEADING_RE.match(continuation) or continuation.startswith("```") or continuation.lstrip().startswith((">", "|")) or LIST_RE.match(continuation):
                    break
                text_parts.append(continuation.strip())
                i += 1
            bullet = f"{marker}." if marker else "•"
            style = ParagraphStyle(
                f"List-{indent}", parent=styles["List"], leftIndent=(7 + min(indent, 12)) * mm,
                bulletIndent=(1 + min(indent, 12)) * mm,
            )
            story.append(Paragraph(inline_markup(" ".join(text_parts), font_name), style, bulletText=bullet))
            continue
        paragraph = [line.strip()]
        i += 1
        while i < len(lines):
            candidate = lines[i]
            if not candidate.strip():
                i += 1
                break
            if (
                HEADING_RE.match(candidate)
                or candidate.strip() == "---"
                or candidate.startswith("```")
                or candidate.lstrip().startswith((">", "|"))
                or LIST_RE.match(candidate)
            ):
                break
            paragraph.append(candidate.strip())
            i += 1
        story.append(Paragraph(inline_markup(" ".join(paragraph), font_name), styles["Body"]))
    return story


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    source = args.source.read_text(encoding="utf-8")
    version_source = (ROOT / "lib" / "version.js").read_text(encoding="utf-8")
    match = VERSION_RE.search(version_source)
    if not match:
        raise SystemExit("APP_VERSION was not found")
    version = match.group(1)
    font_name, font_path = find_font()
    styles = make_styles(font_name)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    document = GuideDocument(str(args.output), font_name=font_name, version=version)
    document.build(markdown_story(source, styles, font_name))
    print(f"wrote {args.output} (v{version}; font={font_path})")


if __name__ == "__main__":
    main()
