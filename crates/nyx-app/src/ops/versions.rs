//! Versions, branches, diff, three-way merge, snapshots and timeline.
//! Source: `nyx_core::vcs::{version, branch, diff, merge, snapshot, timeline}`.
//! TS parity: `nyx_list_versions`, `nyx_get_timeline`; everything else is new (the TS MCP server
//! had no branch/merge/snapshot tools; the CLI had them over the HTTP API).

use nyx_core::model::BranchStatus;
use nyx_core::store::{DocumentRepo, SqliteDocuments};
use nyx_core::vcs::branch::{self, MergeAttempt, SyncAttempt};
use nyx_core::vcs::diff::{diff_lines, diff_words, unified, DEFAULT_CONTEXT};
use nyx_core::vcs::merge::Resolution;
use nyx_core::vcs::timeline::{self, TimelineOptions};
use nyx_core::vcs::{snapshot, version};
use serde_json::{json, Value};

use super::{id, name, text, to_json, MAX_CONTENT_BYTES};
use crate::args::Args;
use crate::error::{AppError, AppResult};
use crate::registry::{obj, strict, Parity, ToolSpec};
use crate::Cx;

fn version_json(v: &nyx_core::model::DocumentVersion, with_content: bool) -> Value {
    let mut j = json!({
        "id": v.id, "documentId": v.document_id, "version": v.version,
        "message": v.message, "createdById": v.created_by_id, "createdAt": v.created_at,
    });
    if with_content {
        j["content"] = json!(v.content);
    }
    j
}

fn list_versions(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    SqliteDocuments::new(cx.conn()).get(d)?;
    let vs = version::list(cx.conn(), d)?;
    Ok(Value::Array(vs.iter().map(|v| version_json(v, false)).collect()))
}

fn get_timeline(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    SqliteDocuments::new(cx.conn()).get(d)?;
    let opts = TimelineOptions {
        limit: a.opt_i64("limit").map(|n| n.max(1) as usize),
        kinds: a.str_list("kinds"),
    };
    let entries = timeline::assemble(cx.conn(), d, &opts)?;
    Ok(Value::Array(
        entries
            .iter()
            .map(|e| {
                json!({
                    "createdAt": e.at, "type": e.kind, "description": e.summary,
                    "actorId": e.actor_id, "payload": e.payload,
                    "source": format!("{:?}", e.source).to_lowercase(),
                })
            })
            .collect(),
    ))
}

fn create_version(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    if let Some(c) = a.opt_str("content") {
        text("content", c, MAX_CONTENT_BYTES)?;
    }
    if let Some(m) = a.opt_str("message") {
        text("message", m, 1000)?;
    }
    let user = cx.user_id().to_owned();
    let v = version::create(cx.conn(), d, a.opt_str("content"), a.opt_str("message"), &user)?;
    Ok(version_json(&v, false))
}

fn get_version(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let repo = SqliteDocuments::new(cx.conn());
    let v = if let Some(vid) = a.opt_str("version_id") {
        id("version_id", vid)?;
        repo.version_by_id(vid)?
    } else {
        let d = a.str("document_id")?;
        id("document_id", d)?;
        match a.opt_i64("version") {
            Some(n) => repo.version(d, n)?,
            None => repo.latest_version(d)?,
        }
    };
    Ok(version_json(&v, true))
}

fn diff_versions(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let (x, y) = (a.str("version_a")?, a.str("version_b")?);
    id("version_a", x)?;
    id("version_b", y)?;
    match a.opt_str("format").unwrap_or("lines") {
        "words" => to_json(&version::diff_words_between(cx.conn(), x, y)?),
        "unified" => {
            let d = version::diff(cx.conn(), x, y)?;
            let (va, vb) = (&d.a, &d.b);
            Ok(json!({
                "a": {"id": va.id, "version": va.version}, "b": {"id": vb.id, "version": vb.version},
                "unified": unified(&va.content, &vb.content, &format!("v{}", va.version), &format!("v{}", vb.version), DEFAULT_CONTEXT),
                "stats": d.lines.stats,
            }))
        }
        _ => {
            let d = version::diff(cx.conn(), x, y)?;
            Ok(json!({
                "a": version_json(&d.a, false), "b": version_json(&d.b, false), "diff": d.lines,
            }))
        }
    }
}

fn diff_text(_cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let (old, new) = (a.str("old")?, a.str("new")?);
    text("old", old, MAX_CONTENT_BYTES)?;
    text("new", new, MAX_CONTENT_BYTES)?;
    match a.opt_str("format").unwrap_or("lines") {
        "words" => to_json(&diff_words(old, new)),
        "unified" => Ok(json!({"unified": unified(old, new, "old", "new", DEFAULT_CONTEXT)})),
        _ => to_json(&diff_lines(old, new, DEFAULT_CONTEXT)),
    }
}

