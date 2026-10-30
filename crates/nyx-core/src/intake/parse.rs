//! File parsing: bytes -> text. Port of `file-parser.service.ts` plus the PDF/DOCX/PCB paths.
//!
//! [`parse_file`] sniffs the content ([`super::kind::sniff`]), applies the size limit for the
//! detected kind, then extracts text. Images and audio are *not* handled here: they need an
//! [`super::OcrEngine`] / [`super::Transcriber`] and are routed by [`super::pipeline`].

use serde::{Deserialize, Serialize};

use super::docx::extract_docx_text;
use super::kind::{sniff, InputKind};
use super::limits::{sanitize_filename, Limits};
use super::pcb::{self, BomEntry, PcbMetadata};
use super::pdf::extract_pdf_text;
use crate::error::{Error, Result};

/// Output of [`parse_file`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParsedFile {
    /// Detected kind.
    pub kind: InputKind,
    /// Detected/refined MIME type.
    pub mime: String,
    /// Extracted text (markdown-compatible).
    pub content: String,
    /// Non-fatal remark for the user (TS `ParsedFile.note`).
    pub note: Option<String>,
    /// True when the declared type/extension disagreed with the content.
    pub mismatch: bool,
    /// PCB metadata, for [`InputKind::Pcb`].
    pub pcb: Option<PcbMetadata>,
    /// PCB bill of materials, for KiCad files.
    pub bom: Vec<BomEntry>,
}

/// Parse one CSV line, honouring quoted fields (port of `parseCsvRow`). Fields are trimmed.
#[must_use]
pub fn parse_csv_row(row: &str) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    let mut chars = row.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    current.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                current.push(c);
            }
        } else if c == '"' {
            in_quotes = true;
        } else if c == ',' {
            fields.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(c);
        }
    }
    fields.push(current.trim().to_string());
    fields
}

/// Convert CSV text into a markdown table (port of `csvToMarkdownTable`). As in the TypeScript,
/// the text is split into lines first, so a quoted field containing a newline is not supported.
#[must_use]
pub fn csv_to_markdown_table(csv: &str) -> String {
    let rows: Vec<Vec<String>> = csv
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty())
        .map(parse_csv_row)
        .collect();
    let Some(header) = rows.first() else {
        return String::new();
    };
    let head = format!("| {} |", header.join(" | "));
    let sep = format!("| {} |", vec!["---"; header.len()].join(" | "));
    let body = rows[1..]
        .iter()
        .map(|r| format!("| {} |", r.join(" | ")))
        .collect::<Vec<_>>()
        .join("\n");
    [head, sep, body]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

const KNOWN_TEXT_MIMES: [&str; 5] = [
    "text/plain",
    "text/markdown",
    "text/x-markdown",
    "text/csv",
    "application/csv",
];

/// Parse an uploaded file into text. See the module docs for what is and is not handled.
pub fn parse_file(
    bytes: &[u8],
    filename: Option<&str>,
    declared_mime: Option<&str>,
    limits: &Limits,
) -> Result<ParsedFile> {
    let name = filename.map(sanitize_filename).transpose()?;
    let sniffed = sniff(name.as_deref(), declared_mime, bytes);
    match sniffed.kind {
        InputKind::Unknown => {
            return Err(Error::Invalid(format!(
                "unsupported file type \"{}\"",
                sniffed.mime
            )))
        }
        InputKind::Image => {
            return Err(Error::Invalid(
                "images need OCR; route them through the intake pipeline with an OcrEngine".into(),
            ))
        }
        InputKind::Audio => return Err(Error::Invalid(
            "audio needs transcription; route it through the intake pipeline with a Transcriber"
                .into(),
        )),
        _ => {}
    }
    limits.check_size(sniffed.kind, bytes.len())?;

    let mut parsed = ParsedFile {
        kind: sniffed.kind,
        mime: sniffed.mime.clone(),
        content: String::new(),
        note: None,
        mismatch: sniffed.mismatch,
        pcb: None,
        bom: Vec::new(),
    };
    match sniffed.kind {
        InputKind::Text | InputKind::Markdown | InputKind::Csv => {
            let text = String::from_utf8_lossy(bytes);
            parsed.content = if sniffed.kind == InputKind::Csv {
                csv_to_markdown_table(&text)
            } else {
                text.into_owned()
            };
            if !KNOWN_TEXT_MIMES.contains(&sniffed.mime.as_str()) {
                parsed.note = Some(format!(
                    "File type \"{}\" is not fully supported. Content was imported as raw text.",
                    sniffed.mime
                ));
            }
        }
        InputKind::Pdf => {
            parsed.content = extract_pdf_text(bytes, limits)?;
            if parsed.content.trim().is_empty() {
                parsed.note = Some(
                    "No text layer found; this looks like a scanned PDF and needs OCR.".into(),
                );
            }
        }
        InputKind::Docx => parsed.content = extract_docx_text(bytes, limits)?,
        InputKind::Pcb => {
            let file_name = name.as_deref().unwrap_or("board.kicad_pcb");
            let file_name = if pcb::detect_format(file_name) == pcb::PcbFormat::Unknown {
                "board.kicad_pcb"
            } else {
                file_name
            };
            let meta = pcb::parse_pcb_file(bytes, file_name);
            let bom = pcb::extract_bom(bytes, file_name);
            parsed.content = pcb::to_markdown(&meta, &bom);
            parsed.pcb = Some(meta);
            parsed.bom = bom;
        }
        InputKind::Image | InputKind::Audio | InputKind::Unknown => unreachable!("handled above"),
    }
    limits.clamp_text(&mut parsed.content);
    Ok(parsed)
}

