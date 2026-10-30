//! Deliverables (TS `deliverable.service.ts` and `routes/deliverables.ts`).
//!
//! A deliverable is "document X rendered as type T for lifecycle stage S". The TS service rendered
//! nothing itself: it computed a file name and a placeholder `fileUrl` and inserted a row ("in
//! production this would upload to object storage"). The Rust version keeps the row and the
//! naming, and also returns the rendered bytes so a caller (CLI, MCP, desktop) can write them
//! wherever it likes. Bytes are not persisted; `file_url` stays a logical reference.
//!
//! Differences from TS, deliberate:
//!
//! - the TS `report` type created a row with no content; here it renders a real Markdown report
//!   (title, stage, generation-independent header, then the document body).
//! - the TS route only accepted `pdf | markdown | report` although the service also handled
//!   `jupyter`; all types are accepted here, plus `docx`, `latex` and `txt`.
//! - unknown documents are [`Error::NotFound`] instead of `null`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::{json, Value};

use super::bundle::bundle_documents;
use super::{export_with, safe_file_stem, ExportDoc, ExportFormat, ExportOptions};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, string_enum, Document, Id, Timestamp};
use crate::store::{db_err, json_col_opt, DocumentRepo, SqliteDocuments};

string_enum! {
    /// What a deliverable is rendered as.
    DeliverableType {
        /// PDF document.
        Pdf => "pdf",
        /// Markdown source.
        Markdown => "markdown",
        /// Markdown stage report (title, stage, body).
        Report => "report",
        /// Jupyter notebook.
        Jupyter => "jupyter",
        /// Word document.
        Docx => "docx",
        /// LaTeX source.
        Latex => "latex",
        /// Plain text.
        Txt => "txt",
    }
}

impl DeliverableType {
    /// The export format that renders this deliverable.
    #[must_use]
    pub fn format(self) -> ExportFormat {
        match self {
            Self::Pdf => ExportFormat::Pdf,
            Self::Markdown | Self::Report => ExportFormat::Markdown,
            Self::Jupyter => ExportFormat::Jupyter,
            Self::Docx => ExportFormat::Docx,
            Self::Latex => ExportFormat::Latex,
            Self::Txt => ExportFormat::Txt,
        }
    }
}

/// A recorded deliverable.
#[derive(Debug, Clone, PartialEq)]
pub struct Deliverable {
    /// Id.
    pub id: Id,
    /// Source document.
    pub document_id: Id,
    /// Lifecycle stage the deliverable was generated for (free text).
    pub stage: String,
    /// Kind.
    pub kind: DeliverableType,
    /// File name, e.g. `My_Doc_review.pdf`.
    pub file_name: String,
    /// Logical reference `/deliverables/<document_id>/<file_name>`.
    pub file_url: String,
    /// Generation time (unix ms).
    pub generated_at: Timestamp,
    /// Extra data (`{"title": ...}`).
    pub metadata: Option<Value>,
}

/// A deliverable record together with its rendered bytes.
#[derive(Debug, Clone, PartialEq)]
pub struct GeneratedDeliverable {
    /// The stored row.
    pub record: Deliverable,
    /// The rendered file.
    pub bytes: Vec<u8>,
}

/// Deliverable file name: `<safe title>_<stage>.<ext>` (`<safe title>_<stage>_report.md` for
/// reports). The stage is sanitised like the title so it cannot smuggle path separators.
#[must_use]
pub fn deliverable_file_name(title: &str, stage: &str, kind: DeliverableType) -> String {
    let t = safe_file_stem(title);
    let s = safe_file_stem(stage);
    match kind {
        DeliverableType::Report => format!("{t}_{s}_report.md"),
        k => format!("{t}_{s}.{}", k.format().extension()),
    }
}

/// Markdown body of a `report` deliverable.
#[must_use]
pub fn report_markdown(title: &str, stage: &str, content: &str) -> String {
    format!("# {title}\n\n**Stage:** {stage}\n\n---\n\n{content}\n")
}

/// Render a deliverable from an in-memory document (no database). Returns `(file_name, bytes)`.
pub fn render_deliverable(
    doc: &ExportDoc,
    stage: &str,
    kind: DeliverableType,
    opts: &ExportOptions,
) -> Result<(String, Vec<u8>)> {
    if stage.trim().is_empty() {
        return Err(Error::Invalid("stage is required".into()));
    }
    let file_name = deliverable_file_name(&doc.title, stage, kind);
    let bytes = if kind == DeliverableType::Report {
        report_markdown(&doc.title, stage, &doc.content).into_bytes()
    } else {
        export_with(doc, kind.format(), opts)?
    };
    Ok((file_name, bytes))
}

/// Deliverable persistence.
pub trait DeliverableRepo {
    /// Insert a row.
    fn insert(&self, d: &Deliverable) -> Result<()>;
    /// Fetch by id (TS `getDeliverable`).
    fn get(&self, id: &str) -> Result<Deliverable>;
    /// Deliverables of a document, oldest first (TS `listDeliverables`).
    fn list_by_document(&self, document_id: &str) -> Result<Vec<Deliverable>>;
}

/// SQLite [`DeliverableRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteDeliverables<'c>(&'c Connection);