fn restore_version(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let (d, vid) = (a.str("document_id")?, a.str("version_id")?);
    id("document_id", d)?;
    id("version_id", vid)?;
    let user = cx.user_id().to_owned();
    let v = version::restore_to_version(cx.conn(), d, vid, &user)?;
    Ok(version_json(&v, false))
}

// ---- branches ----

fn create_branch(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let nm = name("name", a.str("name")?, 100)?;
    if let Some(b) = a.opt_str("base_version_id") {
        id("base_version_id", b)?;
    }
    let b = branch::create(
        cx.conn(),
        &nyx_core::model::NewBranch {
            document_id: d.to_owned(),
            name: nm,
            base_version_id: a.opt_str("base_version_id").map(str::to_owned),
            created_by_id: cx.user_id().to_owned(),
        },
    )?;
    to_json(&b)
}

fn list_branches(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let d = a.str("document_id")?;
    id("document_id", d)?;
    let bs = branch::list(cx.conn(), d)?;
    Ok(Value::Array(
        bs.iter()
            .map(|b| json!({"id": b.id, "name": b.name, "status": b.status, "baseVersionId": b.base_version_id, "createdAt": b.created_at, "mergedAt": b.merged_at}))
            .collect(),
    ))
}

fn get_branch(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let b = a.str("branch_id")?;
    id("branch_id", b)?;
    to_json(&branch::get(cx.conn(), b)?)
}

fn update_branch(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let b = a.str("branch_id")?;
    id("branch_id", b)?;
    let content = a.str("content")?;
    text("content", content, MAX_CONTENT_BYTES)?;
    to_json(&branch::update_content(cx.conn(), b, content)?)
}

fn branch_review(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let b = a.str("branch_id")?;
    id("branch_id", b)?;
    let user = cx.user_id().to_owned();
    let out = match a.str("action")? {
        "submit" => branch::submit_for_review(cx.conn(), b)?,
        "approve" => branch::approve(cx.conn(), b, &user)?,
        "reject" => branch::reject(cx.conn(), b, &user)?,
        "reopen" => branch::reopen(cx.conn(), b)?,
        other => return Err(AppError::invalid(format!("unknown action {other}"))),
    };
    debug_assert!(matches!(
        out.status,
        BranchStatus::Draft | BranchStatus::InReview | BranchStatus::Approved | BranchStatus::Rejected
    ));
    to_json(&out)
}

fn diff_branch(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let b = a.str("branch_id")?;
    id("branch_id", b)?;
    let d = match a.opt_str("against").unwrap_or("base") {
        "head" => branch::diff_against_head(cx.conn(), b)?,
        _ => branch::diff(cx.conn(), b)?,
    };
    Ok(json!({
        "branch": {"id": d.branch.id, "name": d.branch.name, "status": d.branch.status},
        "baseVersion": version_json(&d.base_version, false),
        "headVersion": version_json(&d.head_version, false),
        "diff": d.lines,
    }))
}

fn resolutions(a: &Args<'_>) -> AppResult<Option<Vec<Resolution>>> {
    match a.raw("resolutions") {
        None => Ok(None),
        Some(v) => serde_json::from_value::<Vec<Resolution>>(v.clone())
            .map(Some)
            .map_err(|e| AppError::invalid(format!("resolutions: {e}"))),
    }
}

fn merge_branch(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let b = a.str("branch_id")?;
    id("branch_id", b)?;
    if a.opt_bool("dry_run").unwrap_or(false) {
        return to_json(&branch::plan_merge(cx.conn(), b)?);
    }
    let rs = resolutions(a)?;
    let user = cx.user_id().to_owned();
    match branch::merge(cx.conn(), b, &user, rs.as_deref())? {
        MergeAttempt::Merged(r) => Ok(json!({"outcome": "merged", "kind": r.kind, "version": version_json(&r.version, false), "branch": r.branch})),
        MergeAttempt::Conflicted(c) => Ok(json!({
            "outcome": "conflicted",
            "message": "overlapping edits; retry with one resolution per conflict (choose: ours|theirs|base|both|custom)",
            "conflicts": c.merge.conflicts(),
            "markedContent": c.marked_content,
            "baseVersion": version_json(&c.base_version, false),
            "headVersion": version_json(&c.head_version, false),
        })),
    }
}

