//! Document export and deliverables.
//!
//! Ported from the TypeScript `export.service.ts`, `export-latex.service.ts`,
//! `export-jupyter.service.ts` and `deliverable.service.ts` (see `docs/rust-core/export.md`).
//!
//! The public surface is deliberately small:
//!
//! - [`ExportFormat`]: the six supported output formats.
//! - [`Exporter`]: one implementation per format (`MarkdownExporter`, `PdfExporter`, ...).
//! - [`export`] / [`export_with`]: render an [`ExportDoc`] to bytes.
//! - [`bundle`]: zip several rendered documents into one archive.
//! - [`deliverable`]: stage deliverables for a stored document (record + bytes).
//!
//! Everything is pure Rust and deterministic (same input, same bytes), so outputs can be golden
//! tested. No network, no system fonts, no external tools.

pub mod blocks;
pub mod bundle;
pub mod deliverable;
pub mod docx;
pub mod jupyter;
pub mod latex;
pub mod pdf;
pub mod plain;

use std::fmt;
use std::str::FromStr;

use crate::error::{Error, Result};
use crate::model::Document;

pub use bundle::{bundle, BundleEntry};
pub use deliverable::{Deliverable, DeliverableType, SqliteDeliverables};
pub use latex::LatexTheme;

/// Output format of an export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ExportFormat {
    /// Original Markdown, unchanged.
    Markdown,
    /// Plain text (Markdown syntax stripped, title underlined).
    Txt,
    /// PDF 1.4 with the standard Helvetica fonts (Latin-1 text only, see [`pdf`]).
    Pdf,
    /// Office Open XML word-processing document.
    Docx,
    /// LaTeX source (`ieee`, `acm`, `apa` or `plain` preamble).
    Latex,
    /// Jupyter notebook (`nbformat` 4.5 JSON).
    Jupyter,
}

impl ExportFormat {
    /// Every format, in documentation order.
    pub const ALL: &'static [Self] = &[
        Self::Markdown,
        Self::Txt,
        Self::Pdf,
        Self::Docx,
        Self::Latex,
        Self::Jupyter,
    ];

    /// Canonical lowercase name (`markdown`, `txt`, `pdf`, `docx`, `latex`, `jupyter`).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Markdown => "markdown",
            Self::Txt => "txt",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Latex => "latex",
            Self::Jupyter => "jupyter",
        }
    }

    /// File extension without the dot, matching the TS download filenames.
    #[must_use]
    pub fn extension(self) -> &'static str {
        match self {
            Self::Markdown => "md",
            Self::Txt => "txt",
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Latex => "tex",
            Self::Jupyter => "ipynb",
        }
    }

    /// MIME type, matching the TS `Content-Type` headers.
    #[must_use]
    pub fn mime(self) -> &'static str {
        match self {
            Self::Markdown => "text/markdown; charset=utf-8",
            Self::Txt => "text/plain; charset=utf-8",
            Self::Pdf => "application/pdf",
            Self::Docx => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            Self::Latex => "application/x-tex; charset=utf-8",
            Self::Jupyter => "application/x-ipynb+json",
        }
    }
}

impl fmt::Display for ExportFormat {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ExportFormat {
    type Err = Error;

    /// Accepts the canonical names plus the common aliases `md`, `text`, `tex`, `ipynb`.
    fn from_str(s: &str) -> Result<Self> {
        match s.to_ascii_lowercase().as_str() {
            "markdown" | "md" => Ok(Self::Markdown),
            "txt" | "text" => Ok(Self::Txt),
            "pdf" => Ok(Self::Pdf),
            "docx" => Ok(Self::Docx),
            "latex" | "tex" => Ok(Self::Latex),
            "jupyter" | "ipynb" => Ok(Self::Jupyter),
            other => Err(Error::Invalid(format!(
                "unknown export format \"{other}\"; expected one of: markdown, txt, pdf, docx, latex, jupyter"
            ))),
        }
    }
}

/// The input of an export: a title and Markdown content.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportDoc {
    /// Document title.
    pub title: String,
    /// Markdown body.
    pub content: String,
}

impl ExportDoc {
    /// Build from parts.
    #[must_use]
    pub fn new(title: impl Into<String>, content: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            content: content.into(),
        }
    }

    /// Download file name (`<safe title>.<ext>`) for a format.
    #[must_use]
    pub fn file_name(&self, format: ExportFormat) -> String {
        format!("{}.{}", safe_file_stem(&self.title), format.extension())
    }
}

impl From<&Document> for ExportDoc {
    fn from(d: &Document) -> Self {
        Self::new(d.title.clone(), d.content.clone())
    }
}

/// Per-export options. Only LaTeX has any today.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExportOptions {
    /// LaTeX preamble theme (default [`LatexTheme::Plain`]).
    pub latex_theme: LatexTheme,
}

/// One exporter per [`ExportFormat`].
pub trait Exporter {
    /// The format this exporter produces.
    fn format(&self) -> ExportFormat;
    /// Render `doc` to bytes.
    fn export(&self, doc: &ExportDoc, opts: &ExportOptions) -> Result<Vec<u8>>;
}

