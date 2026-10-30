//! Input kinds and content sniffing.
//!
//! Ported from the extension/MIME refinement in `file-parser.service.ts` (`refineMimeType`) and
//! `transcription.service.ts` (supported audio types), extended with magic-byte sniffing so a
//! renamed or mislabelled upload is classified by what it actually contains. Magic bytes win over
//! the extension and the declared MIME; a disagreement is reported via [`Sniffed::mismatch`].

use std::io::Cursor;

use crate::model::string_enum;

string_enum! {
    /// What an upload (or pasted blob) is, which decides how it is turned into text.
    InputKind {
        /// Plain text (also the fallback for unknown text-like content).
        Text => "text",
        /// Markdown.
        Markdown => "markdown",
        /// Comma separated values; rendered as a markdown table.
        Csv => "csv",
        /// PDF document (text extraction).
        Pdf => "pdf",
        /// Word `.docx` (zip + WordprocessingML).
        Docx => "docx",
        /// Raster image; needs an [`crate::intake::OcrEngine`].
        Image => "image",
        /// Audio recording; needs a [`crate::intake::Transcriber`].
        Audio => "audio",
        /// KiCad `.kicad_pcb` or Gerber layer file (metadata + BOM extraction).
        Pcb => "pcb",
        /// Anything else (binary, unsupported archive). Rejected by the parser.
        Unknown => "unknown",
    }
}

impl InputKind {
    /// True if the content can be turned into text without an external engine.
    #[must_use]
    pub fn is_directly_parseable(self) -> bool {
        !matches!(self, Self::Image | Self::Audio | Self::Unknown)
    }
}

/// Result of [`sniff`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sniffed {
    /// Detected kind.
    pub kind: InputKind,
    /// Best MIME type: the sniffed one for binary formats, the (refined) declared one for text.
    pub mime: String,
    /// True when the declared MIME or extension contradicted the content.
    pub mismatch: bool,
}

/// MIME types that carry no information (`refineMimeType` treats them as "unknown").
fn is_generic_mime(m: &str) -> bool {
    m.is_empty() || m == "application/octet-stream" || m == "unknown"
}

/// Lower-cased extension of a file name (text after the last dot; whole name if there is no dot,
/// mirroring `filename.split('.').pop()` in the TypeScript).
#[must_use]
pub fn extension(filename: &str) -> String {
    filename
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_lowercase()
}

/// Port of `refineMimeType`: keep a specific declared MIME, otherwise infer from the extension.
#[must_use]
pub fn refine_mime(declared: Option<&str>, filename: Option<&str>) -> String {
    let declared = declared.unwrap_or("").trim().to_lowercase();
    if !is_generic_mime(&declared) {
        return declared;
    }
    let Some(name) = filename else {
        return declared;
    };
    match extension(name).as_str() {
        "txt" => "text/plain".into(),
        "md" | "markdown" => "text/markdown".into(),
        "csv" => "text/csv".into(),
        _ => declared,
    }
}

/// Gerber layer extensions recognised by `pcb-parser.service.ts`.
const GERBER_EXTS: [&str; 7] = ["gbr", "gbl", "gtl", "gbs", "gts", "gbo", "gto"];

/// True for file names the PCB parser handles.
#[must_use]
pub fn is_pcb_filename(filename: &str) -> bool {
    let ext = extension(filename);
    ext == "kicad_pcb" || GERBER_EXTS.contains(&ext.as_str())
}

