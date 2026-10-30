//! Export and deliverables. Source: `nyx_core::export`. All tools are new relative to the TS MCP
//! server (export lived in the HTTP routes and the CLI).

use std::str::FromStr;

use base64::Engine as _;
use nyx_core::export::bundle::bundle_documents;
use nyx_core::export::{
    export_with, DeliverableType, ExportDoc, ExportFormat, ExportOptions, LatexTheme,
    SqliteDeliverables,
};
use nyx_core::store::{DocumentRepo, SqliteDocuments};
use serde_json::{json, Value};

use super::id;
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{strict, ToolSpec};
use crate::Cx;

const FORMATS: [&str; 6] = ["markdown", "txt", "pdf", "docx", "latex", "jupyter"];

fn opts(a: &Args<'_>) -> AppResult<ExportOptions> {
    let latex_theme = match a.opt_str("latex_theme") {
        Some(t) => LatexTheme::from_str(t)?,
        None => LatexTheme::default(),
    };
    Ok(ExportOptions { latex_theme })
}

fn is_text(f: ExportFormat) -> bool {
    !matches!(f, ExportFormat::Pdf | ExportFormat::Docx)
}

/// Deliver bytes: write inside the workspace jail when `path` is given, else inline (text as a
/// string, binary as base64).
fn deliver(cx: &Cx<'_>, a: &Args<'_>, bytes: &[u8], text: bool, extra: Value) -> AppResult<Value> {
    let mut out = extra;
    out["bytes"] = json!(bytes.len());
    if let Some(p) = a.opt_str("path") {
        let jail = cx
            .app
            .jail
            .as_ref()
            .ok_or_else(|| AppError::not_configured("no workspace root available for file output"))?;
        let written = jail.write(p, bytes)?;
        out["path"] = json!(jail.display_relative(&written));
    } else if text {
        out["content"] = json!(String::from_utf8_lossy(bytes));
    } else {
        out["base64"] = json!(base64::engine::general_purpose::STANDARD.encode(bytes));
    }
    Ok(out)
}

fn export_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let format = ExportFormat::from_str(a.opt_str("format").unwrap_or("markdown"))?;
    let doc = SqliteDocuments::new(cx.conn()).get(d)?;
    if doc.deleted_at.is_some() {
        return Err(AppError::not_found(format!("document {d} is deleted")));
    }
    let ed = ExportDoc::from(&doc);
    let bytes = export_with(&ed, format, &opts(a)?)?;
    deliver(
        cx,
        a,
        &bytes,
        is_text(format),
        json!({"documentId": doc.id, "format": format.as_str(), "mime": format.mime(), "fileName": ed.file_name(format)}),
    )
}

fn export_bundle(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let ids = a.str_list("document_ids");
    let formats = a
        .str_list("formats")
        .iter()
        .map(|f| ExportFormat::from_str(f).map_err(AppError::from))
        .collect::<AppResult<Vec<_>>>()?;
    let repo = SqliteDocuments::new(cx.conn());
    let mut docs = Vec::new();
    for i in &ids {
        id("document_ids", i)?;
        docs.push(ExportDoc::from(&repo.get(i)?));
    }
    let bytes = bundle_documents(&docs, &formats, &opts(a)?)?;
    deliver(cx, a, &bytes, false, json!({"format": "zip", "mime": "application/zip", "documents": ids.len()}))
}

fn deliverable(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let stage = a.str("stage")?;
    let kind = DeliverableType::from_str(a.str("type")?).map_err(|e| AppError::invalid(e.to_string()))?;
    let o = opts(a)?;
    let g = cx.db.transaction(|c| SqliteDeliverables::new(c).generate(d, stage, kind, &o))?;
    let text = is_text(kind.format());
    let r = &g.record;
    let rec = json!({"id": r.id, "documentId": r.document_id, "stage": r.stage, "kind": r.kind, "fileName": r.file_name, "fileUrl": r.file_url, "generatedAt": r.generated_at});
    deliver(cx, a, &g.bytes, text, json!({"deliverable": rec}))
}

/// Register export tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let theme = json!({"type": "string", "enum": ["ieee", "acm", "apa", "plain"], "description": "LaTeX document class"});
    let path = json!({"type": "string", "description": "Write the file here (relative to the workspace root) instead of returning it inline"});
    v.push(ToolSpec::new(
        "nyx_export_doc",
        "export",
        "Export a document as markdown, txt, pdf, docx, latex or jupyter. Text formats are returned inline; pdf/docx as base64, or written to `path` inside the workspace.",
        strict(
            json!({"document_id": {"type": "string"}, "format": {"type": "string", "enum": FORMATS}, "latex_theme": theme, "path": path}),
            &["document_id"],
        ),
        export_doc,
    ));
    v.push(ToolSpec::new(
        "nyx_export_bundle",
        "export",
        "Zip several documents in several formats (with manifest.json).",
        strict(
            json!({
                "document_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                "formats": {"type": "array", "items": {"type": "string", "enum": FORMATS}, "minItems": 1},
                "latex_theme": theme, "path": path,
            }),
            &["document_ids", "formats"],
        ),
        export_bundle,
    ));
    v.push(
        ToolSpec::new(
            "nyx_generate_deliverable",
            "export",
            "Generate and record a stage deliverable (pdf, markdown, report, jupyter, docx, latex, txt) for a document.",
            strict(
                json!({
                    "document_id": {"type": "string"}, "stage": {"type": "string"},
                    "type": {"type": "string", "enum": ["pdf", "markdown", "report", "jupyter", "docx", "latex", "txt"]},
                    "latex_theme": theme, "path": path,
                }),
                &["document_id", "stage", "type"],
            ),
            deliverable,
        )
        .mutates(),
    );
}
