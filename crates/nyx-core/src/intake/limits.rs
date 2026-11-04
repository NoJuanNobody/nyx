//! Size limits and safety checks shared by every intake path.
//!
//! The TypeScript enforced a 10 MB upload cap (`routes/upload.ts`) and a 25 MB audio cap
//! (`transcription.service.ts`). This module keeps those numbers and adds the checks the Rust
//! desktop app needs because files now come from the local disk: file-name sanitising, path
//! traversal rejection, and zip-bomb limits used by the `.docx` reader.

use std::path::{Component, Path, PathBuf};

use super::kind::InputKind;
use crate::error::{Error, Result};

const MIB: u64 = 1024 * 1024;

/// Intake limits. [`Limits::default`] mirrors the TypeScript values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Limits {
    /// Maximum size of documents, text, images and PCB files (TS: 10 MB).
    pub max_upload_bytes: u64,
    /// Maximum size of audio files (TS: 25 MB).
    pub max_audio_bytes: u64,
    /// Maximum number of entries in a `.docx` zip.
    pub max_zip_entries: usize,
    /// Maximum bytes read from a single zip entry (the real, streamed size, not the header value).
    pub max_zip_entry_bytes: u64,
    /// Maximum total of the declared uncompressed sizes across a zip.
    pub max_zip_total_bytes: u64,
    /// Maximum uncompressed/compressed ratio of one entry above `ratio_floor_bytes`.
    pub max_zip_ratio: u64,
    /// Entries smaller than this are exempt from the ratio check.
    pub ratio_floor_bytes: u64,
    /// Maximum decompressed content stream size per PDF page.
    pub max_pdf_page_bytes: usize,
    /// Maximum number of PDF pages read.
    pub max_pdf_pages: usize,
    /// Maximum characters of extracted text kept from any parser.
    pub max_extracted_chars: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_upload_bytes: 10 * MIB,
            max_audio_bytes: 25 * MIB,
            max_zip_entries: 2_000,
            max_zip_entry_bytes: 32 * MIB,
            max_zip_total_bytes: 128 * MIB,
            max_zip_ratio: 200,
            ratio_floor_bytes: MIB,
            max_pdf_page_bytes: 16 * 1024 * 1024,
            max_pdf_pages: 2_000,
            max_extracted_chars: 5_000_000,
        }
    }
}

impl Limits {
    /// Size cap that applies to a kind.
    #[must_use]
    pub fn max_bytes(&self, kind: InputKind) -> u64 {
        if kind == InputKind::Audio {
            self.max_audio_bytes
        } else {
            self.max_upload_bytes
        }
    }

    /// Reject empty input and input over the cap for `kind` (TS: "Uploaded file is empty.").
    pub fn check_size(&self, kind: InputKind, len: usize) -> Result<()> {
        if len == 0 {
            return Err(Error::Invalid("Uploaded file is empty.".into()));
        }
        let max = self.max_bytes(kind);
        if len as u64 > max {
            return Err(Error::Invalid(format!(
                "File too large. Maximum size is {}MB, got {}MB.",
                max / MIB,
                (len as u64).div_ceil(MIB)
            )));
        }
        Ok(())
    }

    /// Truncate extracted text to [`Limits::max_extracted_chars`]; returns whether it was cut.
    pub(crate) fn clamp_text(&self, text: &mut String) -> bool {
        match text.char_indices().nth(self.max_extracted_chars) {
            Some((i, _)) => {
                text.truncate(i);
                true
            }
            None => false,
        }
    }
}

/// Reduce an untrusted client-supplied file name to a safe base name.
///
/// Keeps only the last path component (both `/` and `\` separate components), drops control
/// characters, and rejects names that are empty, `.`/`..`, or longer than 255 bytes after
/// cleaning. Never returns anything containing a path separator.
pub fn sanitize_filename(name: &str) -> Result<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err(Error::Invalid(format!("unsafe file name '{name}'")));
    }
    if cleaned.len() > 255 {
        return Err(Error::Invalid("file name too long".into()));
    }
    Ok(cleaned)
}

/// Join an untrusted relative path under `base`, refusing absolute paths, `..`, and drive/UNC
/// prefixes. Purely lexical (does not touch the filesystem, so it also works for files that do
/// not exist yet); callers that follow symlinks should canonicalise `base` themselves.
pub fn safe_join(base: &Path, relative: &str) -> Result<PathBuf> {
    if relative.contains('\0') || relative.contains('\\') && relative.contains("..") {
        return Err(Error::Invalid(format!("unsafe path '{relative}'")));
    }
    let mut out = base.to_path_buf();
    let mut any = false;
    for comp in Path::new(relative).components() {
        match comp {
            Component::Normal(c) => {
                out.push(c);
                any = true;
            }
            Component::CurDir => {}
            _ => return Err(Error::Invalid(format!("unsafe path '{relative}'"))),
        }
    }
    if any {
        Ok(out)
    } else {
        Err(Error::Invalid("empty path".into()))
    }
}

/// Reject archive entry names that would escape an extraction root (zip-slip) or are otherwise
/// suspicious. We never extract to disk, but a hostile name is a strong signal, so the archive
/// is refused.
pub fn check_entry_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name.contains('\0')
        || name.starts_with('/')
        || name.starts_with('\\')
        || name.split(['/', '\\']).any(|p| p == "..")
        || name.as_bytes().get(1) == Some(&b':');
    if bad {
        Err(Error::Invalid(format!(
            "archive entry has an unsafe path: {name:?}"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn sizes() {
        let l = Limits::default();
        assert!(l.check_size(InputKind::Text, 0).is_err());
        assert!(l.check_size(InputKind::Text, 10 * 1024 * 1024).is_ok());
        assert!(l.check_size(InputKind::Text, 10 * 1024 * 1024 + 1).is_err());
        assert!(l.check_size(InputKind::Audio, 20 * 1024 * 1024).is_ok());
        assert!(l
            .check_size(InputKind::Audio, 25 * 1024 * 1024 + 1)
            .is_err());
    }

    #[test]
    fn filenames_lose_their_directories() {
        assert_eq!(sanitize_filename("../../etc/passwd").unwrap(), "passwd");
        assert_eq!(
            sanitize_filename("C:\\Users\\a\\notes.txt").unwrap(),
            "notes.txt"
        );
        assert_eq!(sanitize_filename("a\0b.txt").unwrap(), "ab.txt");
        assert!(sanitize_filename("..").is_err());
        assert!(sanitize_filename("dir/").is_err());
        assert!(sanitize_filename("").is_err());
        assert!(sanitize_filename(&"x".repeat(300)).is_err());
    }

    #[test]
    fn safe_join_rejects_escapes() {
        let b = Path::new("/data/uploads");
        assert_eq!(safe_join(b, "a/b.txt").unwrap(), b.join("a/b.txt"));
        assert_eq!(safe_join(b, "./a.txt").unwrap(), b.join("a.txt"));
        for bad in [
            "../x",
            "a/../../x",
            "/etc/passwd",
            "a\\..\\b",
            "",
            ".",
            "a\0b",
        ] {
            assert!(safe_join(b, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn entry_names() {
        assert!(check_entry_name("word/document.xml").is_ok());
        for bad in ["../evil", "a/../../b", "/abs", "C:/x", "", "a\\..\\b"] {
            assert!(check_entry_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn clamp() {
        let l = Limits {
            max_extracted_chars: 3,
            ..Limits::default()
        };
        let mut s = "héllo".to_string();
        assert!(l.clamp_text(&mut s));
        assert_eq!(s, "hél");
        assert!(!l.clamp_text(&mut s));
    }
}
