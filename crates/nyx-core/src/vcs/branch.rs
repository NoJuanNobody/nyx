//! Document branches as a service. Ports `branch.service.ts` and fills the gap AI-60 documented:
//! merge is now a real three-way text merge (fast-forward, clean merge, or structured conflicts
//! that callers resolve) instead of overwrite-only.
//!
//! Terminology: `base` is the version the branch forked from, `ours` is the document head,
//! `theirs` is the branch content.
//!
//! The review state machine (`draft -> in_review -> approved|rejected`, ...) lives in
//! [`BranchRepo`]; the wrappers here add timeline events.

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::diff::{diff_lines, LineDiff, DEFAULT_CONTEXT};
use super::merge::{merge3, MergeLabels, Resolution, ThreeWayMerge};
use super::{atomic, timeline};
use crate::error::{Error, Result};
use crate::model::{now_ms, BranchStatus, DocumentBranch, DocumentVersion, NewBranch};
use crate::store::{db_err, BranchRepo, DocumentRepo, SqliteBranches, SqliteDocuments};

/// Create a branch and record a `branch_created` timeline event.
pub fn create(conn: &Connection, new: &NewBranch) -> Result<DocumentBranch> {
    atomic(conn, || {
        let b = SqliteBranches::new(conn).create(new)?;
        timeline::record(
            conn,
            &b.document_id,
            "branch_created",
            json!({"branchId": b.id, "name": b.name, "baseVersionId": b.base_version_id}),
            Some(&b.created_by_id),
        )?;
        Ok(b)
    })
}

/// Branches of a document, oldest first.
pub fn list(conn: &Connection, document_id: &str) -> Result<Vec<DocumentBranch>> {
    SqliteBranches::new(conn).list(document_id)
}

/// Fetch a branch.
pub fn get(conn: &Connection, branch_id: &str) -> Result<DocumentBranch> {
    SqliteBranches::new(conn).get(branch_id)
}

/// Edit branch content (frozen once merged or rejected).
pub fn update_content(conn: &Connection, branch_id: &str, content: &str) -> Result<DocumentBranch> {
    SqliteBranches::new(conn).update_content(branch_id, content)
}

/// `draft -> in_review`.
pub fn submit_for_review(conn: &Connection, branch_id: &str) -> Result<DocumentBranch> {
    SqliteBranches::new(conn).set_status(branch_id, BranchStatus::InReview, None)
}

/// Approve (from `draft`, `in_review`). The TS service also refused already-merged branches.
pub fn approve(conn: &Connection, branch_id: &str, reviewer_id: &str) -> Result<DocumentBranch> {
    set_status_logged(conn, branch_id, BranchStatus::Approved, reviewer_id)
}

/// Reject (from `in_review` or `approved`).
pub fn reject(conn: &Connection, branch_id: &str, reviewer_id: &str) -> Result<DocumentBranch> {
    set_status_logged(conn, branch_id, BranchStatus::Rejected, reviewer_id)
}

/// Send an approved or rejected branch back to `draft` for more work.
pub fn reopen(conn: &Connection, branch_id: &str) -> Result<DocumentBranch> {
    SqliteBranches::new(conn).set_status(branch_id, BranchStatus::Draft, None)
}

fn set_status_logged(
    conn: &Connection,
    branch_id: &str,
    status: BranchStatus,
    reviewer: &str,
) -> Result<DocumentBranch> {
    atomic(conn, || {
        let b = SqliteBranches::new(conn).set_status(branch_id, status, Some(reviewer))?;
        timeline::record(
            conn,
            &b.document_id,
            &format!("branch_{status}"),
            json!({"branchId": b.id, "name": b.name}),
            Some(reviewer),
        )?;
        Ok(b)
    })
}

/// A branch compared with another text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchDiff {
    /// The branch.
    pub branch: DocumentBranch,
    /// The version the branch forked from.
    pub base_version: DocumentVersion,
    /// Document head version at diff time.
    pub head_version: DocumentVersion,
    /// Diff from the compared side to the branch content.
    pub lines: LineDiff,
}

/// What the branch changed relative to the version it forked from (TS `diff`).
pub fn diff(conn: &Connection, branch_id: &str) -> Result<BranchDiff> {
    let (branch, base, head) = load(conn, branch_id)?;
    let lines = diff_lines(&base.content, &branch.content, DEFAULT_CONTEXT);
    Ok(BranchDiff {
        branch,
        base_version: base,
        head_version: head,
        lines,
    })
}

