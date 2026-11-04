//! `.docx` text extraction: zip container + WordprocessingML, with zip-bomb protection.
//!
//! Only `word/document.xml` is read. Safety checks, all enforced before or while reading:
//! entry count, unsafe entry names (zip-slip), declared total size, per-entry compression ratio,
//! and a hard cap on the *actual* bytes inflated (the declared size in a zip header is attacker
//! controlled, so the reader is wrapped in `take`). XML containing a DOCTYPE is refused (no
//! entity tricks), and nothing is ever written to disk.
//!
//! Output is markdown-ish: `Heading N` styles become `#`, list paragraphs `- `, tables become
//! pipe rows, tabs and line breaks are preserved.

use std::io::{Cursor, Read};

use quick_xml::events::Event;
use quick_xml::Reader;

use super::limits::{check_entry_name, Limits};
use crate::error::{Error, Result};

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

/// Read `word/document.xml` out of a `.docx`, enforcing [`Limits`].
fn read_document_xml(bytes: &[u8], limits: &Limits) -> Result<Vec<u8>> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| invalid(format!("not a valid .docx archive: {e}")))?;
    if zip.len() > limits.max_zip_entries {
        return Err(invalid(format!(
            "archive has too many entries ({} > {})",
            zip.len(),
            limits.max_zip_entries
        )));
    }

    let mut declared_total: u64 = 0;
    for i in 0..zip.len() {
        let f = zip
            .by_index_raw(i)
            .map_err(|e| invalid(format!("corrupt archive entry: {e}")))?;
        let name = f
            .name()
            .map_err(|e| invalid(format!("corrupt archive entry name: {e}")))?;
        check_entry_name(&name)?;
        declared_total = declared_total.saturating_add(f.size());
        if declared_total > limits.max_zip_total_bytes {
            return Err(invalid(
                "archive expands to more than the allowed total size",
            ));
        }
        let compressed = f.compressed_size().max(1);
        if f.size() > limits.ratio_floor_bytes && f.size() / compressed > limits.max_zip_ratio {
            return Err(invalid(format!(
                "entry {name:?} has a suspicious compression ratio (zip bomb?)"
            )));
        }
    }

    let entry = zip
        .by_name("word/document.xml")
        .map_err(|_| invalid("not a .docx: word/document.xml is missing"))?;
    let cap = limits.max_zip_entry_bytes;
    let mut out = Vec::new();
    entry
        .take(cap + 1)
        .read_to_end(&mut out)
        .map_err(|e| invalid(format!("could not inflate word/document.xml: {e}")))?;
    if out.len() as u64 > cap {
        return Err(invalid(
            "word/document.xml exceeds the allowed uncompressed size",
        ));
    }
    Ok(out)
}

fn attr(e: &quick_xml::events::BytesStart<'_>, key: &str) -> Option<String> {
    e.attributes()
        .flatten()
        .find_map(|a| (a.key.local_name().as_ref() == key).then(|| a.value.to_string()))
}

/// Extract markdown-ish text from a `.docx` file.
pub fn extract_docx_text(bytes: &[u8], limits: &Limits) -> Result<String> {
    let xml = read_document_xml(bytes, limits)?;
    let mut reader = Reader::from_reader(xml.as_slice());

    let mut blocks: Vec<String> = Vec::new();
    let mut para = String::new();
    let mut style: Option<String> = None;
    let mut numbered = false;
    let mut in_text = false;
    let mut cell: Option<String> = None;
    let mut row: Vec<String> = Vec::new();

    loop {
        match reader.read_event() {
            Err(e) => return Err(invalid(format!("malformed document.xml: {e}"))),
            Ok(Event::Eof) => break,
            Ok(Event::DocType(_)) => return Err(invalid("document.xml contains a DOCTYPE")),
            Ok(Event::Start(e)) => match e.local_name().as_ref() {
                "p" => {
                    para.clear();
                    style = None;
                    numbered = false;
                }
                "t" => in_text = true,
                "tc" => cell = Some(String::new()),
                "tr" => row.clear(),
                "pStyle" => style = attr(&e, "val"),
                "numPr" => numbered = true,
                _ => {}
            },
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "tab" => para.push('\t'),
                "br" | "cr" => para.push('\n'),
                "pStyle" => style = attr(&e, "val"),
                "numPr" => numbered = true,
                _ => {}
            },
            Ok(Event::Text(t)) if in_text => {
                para.push_str(&t);
            }
            Ok(Event::GeneralRef(r)) if in_text => {
                if let Ok(Some(c)) = r.resolve_char_ref() {
                    para.push(c);
                } else {
                    match r.as_ref() {
                        "amp" => para.push('&'),
                        "lt" => para.push('<'),
                        "gt" => para.push('>'),
                        "quot" => para.push('"'),
                        "apos" => para.push('\''),
                        _ => {}
                    }
                }
            }
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" => {
                    let text = para.trim_end().to_string();
                    if let Some(c) = cell.as_mut() {
                        if !text.is_empty() {
                            if !c.is_empty() {
                                c.push(' ');
                            }
                            c.push_str(&text);
                        }
                    } else if !text.is_empty() {
                        blocks.push(format_paragraph(&text, style.as_deref(), numbered));
                    }
                    para.clear();
                }
                "tc" => row.push(cell.take().unwrap_or_default()),
                "tr" => {
                    if !row.is_empty() {
                        blocks.push(format!("| {} |", row.join(" | ")));
                    }
                    row.clear();
                }
                _ => {}
            },
            Ok(_) => {}
        }
    }

    let mut text = blocks.join("\n\n");
    limits.clamp_text(&mut text);
    Ok(text)
}