/// Pass-through Markdown exporter (TS `toMarkdown`).
#[derive(Debug, Clone, Copy, Default)]
pub struct MarkdownExporter;
/// Plain-text exporter (TS `toPlainText`).
#[derive(Debug, Clone, Copy, Default)]
pub struct TxtExporter;
/// PDF exporter (TS `toPdf`).
#[derive(Debug, Clone, Copy, Default)]
pub struct PdfExporter;
/// DOCX exporter (TS `toDocx`).
#[derive(Debug, Clone, Copy, Default)]
pub struct DocxExporter;
/// LaTeX exporter (TS `toLatex`).
#[derive(Debug, Clone, Copy, Default)]
pub struct LatexExporter;
/// Jupyter notebook exporter (TS `toJupyterNotebook`).
#[derive(Debug, Clone, Copy, Default)]
pub struct JupyterExporter;

impl Exporter for MarkdownExporter {
    fn format(&self) -> ExportFormat {
        ExportFormat::Markdown
    }
    fn export(&self, doc: &ExportDoc, _: &ExportOptions) -> Result<Vec<u8>> {
        Ok(doc.content.clone().into_bytes())
    }
}

impl Exporter for TxtExporter {
    fn format(&self) -> ExportFormat {
        ExportFormat::Txt
    }
    fn export(&self, doc: &ExportDoc, _: &ExportOptions) -> Result<Vec<u8>> {
        Ok(plain::to_plain_text(&doc.title, &doc.content).into_bytes())
    }
}

impl Exporter for PdfExporter {
    fn format(&self) -> ExportFormat {
        ExportFormat::Pdf
    }
    fn export(&self, doc: &ExportDoc, _: &ExportOptions) -> Result<Vec<u8>> {
        Ok(pdf::to_pdf(&doc.title, &doc.content))
    }
}

impl Exporter for DocxExporter {
    fn format(&self) -> ExportFormat {
        ExportFormat::Docx
    }
    fn export(&self, doc: &ExportDoc, _: &ExportOptions) -> Result<Vec<u8>> {
        docx::to_docx(&doc.title, &doc.content)
    }
}

impl Exporter for LatexExporter {
    fn format(&self) -> ExportFormat {
        ExportFormat::Latex
    }
    fn export(&self, doc: &ExportDoc, opts: &ExportOptions) -> Result<Vec<u8>> {
        Ok(latex::markdown_to_latex(&doc.content, opts.latex_theme).into_bytes())
    }
}

impl Exporter for JupyterExporter {
    fn format(&self) -> ExportFormat {
        ExportFormat::Jupyter
    }
    fn export(&self, doc: &ExportDoc, _: &ExportOptions) -> Result<Vec<u8>> {
        jupyter::to_notebook_bytes(&doc.content, &doc.title)
    }
}

/// The built-in exporter for a format.
#[must_use]
pub fn exporter_for(format: ExportFormat) -> &'static dyn Exporter {
    match format {
        ExportFormat::Markdown => &MarkdownExporter,
        ExportFormat::Txt => &TxtExporter,
        ExportFormat::Pdf => &PdfExporter,
        ExportFormat::Docx => &DocxExporter,
        ExportFormat::Latex => &LatexExporter,
        ExportFormat::Jupyter => &JupyterExporter,
    }
}

/// Render `doc` as `format` with default options.
pub fn export(doc: &ExportDoc, format: ExportFormat) -> Result<Vec<u8>> {
    export_with(doc, format, &ExportOptions::default())
}

/// Render `doc` as `format` with explicit options.
pub fn export_with(doc: &ExportDoc, format: ExportFormat, opts: &ExportOptions) -> Result<Vec<u8>> {
    exporter_for(format).export(doc, opts)
}

/// File-name stem used by the TS routes: every char outside `[A-Za-z0-9-_]` becomes `_`.
/// Chars are replaced one for one, so `"a b.c"` becomes `"a_b_c"`. An empty title yields `untitled`.
#[must_use]
pub fn safe_file_stem(title: &str) -> String {
    let s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() {
        "untitled".to_string()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_parse_roundtrip_and_aliases() {
        for f in ExportFormat::ALL {
            assert_eq!(f.as_str().parse::<ExportFormat>().unwrap(), *f);
        }
        assert_eq!(
            "MD".parse::<ExportFormat>().unwrap(),
            ExportFormat::Markdown
        );
        assert_eq!(
            "ipynb".parse::<ExportFormat>().unwrap(),
            ExportFormat::Jupyter
        );
        assert!("rtf".parse::<ExportFormat>().is_err());
    }

    #[test]
    fn safe_stem_matches_ts_regex() {
        assert_eq!(safe_file_stem("My Doc: v2.0"), "My_Doc__v2_0");
        assert_eq!(safe_file_stem(""), "untitled");
        assert_eq!(safe_file_stem("a-b_c"), "a-b_c");
    }

    #[test]
    fn file_name_uses_extension() {
        let d = ExportDoc::new("Q3 Plan", "x");
        assert_eq!(d.file_name(ExportFormat::Latex), "Q3_Plan.tex");
        assert_eq!(d.file_name(ExportFormat::Jupyter), "Q3_Plan.ipynb");
    }

    #[test]
    fn every_format_exports_non_empty_bytes() {
        let d = ExportDoc::new("T", "# H\n\nbody **b**\n");
        for f in ExportFormat::ALL {
            assert!(!export(&d, *f).unwrap().is_empty(), "{f}");
            assert_eq!(exporter_for(*f).format(), *f);
        }
    }

    #[test]
    fn markdown_is_passthrough() {
        let d = ExportDoc::new("T", "# keep *as is*\n");
        assert_eq!(
            export(&d, ExportFormat::Markdown).unwrap(),
            b"# keep *as is*\n"
        );
    }
}