/// How the branch differs from the current document head.
pub fn diff_against_head(conn: &Connection, branch_id: &str) -> Result<BranchDiff> {
    let (branch, base, head) = load(conn, branch_id)?;
    let lines = diff_lines(&head.content, &branch.content, DEFAULT_CONTEXT);
    Ok(BranchDiff {
        branch,
        base_version: base,
        head_version: head,
        lines,
    })
}

fn load(
    conn: &Connection,
    branch_id: &str,
) -> Result<(DocumentBranch, DocumentVersion, DocumentVersion)> {
    let branch = get(conn, branch_id)?;
    let docs = SqliteDocuments::new(conn);
    let base = docs.version_by_id(&branch.base_version_id)?;
    let head = docs.latest_version(&branch.document_id)?;
    Ok((branch, base, head))
}

/// How a merge would go.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "plan", rename_all = "snake_case")]
pub enum MergePlan {
    /// The document has not moved since the fork: the branch content becomes the head.
    FastForward {
        /// Resulting content.
        content: String,
    },
    /// Both moved, but the changes do not overlap.
    Clean {
        /// Resulting content.
        content: String,
    },
    /// Overlapping changes need a human (or agent) decision.
    Conflicted {
        /// Structured merge with conflicts.
        merge: ThreeWayMerge,
    },
}

/// Compute the merge without touching anything.
pub fn plan_merge(conn: &Connection, branch_id: &str) -> Result<MergePlan> {
    let (branch, base, head) = load(conn, branch_id)?;
    Ok(plan(&branch, &base, &head))
}

fn plan(branch: &DocumentBranch, base: &DocumentVersion, head: &DocumentVersion) -> MergePlan {
    if head.id == base.id {
        return MergePlan::FastForward {
            content: branch.content.clone(),
        };
    }
    let m = merge3(&base.content, &head.content, &branch.content);
    match m.clean_text() {
        Some(content) => MergePlan::Clean { content },
        None => MergePlan::Conflicted { merge: m },
    }
}

/// Text of a conflicted merge with `<<<<<<<` markers, labelled with the branch name.
pub fn conflict_markers(branch: &DocumentBranch, merge: &ThreeWayMerge) -> String {
    merge.render(&MergeLabels {
        ours: "head".into(),
        base: "base".into(),
        theirs: format!("branch {}", branch.name),
        show_base: false,
    })
}

/// How a successful merge was achieved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeKind {
    /// Branch content became the head directly.
    FastForward,
    /// Non-overlapping edits were combined.
    Clean,
    /// Conflicts were settled with supplied [`Resolution`]s.
    Resolved,
}

/// A merge that landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeReport {
    /// How it merged.
    pub kind: MergeKind,
    /// The new (or, if nothing changed, existing) head version.
    pub version: DocumentVersion,
    /// The branch, now `merged`.
    pub branch: DocumentBranch,
}

/// A merge that needs decisions. Nothing was written; the branch stays `approved`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConflictReport {
    /// Branch id.
    pub branch_id: String,
    /// Fork point.
    pub base_version: DocumentVersion,
    /// Current head.
    pub head_version: DocumentVersion,
    /// Structured conflicts; pass one [`Resolution`] per conflict to retry.
    pub merge: ThreeWayMerge,
    /// The merged text with conflict markers, for display or manual editing.
    pub marked_content: String,
}

/// Result of [`merge`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum MergeAttempt {
    /// The merge landed.
    Merged(Box<MergeReport>),
    /// Conflicts block the merge.
    Conflicted(Box<ConflictReport>),
}