fn magic(bytes: &[u8]) -> Option<(InputKind, &'static str)> {
    let starts = |p: &[u8]| bytes.starts_with(p);
    if bytes[..bytes.len().min(1024)]
        .windows(5)
        .any(|w| w == b"%PDF-")
    {
        return Some((InputKind::Pdf, "application/pdf"));
    }
    if starts(b"\x89PNG\r\n\x1a\n") {
        return Some((InputKind::Image, "image/png"));
    }
    if starts(&[0xFF, 0xD8, 0xFF]) {
        return Some((InputKind::Image, "image/jpeg"));
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some((InputKind::Image, "image/gif"));
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" {
        match &bytes[8..12] {
            b"WEBP" => return Some((InputKind::Image, "image/webp")),
            b"WAVE" => return Some((InputKind::Audio, "audio/wav")),
            _ => {}
        }
    }
    if starts(b"ID3") || (bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0) {
        return Some((InputKind::Audio, "audio/mpeg"));
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return match &bytes[8..12] {
            b"M4A " | b"M4B " => Some((InputKind::Audio, "audio/mp4")),
            _ => None,
        };
    }
    if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some((InputKind::Audio, "audio/webm"));
    }
    None
}

/// Is this a zip that looks like a `.docx` package?
fn is_docx(bytes: &[u8]) -> bool {
    if !bytes.starts_with(b"PK\x03\x04") {
        return false;
    }
    zip::ZipArchive::new(Cursor::new(bytes)).is_ok_and(|z| {
        let names: Vec<String> = z
            .file_names()
            .filter_map(|n| n.ok().map(String::from))
            .collect();
        names.iter().any(|n| n == "[Content_Types].xml")
            && names.iter().any(|n| n == "word/document.xml")
    })
}

/// Heuristic: valid UTF-8 (allowing a truncated trailing sequence) without NUL bytes in the head.
fn looks_like_text(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(8192)];
    if head.contains(&0) {
        return false;
    }
    match std::str::from_utf8(head) {
        Ok(_) => true,
        Err(e) => e.error_len().is_none() && head.len() - e.valid_up_to() < 4,
    }
}

/// Classify an upload.
///
/// Order: binary magic bytes, then the `.docx` package check, then PCB (extension or
/// `(kicad_pcb` header), then declared MIME / extension for text formats, then a UTF-8 text
/// heuristic. Anything else is [`InputKind::Unknown`].
#[must_use]
pub fn sniff(filename: Option<&str>, declared_mime: Option<&str>, bytes: &[u8]) -> Sniffed {
    let refined = refine_mime(declared_mime, filename);
    let ext = filename
        .filter(|n| n.contains('.'))
        .map(extension)
        .unwrap_or_default();
    let declared_specific = !is_generic_mime(&refined);

    let found = |kind, mime: &str, expected: bool| Sniffed {
        kind,
        mime: mime.to_string(),
        mismatch: !expected,
    };

    if let Some((kind, mime)) = magic(bytes) {
        let expected = (!declared_specific
            || refined == mime
            || refined.starts_with(&mime[..mime.find('/').unwrap_or(0)]))
            && (ext.is_empty() || ext_matches(kind, &ext));
        return found(kind, mime, expected);
    }
    if is_docx(bytes) {
        let mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        return found(InputKind::Docx, mime, !declared_specific || refined == mime);
    }
    if bytes.starts_with(b"PK\x03\x04") || !looks_like_text(bytes) {
        return Sniffed {
            kind: InputKind::Unknown,
            mime: if declared_specific {
                refined
            } else {
                "application/octet-stream".into()
            },
            mismatch: false,
        };
    }

    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]);
    if filename.is_some_and(is_pcb_filename) || head.trim_start().starts_with("(kicad_pcb") {
        return Sniffed {
            kind: InputKind::Pcb,
            mime: "text/plain".into(),
            mismatch: false,
        };
    }

    let (kind, mime) = match refined.as_str() {
        "text/markdown" | "text/x-markdown" => (InputKind::Markdown, refined),
        "text/csv" | "application/csv" => (InputKind::Csv, refined),
        "text/plain" => (InputKind::Text, refined),
        _ if declared_specific => (InputKind::Text, refined),
        _ => (InputKind::Text, "text/plain".to_string()),
    };
    Sniffed {
        kind,
        mime,
        mismatch: false,
    }
}

