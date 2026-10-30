//! DOCX export (TS `exportService.toDocx`, which used the `docx` npm package).
//!
//! Implemented as a minimal hand-written Office Open XML package on top of the `zip` crate
//! instead of the `docx-rs` crate: `docx-rs` (MIT) pulls in an image stack and an XML builder we do
//! not need, while a Markdown document only needs paragraphs, runs, a few styles and tables.
//! The package has: `[Content_Types].xml`, `_rels/.rels`, `docProps/core.xml`,
//! `word/document.xml`, `word/styles.xml`, `word/_rels/document.xml.rels`.
//!
//! Mapping: title -> `Title` style; `#`..`######` -> `Heading1`..`Heading6` (TS handled 1 to 3
//! only); bold/italic/inline code -> run properties; code blocks -> `Code` paragraphs;
//! lists -> `ListParagraph` with a literal bullet/number marker and hanging indent (no
//! `numbering.xml`, so numbering restarts are exact but not Word "live" lists); block quotes ->
//! `Quote`; tables -> bordered `w:tbl`; rules -> paragraph bottom border. Images are not embedded.

use std::fmt::Write as _;
use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::blocks::{parse, Block, Span};
use super::bundle::zip_err;
use crate::error::Result;

const NS: &str = "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"";

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>"#;

const ROOT_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>"#;

const DOC_RELS: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>"#;

fn styles_xml() -> String {
    let mut s =
        String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:styles ");
    s.push_str(NS);
    s.push('>');
    s.push_str("<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\" w:cs=\"Calibri\"/><w:sz w:val=\"22\"/><w:szCs w:val=\"22\"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after=\"120\" w:line=\"276\" w:lineRule=\"auto\"/></w:pPr></w:pPrDefault></w:docDefaults>");
    s.push_str("<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/><w:qFormat/></w:style>");
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:after=\"240\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"56\"/><w:szCs w:val=\"56\"/></w:rPr></w:style>");
    // Heading sizes in half points: 32, 28, 26, 24, 22, 22.
    for (n, sz) in [(1, 32), (2, 28), (3, 26), (4, 24), (5, 22), (6, 22)] {
        let _ = write!(
            s,
            "<w:style w:type=\"paragraph\" w:styleId=\"Heading{n}\"><w:name w:val=\"heading {n}\"/><w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before=\"240\" w:after=\"80\"/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"{sz}\"/><w:szCs w:val=\"{sz}\"/></w:rPr></w:style>",
            n - 1
        );
    }
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/><w:spacing w:after=\"0\" w:line=\"240\" w:lineRule=\"auto\"/></w:pPr><w:rPr><w:rFonts w:ascii=\"Courier New\" w:hAnsi=\"Courier New\" w:cs=\"Courier New\"/><w:sz w:val=\"20\"/></w:rPr></w:style>");
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:ind w:left=\"720\"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>");
    s.push_str("<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:qFormat/><w:pPr><w:spacing w:after=\"40\"/></w:pPr></w:style>");
    s.push_str("<w:style w:type=\"table\" w:styleId=\"TableGrid\"><w:name w:val=\"Table Grid\"/><w:tblPr><w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:left w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:bottom w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:right w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:insideH w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/><w:insideV w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"808080\"/></w:tblBorders><w:tblCellMar><w:left w:w=\"100\" w:type=\"dxa\"/><w:right w:w=\"100\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr></w:style>");
    s.push_str("</w:styles>");
    s
}

/// Escape text for XML content and drop characters XML 1.0 forbids.
fn esc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\t' | '\n' | '\r' => out.push(c),
            c if (c as u32) < 0x20 || c == '\u{FFFE}' || c == '\u{FFFF}' => {}
            c => out.push(c),
        }
    }
    out
}

fn run(span: &Span, force_bold: bool) -> String {
    // Child order follows the CT_RPr schema sequence: rFonts, b, i, shd.
    let mut rpr = String::new();
    if span.code {
        rpr.push_str(
            "<w:rFonts w:ascii=\"Courier New\" w:hAnsi=\"Courier New\" w:cs=\"Courier New\"/>",
        );
    }
    if span.bold || force_bold {
        rpr.push_str("<w:b/>");
    }
    if span.italic {
        rpr.push_str("<w:i/>");
    }
    if span.code {
        rpr.push_str("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"F2F2F2\"/>");
    }
    let mut out = String::new();
    // Hard line breaks become <w:br/> between text pieces.
    for (i, piece) in span.text.split('\n').enumerate() {
        out.push_str("<w:r>");
        if !rpr.is_empty() {
            let _ = write!(out, "<w:rPr>{rpr}</w:rPr>");
        }
        if i > 0 {
            out.push_str("<w:br/>");
        }
        if !piece.is_empty() {
            let _ = write!(out, "<w:t xml:space=\"preserve\">{}</w:t>", esc(piece));
        }
        out.push_str("</w:r>");
    }
    out
}

fn runs(spans: &[Span]) -> String {
    spans.iter().map(|s| run(s, false)).collect()
}

fn para(style: &str, ppr_extra: &str, body: &str) -> String {
    format!("<w:p><w:pPr><w:pStyle w:val=\"{style}\"/>{ppr_extra}</w:pPr>{body}</w:p>")
}

fn plain_runs(text: &str) -> String {
    run(
        &Span {
            text: text.to_string(),
            ..Span::default()
        },
        false,
    )
}

