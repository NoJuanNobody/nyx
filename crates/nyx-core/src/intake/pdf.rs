//! PDF text extraction via `lopdf` (MIT, pure Rust).
//!
//! Extraction uses `Document::extract_text_with_limit`, which bounds the decompressed size of
//! each page's content streams, so a small PDF cannot inflate without limit. Page count and
//! total text are capped by [`Limits`], encrypted documents are refused, and the parser runs
//! under `catch_unwind` because `lopdf` can panic on adversarial input.
//!
//! Scanned (image-only) PDFs contain no text; they produce an empty string and the caller should
//! fall back to rendering pages and running an [`crate::intake::OcrEngine`] (not implemented here).

use std::panic::{catch_unwind, AssertUnwindSafe};

use super::limits::Limits;
use crate::error::{Error, Result};

/// Extract the text of a PDF, pages separated by blank lines.
pub fn extract_pdf_text(bytes: &[u8], limits: &Limits) -> Result<String> {
    let limits = limits.clone();
    let bytes = bytes.to_vec();
    catch_unwind(AssertUnwindSafe(move || extract(&bytes, &limits))).unwrap_or_else(|_| {
        Err(Error::Invalid(
            "PDF parser failed on malformed input".into(),
        ))
    })
}

fn extract(bytes: &[u8], limits: &Limits) -> Result<String> {
    let doc = lopdf::Document::load_mem(bytes)
        .map_err(|e| Error::Invalid(format!("could not read PDF: {e}")))?;
    if doc.is_encrypted() {
        return Err(Error::Invalid("encrypted PDFs are not supported".into()));
    }
    let pages: Vec<u32> = doc.get_pages().keys().copied().collect();
    if pages.len() > limits.max_pdf_pages {
        return Err(Error::Invalid(format!(
            "PDF has too many pages ({} > {})",
            pages.len(),
            limits.max_pdf_pages
        )));
    }

    let mut out = String::new();
    for page in pages {
        let text = doc
            .extract_text_with_limit(&[page], limits.max_pdf_page_bytes)
            .map_err(|e| Error::Invalid(format!("could not extract PDF page {page}: {e}")))?;
        let text = text.trim();
        if !text.is_empty() {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(text);
        }
        if out.chars().count() > limits.max_extracted_chars {
            break;
        }
    }
    limits.clamp_text(&mut out);
    Ok(out)
}

/// Build a tiny single- or multi-page PDF with one line of text per page (test fixture).
#[cfg(test)]
pub(crate) fn build_pdf(lines: &[&str]) -> Vec<u8> {
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Document, Object, Stream};

    let mut doc = Document::with_version("1.5");
    let pages_id = doc.new_object_id();
    let font_id = doc.add_object(dictionary! {
        "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
    });
    let resources_id = doc.add_object(dictionary! {
        "Font" => dictionary! { "F1" => font_id },
    });
    let mut kids = Vec::new();
    for line in lines {
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec!["F1".into(), 12.into()]),
                Operation::new("Td", vec![72.into(), 700.into()]),
                Operation::new("Tj", vec![Object::string_literal(*line)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = doc.add_object(dictionary! {
            "Type" => "Page", "Parent" => pages_id, "Contents" => content_id,
            "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
        });
        kids.push(page_id.into());
    }
    let count = i64::try_from(kids.len()).unwrap();
    doc.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => kids, "Count" => count, "Resources" => resources_id,
        }),
    );
    let catalog_id = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    doc.trailer.set("Root", catalog_id);
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn extracts_text_from_each_page() {
        let pdf = build_pdf(&["Hello Nyx", "Second page"]);
        let text = extract_pdf_text(&pdf, &Limits::default()).unwrap();
        assert!(text.contains("Hello Nyx"), "{text:?}");
        assert!(text.contains("Second page"), "{text:?}");
        assert!(text.find("Hello").unwrap() < text.find("Second").unwrap());
    }

    #[test]
    fn garbage_is_an_error_not_a_panic() {
        assert!(extract_pdf_text(b"%PDF-1.4 total nonsense", &Limits::default()).is_err());
        assert!(extract_pdf_text(b"", &Limits::default()).is_err());
    }

    #[test]
    fn page_limit_is_enforced() {
        let pdf = build_pdf(&["a", "b", "c"]);
        let l = Limits {
            max_pdf_pages: 2,
            ..Limits::default()
        };
        assert!(extract_pdf_text(&pdf, &l).is_err());
    }

    #[test]
    fn output_is_clamped() {
        let pdf = build_pdf(&["abcdefghij"]);
        let l = Limits {
            max_extracted_chars: 4,
            ..Limits::default()
        };
        assert_eq!(extract_pdf_text(&pdf, &l).unwrap(), "abcd");
    }
}