impl<'c> SqliteDeliverables<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Render and record a deliverable for a stored document (TS `generateDeliverable`).
    ///
    /// Fails with [`Error::NotFound`] when the document does not exist and [`Error::Invalid`] on a
    /// blank stage. Call inside a transaction if the surrounding work must be atomic.
    pub fn generate(
        &self,
        document_id: &str,
        stage: &str,
        kind: DeliverableType,
        opts: &ExportOptions,
    ) -> Result<GeneratedDeliverable> {
        let doc = SqliteDocuments::new(self.0).get(document_id)?;
        let (file_name, bytes) = render_deliverable(&ExportDoc::from(&doc), stage, kind, opts)?;
        let record = Deliverable {
            id: new_id(),
            document_id: doc.id.clone(),
            stage: stage.to_string(),
            kind,
            file_url: format!("/deliverables/{}/{file_name}", doc.id),
            file_name,
            generated_at: now_ms(),
            metadata: Some(json!({ "title": doc.title })),
        };
        self.insert(&record)?;
        Ok(GeneratedDeliverable { record, bytes })
    }
}

fn row(r: &Row<'_>) -> rusqlite::Result<Deliverable> {
    Ok(Deliverable {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        stage: r.get("stage")?,
        kind: r.get("type")?,
        file_name: r.get("file_name")?,
        file_url: r.get("file_url")?,
        generated_at: r.get("generated_at")?,
        metadata: json_col_opt(r, "metadata")?,
    })
}

impl DeliverableRepo for SqliteDeliverables<'_> {
    fn insert(&self, d: &Deliverable) -> Result<()> {
        let meta = d.metadata.as_ref().map(Value::to_string);
        self.0
            .execute(
                "INSERT INTO deliverables
                 (id, document_id, stage, type, file_name, file_url, generated_at, metadata)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    d.id,
                    d.document_id,
                    d.stage,
                    d.kind,
                    d.file_name,
                    d.file_url,
                    d.generated_at,
                    meta
                ],
            )
            .map_err(db_err)?;
        Ok(())
    }

    fn get(&self, id: &str) -> Result<Deliverable> {
        self.0
            .query_row("SELECT * FROM deliverables WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("deliverable {id}")))
    }

    fn list_by_document(&self, document_id: &str) -> Result<Vec<Deliverable>> {
        let mut s = self.0.prepare(
            "SELECT * FROM deliverables WHERE document_id = ?1 ORDER BY generated_at, rowid",
        )?;
        let rows = s.query_map([document_id], row)?;
        Ok(rows.collect::<std::result::Result<_, _>>()?)
    }
}

/// Zip several stored documents in several formats (see [`bundle_documents`]).
///
/// Missing ids fail the whole call with [`Error::NotFound`].
pub fn bundle_stored_documents(
    conn: &Connection,
    document_ids: &[&str],
    formats: &[ExportFormat],
    opts: &ExportOptions,
) -> Result<Vec<u8>> {
    let repo = SqliteDocuments::new(conn);
    let docs: Vec<Document> = document_ids
        .iter()
        .map(|id| repo.get(id))
        .collect::<Result<_>>()?;
    let docs: Vec<ExportDoc> = docs.iter().map(ExportDoc::from).collect();
    bundle_documents(&docs, formats, opts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_match_ts() {
        use DeliverableType::*;
        assert_eq!(
            deliverable_file_name("My Doc!", "review", Pdf),
            "My_Doc__review.pdf"
        );
        assert_eq!(
            deliverable_file_name("My Doc", "draft", Markdown),
            "My_Doc_draft.md"
        );
        assert_eq!(
            deliverable_file_name("My Doc", "draft", Report),
            "My_Doc_draft_report.md"
        );
        assert_eq!(deliverable_file_name("X", "s", Jupyter), "X_s.ipynb");
        assert_eq!(deliverable_file_name("X", "../s", Latex), "X____s.tex");
    }

    #[test]
    fn type_parsing() {
        assert_eq!(
            "report".parse::<DeliverableType>().unwrap(),
            DeliverableType::Report
        );
        assert!("zip".parse::<DeliverableType>().is_err());
        for t in DeliverableType::ALL {
            assert_eq!(t.as_str().parse::<DeliverableType>().unwrap(), *t);
        }
    }

    #[test]
    fn render_every_type() {
        let d = ExportDoc::new("T", "# H\n\nbody");
        for t in DeliverableType::ALL {
            let (name, bytes) =
                render_deliverable(&d, "stage", *t, &ExportOptions::default()).unwrap();
            assert!(!bytes.is_empty() && name.starts_with("T_stage"), "{t}");
        }
        let (_, report) = render_deliverable(
            &d,
            "review",
            DeliverableType::Report,
            &ExportOptions::default(),
        )
        .unwrap();
        assert_eq!(
            String::from_utf8(report).unwrap(),
            "# T\n\n**Stage:** review\n\n---\n\n# H\n\nbody\n"
        );
    }

    #[test]
    fn blank_stage_rejected() {
        let d = ExportDoc::new("T", "x");
        assert!(
            render_deliverable(&d, "  ", DeliverableType::Pdf, &ExportOptions::default()).is_err()
        );
    }
}