fn sync_branch(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let b = a.str("branch_id")?;
    id("branch_id", b)?;
    let rs = resolutions(a)?;
    match branch::update_from_head(cx.conn(), b, rs.as_deref())? {
        SyncAttempt::UpToDate => Ok(json!({"outcome": "up_to_date"})),
        SyncAttempt::Updated(br) => Ok(json!({"outcome": "updated", "branch": br})),
        SyncAttempt::Conflicted(c) => Ok(json!({
            "outcome": "conflicted",
            "conflicts": c.merge.conflicts(),
            "markedContent": c.marked_content,
        })),
    }
}

// ---- snapshots ----

fn create_snapshot(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let nm = name("name", a.str("name")?, 200)?;
    let docs = a.str_list("document_ids");
    if docs.is_empty() {
        return Err(AppError::invalid("document_ids needs at least one id"));
    }
    for d in &docs {
        id("document_ids", d)?;
    }
    let user = cx.user_id().to_owned();
    let snaps = cx.db.transaction(|c| snapshot::create(c, &nm, &docs, Some(&user)))?;
    to_json(&snaps)
}

fn list_snapshots(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let snaps = if let Some(d) = a.opt_str("document_id") {
        id("document_id", d)?;
        snapshot::list_for_document(cx.conn(), d)?
    } else {
        snapshot::list_for_team(cx.conn(), &cx.team(a))?
    };
    Ok(Value::Array(
        snaps
            .iter()
            .map(|s| json!({"id": s.id, "documentId": s.document_id, "name": s.external_ref, "capturedAt": s.captured_at}))
            .collect(),
    ))
}

fn restore_snapshot(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let s = a.str("snapshot_id")?;
    id("snapshot_id", s)?;
    let user = cx.user_id().to_owned();
    let r = snapshot::restore(cx.conn(), s, &user)?;
    Ok(json!({"documentId": r.document_id, "restoredFrom": r.restored_from, "version": version_json(&r.version, false)}))
}

fn diff_snapshot(cx: &mut Cx<'_>, a: &Args<'_>) -> AppResult<Value> {
    let s = a.str("snapshot_id")?;
    id("snapshot_id", s)?;
    to_json(&snapshot::diff_with_head(cx.conn(), s)?)
}

