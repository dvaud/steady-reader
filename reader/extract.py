"""Turn PDF / DOCX / HTML / Markdown / TXT into a simple, uniform block model.

A document is a list of blocks:  {"k": kind, "w": [word, ...]}
  kind: "p" paragraph, "h1".."h6" heading, "li" list item, "q" quote
  word: a plain string, or a list of [text, flags] segments when part of
        the word is formatted. flags is a string made of
        b = bold, i = italic, h = highlight, u = underline.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import unicodedata
from collections import Counter
from functools import lru_cache
from pathlib import Path

from bs4 import BeautifulSoup, Comment, NavigableString, Tag

# Bump when extraction improves; older documents are re-read from their saved file.
PARSER_VERSION = 3  # 3: headings keep levels 4 to 6

LIGATURES = str.maketrans({
    "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi",
    "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st",
    "­": "", "​": "", "‌": "", "‍": "", "﻿": "",
    " ": " ", " ": " ",
})
SPACE_RE = re.compile(r"\s+")


# ---------------------------------------------------------------- tokenizing

def _norm_flags(flags) -> str:
    return "".join(f for f in "bihu" if f in flags)


HEX_RE = re.compile(r"^#[0-9a-f]{6}$")


def tokenize(runs: list[tuple]) -> list:
    """Split formatted runs into words; formatting is kept per segment.

    A run is (text, flags) or (text, flags, colour). Highlight colours are
    "#rrggbb" strings, kept only on highlighted ("h") text.
    """
    words: list[list[list[str]]] = []
    cur: list[list[str]] = []
    for run in runs:
        text, flags = run[0], _norm_flags(run[1])
        color = run[2] if len(run) > 2 and "h" in flags and run[2] and HEX_RE.match(run[2]) else None
        text = unicodedata.normalize("NFC", text.translate(LIGATURES))
        for piece in re.split(r"(\s+)", text):
            if not piece:
                continue
            if piece.isspace():
                if cur:
                    words.append(cur)
                    cur = []
                continue
            seg_color = cur[-1][2] if cur and len(cur[-1]) > 2 else None
            if cur and cur[-1][1] == flags and seg_color == color:
                cur[-1][0] += piece
            else:
                cur.append([piece, flags, color] if color else [piece, flags])
    if cur:
        words.append(cur)
    out = []
    for w in words:
        if len(w) == 1 and not w[0][1]:
            out.append(w[0][0])
        else:
            out.append(w)
    return out


def strip_flag(words: list, flag: str) -> list:
    out = []
    for w in words:
        if isinstance(w, str):
            out.append(w)
            continue
        segs = [[seg[0], seg[1].replace(flag, ""), *seg[2:]] for seg in w]
        out.append(word_text(segs) if not any(seg[1] for seg in segs) else segs)
    return out


def word_text(w) -> str:
    return w if isinstance(w, str) else "".join(s[0] for s in w)


class BlockBuilder:
    def __init__(self):
        self.blocks: list[dict] = []
        self.runs: list[tuple[str, str]] = []
        self.kind = "p"

    def add(self, text: str, flags: str = "", color: str | None = None):
        if text:
            self.runs.append((text, flags, color))

    def flush(self, kind: str | None = None):
        words = tokenize(self.runs)
        self.runs = []
        kind = kind or self.kind
        if words:
            if kind.startswith("h"):
                words = strip_flag(words, "b")
            self.blocks.append({"k": kind, "w": words})


# ---------------------------------------------------------------- HTML

BLOCK_TAGS = {
    "p", "div", "section", "article", "main", "header", "footer", "aside",
    "h1", "h2", "h3", "h4", "h5", "h6", "li", "ul", "ol", "dl", "dt", "dd",
    "blockquote", "pre", "table", "thead", "tbody", "tr", "td", "th",
    "figcaption", "caption", "hr", "body", "html", "address", "details", "summary",
}
SKIP_TAGS = {
    "script", "style", "noscript", "svg", "head", "nav", "img", "button",
    "form", "iframe", "input", "select", "textarea", "video", "audio", "canvas",
    "math", "template", "object",
}
HEADINGS = {"h1": "h1", "h2": "h2", "h3": "h3", "h4": "h4", "h5": "h5", "h6": "h6"}


def _inline_flags(tag: Tag) -> str:
    name = tag.name
    f = ""
    if name in ("b", "strong"):
        f += "b"
    if name in ("i", "em", "cite", "dfn", "var"):
        f += "i"
    if name == "mark":
        f += "h"
    if name in ("u", "ins"):
        f += "u"
    if name == "hi":  # TEI-style (trafilatura xml)
        rend = tag.get("rend", "")
        f += "b" if "b" in rend else ""
        f += "i" if "i" in rend else ""
        f += "u" if "u" in rend else ""
    style = (tag.get("style") or "").replace(" ", "").lower()
    if style:
        if re.search(r"font-weight:(bold|[6-9]00)", style):
            f += "b"
        if "font-style:italic" in style:
            f += "i"
        if "text-decoration:underline" in style:
            f += "u"
        if re.search(r"background(-color)?:(?!transparent|none|#fff\b|#ffffff|white|inherit)", style):
            f += "h"
    return f


# Word's fixed highlight palette (mammoth reports these names)
WORD_HIGHLIGHTS = {
    "yellow": "#ffff00", "green": "#00ff00", "cyan": "#00ffff", "magenta": "#ff00ff",
    "blue": "#0000ff", "red": "#ff0000", "darkBlue": "#000080", "darkCyan": "#008080",
    "darkGreen": "#008000", "darkMagenta": "#800080", "darkRed": "#800000",
    "darkYellow": "#808000", "darkGray": "#808080", "lightGray": "#c0c0c0", "black": "#000000",
}
CSS_HEX_RE = re.compile(r"background(?:-color)?:\s*(#[0-9a-f]{6}|#[0-9a-f]{3})\b", re.I)


def _inline_color(tag: Tag) -> str | None:
    for cls in tag.get("class") or []:
        if cls.startswith("hl-") and cls[3:] in WORD_HIGHLIGHTS:
            return WORD_HIGHLIGHTS[cls[3:]]
    m = CSS_HEX_RE.search(tag.get("style") or "")
    if m:
        h = m.group(1).lower()
        return h if len(h) == 7 else "#" + "".join(c * 2 for c in h[1:])
    return None


def html_to_blocks(html: str) -> tuple[list[dict], str | None]:
    soup = BeautifulSoup(html, "html.parser")
    title = None
    if soup.title and soup.title.string:
        title = soup.title.string.strip()
    root = soup.body or soup
    bb = BlockBuilder()

    def walk(node, flags: str, kind: str, color: str | None = None):
        for child in node.children:
            if isinstance(child, Comment):
                continue
            if isinstance(child, NavigableString):
                bb.add(str(child), flags, color)
                continue
            if not isinstance(child, Tag):
                continue
            name = child.name.lower()
            if name in SKIP_TAGS:
                continue
            if name == "br":
                bb.add(" ", flags)
                continue
            if name in BLOCK_TAGS:
                bb.flush(kind)
                k = kind
                if name in HEADINGS:
                    k = HEADINGS[name]
                elif name == "li":
                    k = "li"
                elif name == "blockquote":
                    k = "q"
                walk(child, flags, k, color)
                bb.flush(k)
            else:
                walk(child, flags + _inline_flags(child), kind, _inline_color(child) or color)

    walk(root, "", "p")
    bb.flush("p")
    return bb.blocks, title


# ---------------------------------------------------------------- plain text / markdown

def text_to_blocks(text: str) -> list[dict]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    paras = re.split(r"\n\s*\n", text)
    if len(paras) == 1 and text.count("\n") > 3:
        paras = text.split("\n")
    bb = BlockBuilder()
    for p in paras:
        p = p.strip()
        if not p:
            continue
        kind = "p"
        m = re.match(r"^[•\-\*–·▪◦]\s+", p)
        if m:
            kind, p = "li", p[m.end():]
        bb.add(SPACE_RE.sub(" ", p))
        bb.flush(kind)
    return bb.blocks


def markdown_to_blocks(text: str) -> list[dict]:
    import markdown

    # ==highlight== is a common markdown extension; map it to <mark>.
    text = re.sub(r"==(?=\S)(.+?)(?<=\S)==", r"<mark>\1</mark>", text)
    html = markdown.markdown(text, extensions=["extra", "sane_lists"])
    blocks, _ = html_to_blocks(html)
    return blocks


# ---------------------------------------------------------------- DOCX

def docx_to_blocks(path: Path) -> tuple[list[dict], str | None]:
    import mammoth

    style_map = "\n".join([
        *(f"highlight[color='{name}'] => mark.hl-{name}" for name in WORD_HIGHLIGHTS),
        "highlight => mark",
        "u => u",
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Subtitle'] => h2:fresh",
        "p[style-name='Quote'] => blockquote > p:fresh",
        "p[style-name='Intense Quote'] => blockquote > p:fresh",
    ])
    with open(path, "rb") as f:
        result = mammoth.convert_to_html(f, style_map=style_map, convert_image=lambda img: {})
    blocks, _ = html_to_blocks(result.value)
    title = None
    try:
        import zipfile
        with zipfile.ZipFile(path) as z:
            core = z.read("docProps/core.xml").decode("utf8", "ignore")
        m = re.search(r"<dc:title>(.*?)</dc:title>", core, re.S)
        if m and m.group(1).strip():
            title = m.group(1).strip()
    except Exception:
        pass
    return blocks, title


# ---------------------------------------------------------------- web pages

def web_to_blocks(html: str, url: str | None = None) -> tuple[list[dict], str | None]:
    import trafilatura

    extracted = trafilatura.extract(
        html, url=url, output_format="html", include_formatting=True,
        include_links=False, include_images=False, include_tables=True,
        include_comments=False, favor_recall=True,
    )
    title = None
    try:
        meta = trafilatura.extract_metadata(html, default_url=url)
        title = meta.title if meta else None
    except Exception:
        pass
    if extracted:
        blocks, _ = html_to_blocks(extracted)
    else:
        blocks, t2 = html_to_blocks(html)
        title = title or t2
    if not title:
        title = BeautifulSoup(html, "html.parser").title
        title = title.string.strip() if title and title.string else None
    return blocks, title


# ---------------------------------------------------------------- PDF

OCR_LANGS = ["eng", "hun", "fra", "deu", "nld"]


@lru_cache(maxsize=1)
def ocr_languages() -> str | None:
    """Tesseract language string, or None if Tesseract isn't installed."""
    if os.name == "nt" and not shutil.which("tesseract"):
        # The Windows installer doesn't put Tesseract on PATH; PyMuPDF also looks it up there.
        for base in (os.environ.get("ProgramFiles", r"C:\Program Files"), os.environ.get("LOCALAPPDATA", "")):
            d = os.path.join(base, "Tesseract-OCR") if base else ""
            if d and os.path.isfile(os.path.join(d, "tesseract.exe")):
                os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                break
    if not shutil.which("tesseract"):
        return None
    try:
        out = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=10)
        have = set(out.stdout.split()) | set(out.stderr.split())
    except Exception:
        return None
    langs = [l for l in OCR_LANGS if l in have]
    return "+".join(langs) if langs else None