fn format_paragraph(text: &str, style: Option<&str>, numbered: bool) -> String {
    if let Some(level) = style
        .and_then(|s| {
            s.strip_prefix("Heading")
                .or_else(|| s.strip_prefix("heading"))
        })
        .and_then(|n| n.trim().parse::<usize>().ok())
    {
        return format!("{} {text}", "#".repeat(level.clamp(1, 6)));
    }
    if style == Some("Title") {
        return format!("# {text}");
    }
    if numbered || style.is_some_and(|s| s.starts_with("ListParagraph")) {
        return format!("- {text}");
    }
    text.to_string()
}

/// Test helper (also useful for fixtures elsewhere in the crate): build a minimal `.docx`.
#[cfg(test)]
pub(crate) fn build_docx(body_xml: &str) -> Vec<u8> {
    use std::io::Write;
    let mut buf = Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut buf);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        z.start_file("[Content_Types].xml", opts).unwrap();
        z.write_all(b"<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>").unwrap();
        z.start_file("word/document.xml", opts).unwrap();
        z.write_all(
            format!(
                "<?xml version=\"1.0\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{body_xml}</w:body></w:document>"
            )
            .as_bytes(),
        )
        .unwrap();
        z.finish().unwrap();
    }
    buf.into_inner()
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::io::Write;

    fn p(text: &str) -> String {
        format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>")
    }

    #[test]
    fn extracts_paragraphs_headings_lists_and_tables() {
        let body = format!(
            "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Title here</w:t></w:r></w:p>{}\
             <w:p><w:pPr><w:numPr><w:ilvl w:val=\"0\"/></w:numPr></w:pPr><w:r><w:t>item &amp; more</w:t></w:r></w:p>\
             <w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/><w:t xml:space=\"preserve\"> b</w:t></w:r></w:p>\
             <w:tbl><w:tr><w:tc>{}</w:tc><w:tc>{}</w:tc></w:tr></w:tbl>",
            p("Plain text"),
            p("c1"),
            p("c2")
        );
        let text = extract_docx_text(&build_docx(&body), &Limits::default()).unwrap();
        assert_eq!(
            text,
            "# Title here\n\nPlain text\n\n- item & more\n\na\t b\n\n| c1 | c2 |"
        );
    }

    #[test]
    fn rejects_non_docx_zip_and_garbage() {
        assert!(extract_docx_text(b"not a zip", &Limits::default()).is_err());
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            z.start_file("hello.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            z.write_all(b"hi").unwrap();
            z.finish().unwrap();
        }
        let err = extract_docx_text(&buf.into_inner(), &Limits::default()).unwrap_err();
        assert!(err.to_string().contains("word/document.xml"));
    }

    #[test]
    fn zip_bomb_is_rejected_by_ratio() {
        // ~6 MiB of zeros compresses to a few KiB: ratio far above 200:1.
        let zeros = "a".repeat(6 * 1024 * 1024);
        let docx = build_docx(&p(&zeros));
        assert!(docx.len() < 100 * 1024);
        let err = extract_docx_text(&docx, &Limits::default()).unwrap_err();
        assert!(err.to_string().contains("compression ratio"), "{err}");
    }

    #[test]
    fn inflation_is_capped_even_when_headers_lie() {
        let docx = build_docx(&p(&"b".repeat(200_000)));
        let limits = Limits {
            max_zip_entry_bytes: 50_000,
            max_zip_ratio: u64::MAX,
            ..Limits::default()
        };
        let err = extract_docx_text(&docx, &limits).unwrap_err();
        assert!(err.to_string().contains("exceeds"), "{err}");
    }

    #[test]
    fn entry_count_and_total_size_limits() {
        let docx = build_docx(&p("x"));
        let few = Limits {
            max_zip_entries: 1,
            ..Limits::default()
        };
        assert!(extract_docx_text(&docx, &few).is_err());
        let small = Limits {
            max_zip_total_bytes: 10,
            ..Limits::default()
        };
        assert!(extract_docx_text(&docx, &small).is_err());
    }

    #[test]
    fn path_traversal_entry_names_are_rejected() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("../evil.txt", o).unwrap();
            z.write_all(b"x").unwrap();
            z.start_file("word/document.xml", o).unwrap();
            z.write_all(b"<w:document/>").unwrap();
            z.finish().unwrap();
        }
        let err = extract_docx_text(&buf.into_inner(), &Limits::default()).unwrap_err();
        assert!(err.to_string().contains("unsafe path"), "{err}");
    }

    #[test]
    fn doctype_is_refused() {
        let mut buf = Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("word/document.xml", o).unwrap();
            z.write_all(b"<!DOCTYPE x [<!ENTITY a \"b\">]><w:document/>")
                .unwrap();
            z.finish().unwrap();
        }
        assert!(extract_docx_text(&buf.into_inner(), &Limits::default()).is_err());
    }
}