fn table(rows: &[Vec<Vec<Span>>]) -> String {
    let cols = rows.iter().map(Vec::len).max().unwrap_or(1).max(1);
    let width = 9360 / cols; // twips across a 6.5in text area
    let mut s = String::from(
        "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"5000\" w:type=\"pct\"/></w:tblPr><w:tblGrid>",
    );
    for _ in 0..cols {
        let _ = write!(s, "<w:gridCol w:w=\"{width}\"/>");
    }
    s.push_str("</w:tblGrid>");
    for (ri, row) in rows.iter().enumerate() {
        s.push_str("<w:tr>");
        for ci in 0..cols {
            let cell = row.get(ci).map_or(&[][..], Vec::as_slice);
            let body: String = cell.iter().map(|sp| run(sp, ri == 0)).collect();
            let _ = write!(
                s,
                "<w:tc><w:tcPr><w:tcW w:w=\"{width}\" w:type=\"dxa\"/></w:tcPr>{}</w:tc>",
                para("Normal", "<w:spacing w:after=\"0\"/>", &body)
            );
        }
        s.push_str("</w:tr>");
    }
    s.push_str("</w:tbl>");
    // Word requires a paragraph after a table at the end of a cell/body; also gives spacing.
    s.push_str("<w:p/>");
    s
}

fn body_xml(title: &str, markdown: &str) -> String {
    let mut b = para("Title", "", &plain_runs(title));
    for block in parse(markdown) {
        match block {
            Block::Heading { level, spans } => {
                b.push_str(&para(&format!("Heading{}", level.clamp(1, 6)), "", &runs(&spans)));
            }
            Block::Paragraph(spans) => b.push_str(&para("Normal", "", &runs(&spans))),
            Block::Quote(spans) => b.push_str(&para("Quote", "", &runs(&spans))),
            Block::Code { text, .. } => {
                for line in text.split('\n') {
                    b.push_str(&para("Code", "", &plain_runs(line)));
                }
                b.push_str("<w:p/>");
            }
            Block::ListItem {
                depth,
                marker,
                spans,
            } => {
                let left = 360 * (depth + 1);
                let ind = format!("<w:ind w:left=\"{}\" w:hanging=\"360\"/>", left + 360);
                let mut body = String::new();
                if !marker.is_empty() {
                    body.push_str(&plain_runs(&marker));
                    body.push_str("<w:r><w:tab/></w:r>");
                }
                body.push_str(&runs(&spans));
                b.push_str(&para("ListParagraph", &ind, &body));
            }
            Block::Table(rows) => b.push_str(&table(&rows)),
            Block::Rule => b.push_str(
                "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"808080\"/></w:pBdr></w:pPr></w:p>",
            ),
        }
    }
    b
}

/// Build a `.docx` file.
pub fn to_docx(title: &str, markdown: &str) -> Result<Vec<u8>> {
    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:document {NS}><w:body>{}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>",
        body_xml(title, markdown)
    );
    let core = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>Nyx</dc:creator></cp:coreProperties>",
        esc(title)
    );

    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let styles = styles_xml();
    let parts: [(&str, &str); 6] = [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("docProps/core.xml", &core),
        ("word/document.xml", &document),
        ("word/styles.xml", &styles),
        ("word/_rels/document.xml.rels", DOC_RELS),
    ];
    for (name, data) in parts {
        zip.start_file(name, opts).map_err(zip_err)?;
        zip.write_all(data.as_bytes())?;
    }
    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn part(docx: &[u8], name: &str) -> String {
        let mut z = zip::ZipArchive::new(Cursor::new(docx)).unwrap();
        let mut s = String::new();
        z.by_name(name).unwrap().read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn package_is_a_valid_zip_with_required_parts() {
        let d = to_docx("Title", "# H1\n\ntext").unwrap();
        assert_eq!(&d[..2], b"PK");
        let mut z = zip::ZipArchive::new(Cursor::new(&d)).unwrap();
        for n in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/styles.xml",
            "word/_rels/document.xml.rels",
            "docProps/core.xml",
        ] {
            assert!(z.by_name(n).is_ok(), "missing {n}");
        }
        // CRC check of every entry (what `unzip -t` does).
        for i in 0..z.len() {
            let mut sink = Vec::new();
            z.by_index(i).unwrap().read_to_end(&mut sink).unwrap();
        }
    }

    #[test]
    fn all_parts_are_well_formed_xml_like() {
        let d = to_docx(
            "A & B <c>",
            "# H\n\n**b** *i* `c` & <tag>\n\n- x\n- y\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\ncode & more\n```\n\n> q\n\n---\n",
        )
        .unwrap();
        let doc = part(&d, "word/document.xml");
        assert!(doc.contains("A &amp; B &lt;c&gt;"));
        assert!(doc.contains("w:val=\"Heading1\""));
        assert!(doc.contains("<w:b/>") && doc.contains("<w:i/>"));
        assert!(doc.contains("<w:tbl>") && doc.contains("code &amp; more"));
        assert!(doc.contains("w:val=\"Quote\""));
        // balanced tags (cheap well-formedness check): every <w:p> closes
        assert_eq!(doc.matches("<w:p>").count(), doc.matches("</w:p>").count());
        assert_eq!(
            doc.matches("<w:tbl>").count(),
            doc.matches("</w:tbl>").count()
        );
    }

    #[test]
    fn deterministic() {
        assert_eq!(to_docx("T", "x").unwrap(), to_docx("T", "x").unwrap());
    }

    #[test]
    fn control_chars_are_dropped() {
        assert_eq!(esc("a\u{0}b\u{8}c\td"), "abc\td");
    }

    #[test]
    fn ordered_list_markers_present() {
        let d = to_docx("T", "1. one\n2. two").unwrap();
        let doc = part(&d, "word/document.xml");
        assert!(doc.contains(">1.<") && doc.contains(">2.<"));
    }
}