fn ext_matches(kind: InputKind, ext: &str) -> bool {
    match kind {
        InputKind::Pdf => ext == "pdf",
        InputKind::Image => matches!(
            ext,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff"
        ),
        InputKind::Audio => matches!(ext, "mp3" | "wav" | "m4a" | "mp4" | "webm"),
        _ => true,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn refine_mime_matches_the_typescript() {
        assert_eq!(
            refine_mime(Some("application/octet-stream"), Some("a.MD")),
            "text/markdown"
        );
        assert_eq!(refine_mime(Some(""), Some("a.txt")), "text/plain");
        assert_eq!(refine_mime(Some("unknown"), Some("t.csv")), "text/csv");
        assert_eq!(refine_mime(Some("text/plain"), Some("t.csv")), "text/plain");
        assert_eq!(refine_mime(None, Some("x.bin")), "");
        assert_eq!(
            refine_mime(Some("application/octet-stream"), Some("x.bin")),
            "application/octet-stream"
        );
    }

    #[test]
    fn binary_formats_are_detected_by_magic() {
        assert_eq!(
            sniff(Some("a.bin"), None, b"%PDF-1.4\n").kind,
            InputKind::Pdf
        );
        assert_eq!(sniff(None, None, PNG).kind, InputKind::Image);
        assert_eq!(
            sniff(None, None, &[0xFF, 0xD8, 0xFF, 0xE0]).mime,
            "image/jpeg"
        );
        assert_eq!(sniff(None, None, b"RIFF\0\0\0\0WAVEfmt ").mime, "audio/wav");
        assert_eq!(sniff(None, None, b"ID3\x04\0\0").kind, InputKind::Audio);
        assert_eq!(
            sniff(None, None, b"\0\0\0\x20ftypM4A \0\0").mime,
            "audio/mp4"
        );
        assert_eq!(
            sniff(None, None, &[0x1A, 0x45, 0xDF, 0xA3, 1]).mime,
            "audio/webm"
        );
    }

    #[test]
    fn mislabelled_content_is_flagged() {
        let s = sniff(Some("notes.txt"), Some("text/plain"), PNG);
        assert_eq!(s.kind, InputKind::Image);
        assert!(s.mismatch);
        let ok = sniff(Some("pic.png"), Some("image/png"), PNG);
        assert!(!ok.mismatch);
    }

    #[test]
    fn text_formats_follow_mime_then_extension() {
        assert_eq!(sniff(Some("a.md"), None, b"# hi").kind, InputKind::Markdown);
        assert_eq!(
            sniff(Some("a.csv"), Some("application/octet-stream"), b"a,b").kind,
            InputKind::Csv
        );
        assert_eq!(
            sniff(Some("a.csv"), Some("text/plain"), b"a,b").kind,
            InputKind::Text
        );
        let t = sniff(None, None, "héllo".as_bytes());
        assert_eq!((t.kind, t.mime.as_str()), (InputKind::Text, "text/plain"));
    }

    #[test]
    fn pcb_by_extension_and_header() {
        assert_eq!(
            sniff(Some("b.kicad_pcb"), None, b"(kicad_pcb)").kind,
            InputKind::Pcb
        );
        assert_eq!(sniff(Some("top.GTL"), None, b"G04*").kind, InputKind::Pcb);
        assert_eq!(
            sniff(Some("noext"), None, b"  (kicad_pcb (version 1))").kind,
            InputKind::Pcb
        );
    }

    #[test]
    fn binary_garbage_and_foreign_zips_are_unknown() {
        assert_eq!(
            sniff(Some("x.dat"), None, &[0, 1, 2, 3, 0xFE, 0]).kind,
            InputKind::Unknown
        );
        assert_eq!(
            sniff(Some("x.zip"), None, b"PK\x03\x04junk").kind,
            InputKind::Unknown
        );
        assert_eq!(
            sniff(None, None, &[0xC3, 0x28, 0x41]).kind,
            InputKind::Unknown
        );
    }

    #[test]
    fn truncated_utf8_tail_is_still_text() {
        let mut b = "ab".as_bytes().to_vec();
        b.push(0xC3);
        assert_eq!(sniff(None, None, &b).kind, InputKind::Text);
    }
}