/// Merge an `approved` branch into its document (TS `merge`, now with a three-way text merge).
///
/// - Head unchanged since the fork: fast-forward.
/// - Head moved, edits do not overlap: clean merge.
/// - Overlap: returns [`MergeAttempt::Conflicted`] unless `resolutions` has exactly one entry per
///   conflict, in which case the settled text is merged ([`MergeKind::Resolved`]).
///
/// Not-approved and already-merged branches fail with [`Error::Conflict`]. The new version is
/// authored by `merger_id` with message `Merged branch "name"`.
pub fn merge(
    conn: &Connection,
    branch_id: &str,
    merger_id: &str,
    resolutions: Option<&[Resolution]>,
) -> Result<MergeAttempt> {
    atomic(conn, || {
        let (branch, base, head) = load(conn, branch_id)?;
        if branch.status == BranchStatus::Merged {
            return Err(Error::Conflict("branch already merged".into()));
        }
        if branch.status != BranchStatus::Approved {
            return Err(Error::Conflict(format!(
                "branch must be approved before merging (is {})",
                branch.status
            )));
        }
        let (kind, content) = match plan(&branch, &base, &head) {
            MergePlan::FastForward { content } => (MergeKind::FastForward, content),
            MergePlan::Clean { content } => (MergeKind::Clean, content),
            MergePlan::Conflicted { merge } => match resolutions {
                Some(r) => (MergeKind::Resolved, merge.resolve(r)?),
                None => {
                    return Ok(MergeAttempt::Conflicted(Box::new(ConflictReport {
                        branch_id: branch.id.clone(),
                        marked_content: conflict_markers(&branch, &merge),
                        base_version: base,
                        head_version: head,
                        merge,
                    })))
                }
            },
        };
        let msg = format!("Merged branch \"{}\"", branch.name);
        let version = SqliteDocuments::new(conn).save_content(
            &branch.document_id,
            &content,
            Some(&msg),
            merger_id,
        )?;
        conn.execute(
            "UPDATE document_branches SET status = 'merged', merged_at = ?2, reviewed_by_id = COALESCE(reviewed_by_id, ?3) WHERE id = ?1",
            params![branch.id, now_ms(), merger_id],
        )
        .map_err(db_err)?;
        timeline::record(
            conn,
            &branch.document_id,
            "branch_merged",
            json!({"branchId": branch.id, "name": branch.name, "versionId": version.id, "kind": kind}),
            Some(merger_id),
        )?;
        Ok(MergeAttempt::Merged(Box::new(MergeReport {
            kind,
            version,
            branch: get(conn, branch_id)?,
        })))
    })
}

/// Result of [`update_from_head`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum SyncAttempt {
    /// Branch already based on the head.
    UpToDate,
    /// Head changes were folded into the branch and its base advanced to the head.
    Updated(DocumentBranch),
    /// Overlapping edits; branch untouched.
    Conflicted(Box<ConflictReport>),
}

