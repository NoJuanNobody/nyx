//! Document branches: forked working copies with a review state machine and merge.
//!
//! Semantics:
//! - A branch forks from a version (default: latest) and starts with that version's content.
//! - Names are unique per document. Only live documents can be branched.
//! - Status moves `draft -> in_review -> approved|rejected`, `rejected|approved -> draft`;
//!   `merged` is terminal and reachable only through [`BranchRepo::merge`].
//! - Content can be edited until the branch is merged or rejected.
//! - Merge requires `approved`. If the document advanced past the branch's base version the merge
//!   fails with [`Error::Conflict`] under [`MergeStrategy::FailIfDiverged`]; [`MergeStrategy::Overwrite`]
//!   replaces the head with the branch content. (No three-way text merge yet.)

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::db_err;
use super::documents::{DocumentRepo, SqliteDocuments};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, BranchStatus, DocumentBranch, DocumentVersion, NewBranch};

/// What to do when the document moved on since the branch was forked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum MergeStrategy {
    /// Refuse to merge (default).
    #[default]
    FailIfDiverged,
    /// Replace the head with the branch content, keeping history.
    Overwrite,
}

/// Branch persistence.
pub trait BranchRepo {
    /// Create a branch.
    fn create(&self, new: &NewBranch) -> Result<DocumentBranch>;
    /// Fetch by id.
    fn get(&self, id: &str) -> Result<DocumentBranch>;
    /// Branches of a document, oldest first.
    fn list(&self, document_id: &str) -> Result<Vec<DocumentBranch>>;
    /// Edit branch content.
    fn update_content(&self, id: &str, content: &str) -> Result<DocumentBranch>;
    /// Move through the review state machine (not to `merged`).
    fn set_status(
        &self,
        id: &str,
        status: BranchStatus,
        reviewer_id: Option<&str>,
    ) -> Result<DocumentBranch>;
    /// Merge an approved branch into its document; returns the new document version.
    fn merge(&self, id: &str, merger_id: &str, strategy: MergeStrategy) -> Result<DocumentVersion>;
}

/// SQLite [`BranchRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteBranches<'c>(&'c Connection);

impl<'c> SqliteBranches<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn branch_row(r: &Row<'_>) -> rusqlite::Result<DocumentBranch> {
    Ok(DocumentBranch {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        name: r.get("name")?,
        base_version_id: r.get("base_version_id")?,
        content: r.get("content")?,
        created_by_id: r.get("created_by_id")?,
        status: r.get("status")?,
        reviewed_by_id: r.get("reviewed_by_id")?,
        created_at: r.get("created_at")?,
        merged_at: r.get("merged_at")?,
    })
}

fn transition_allowed(from: BranchStatus, to: BranchStatus) -> bool {
    use BranchStatus::{Approved, Draft, InReview, Merged, Rejected};
    matches!(
        (from, to),
        (Draft, InReview | Approved)
            | (InReview, Approved | Rejected | Draft)
            | (Approved, Draft | Rejected)
            | (Rejected, Draft)
    ) && to != Merged
}

impl BranchRepo for SqliteBranches<'_> {
    fn create(&self, new: &NewBranch) -> Result<DocumentBranch> {
        if new.name.trim().is_empty() {
            return Err(Error::Invalid("branch name is required".into()));
        }
        let docs = SqliteDocuments::new(self.0);
        let doc = docs.get(&new.document_id)?;
        if doc.deleted_at.is_some() {
            return Err(Error::Conflict(format!("document {} is deleted", doc.id)));
        }
        let base = match &new.base_version_id {
            Some(v) => docs.version_by_id(v)?,
            None => docs.latest_version(&doc.id)?,
        };
        if base.document_id != doc.id {
            return Err(Error::Invalid(
                "base version belongs to a different document".into(),
            ));
        }
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO document_branches (id, document_id, name, base_version_id, content, created_by_id, status, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,'draft',?7)",
                params![id, doc.id, new.name, base.id, base.content, new.created_by_id, now_ms()],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    fn get(&self, id: &str) -> Result<DocumentBranch> {
        self.0
            .query_row(
                "SELECT * FROM document_branches WHERE id = ?1",
                [id],
                branch_row,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("branch {id}")))
    }

    fn list(&self, document_id: &str) -> Result<Vec<DocumentBranch>> {
        let mut s = self.0.prepare(
            "SELECT * FROM document_branches WHERE document_id = ?1 ORDER BY created_at, name",
        )?;
        let rows = s
            .query_map([document_id], branch_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn update_content(&self, id: &str, content: &str) -> Result<DocumentBranch> {
        let b = self.get(id)?;
        if matches!(b.status, BranchStatus::Merged | BranchStatus::Rejected) {
            return Err(Error::Conflict(format!(
                "branch is {}; content is frozen",
                b.status
            )));
        }
        self.0.execute(
            "UPDATE document_branches SET content = ?2 WHERE id = ?1",
            params![id, content],
        )?;
        self.get(id)
    }

    fn set_status(
        &self,
        id: &str,
        status: BranchStatus,
        reviewer_id: Option<&str>,
    ) -> Result<DocumentBranch> {
        let b = self.get(id)?;
        if !transition_allowed(b.status, status) {
            return Err(Error::Conflict(format!(
                "cannot move branch from {} to {}",
                b.status, status
            )));
        }
        self.0
            .execute(
                "UPDATE document_branches SET status = ?2, reviewed_by_id = COALESCE(?3, reviewed_by_id) WHERE id = ?1",
                params![id, status, reviewer_id],
            )
            .map_err(db_err)?;
        self.get(id)
    }

    fn merge(&self, id: &str, merger_id: &str, strategy: MergeStrategy) -> Result<DocumentVersion> {
        let b = self.get(id)?;
        if b.status != BranchStatus::Approved {
            return Err(Error::Conflict(format!(
                "branch must be approved to merge (is {})",
                b.status
            )));
        }
        let docs = SqliteDocuments::new(self.0);
        let latest = docs.latest_version(&b.document_id)?;
        if latest.id != b.base_version_id && strategy == MergeStrategy::FailIfDiverged {
            return Err(Error::Conflict(format!(
                "document advanced to version {} since the branch was forked",
                latest.version
            )));
        }
        let msg = format!("Merge branch {}", b.name);
        let v = docs.save_content(&b.document_id, &b.content, Some(&msg), merger_id)?;
        self.0
            .execute(
                "UPDATE document_branches SET status = 'merged', merged_at = ?2, reviewed_by_id = COALESCE(reviewed_by_id, ?3) WHERE id = ?1",
                params![id, now_ms(), merger_id],
            )
            .map_err(db_err)?;
        Ok(v)
    }
}