BULLET_RE = re.compile(r"^\s*([•●▪◦‣∙·\-–—*])\s+")


def _is_bold(span) -> bool:
    font = span.get("font", "").lower()
    return bool(span["flags"] & 16) or any(x in font for x in ("bold", "black", "heavy", "semibold", "demi"))


def _is_italic(span) -> bool:
    font = span.get("font", "").lower()
    return bool(span["flags"] & 2) or "italic" in font or "oblique" in font


def pdf_to_blocks(path: Path, progress=None) -> tuple[list[dict], str | None, list[str]]:
    """progress(done, total, ocr) is called after each page, if given."""
    import pymupdf

    notes: list[str] = []
    doc = pymupdf.open(path)
    ocr = None  # resolved lazily
    ocr_pages = 0
    skipped_scans = 0

    # Pass 1: collect lines with their spans/chars per page.
    pages = []
    for page_no, page in enumerate(doc):
        if progress:
            progress(page_no, doc.page_count, ocr_pages > 0)
        flags = pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
        tp = None
        plain = page.get_text("text").strip()
        if len(plain) < 25 and page.get_images():
            if ocr is None:
                ocr = ocr_languages() or ""
            if ocr:
                try:
                    tp = page.get_textpage_ocr(language=ocr, dpi=300, full=True)
                    ocr_pages += 1
                except Exception:
                    tp = None
            if tp is None:
                skipped_scans += 1
                pages.append({"h": page.rect.height, "blocks": []})
                continue
        raw = page.get_text("rawdict", flags=flags, textpage=tp)  # keep the PDF's own order (columns stay intact)

        hl_rects = []  # (rect, "#rrggbb" or None)
        for annot in page.annots() or []:
            if annot.type[0] == pymupdf.PDF_ANNOT_HIGHLIGHT:
                rgb = (annot.colors or {}).get("stroke") or (annot.colors or {}).get("fill")
                color = ("#%02x%02x%02x" % tuple(round(max(0, min(1, c)) * 255) for c in rgb[:3])
                         if rgb and len(rgb) >= 3 else None)
                v = annot.vertices or []
                if v and len(v) >= 4:
                    for i in range(0, len(v) - 3, 4):
                        hl_rects.append((pymupdf.Quad(v[i:i + 4]).rect, color))
                else:
                    hl_rects.append((annot.rect, color))

        blocks = []
        for b in raw["blocks"]:
            if b.get("type") != 0:
                continue
            lines = []
            for ln in b["lines"]:
                if abs(ln.get("dir", (1, 0))[1]) > 0.2:  # skip vertical / rotated text
                    continue
                spans = []
                for sp in ln["spans"]:
                    chars = sp.get("chars", [])
                    text = "".join(c["c"] for c in chars)
                    if not text:
                        continue
                    # drop superscript footnote markers like ¹ or "12"
                    if sp["flags"] & 1 and re.fullmatch(r"[\d*†‡,\s]+", text):
                        continue
                    base = ("b" if _is_bold(sp) else "") + ("i" if _is_italic(sp) else "")
                    if hl_rects:
                        # per character highlight test
                        cur_t, cur_f, cur_c = "", None, None
                        for c in chars:
                            r = pymupdf.Rect(c["bbox"])
                            cx, cy = (r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2
                            hit = [col for h, col in hl_rects if h.x0 <= cx <= h.x1 and h.y0 <= cy <= h.y1]
                            f = base + ("h" if hit else "")
                            col = hit[-1] if hit else None  # the last one drawn is on top
                            if (f, col) != (cur_f, cur_c) and cur_t:
                                spans.append((cur_t, cur_f, sp["size"], cur_c))
                                cur_t = ""
                            cur_f, cur_c = f, col
                            cur_t += c["c"]
                        if cur_t:
                            spans.append((cur_t, cur_f, sp["size"], cur_c))
                    else:
                        spans.append((text, base, sp["size"], None))
                if spans and "".join(s[0] for s in spans).strip():
                    lines.append({"spans": spans, "bbox": ln["bbox"]})
            if lines:
                blocks.append({"lines": lines, "bbox": b["bbox"]})
        pages.append({"h": page.rect.height, "blocks": blocks})

    if ocr_pages:
        notes.append(f"{ocr_pages} scanned page{'s' if ocr_pages > 1 else ''} read with OCR (no formatting).")
    if skipped_scans:
        notes.append(f"{skipped_scans} scanned page{'s' if skipped_scans > 1 else ''} skipped: install Tesseract for OCR "
                     "(Mac: brew install tesseract tesseract-lang; Windows: winget install UB-Mannheim.TesseractOCR).")

    # Body font size = most common size by character count.
    sizes = Counter()
    for p in pages:
        for b in p["blocks"]:
            for ln in b["lines"]:
                for t, _, s, _c in ln["spans"]:
                    sizes[round(s, 1)] += len(t)
    body = sizes.most_common(1)[0][0] if sizes else 10

    # Running headers / footers: lines in the top/bottom margin that repeat.
    def line_key(ln):
        return re.sub(r"\d+", "#", "".join(s[0] for s in ln["spans"]).strip().lower())

    margin_counts = Counter()
    for p in pages:
        for b in p["blocks"]:
            for ln in b["lines"]:
                y0, y1 = ln["bbox"][1], ln["bbox"][3]
                if y1 < p["h"] * 0.09 or y0 > p["h"] * 0.91:
                    margin_counts[line_key(ln)] += 1
    repeat_min = max(3, len(pages) // 3)

    def is_furniture(ln, page_h):
        y0, y1 = ln["bbox"][1], ln["bbox"][3]
        if not (y1 < page_h * 0.09 or y0 > page_h * 0.91):
            return False
        k = line_key(ln)
        if re.fullmatch(r"[\s#ivxlc.\-–/|]*(page|oldal|seite)?[\s#.\-–/|]*", k):
            return True  # page numbers
        return len(pages) >= 3 and margin_counts[k] >= repeat_min

    # Pass 2: build blocks.
    out: list[dict] = []
    for p in pages:
        for b in p["blocks"]:
            lines = [ln for ln in b["lines"] if not is_furniture(ln, p["h"])]
            if not lines:
                continue
            groups: list[tuple[str, list]] = []  # split on bullets inside a block
            for ln in lines:
                first = ln["spans"][0][0]
                m = BULLET_RE.match(first)
                if m:
                    spans = list(ln["spans"])
                    spans[0] = (first[m.end():], *spans[0][1:])
                    groups.append(("li", [dict(ln, spans=spans)]))
                elif groups and groups[-1][0] == "li":
                    groups[-1][1].append(ln)
                else:
                    if not groups:
                        groups.append(("p", []))
                    groups[-1][1].append(ln)
            for kind, glines in groups:
                runs: list[tuple[str, str]] = []
                chars = 0
                big = 0
                allbold = True
                for i, ln in enumerate(glines):
                    for t, f, s, _c in ln["spans"]:
                        n = len(t.strip())
                        chars += n
                        if s >= body * 1.18:
                            big += n
                        if n and "b" not in f:
                            allbold = False
                    # join lines; undo end-of-line hyphenation
                    if runs and i > 0:
                        prev = runs[-1]
                        nxt = ln["spans"][0][0].lstrip()
                        if re.search(r"\w[-‐]$", prev[0].rstrip()) and nxt[:1].islower():
                            runs[-1] = (prev[0].rstrip()[:-1], *prev[1:])
                        else:
                            runs.append((" ", ""))
                    runs.extend((t, f, c) for t, f, _, c in ln["spans"])
                words = tokenize(runs)
                if not words:
                    continue
                text = " ".join(word_text(w) for w in words)
                k = kind
                if kind == "p" and len(words) <= 20 and not re.search(r"[.,;:]$", text):
                    if chars and big / chars > 0.7:
                        ratio = max(s for ln in glines for _, _, s, _c in ln["spans"]) / body
                        k = "h1" if ratio >= 1.6 else "h2" if ratio >= 1.3 else "h3"
                    elif allbold and len(words) <= 12:
                        k = "h3"
                if k.startswith("h"):
                    words = strip_flag(words, "b")  # heading weight comes from the style
                # paragraph continued across a page / column break?
                if (out and k == "p" and out[-1]["k"] == "p"
                        and not re.search(r"[.!?:;\"”»)]$", word_text(out[-1]["w"][-1]))
                        and word_text(words[0])[:1].islower()):
                    out[-1]["w"].extend(words)
                    continue
                out.append({"k": k, "w": words})

    title = (doc.metadata or {}).get("title") or None
    if title and (len(title) < 3 or title.lower().startswith(("microsoft word", "untitled"))
                  or title.lower().endswith((".doc", ".docx", ".pdf"))):
        title = None
    return out, title, notes


# ---------------------------------------------------------------- entry points

def extract_file(path: Path, filename: str, progress=None) -> dict:
    ext = Path(filename).suffix.lower()
    notes: list[str] = []
    title = None
    if ext == ".pdf":
        blocks, title, notes = pdf_to_blocks(path, progress)
        kind = "PDF"
    elif ext in (".docx",):
        blocks, title = docx_to_blocks(path)
        kind = "Word"
    elif ext in (".html", ".htm", ".xhtml"):
        blocks, title = web_to_blocks(path.read_text("utf8", errors="replace"))
        kind = "Web page"
    elif ext in (".md", ".markdown"):
        blocks = markdown_to_blocks(path.read_text("utf8", errors="replace"))
        kind = "Markdown"
    elif ext in (".txt", ".text", ""):
        blocks = text_to_blocks(path.read_text("utf8", errors="replace"))
        kind = "Text"
    else:
        raise ValueError(f"Unsupported file type: {ext or filename}")
    if not title:
        title = next((" ".join(word_text(w) for w in b["w"]) for b in blocks if b["k"].startswith("h")), None)
        if not title or len(title) > 90:
            title = Path(filename).stem.replace("_", " ")
    return {"title": title, "kind": kind, "blocks": blocks, "notes": notes}


def extract_url(url: str) -> dict:
    import trafilatura

    html = trafilatura.fetch_url(url)
    if not html:
        raise ValueError("Couldn't download that page.")
    blocks, title = web_to_blocks(html, url)
    return {"title": title or url, "kind": "Web page", "blocks": blocks, "notes": [], "source": url}
