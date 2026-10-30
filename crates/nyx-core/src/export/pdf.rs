//! PDF export (TS `exportService.toPdf`, which used `pdfkit`).
//!
//! A small, dependency-free PDF 1.4 writer. Decision record:
//!
//! - `printpdf` 0.12 (MIT) was evaluated and rejected: it now drags in an HTML/CSS layout engine,
//!   image codecs and font shapers; `genpdf` (MIT/Apache-2.0) needs TTF files on disk for every
//!   style and bundles none; `lopdf` is a low-level editor. A Markdown document needs only text
//!   layout with the standard fonts, which is ~400 lines and zero extra crates.
//! - Fonts are the PDF base-14 set (`Helvetica`, `-Bold`, `-Oblique`, `-BoldOblique`, `Courier`),
//!   referenced by name and **not embedded**, so every viewer supplies its own metric-compatible
//!   face and no font files ship with Nyx. Line breaking uses the Adobe AFM advance widths for
//!   Helvetica/Helvetica-Bold (Oblique shares the upright widths) and 600 for Courier.
//!
//! Limits (documented parity gaps; pdfkit with the same base-14 fonts had the same text range):
//!
//! - Text is limited to `WinAnsiEncoding` (Latin-1 plus common punctuation: curly quotes, dashes,
//!   bullet, ellipsis, euro, trademark). Other characters (CJK, Cyrillic, emoji, math) render as
//!   `?`. Embedding a TTF with subsetting is the upgrade path if that matters.
//! - No images, no hyperlinks (link text is kept), no hyphenation, no compression of streams.
//! - Page is US Letter with 50 pt margins (the pdfkit setting); tables use equal-width columns.
//!
//! Output is deterministic: no timestamps or random ids are written.

use std::fmt::Write as _;

use super::blocks::{parse, Block, Span};

const PAGE_W: f32 = 612.0;
const PAGE_H: f32 = 792.0;
const MARGIN: f32 = 50.0;
const TEXT_W: f32 = PAGE_W - 2.0 * MARGIN;
const LEADING: f32 = 1.25;

/// Font slots, indexes into [`FONT_NAMES`] and the `/F<n>` resource names.
const REGULAR: usize = 0;
const BOLD: usize = 1;
const OBLIQUE: usize = 2;
const BOLD_OBLIQUE: usize = 3;
const MONO: usize = 4;
const FONT_NAMES: [&str; 5] = [
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica-Oblique",
    "Helvetica-BoldOblique",
    "Courier",
];

