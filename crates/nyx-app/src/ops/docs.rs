//! Documents and teams. Source: `nyx_core::store::{documents, identity}`, `vcs::version`.
//! TS parity: `nyx_search_docs`, `nyx_read_doc`, `nyx_create_doc`, `nyx_update_doc`,
//! `nyx_delete_doc`, `nyx_list_teams`, `nyx_get_team`, `nyx_create_team`.

use nyx_core::model::{AuditEventType, NewAuditEvent, NewDocument, NewTeam, UserRole};
use nyx_core::store::{AuditRepo, DocumentRepo, SqliteAudit, SqliteDocuments, SqliteTeams, TeamRepo};
use nyx_core::tree::path as tpath;
use nyx_core::vcs::version as vers;
use serde_json::{json, Value};

use super::{doc_full, doc_summary, id, name, text, to_json, MAX_CONTENT_BYTES};
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, strict, Parity, ToolSpec};
use crate::Cx;

fn live_doc(c: &rusqlite::Connection, doc_id: &str) -> AppResult<nyx_core::model::Document> {
    id("document_id", doc_id)?;
    let d = SqliteDocuments::new(c).get(doc_id)?;
    if d.deleted_at.is_some() {
        return Err(AppError::not_found(format!("document {doc_id} is deleted")));
    }
    Ok(d)
}

fn audit_edit(cx: &Cx<'_>, team: &str, doc_id: &str, action: &str) -> AppResult<()> {
    let mut ev = NewAuditEvent::new(team, AuditEventType::DocEdit);
    ev.actor_id = Some(cx.user_id().to_owned());
    ev.document_id = Some(doc_id.to_owned());
    ev.metadata = json!({"action": action, "agent": cx.caller.agent_id});
    SqliteAudit::new(cx.conn()).append(&ev)?;
    Ok(())
}

fn search_docs(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = a.str("team_id")?;
    id("team_id", team)?;
    SqliteTeams::new(cx.conn()).get(team)?;
    let docs = SqliteDocuments::new(cx.conn()).list_live(team)?;
    Ok(Value::Array(docs.iter().map(doc_summary).collect()))
}

fn read_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = live_doc(cx.conn(), a.str("document_id")?)?;
    let v = SqliteDocuments::new(cx.conn()).latest_version(&d.id).ok().map(|v| v.version);
    Ok(doc_full(&d, v))
}

fn create_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = a.str("team_id")?;
    id("team_id", team)?;
    let title = name("title", a.str("title")?, 300)?;
    let content = a.str("content")?;
    text("content", content, MAX_CONTENT_BYTES)?;
    let path = tpath::normalize_lenient(a.opt_str("path").unwrap_or("/"));
    let user = cx.user_id().to_owned();
    let doc = cx.db.transaction(|c| {
        SqliteTeams::new(c).get(team)?;
        SqliteDocuments::new(c).create(&NewDocument {
            title,
            content: content.to_owned(),
            path,
            team_id: team.to_owned(),
            created_by_id: user,
            stage: None,
            lifecycle_id: None,
        })
    })?;
    audit_edit(cx, team, &doc.id, "create")?;
    Ok(doc_full(&doc, Some(1)))
}

fn update_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = live_doc(cx.conn(), a.str("document_id")?)?;
    let title = a.opt_str("title").filter(|s| !s.is_empty());
    let content = a.opt_str("content").filter(|s| !s.is_empty());
    if let Some(c) = content {
        text("content", c, MAX_CONTENT_BYTES)?;
    }
    let title = title.map(|t| name("title", t, 300)).transpose()?;
    let user = cx.user_id().to_owned();
    let agent = cx.caller.agent_id.clone();
    let updated = cx.db.transaction(|c| {
        if title.is_some() {
            SqliteDocuments::new(c).update_meta(&d.id, title.as_deref(), None)?;
        }
        if let Some(body) = content {
            vers::create(c, &d.id, Some(body), Some(&format!("Updated by {agent}")), &user)?;
        }
        SqliteDocuments::new(c).get(&d.id)
    })?;
    audit_edit(cx, &d.team_id, &d.id, "update")?;
    let v = SqliteDocuments::new(cx.conn()).latest_version(&d.id).ok().map(|v| v.version);
    Ok(doc_full(&updated, v))
}

fn delete_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = live_doc(cx.conn(), a.str("document_id")?)?;
    let removed = SqliteDocuments::new(cx.conn()).soft_delete(&d.id)?;
    audit_edit(cx, &d.team_id, &d.id, "delete")?;
    Ok(json!({"success": removed, "id": d.id, "softDeleted": true}))
}