/// Bring head changes into a branch (merge head into branch), advancing its fork point so a later
/// [`merge`] fast-forwards. Allowed while the branch is editable (not merged or rejected).
pub fn update_from_head(
    conn: &Connection,
    branch_id: &str,
    resolutions: Option<&[Resolution]>,
) -> Result<SyncAttempt> {
    atomic(conn, || {
        let (branch, base, head) = load(conn, branch_id)?;
        if matches!(branch.status, BranchStatus::Merged | BranchStatus::Rejected) {
            return Err(Error::Conflict(format!(
                "branch is {}; cannot update",
                branch.status
            )));
        }
        if head.id == base.id {
            return Ok(SyncAttempt::UpToDate);
        }
        // ours = branch work, theirs = incoming head changes.
        let m = merge3(&base.content, &branch.content, &head.content);
        let content = match m.clean_text() {
            Some(c) => c,
            None => match resolutions {
                Some(r) => m.resolve(r)?,
                None => {
                    return Ok(SyncAttempt::Conflicted(Box::new(ConflictReport {
                        branch_id: branch.id.clone(),
                        marked_content: m.render(&MergeLabels {
                            ours: format!("branch {}", branch.name),
                            base: "base".into(),
                            theirs: "head".into(),
                            show_base: false,
                        }),
                        base_version: base,
                        head_version: head,
                        merge: m,
                    })))
                }
            },
        };
        conn.execute(
            "UPDATE document_branches SET content = ?2, base_version_id = ?3 WHERE id = ?1",
            params![branch.id, content, head.id],
        )
        .map_err(db_err)?;
        Ok(SyncAttempt::Updated(get(conn, branch_id)?))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcs::testutil::{doc, fx, Fx};

    fn nb(f: &Fx, doc_id: &str, name: &str) -> NewBranch {
        NewBranch {
            document_id: doc_id.into(),
            name: name.into(),
            base_version_id: None,
            created_by_id: f.user.id.clone(),
        }
    }

    fn approved_branch(f: &Fx, doc_id: &str, name: &str, content: &str) -> DocumentBranch {
        let c = f.db.conn();
        let b = create(c, &nb(f, doc_id, name)).unwrap();
        update_content(c, &b.id, content).unwrap();
        approve(c, &b.id, &f.other.id).unwrap()
    }

    const BASE: &str = "a\nb\nc\nd\ne\n";

    #[test]
    fn diff_reports_branch_changes_against_base() {
        let f = fx();
        let d = doc(&f, BASE);
        let c = f.db.conn();
        let b = create(c, &nb(&f, &d.id, "feat")).unwrap();
        update_content(c, &b.id, "a\nB\nc\nd\ne\n").unwrap();
        let r = diff(c, &b.id).unwrap();
        assert_eq!(r.base_version.version, 1);
        assert_eq!((r.lines.stats.added, r.lines.stats.removed), (1, 1));
        assert_eq!(r.branch.name, "feat");
        assert!(!diff_against_head(c, &b.id).unwrap().lines.identical);
    }

    #[test]
    fn fast_forward_merge() {
        let f = fx();
        let d = doc(&f, BASE);
        let b = approved_branch(&f, &d.id, "ff", "a\nB\nc\nd\ne\n");
        let c = f.db.conn();
        assert!(matches!(
            plan_merge(c, &b.id).unwrap(),
            MergePlan::FastForward { .. }
        ));
        let MergeAttempt::Merged(r) = merge(c, &b.id, &f.user.id, None).unwrap() else {
            panic!("expected merge");
        };
        assert_eq!(r.kind, MergeKind::FastForward);
        assert_eq!(r.version.version, 2);
        assert_eq!(r.version.message.as_deref(), Some("Merged branch \"ff\""));
        assert_eq!(r.branch.status, BranchStatus::Merged);
        assert!(r.branch.merged_at.is_some());
        assert_eq!(
            SqliteDocuments::new(c).get(&d.id).unwrap().content,
            "a\nB\nc\nd\ne\n"
        );
        // second merge refused
        assert!(matches!(
            merge(c, &b.id, &f.user.id, None),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn clean_three_way_merge_when_head_moved_elsewhere() {
        let f = fx();
        let d = doc(&f, BASE);
        let b = approved_branch(&f, &d.id, "top", "A\nb\nc\nd\ne\n");
        let c = f.db.conn();
        SqliteDocuments::new(c)
            .save_content(&d.id, "a\nb\nc\nd\nE\n", None, &f.user.id)
            .unwrap();
        assert!(matches!(
            plan_merge(c, &b.id).unwrap(),
            MergePlan::Clean { .. }
        ));
        let MergeAttempt::Merged(r) = merge(c, &b.id, &f.user.id, None).unwrap() else {
            panic!("expected merge");
        };
        assert_eq!(r.kind, MergeKind::Clean);
        assert_eq!(r.version.version, 3);
        assert_eq!(r.version.content, "A\nb\nc\nd\nE\n");
        assert_eq!(
            SqliteDocuments::new(c).get(&d.id).unwrap().content,
            "A\nb\nc\nd\nE\n"
        );
    }

    #[test]
    fn conflicting_merge_returns_structured_conflicts_and_writes_nothing() {
        let f = fx();
        let d = doc(&f, BASE);
        let b = approved_branch(&f, &d.id, "x", "a\nB-branch\nc\nd\ne\n");
        let c = f.db.conn();
        SqliteDocuments::new(c)
            .save_content(&d.id, "a\nB-head\nc\nd\ne\n", None, &f.user.id)
            .unwrap();
        let MergeAttempt::Conflicted(rep) = merge(c, &b.id, &f.user.id, None).unwrap() else {
            panic!("expected conflict");
        };
        let cs = rep.merge.conflicts();
        assert_eq!(cs.len(), 1);
        assert_eq!(
            (cs[0].ours.as_str(), cs[0].theirs.as_str()),
            ("B-head\n", "B-branch\n")
        );
        assert!(rep.marked_content.contains("<<<<<<< head"));
        assert!(rep.marked_content.contains(">>>>>>> branch x"));
        // untouched
        assert_eq!(get(c, &b.id).unwrap().status, BranchStatus::Approved);
        assert_eq!(
            SqliteDocuments::new(c).get(&d.id).unwrap().content,
            "a\nB-head\nc\nd\ne\n"
        );
        assert_eq!(SqliteDocuments::new(c).versions(&d.id).unwrap().len(), 2);

        // wrong number of resolutions is rejected
        assert!(matches!(
            merge(c, &b.id, &f.user.id, Some(&[])),
            Err(Error::Invalid(_))
        ));
        // retry with a resolution
        let MergeAttempt::Merged(r) =
            merge(c, &b.id, &f.user.id, Some(&[Resolution::Theirs])).unwrap()
        else {
            panic!("expected merge");
        };
        assert_eq!(r.kind, MergeKind::Resolved);
        assert_eq!(r.version.content, "a\nB-branch\nc\nd\ne\n");
        assert_eq!(get(c, &b.id).unwrap().status, BranchStatus::Merged);
    }

    #[test]
    fn merge_requires_approval() {
        let f = fx();
        let d = doc(&f, BASE);
        let c = f.db.conn();
        let b = create(c, &nb(&f, &d.id, "wip")).unwrap();
        assert!(matches!(
            merge(c, &b.id, &f.user.id, None),
            Err(Error::Conflict(_))
        ));
        submit_for_review(c, &b.id).unwrap();
        assert!(matches!(
            merge(c, &b.id, &f.user.id, None),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn review_transitions_and_timeline_events() {
        let f = fx();
        let d = doc(&f, BASE);
        let c = f.db.conn();
        let b = create(c, &nb(&f, &d.id, "r")).unwrap();
        submit_for_review(c, &b.id).unwrap();
        let rej = reject(c, &b.id, &f.other.id).unwrap();
        assert_eq!(rej.status, BranchStatus::Rejected);
        assert_eq!(rej.reviewed_by_id.as_deref(), Some(f.other.id.as_str()));
        // rejected content is frozen; cannot approve directly
        assert!(update_content(c, &b.id, "x").is_err());
        assert!(approve(c, &b.id, &f.other.id).is_err());
        assert_eq!(reopen(c, &b.id).unwrap().status, BranchStatus::Draft);
        let kinds: Vec<_> = timeline::events(c, &d.id)
            .unwrap()
            .into_iter()
            .map(|e| e.kind)
            .collect();
        assert_eq!(kinds, ["branch_rejected", "branch_created"]);
    }

    #[test]
    fn update_from_head_advances_base_then_fast_forwards() {
        let f = fx();
        let d = doc(&f, BASE);
        let c = f.db.conn();
        let b = create(c, &nb(&f, &d.id, "sync")).unwrap();
        update_content(c, &b.id, "A\nb\nc\nd\ne\n").unwrap();
        assert!(matches!(
            update_from_head(c, &b.id, None).unwrap(),
            SyncAttempt::UpToDate
        ));
        let head = SqliteDocuments::new(c)
            .save_content(&d.id, "a\nb\nc\nd\nE\n", None, &f.user.id)
            .unwrap();
        let SyncAttempt::Updated(u) = update_from_head(c, &b.id, None).unwrap() else {
            panic!("expected update");
        };
        assert_eq!(u.base_version_id, head.id);
        assert_eq!(u.content, "A\nb\nc\nd\nE\n");
        approve(c, &b.id, &f.other.id).unwrap();
        let MergeAttempt::Merged(r) = merge(c, &b.id, &f.user.id, None).unwrap() else {
            panic!("expected merge");
        };
        assert_eq!(r.kind, MergeKind::FastForward);
    }

    #[test]
    fn update_from_head_reports_conflict_without_writing() {
        let f = fx();
        let d = doc(&f, BASE);
        let c = f.db.conn();
        let b = create(c, &nb(&f, &d.id, "sync2")).unwrap();
        update_content(c, &b.id, "a\nBB\nc\nd\ne\n").unwrap();
        SqliteDocuments::new(c)
            .save_content(&d.id, "a\nXX\nc\nd\ne\n", None, &f.user.id)
            .unwrap();
        let SyncAttempt::Conflicted(rep) = update_from_head(c, &b.id, None).unwrap() else {
            panic!("expected conflict");
        };
        assert!(rep.marked_content.contains("<<<<<<< branch sync2"));
        assert_eq!(get(c, &b.id).unwrap().content, "a\nBB\nc\nd\ne\n");
    }
}
