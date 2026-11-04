//! Folder / document tree. Source: `nyx_core::tree`. All tools are new relative to the TS MCP
//! server (the TS CLI exposed folders through `docs`).

use nyx_core::tree::{DeletePolicy, SqliteTree};
use serde_json::{json, Value};

use super::{id, name, to_json};
use crate::args::Args;
use crate::error::AppResult;
use crate::registry::{strict, ToolSpec};
use crate::Cx;

fn tree(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let t = SqliteTree::new(cx.conn());
    let node = match a.opt_str("path") {
        Some(p) if p != "/" => t.subtree(&team, p)?,
        _ => t.tree(&team)?,
    };
    to_json(&node)
}

fn create_folder(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let parent = a.opt_str("parent_path").unwrap_or("/");
    let nm = name("name", a.str("name")?, 100)?;
    let f = cx
        .db
        .transaction(|c| SqliteTree::new(c).create_folder(&team, parent, &nm))?;
    to_json(&f)
}

fn rename_folder(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let nm = name("name", a.str("name")?, 100)?;
    let p = a.str("path")?;
    let new = cx
        .db
        .transaction(|c| SqliteTree::new(c).rename_folder(&team, p, &nm))?;
    Ok(json!({"path": new}))
}

fn move_folder(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let (p, to) = (a.str("path")?, a.str("new_parent")?);
    let new = cx
        .db
        .transaction(|c| SqliteTree::new(c).move_folder(&team, p, to))?;
    Ok(json!({"path": new}))
}

fn delete_folder(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let team = cx.team(a);
    let p = a.str("path")?;
    let policy = if a.opt_bool("cascade").unwrap_or(false) {
        DeletePolicy::Cascade
    } else {
        DeletePolicy::RefuseIfNotEmpty
    };
    let r = cx
        .db
        .transaction(|c| SqliteTree::new(c).delete_folder(&team, p, policy))?;
    to_json(&r)
}

fn move_doc(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let to = a.str("new_parent")?;
    let doc = cx
        .db
        .transaction(|c| SqliteTree::new(c).move_document(d, to))?;
    Ok(json!({"id": doc.id, "path": doc.path, "title": doc.title}))
}

/// Register tree tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let team =
        json!({"type": "string", "description": "Team UUID (defaults to the local workspace)"});
    v.push(ToolSpec::new(
        "nyx_get_tree",
        "tree",
        "Folder and document tree of a team (optionally only the subtree under `path`).",
        strict(json!({"team_id": team, "path": {"type": "string"}}), &[]),
        tree,
    ));
    v.push(
        ToolSpec::new(
            "nyx_create_folder",
            "tree",
            "Create a folder under parent_path (default /).",
            strict(json!({"team_id": team, "parent_path": {"type": "string"}, "name": {"type": "string"}}), &["name"]),
            create_folder,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_rename_folder",
            "tree",
            "Rename a folder; documents and subfolders move with it.",
            strict(
                json!({"team_id": team, "path": {"type": "string"}, "name": {"type": "string"}}),
                &["path", "name"],
            ),
            rename_folder,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_move_folder",
            "tree",
            "Move a folder under another folder (cycle-safe).",
            strict(json!({"team_id": team, "path": {"type": "string"}, "new_parent": {"type": "string"}}), &["path", "new_parent"]),
            move_folder,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_delete_folder",
            "tree",
            "Delete a folder. Refuses when not empty unless cascade=true (which soft-deletes its documents).",
            strict(json!({"team_id": team, "path": {"type": "string"}, "cascade": {"type": "boolean"}}), &["path"]),
            delete_folder,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_move_doc",
            "tree",
            "Move a document into another folder.",
            strict(
                json!({"document_id": {"type": "string"}, "new_parent": {"type": "string"}}),
                &["document_id", "new_parent"],
            ),
            move_doc,
        )
        .mutates(),
    );
}