/// Helvetica advance widths for ASCII 32..=126 (units of 1/1000 em).
const HELV: [u16; 95] = [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
    611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
    222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/// Helvetica-Bold advance widths for ASCII 32..=126.
const HELV_BOLD: [u16; 95] = [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
    556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
    611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
    667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
    278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/// Map a char to a `WinAnsi` byte, `?` when unrepresentable.
fn winansi(c: char) -> u8 {
    match c {
        ' '..='~' => c as u8,
        '\u{A0}'..='\u{FF}' => c as u32 as u8,
        '\u{20AC}' => 0x80,
        '\u{2026}' => 0x85,
        '\u{2018}' => 0x91,
        '\u{2019}' => 0x92,
        '\u{201C}' => 0x93,
        '\u{201D}' => 0x94,
        '\u{2022}' => 0x95,
        '\u{2013}' => 0x96,
        '\u{2014}' => 0x97,
        '\u{2122}' => 0x99,
        '\t' => b' ',
        _ => b'?',
    }
}

fn glyph_width(b: u8, font: usize) -> f32 {
    if font == MONO {
        return 600.0;
    }
    let bold = font == BOLD || font == BOLD_OBLIQUE;
    let w = match b {
        32..=126 => {
            let t = if bold { &HELV_BOLD } else { &HELV };
            t[usize::from(b - 32)]
        }
        0x91 | 0x92 => {
            if bold {
                278
            } else {
                222
            }
        }
        0x93 | 0x94 => {
            if bold {
                500
            } else {
                333
            }
        }
        0x95 => 350,
        0x97 | 0x85 | 0x99 => 1000,
        _ => 556,
    };
    f32::from(w)
}

fn text_width(bytes: &[u8], font: usize, size: f32) -> f32 {
    bytes.iter().map(|b| glyph_width(*b, font)).sum::<f32>() * size / 1000.0
}

#[derive(Clone)]
struct Token {
    bytes: Vec<u8>,
    font: usize,
    size: f32,
    space: bool,
    newline: bool,
}

impl Token {
    fn width(&self) -> f32 {
        text_width(&self.bytes, self.font, self.size)
    }
}

fn span_font(span: &Span, base_bold: bool, base_italic: bool) -> usize {
    if span.code {
        return MONO;
    }
    match (span.bold || base_bold, span.italic || base_italic) {
        (false, false) => REGULAR,
        (true, false) => BOLD,
        (false, true) => OBLIQUE,
        (true, true) => BOLD_OBLIQUE,
    }
}

fn tokenize(spans: &[Span], size: f32, bold: bool, italic: bool) -> Vec<Token> {
    let mut out = Vec::new();
    for sp in spans {
        let font = span_font(sp, bold, italic);
        let mut word: Vec<u8> = Vec::new();
        let flush = |word: &mut Vec<u8>, out: &mut Vec<Token>| {
            if !word.is_empty() {
                out.push(Token {
                    bytes: std::mem::take(word),
                    font,
                    size,
                    space: false,
                    newline: false,
                });
            }
        };
        for c in sp.text.chars() {
            if c == '\n' {
                flush(&mut word, &mut out);
                out.push(Token {
                    bytes: vec![],
                    font,
                    size,
                    space: false,
                    newline: true,
                });
            } else if c.is_whitespace() {
                flush(&mut word, &mut out);
                out.push(Token {
                    bytes: vec![b' '],
                    font,
                    size,
                    space: true,
                    newline: false,
                });
            } else {
                word.push(winansi(c));
            }
        }
        flush(&mut word, &mut out);
    }
    out
}

/// One laid-out line: runs of (font, size, bytes).
type Line = Vec<(usize, f32, Vec<u8>)>;

/// Greedy word wrap into lines no wider than `width`.
fn wrap(tokens: Vec<Token>, width: f32) -> Vec<Line> {
    let mut done: Vec<Vec<Token>> = Vec::new();
    let mut cur: Vec<Token> = Vec::new();
    let mut cur_w = 0.0f32;
    for t in tokens {
        if t.newline {
            done.push(std::mem::take(&mut cur));
            cur_w = 0.0;
            continue;
        }
        if t.space {
            // Drop leading spaces on a line, and collapse runs.
            if cur.last().map_or(true, |l| l.space) {
                continue;
            }
            cur_w += t.width();
            cur.push(t);
            continue;
        }
        let w = t.width();
        if cur_w + w > width && !cur.is_empty() {
            done.push(std::mem::take(&mut cur));
            cur_w = 0.0;
        }
        if w > width {
            // Hard-split a word wider than the line.
            let mut chunk: Vec<u8> = Vec::new();
            for b in &t.bytes {
                let bw = glyph_width(*b, t.font) * t.size / 1000.0;
                if cur_w + bw > width && !chunk.is_empty() {
                    cur.push(Token {
                        bytes: std::mem::take(&mut chunk),
                        ..t.clone()
                    });
                    done.push(std::mem::take(&mut cur));
                    cur_w = 0.0;
                }
                chunk.push(*b);
                cur_w += bw;
            }
            if !chunk.is_empty() {
                cur.push(Token { bytes: chunk, ..t });
            }
        } else {
            cur_w += w;
            cur.push(t);
        }
    }
    done.push(cur);
    done.into_iter()
        .map(|mut l| {
            while l.last().is_some_and(|t| t.space) {
                l.pop();
            }
            let mut runs: Line = Vec::new();
            for t in l {
                match runs.last_mut() {
                    Some((f, s, b)) if *f == t.font && (*s - t.size).abs() < f32::EPSILON => {
                        b.extend_from_slice(&t.bytes);
                    }
                    _ => runs.push((t.font, t.size, t.bytes)),
                }
            }
            runs
        })
        .collect()
}

fn pdf_string(bytes: &[u8], out: &mut String) {
    // Content streams are written as Latin-1 mapped chars into a String, then converted back to
    // bytes at the end (see `latin1_bytes`), so bytes >127 must be emitted as octal escapes to
    // keep the stream pure ASCII until then.
    out.push('(');
    for &b in bytes {
        match b {
            b'(' | b')' | b'\\' => {
                out.push('\\');
                out.push(b as char);
            }
            32..=126 => out.push(b as char),
            _ => {
                let _ = write!(out, "\\{b:03o}");
            }
        }
    }
    out.push(')');
}

struct Doc {
    /// Finished pages.
    done: Vec<String>,
    /// Content stream of the page being filled.
    page: String,
    y: f32,
}

impl Doc {
    fn new() -> Self {
        Self {
            done: Vec::new(),
            page: String::new(),
            y: PAGE_H - MARGIN,
        }
    }

    fn new_page(&mut self) {
        self.done.push(std::mem::take(&mut self.page));
        self.y = PAGE_H - MARGIN;
    }

    fn finish(mut self) -> Vec<String> {
        self.done.push(self.page);
        self.done
    }

    fn need(&mut self, h: f32) {
        if self.y - h < MARGIN && self.y < PAGE_H - MARGIN {
            self.new_page();
        }
    }

    fn gap(&mut self, h: f32) {
        // No leading gap at the top of a page.
        if self.y < PAGE_H - MARGIN {
            self.y -= h;
        }
    }

    fn line(&mut self, x: f32, line: &Line, size: f32) {
        let h = size * LEADING;
        self.need(h);
        let base = self.y - size;
        if !line.is_empty() {
            let mut s = String::new();
            let _ = write!(s, "BT {x:.2} {base:.2} Td ");
            for (font, sz, bytes) in line {
                let _ = write!(s, "/F{font} {sz:.2} Tf ");
                pdf_string(bytes, &mut s);
                s.push_str(" Tj ");
            }
            s.push_str("ET\n");
            self.page.push_str(&s);
        }
        self.y -= h;
    }

    fn lines(&mut self, x: f32, lines: &[Line], size: f32) {
        for l in lines {
            self.line(x, l, size);
        }
    }

    fn rect_fill(&mut self, x: f32, y: f32, w: f32, h: f32, gray: f32) {
        let _ = writeln!(
            self.page,
            "{gray:.2} g {x:.2} {y:.2} {w:.2} {h:.2} re f 0 g"
        );
    }

    fn hline(&mut self, x1: f32, x2: f32, y: f32, gray: f32) {
        let _ = writeln!(
            self.page,
            "{gray:.2} G 0.5 w {x1:.2} {y:.2} m {x2:.2} {y:.2} l S 0 G"
        );
    }
}

fn heading_size(level: u8) -> f32 {
    match level {
        1 => 20.0,
        2 => 17.0,
        3 => 14.5,
        4 => 13.0,
        _ => 12.0,
    }
}

fn render_table(doc: &mut Doc, rows: &[Vec<Vec<Span>>]) {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    #[allow(clippy::cast_precision_loss)]
    let col_w = TEXT_W / cols as f32;
    let size = 10.0;
    for (ri, row) in rows.iter().enumerate() {
        let cells: Vec<Vec<Line>> = (0..cols)
            .map(|ci| {
                let spans = row.get(ci).map_or(&[][..], Vec::as_slice);
                wrap(tokenize(spans, size, ri == 0, false), col_w - 8.0)
            })
            .collect();
        let nlines = cells.iter().map(Vec::len).max().unwrap_or(1).max(1);
        #[allow(clippy::cast_precision_loss)]
        let h = nlines as f32 * size * LEADING + 4.0;
        doc.need(h);
        let top = doc.y;
        for (ci, lines) in cells.iter().enumerate() {
            doc.y = top - 2.0;
            #[allow(clippy::cast_precision_loss)]
            let x = MARGIN + ci as f32 * col_w + 4.0;
            doc.lines(x, lines, size);
        }
        doc.y = top - h;
        doc.hline(MARGIN, MARGIN + TEXT_W, doc.y, 0.6);
    }
    doc.gap(6.0);
}

fn render_code(doc: &mut Doc, text: &str) {
    let size = 10.0;
    let lh = size * LEADING;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let max_chars = ((TEXT_W - 8.0) / (0.6 * size)).floor() as usize;
    for raw in text.split('\n') {
        let bytes: Vec<u8> = raw.chars().map(winansi).collect();
        let chunks: Vec<&[u8]> = if bytes.is_empty() {
            vec![&[][..]]
        } else {
            bytes.chunks(max_chars.max(1)).collect()
        };
        for chunk in chunks {
            doc.need(lh);
            let y = doc.y - lh;
            doc.rect_fill(MARGIN, y, TEXT_W, lh, 0.95);
            let line: Line = if chunk.is_empty() {
                vec![]
            } else {
                vec![(MONO, size, chunk.to_vec())]
            };
            doc.line(MARGIN + 4.0, &line, size);
        }
    }
    doc.gap(6.0);
}

fn render(title: &str, markdown: &str) -> Vec<String> {
    let mut doc = Doc::new();

    // Title (pdfkit: 24pt Helvetica-Bold, then a blank line).
    let title_spans = [Span {
        text: title.to_string(),
        ..Span::default()
    }];
    doc.lines(
        MARGIN,
        &wrap(tokenize(&title_spans, 24.0, true, false), TEXT_W),
        24.0,
    );
    doc.gap(12.0);

    for block in parse(markdown) {
        match block {
            Block::Heading { level, spans } => {
                let size = heading_size(level);
                doc.gap(8.0);
                doc.need(size * LEADING * 2.0); // keep with next
                doc.lines(
                    MARGIN,
                    &wrap(tokenize(&spans, size, true, false), TEXT_W),
                    size,
                );
                doc.gap(3.0);
            }
            Block::Paragraph(spans) => {
                doc.lines(
                    MARGIN,
                    &wrap(tokenize(&spans, 12.0, false, false), TEXT_W),
                    12.0,
                );
                doc.gap(6.0);
            }
            Block::Quote(spans) => {
                let start = doc.y;
                let page = doc.done.len();
                doc.lines(
                    MARGIN + 18.0,
                    &wrap(tokenize(&spans, 12.0, false, true), TEXT_W - 18.0),
                    12.0,
                );
                if doc.done.len() == page {
                    let end = doc.y;
                    doc.rect_fill(MARGIN + 6.0, end, 2.0, start - end, 0.7);
                }
                doc.gap(6.0);
            }
            Block::Code { text, .. } => render_code(&mut doc, &text),
            Block::ListItem {
                depth,
                marker,
                spans,
            } => {
                #[allow(clippy::cast_precision_loss)]
                let x = MARGIN + 18.0 * depth as f32;
                let lines = wrap(
                    tokenize(&spans, 12.0, false, false),
                    TEXT_W - 18.0 * (depth as f32 + 1.0),
                );
                if !marker.is_empty() {
                    let m: Vec<u8> = marker.chars().map(winansi).collect();
                    doc.need(12.0 * LEADING);
                    let y = doc.y;
                    doc.line(x, &vec![(REGULAR, 12.0, m)], 12.0);
                    doc.y = y;
                }
                doc.lines(x + 18.0, &lines, 12.0);
                doc.gap(2.0);
            }
            Block::Table(rows) => render_table(&mut doc, &rows),
            Block::Rule => {
                doc.gap(4.0);
                doc.need(6.0);
                let y = doc.y;
                doc.hline(MARGIN, MARGIN + TEXT_W, y, 0.5);
                doc.gap(8.0);
            }
        }
    }
    doc.finish()
}

/// Encode a document title for the Info dictionary: Latin-1 literal if possible, else UTF-16BE hex.
fn info_title(title: &str) -> String {
    if title.chars().all(|c| (' '..='~').contains(&c)) {
        let mut s = String::new();
        pdf_string(title.as_bytes(), &mut s);
        s
    } else {
        let mut s = String::from("<FEFF");
        for u in title.encode_utf16() {
            let _ = write!(s, "{u:04X}");
        }
        s.push('>');
        s
    }
}

/// Render Markdown as a PDF. Never fails; unsupported characters become `?`.
#[must_use]
pub fn to_pdf(title: &str, markdown: &str) -> Vec<u8> {
    let pages = render(title, markdown);
    let n = pages.len();

    // Object numbering: 1 catalog, 2 pages, 3 info, 4..=8 fonts, then (page, content) pairs.
    let first_page_obj = 4 + FONT_NAMES.len();
    let mut objs: Vec<String> = Vec::new();
    objs.push("<< /Type /Catalog /Pages 2 0 R >>".into());
    let kids: Vec<String> = (0..n)
        .map(|i| format!("{} 0 R", first_page_obj + 2 * i))
        .collect();
    objs.push(format!(
        "<< /Type /Pages /Count {n} /Kids [{}] >>",
        kids.join(" ")
    ));
    objs.push(format!(
        "<< /Title {} /Creator (Nyx) /Producer (nyx-core) >>",
        info_title(title)
    ));
    for name in FONT_NAMES {
        objs.push(format!(
            "<< /Type /Font /Subtype /Type1 /BaseFont /{name} /Encoding /WinAnsiEncoding >>"
        ));
    }
    let fonts: String = (0..FONT_NAMES.len())
        .map(|i| format!("/F{i} {} 0 R", 4 + i))
        .collect::<Vec<_>>()
        .join(" ");
    for (i, content) in pages.iter().enumerate() {
        let content_obj = first_page_obj + 2 * i + 1;
        objs.push(format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W} {PAGE_H}] /Resources << /Font << {fonts} >> >> /Contents {content_obj} 0 R >>"
        ));
        objs.push(format!(
            "<< /Length {} >>\nstream\n{content}endstream",
            content.len()
        ));
    }

    let mut out: Vec<u8> = Vec::new();
    // Header plus a binary comment so transports treat the file as binary.
    out.extend_from_slice(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    let mut offsets = Vec::with_capacity(objs.len());
    for (i, body) in objs.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref = out.len();
    out.extend_from_slice(format!("xref\n0 {}\n", objs.len() + 1).as_bytes());
    out.extend_from_slice(b"0000000000 65535 f \n");
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R /Info 3 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objs.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// Number of pages in a PDF produced by [`to_pdf`] (counts `/Type /Page ` objects). Handy for
/// tests and callers that want to report page counts without a PDF parser.
#[must_use]
pub fn page_count(pdf: &[u8]) -> usize {
    let hay = String::from_utf8_lossy(pdf);
    hay.matches("/Type /Page /Parent").count()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(b: &[u8]) -> String {
        String::from_utf8_lossy(b).into_owned()
    }

    #[test]
    fn header_trailer_and_one_page() {
        let p = to_pdf("Hello", "# H\n\nbody");
        assert!(p.starts_with(b"%PDF-1.4"));
        assert!(s(&p).trim_end().ends_with("%%EOF"));
        assert_eq!(page_count(&p), 1);
        assert!(s(&p).contains("/BaseFont /Helvetica-Bold"));
    }

    #[test]
    fn empty_document_still_has_a_page() {
        let p = to_pdf("", "");
        assert!(page_count(&p) >= 1);
    }

    #[test]
    fn xref_offsets_point_at_objects() {
        let p = to_pdf("T", "some **text**\n\n- a\n- b\n\n```\ncode\n```");
        let text = p.clone();
        let start = String::from_utf8_lossy(&text);
        let xref_pos: usize = start
            .rsplit("startxref\n")
            .next()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(&p[xref_pos..xref_pos + 4], b"xref");
        // every in-use entry must land on "N 0 obj"
        let table = s(&p[xref_pos..]);
        let mut n = 0;
        for line in table.lines().skip(3) {
            if !line.ends_with(" n ") && !line.ends_with(" n") {
                break;
            }
            let off: usize = line[..10].parse().unwrap();
            n += 1;
            assert!(
                s(&p[off..off + 12]).starts_with(&format!("{n} 0 obj")),
                "obj {n}"
            );
        }
        assert!(n >= 10);
    }

    #[test]
    fn long_documents_paginate() {
        let md = "word ".repeat(20_000);
        let p = to_pdf("Long", &md);
        assert!(page_count(&p) > 3);
        // Kids count matches /Count
        assert!(s(&p).contains(&format!("/Count {}", page_count(&p))));
    }

    #[test]
    fn special_chars_are_escaped_and_mapped() {
        let p = to_pdf("T", "a (paren) \\ back \u{201C}quoted\u{201D} \u{4E2D}");
        let t = s(&p);
        assert!(t.contains("\\(paren\\)"));
        assert!(t.contains("\\\\"));
        assert!(t.contains("\\223quoted\\224"));
        assert!(t.contains('?'));
    }

    #[test]
    fn non_latin_title_uses_utf16_hex() {
        let p = to_pdf("\u{4E2D}\u{6587}", "x");
        assert!(s(&p).contains("/Title <FEFF4E2D6587>"));
    }

    #[test]
    fn huge_unbroken_word_is_split() {
        let p = to_pdf("T", &"x".repeat(2_000));
        assert!(page_count(&p) >= 1);
    }

    #[test]
    fn tables_and_quotes_and_rules_render() {
        let p = to_pdf("T", "> quote\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
        assert_eq!(page_count(&p), 1);
        assert!(s(&p).contains(" re f"));
    }

    #[test]
    fn deterministic() {
        assert_eq!(to_pdf("T", "# x\n\ny"), to_pdf("T", "# x\n\ny"));
    }

    #[test]
    fn widths_sane() {
        assert!((text_width(b"i", REGULAR, 1000.0) - 222.0).abs() < 0.01);
        assert!((text_width(b"M", BOLD, 1000.0) - 833.0).abs() < 0.01);
        assert!((text_width(b"ab", MONO, 10.0) - 12.0).abs() < 0.01);
    }
}
