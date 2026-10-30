//! MCP resources: documents and teams as browsable `nyx://` URIs, plus workspace files via
//! `file://` (jailed). Mirrors `packages/mcp-server/src/resources.ts`.

use nyx_core::store::{DocumentRepo, SqliteDocuments};
use serde_json::{json, Value};

use crate::error::{AppError, AppResult};
use crate::{Caller, NyxApp};

/// A resolved resource.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceContent {
    /// Text body.
    pub text: String,
    /// MIME type.
    pub mime_type: String,
}

/// Resource templates (URI patterns), as in the TS server.
#[must_use]
pub fn templates() -> Vec<Value> {
    vec![
        json!({"uriTemplate": "nyx://docs", "name": "All Documents", "description": "List all documents in Nyx", "mimeType": "application/json"}),
        json!({"uriTemplate": "nyx://docs/{id}", "name": "Document Content", "description": "Read a specific document by ID", "mimeType": "text/markdown"}),
        json!({"uriTemplate": "nyx://docs/{id}/versions", "name": "Document Versions", "description": "List version history for a document", "mimeType": "application/json"}),
        json!({"uriTemplate": "nyx://teams", "name": "All Teams", "description": "List all teams the user belongs to", "mimeType": "application/json"}),
        json!({"uriTemplate": "nyx://teams/{id}", "name": "Team Details", "description": "Get details for a specific team", "mimeType": "application/json"}),
        json!({"uriTemplate": "file://{path}", "name": "Local File", "description": "Read a file inside the workspace root", "mimeType": "text/plain"}),
    ]
}

impl NyxApp {
    /// Concrete resources: the two index resources plus every live document (capped at 200).
    pub fn list_resources(&self) -> AppResult<Vec<Value>> {
        let mut out = vec![
            json!({"uri": "nyx://docs", "name": "All Documents", "mimeType": "application/json"}),
            json!({"uri": "nyx://teams", "name": "All Teams", "mimeType": "application/json"}),
        ];
        let g = self.lock();
        for d in SqliteDocuments::new(g.conn()).list_live(&self.team_id)?.into_iter().take(200) {
            out.push(json!({
                "uri": format!("nyx://docs/{}", d.id), "name": d.title,
                "description": d.path, "mimeType": "text/markdown",
            }));
        }
        Ok(out)
    }

    /// Resolve a resource URI.
    pub fn read_resource(&self, uri: &str, caller: &Caller) -> AppResult<ResourceContent> {
        let json_res = |v: &Value| ResourceContent {
            text: serde_json::to_string_pretty(v).unwrap_or_default(),
            mime_type: "application/json".into(),
        };
        let tool = |name: &str, args: Value| self.call_tool(name, &args, caller);
        if uri == "nyx://teams" {
            return Ok(json_res(&tool("nyx_list_teams", json!({}))?));
        }
        if uri == "nyx://docs" {
            return Ok(json_res(&tool("nyx_search_docs", json!({"team_id": self.team_id}))?));
        }
        if let Some(rest) = uri.strip_prefix("nyx://teams/") {
            if !rest.contains('/') {
                return Ok(json_res(&tool("nyx_get_team", json!({"team_id": rest}))?));
            }
        }
        if let Some(rest) = uri.strip_prefix("nyx://docs/") {
            if let Some(id) = rest.strip_suffix("/versions") {
                return Ok(json_res(&tool("nyx_list_versions", json!({"document_id": id}))?));
            }
            if !rest.contains('/') {
                let d = tool("nyx_read_doc", json!({"document_id": rest}))?;
                return Ok(ResourceContent {
                    text: format!(
                        "# {}\n\n{}",
                        d["title"].as_str().unwrap_or_default(),
                        d["content"].as_str().unwrap_or_default()
                    ),
                    mime_type: "text/markdown".into(),
                });
            }
        }
        if let Some(p) = uri.strip_prefix("file://") {
            let r = tool("nyx_read_file", json!({"path": p}))?;
            let mime = match r["extension"].as_str() {
                Some("json") => "application/json",
                Some("md") => "text/markdown",
                _ => "text/plain",
            };
            return Ok(ResourceContent {
                text: r["content"].as_str().unwrap_or_default().to_owned(),
                mime_type: mime.into(),
            });
        }
        Err(AppError::not_found(format!("Unknown resource URI: {uri}")))
    }
}
