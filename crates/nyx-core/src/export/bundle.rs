//! Zip helpers: the deliverable bundle (several rendered documents in one archive) and the small
//! writer used by the DOCX exporter.
//!
//! Archives are deterministic: entries are written in the order given, with the fixed DOS epoch
//! timestamp (the `zip` crate's `time` feature is off) and deflate compression.

use std::io::{Cursor, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::{export_with, ExportDoc, ExportFormat, ExportOptions};
use crate::error::{Error, Result};

/// One file inside a bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleEntry {
    /// Path inside the archive (forward slashes, no leading slash).
    pub name: String,
    /// File bytes.
    pub data: Vec<u8>,
}

impl BundleEntry {
    /// New entry.
    #[must_use]
    pub fn new(name: impl Into<String>, data: Vec<u8>) -> Self {
        Self {
            name: name.into(),
            data,
        }
    }
}

pub(crate) fn zip_err(e: zip::result::ZipError) -> Error {
    Error::Io(std::io::Error::from(e))
}

/// Validate an archive entry name: relative, `/` separated, no `..`, not empty.
fn check_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.starts_with('/')
        || name.contains('\\')
        || name.split('/').any(|p| p == ".." || p.is_empty())
    {
        return Err(Error::Invalid(format!(
            "invalid bundle entry name \"{name}\""
        )));
    }
    Ok(())
}

/// Write entries into a new zip archive.
///
/// Duplicate names are rejected with [`Error::Invalid`].
pub fn bundle(entries: &[BundleEntry]) -> Result<Vec<u8>> {
    let mut seen = std::collections::HashSet::new();
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for e in entries {
        check_name(&e.name)?;
        if !seen.insert(e.name.as_str()) {
            return Err(Error::Invalid(format!(
                "duplicate bundle entry \"{}\"",
                e.name
            )));
        }
        zip.start_file(&e.name, opts).map_err(zip_err)?;
        zip.write_all(&e.data)?;
    }
    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

/// Export several documents, each in each of `formats`, into one zip.
///
/// Entries are named `<safe title>.<ext>`; when two documents share a safe title (or a title
/// collides across formats) later ones get `_2`, `_3`, ... before the extension. A
/// `manifest.json` listing every file is appended.
pub fn bundle_documents(
    docs: &[ExportDoc],
    formats: &[ExportFormat],
    opts: &ExportOptions,
) -> Result<Vec<u8>> {
    if docs.is_empty() || formats.is_empty() {
        return Err(Error::Invalid(
            "a bundle needs at least one document and one format".into(),
        ));
    }
    let mut used = std::collections::HashSet::new();
    let mut entries = Vec::new();
    let mut manifest = Vec::new();
    for d in docs {
        for f in formats {
            let stem = super::safe_file_stem(&d.title);
            let mut name = format!("{stem}.{}", f.extension());
            let mut n = 2;
            while !used.insert(name.clone()) {
                name = format!("{stem}_{n}.{}", f.extension());
                n += 1;
            }
            let data = export_with(d, *f, opts)?;
            manifest.push(serde_json::json!({
                "file": name,
                "title": d.title,
                "format": f.as_str(),
                "bytes": data.len(),
            }));
            entries.push(BundleEntry::new(name, data));
        }
    }
    entries.push(BundleEntry::new(
        "manifest.json",
        serde_json::to_vec_pretty(&serde_json::json!({ "files": manifest }))?,
    ));
    bundle(&entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn names(bytes: &[u8]) -> Vec<String> {
        let mut z = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..z.len())
            .map(|i| z.by_index(i).unwrap().name().unwrap().to_string())
            .collect()
    }

    #[test]
    fn roundtrip_and_determinism() {
        let e = vec![
            BundleEntry::new("a.txt", b"hello".to_vec()),
            BundleEntry::new("dir/b.txt", b"world".to_vec()),
        ];
        let a = bundle(&e).unwrap();
        assert_eq!(a, bundle(&e).unwrap());
        assert_eq!(names(&a), ["a.txt", "dir/b.txt"]);
        let mut z = zip::ZipArchive::new(Cursor::new(&a)).unwrap();
        let mut s = String::new();
        z.by_name("dir/b.txt")
            .unwrap()
            .read_to_string(&mut s)
            .unwrap();
        assert_eq!(s, "world");
    }

    #[test]
    fn rejects_bad_names() {
        for n in ["", "/abs", "../x", "a//b", "a\\b"] {
            assert!(bundle(&[BundleEntry::new(n, vec![])]).is_err(), "{n}");
        }
        let dup = [BundleEntry::new("a", vec![]), BundleEntry::new("a", vec![])];
        assert!(bundle(&dup).is_err());
    }

    #[test]
    fn documents_bundle_dedupes_names_and_has_manifest() {
        let docs = [ExportDoc::new("Plan", "# A"), ExportDoc::new("Plan", "# B")];
        let z = bundle_documents(
            &docs,
            &[ExportFormat::Markdown, ExportFormat::Txt],
            &ExportOptions::default(),
        )
        .unwrap();
        assert_eq!(
            names(&z),
            [
                "Plan.md",
                "Plan.txt",
                "Plan_2.md",
                "Plan_2.txt",
                "manifest.json"
            ]
        );
        assert!(bundle_documents(&[], &[ExportFormat::Pdf], &ExportOptions::default()).is_err());
    }
}