/// Register version-control tools.
pub fn register(v: &mut Vec<ToolSpec>) {
    let doc = json!({"type": "string", "description": "UUID of the document"});
    v.push(
        ToolSpec::new(
            "nyx_list_versions",
            "versions",
            "List version history for a document. Returns version numbers, messages, and timestamps.",
            obj(json!({"document_id": doc}), &["document_id"]),
            list_versions,
        )
        .parity(Parity::Exact),
    );
    v.push(
        ToolSpec::new(
            "nyx_get_timeline",
            "versions",
            "Get the timeline of events for a Nyx document.",
            obj(
                json!({
                    "document_id": doc,
                    "limit": {"type": "integer", "minimum": 1, "description": "Keep at most this many entries (newest first)"},
                    "kinds": {"type": "array", "items": {"type": "string"}, "description": "Keep only these event kinds"},
                }),
                &["document_id"],
            ),
            get_timeline,
        )
        .parity(Parity::Extended),
    );
    v.push(
        ToolSpec::new(
            "nyx_create_version",
            "versions",
            "Record a new version of a document. Without content the current content is versioned; identical content creates no duplicate.",
            strict(
                json!({
                    "document_id": doc,
                    "content": {"type": "string", "description": "New content (optional)"},
                    "message": {"type": "string", "description": "Commit-style message"},
                }),
                &["document_id"],
            ),
            create_version,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_get_version",
        "versions",
        "Read one version (with content) by version_id, or by document_id plus version number; defaults to the latest.",
        strict(
            json!({
                "version_id": {"type": "string"},
                "document_id": doc,
                "version": {"type": "integer", "minimum": 1},
            }),
            &[],
        ),
        get_version,
    ));
    v.push(ToolSpec::new(
        "nyx_diff_versions",
        "versions",
        "Diff two document versions (line diff with hunks and stats, word diff, or unified text).",
        strict(
            json!({
                "version_a": {"type": "string", "description": "Older version id"},
                "version_b": {"type": "string", "description": "Newer version id"},
                "format": {"type": "string", "enum": ["lines", "words", "unified"]},
            }),
            &["version_a", "version_b"],
        ),
        diff_versions,
    ));
    v.push(ToolSpec::new(
        "nyx_diff_text",
        "versions",
        "Diff two arbitrary texts (no stored document needed).",
        strict(
            json!({
                "old": {"type": "string"}, "new": {"type": "string"},
                "format": {"type": "string", "enum": ["lines", "words", "unified"]},
            }),
            &["old", "new"],
        ),
        diff_text,
    ));
    v.push(
        ToolSpec::new(
            "nyx_restore_version",
            "versions",
            "Make an old version the head again by appending a new version (history is never rewritten).",
            strict(json!({"document_id": doc, "version_id": {"type": "string"}}), &["document_id", "version_id"]),
            restore_version,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_create_branch",
            "branches",
            "Fork a working branch of a document from a version (default: latest).",
            strict(
                json!({
                    "document_id": doc,
                    "name": {"type": "string", "description": "Branch name, unique per document"},
                    "base_version_id": {"type": "string"},
                }),
                &["document_id", "name"],
            ),
            create_branch,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_list_branches",
        "branches",
        "List the branches of a document with status.",
        strict(json!({"document_id": doc}), &["document_id"]),
        list_branches,
    ));
    v.push(ToolSpec::new(
        "nyx_get_branch",
        "branches",
        "Read a branch including its content.",
        strict(json!({"branch_id": {"type": "string"}}), &["branch_id"]),
        get_branch,
    ));
    v.push(
        ToolSpec::new(
            "nyx_update_branch",
            "branches",
            "Replace the content of a branch (until it is merged or rejected).",
            strict(json!({"branch_id": {"type": "string"}, "content": {"type": "string"}}), &["branch_id", "content"]),
            update_branch,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_branch_review",
            "branches",
            "Move a branch through review: submit, approve, reject, reopen. Merge requires approved.",
            strict(
                json!({
                    "branch_id": {"type": "string"},
                    "action": {"type": "string", "enum": ["submit", "approve", "reject", "reopen"]},
                }),
                &["branch_id", "action"],
            ),
            branch_review,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_diff_branch",
        "branches",
        "Diff a branch against the version it forked from (base) or against the current head.",
        strict(
            json!({
                "branch_id": {"type": "string"},
                "against": {"type": "string", "enum": ["base", "head"]},
            }),
            &["branch_id"],
        ),
        diff_branch,
    ));
    v.push(
        ToolSpec::new(
            "nyx_merge_branch",
            "branches",
            "Three-way merge an approved branch into its document. On overlapping edits returns outcome=conflicted with structured conflicts and writes nothing; retry with one resolution per conflict. dry_run=true only plans.",
            strict(
                json!({
                    "branch_id": {"type": "string"},
                    "dry_run": {"type": "boolean"},
                    "resolutions": {
                        "type": "array",
                        "description": "One per conflict, in order: {choose: ours|theirs|base|both|custom, text?}",
                        "items": {"type": "object", "properties": {"choose": {"type": "string", "enum": ["ours", "theirs", "base", "both", "custom"]}, "text": {"type": "string"}}, "required": ["choose"]},
                    },
                }),
                &["branch_id"],
            ),
            merge_branch,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_sync_branch",
            "branches",
            "Fold head changes into a branch (merge head into branch) and advance its fork point.",
            strict(
                json!({
                    "branch_id": {"type": "string"},
                    "resolutions": {"type": "array", "items": {"type": "object", "properties": {"choose": {"type": "string", "enum": ["ours", "theirs", "base", "both", "custom"]}, "text": {"type": "string"}}, "required": ["choose"]}},
                }),
                &["branch_id"],
            ),
            sync_branch,
        )
        .mutates(),
    );
    v.push(
        ToolSpec::new(
            "nyx_create_snapshot",
            "snapshots",
            "Capture the current content of one or more documents under a name.",
            strict(
                json!({
                    "name": {"type": "string"},
                    "document_ids": {"type": "array", "items": {"type": "string"}, "minItems": 1},
                }),
                &["name", "document_ids"],
            ),
            create_snapshot,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_list_snapshots",
        "snapshots",
        "List snapshots of a document, or of the team when no document_id is given.",
        strict(json!({"document_id": doc, "team_id": {"type": "string"}}), &[]),
        list_snapshots,
    ));
    v.push(
        ToolSpec::new(
            "nyx_restore_snapshot",
            "snapshots",
            "Restore a snapshot by appending its content as a new document version.",
            strict(json!({"snapshot_id": {"type": "string"}}), &["snapshot_id"]),
            restore_snapshot,
        )
        .mutates(),
    );
    v.push(ToolSpec::new(
        "nyx_diff_snapshot",
        "snapshots",
        "Line diff between a snapshot and the current document head.",
        strict(json!({"snapshot_id": {"type": "string"}}), &["snapshot_id"]),
        diff_snapshot,
    ));
}