/// Append parsed content to existing document content, as `routes/upload.ts` did: a `---`
/// separator when the document is non-empty and a `> **Note:**` header when there is a note.
#[must_use]
pub fn append_to_document(existing: &str, parsed: &ParsedFile) -> String {
    let separator = if existing.is_empty() {
        ""
    } else {
        "\n\n---\n\n"
    };
    let note = parsed
        .note
        .as_ref()
        .map_or_else(String::new, |n| format!("> **Note:** {n}\n\n"));
    format!("{existing}{separator}{note}{}", parsed.content)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::intake::docx::build_docx;
    use crate::intake::pdf::build_pdf;

    fn parse(bytes: &[u8], name: &str, mime: Option<&str>) -> Result<ParsedFile> {
        parse_file(bytes, Some(name), mime, &Limits::default())
    }

    #[test]
    fn text_and_markdown_pass_through() {
        let p = parse(b"# Title\n\nbody", "a.md", Some("text/markdown")).unwrap();
        assert_eq!(
            (p.kind, p.content.as_str(), p.note),
            (InputKind::Markdown, "# Title\n\nbody", None)
        );
        let p = parse(b"plain", "a.txt", Some("application/octet-stream")).unwrap();
        assert_eq!(p.kind, InputKind::Text);
        assert_eq!(p.mime, "text/plain");
        assert!(p.note.is_none());
    }

    #[test]
    fn csv_becomes_a_markdown_table() {
        let csv = "name,role\r\n\"Doe, Jane\",PM\r\n\"say \"\"hi\"\"\",dev\r\n\r\n";
        let p = parse(csv.as_bytes(), "t.csv", Some("text/csv")).unwrap();
        assert_eq!(
            p.content,
            "| name | role |\n| --- | --- |\n| Doe, Jane | PM |\n| say \"hi\" | dev |"
        );
        assert_eq!(csv_to_markdown_table(""), "");
        assert_eq!(csv_to_markdown_table("a,b"), "| a | b |\n| --- | --- |");
        assert_eq!(parse_csv_row(" a , b ,"), vec!["a", "b", ""]);
    }

    #[test]
    fn unknown_text_type_gets_the_ts_note() {
        let p = parse(b"{\"a\":1}", "a.json", Some("application/json")).unwrap();
        assert_eq!(
            p.note.as_deref(),
            Some("File type \"application/json\" is not fully supported. Content was imported as raw text.")
        );
        assert_eq!(p.content, "{\"a\":1}");
    }

    #[test]
    fn pdf_docx_and_pcb() {
        let p = parse(&build_pdf(&["Spec text"]), "x.pdf", None).unwrap();
        assert_eq!(p.kind, InputKind::Pdf);
        assert!(p.content.contains("Spec text"));

        let docx = build_docx("<w:p><w:r><w:t>Doc body</w:t></w:r></w:p>");
        let p = parse(&docx, "x.docx", Some("application/octet-stream")).unwrap();
        assert_eq!((p.kind, p.content.as_str()), (InputKind::Docx, "Doc body"));

        let kicad = "(kicad_pcb (version 1) (layers (0 \"F.Cu\" signal))\n (footprint \"R:0402\"\n (fp_text reference \"R1\" (at 0 0))\n (fp_text value \"1k\" (at 0 0))\n))";
        let p = parse(kicad.as_bytes(), "b.kicad_pcb", None).unwrap();
        assert_eq!(p.kind, InputKind::Pcb);
        assert_eq!(p.pcb.as_ref().unwrap().component_count, 1);
        assert_eq!(p.bom.len(), 1);
        assert!(p.content.contains("| R1 | 1k | R:0402 | 1 |"));
    }

    #[test]
    fn mislabelled_pdf_is_parsed_as_pdf_and_flagged() {
        let p = parse(&build_pdf(&["hi there"]), "renamed.txt", Some("text/plain")).unwrap();
        assert_eq!(p.kind, InputKind::Pdf);
        assert!(p.mismatch);
    }

    #[test]
    fn rejections() {
        assert!(parse(b"", "e.txt", None).is_err());
        assert!(parse(&[0, 1, 2, 0xFF, 0], "x.dat", None).is_err());
        assert!(parse(b"\x89PNG\r\n\x1a\n....", "x.png", None)
            .unwrap_err()
            .to_string()
            .contains("OCR"));
        assert!(parse(b"ID3\x04\0\0", "x.mp3", None)
            .unwrap_err()
            .to_string()
            .contains("transcription"));
        assert!(parse(b"x", "../..", None).is_err());
        let small = Limits {
            max_upload_bytes: 4,
            ..Limits::default()
        };
        assert!(parse_file(b"hello", Some("a.txt"), None, &small).is_err());
    }

    #[test]
    fn append_matches_upload_route() {
        let p = ParsedFile {
            kind: InputKind::Text,
            mime: "text/plain".into(),
            content: "new".into(),
            note: Some("careful".into()),
            mismatch: false,
            pcb: None,
            bom: vec![],
        };
        assert_eq!(append_to_document("", &p), "> **Note:** careful\n\nnew");
        assert_eq!(
            append_to_document("old", &p),
            "old\n\n---\n\n> **Note:** careful\n\nnew"
        );
    }
}
