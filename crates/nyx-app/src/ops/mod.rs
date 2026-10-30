//! Operation handlers, grouped by domain. Each module exposes `register`, which appends its
//! [`ToolSpec`](crate::ToolSpec)s to the catalogue.

pub mod credit_tools;
pub mod docs;
pub mod export;
pub mod files;
pub mod governance;
pub mod lifecycle;
pub mod scan;
pub mod sync;
pub mod system;
pub mod tickets;
pub mod tree;
pub mod versions;

use nyx_core::model::Document;
use nyx_core::security::validate::{check_id, check_name, check_text};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

/// Maximum accepted document body (bytes).
pub const MAX_CONTENT_BYTES: usize = 5 * 1024 * 1024;

/// Validate an entity id argument.
pub fn id(label: &str, s: &str) -> AppResult<()> {
    check_id(label, s).map_err(AppError::from)
}

/// Validate a display name / title.
pub fn name(label: &str, s: &str, max: usize) -> AppResult<String> {
    check_name(label, s, max).map_err(AppError::from)
}

/// Validate free text (keeps `\n`, `\t`).
pub fn text(label: &str, s: &str, max: usize) -> AppResult<()> {
    check_text(label, s, max, true).map_err(AppError::from)
}

/// Document summary as listed by `nyx_search_docs`.
pub fn doc_summary(d: &Document) -> Value {
    json!({
        "id": d.id,
        "title": d.title,
        "path": d.path,
        "status": d.stage,
        "stage": d.stage,
        "teamId": d.team_id,
        "updatedAt": d.updated_at,
    })
}

/// Full document.
pub fn doc_full(d: &Document, version: Option<i64>) -> Value {
    json!({
        "id": d.id,
        "title": d.title,
        "content": d.content,
        "path": d.path,
        "status": d.stage,
        "stage": d.stage,
        "lifecycleId": d.lifecycle_id,
        "teamId": d.team_id,
        "createdById": d.created_by_id,
        "createdAt": d.created_at,
        "updatedAt": d.updated_at,
        "version": version,
    })
}

/// Serialize any serde value, mapping failure to an error.
pub fn to_json<T: serde::Serialize>(v: &T) -> AppResult<Value> {
    serde_json::to_value(v).map_err(AppError::from)
}