fn restore_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let doc_id = a.str("document_id")?;
    id("document_id", doc_id)?;
    let restored = SqliteDocuments::new(cx.conn()).restore(doc_id)?;
    Ok(json!({"success": restored, "id": doc_id}))
}

fn role_str(r: UserRole) -> String {
    r.to_string()
}

fn list_teams(cx: &mut Cx<'_>, _a: &Args<'_>) -> AppResult<Value> {
    let teams = SqliteTeams::new(cx.conn());
    let mut out = Vec::new();
    for t in teams.list()? {
        let role = teams
            .members(&t.id)?
            .into_iter()
            .find(|m| m.user_id == cx.user_id())
            .map(|m| role_str(m.role));
        out.push(json!({"id": t.id, "name": t.name, "slug": t.slug, "role": role}));
    }
    Ok(Value::Array(out))
}

fn get_team(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let tid = a.str("team_id")?;
    id("team_id", tid)?;
    let teams = SqliteTeams::new(cx.conn());
    let t = teams.get(tid)?;
    let members = teams.members(tid)?;
    Ok(json!({
        "id": t.id, "name": t.name, "slug": t.slug, "createdAt": t.created_at,
        "members": members.iter().map(|m| json!({"userId": m.user_id, "role": role_str(m.role)})).collect::<Vec<_>>(),
    }))
}

fn create_team(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let nm = name("name", a.str("name")?, 120)?;
    let slug = a.str("slug")?;
    let ok = !slug.is_empty()
        && slug.len() <= 60
        && slug.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if !ok {
        return Err(AppError::invalid("slug must be 1-60 chars of a-z, 0-9 and '-'"));
    }
    let user = cx.user_id().to_owned();
    let team = cx.db.transaction(|c| {
        let teams = SqliteTeams::new(c);
        let t = teams.create(&NewTeam {
            name: nm,
            slug: slug.to_owned(),
        })?;
        teams.add_member(&t.id, &user, UserRole::Owner)?;
        Ok(t)
    })?;
    to_json(&team)
}

/// Register document and team tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    v.push(
        ToolSpec::new(
            "nyx_search_docs",
            "documents",
            "Search/list documents in Nyx. Returns document IDs, titles, paths, and status.",
            obj(json!({"team_id": {"type": "string", "description": "Team UUID to scope the search"}}), &["team_id"]),
            search_docs,
        )
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_read_doc",
            "documents",
            "Read a specific document from Nyx by ID. Returns full content, title, and metadata.",
            obj(json!({"document_id": {"type": "string", "description": "UUID of the document to read"}}), &["document_id"]),
            read_doc,
        )
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_create_doc",
            "documents",
            "Create a new document in Nyx.",
            obj(
                json!({
                    "team_id": {"type": "string", "description": "Team UUID for the document"},
                    "title": {"type": "string", "description": "Document title"},
                    "content": {"type": "string", "description": "Document content (markdown)"},
                    "path": {"type": "string", "description": "Document path (e.g. /api/auth)"},
                }),
                &["team_id", "title", "content"],
            ),
            create_doc,
        )
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_update_doc",
            "documents",
            "Update an existing document in Nyx.",
            obj(
                json!({
                    "document_id": {"type": "string", "description": "UUID of the document to update"},
                    "title": {"type": "string", "description": "New title (optional)"},
                    "content": {"type": "string", "description": "New content (optional)"},
                }),
                &["document_id"],
            ),
            update_doc,
        )
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_delete_doc",
            "documents",
            "Delete a document from Nyx by ID.",
            obj(json!({"document_id": {"type": "string", "description": "UUID of the document to delete"}}), &["document_id"]),
            delete_doc,
        )
        .parity(Parity::Exact)
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_restore_doc",
            "documents",
            "Undo a document delete (soft-delete tombstone).",
            strict(json!({"document_id": {"type": "string"}}), &["document_id"]),
            restore_doc,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_list_teams",
            "teams",
            "List all teams the authenticated user belongs to. Returns team IDs, names, slugs, and roles.",
            obj(json!({}), &[]),
            list_teams,
        )
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_get_team",
            "teams",
            "Get details for a specific team by ID.",
            obj(json!({"team_id": {"type": "string", "description": "UUID of the team"}}), &["team_id"]),
            get_team,
        )
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_create_team",
            "teams",
            "Create a new team in Nyx.",
            obj(
                json!({
                    "name": {"type": "string", "description": "Team display name"},
                    "slug": {"type": "string", "description": "URL-friendly team slug"},
                }),
                &["name", "slug"],
            ),
            create_team,
        )
        .parity(Parity::Exact)
        .mutates(),
    );
}
