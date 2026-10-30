//! Documents, versions, branches, snapshots. Drizzle: `documents`, `document_versions`,
//! `document_branches`, `snapshots`.

use serde::{Deserialize, Serialize};

use super::{string_enum, Id, Timestamp};

/// A markdown document with a soft-delete tombstone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Document {
    /// Id.
    pub id: Id,
    /// Title.
    pub title: String,
    /// Current content (head).
    pub content: String,
    /// Folder-like path.
    pub path: String,
    /// Owning team.
    pub team_id: Id,
    /// Creator.
    pub created_by_id: Id,
    /// Lifecycle stage slug (free text, may be `None`).
    pub stage: Option<String>,
    /// Lifecycle.
    pub lifecycle_id: Option<Id>,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last update time.
    pub updated_at: Timestamp,
    /// Soft-delete time; `None` means live.
    pub deleted_at: Option<Timestamp>,
}

/// Input for creating a document. Creating also records version 1.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewDocument {
    /// Title.
    pub title: String,
    /// Initial content.
    pub content: String,
    /// Path (defaults to `/` when empty).
    pub path: String,
    /// Team.
    pub team_id: Id,
    /// Creator.
    pub created_by_id: Id,
    /// Stage slug.
    pub stage: Option<String>,
    /// Lifecycle.
    pub lifecycle_id: Option<Id>,
}

/// Immutable content snapshot of a document; `version` is 1-based and gapless per document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentVersion {
    /// Id.
    pub id: Id,
    /// Document.
    pub document_id: Id,
    /// 1-based version number.
    pub version: i64,
    /// Content at that version.
    pub content: String,
    /// Commit-style message.
    pub message: Option<String>,
    /// Author.
    pub created_by_id: Id,
    /// Creation time.
    pub created_at: Timestamp,
}

string_enum! {
    /// Branch review state. In Drizzle this is free text defaulting to `draft`; the Rust model fixes the set.
    BranchStatus {
        /// Work in progress (default).
        Draft => "draft",
        /// Awaiting review.
        InReview => "in_review",
        /// Approved, not yet merged.
        Approved => "approved",
        /// Rejected.
        Rejected => "rejected",
        /// Merged into the document.
        Merged => "merged",
    }
}

/// A working copy of a document forked from a specific version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentBranch {
    /// Id.
    pub id: Id,
    /// Document.
    pub document_id: Id,
    /// Name, unique per document.
    pub name: String,
    /// Version this branch forked from.
    pub base_version_id: Id,
    /// Branch content.
    pub content: String,
    /// Author.
    pub created_by_id: Id,
    /// Status.
    pub status: BranchStatus,
    /// Reviewer.
    pub reviewed_by_id: Option<Id>,
    /// Creation time.
    pub created_at: Timestamp,
    /// Merge time.
    pub merged_at: Option<Timestamp>,
}

/// Input for creating a branch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewBranch {
    /// Document.
    pub document_id: Id,
    /// Branch name.
    pub name: String,
    /// Version to fork from; `None` forks from the latest.
    pub base_version_id: Option<Id>,
    /// Author.
    pub created_by_id: Id,
}

/// A captured external (code) state attached to a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Snapshot {
    /// Id.
    pub id: Id,
    /// Document.
    pub document_id: Id,
    /// Source integration.
    pub integration_id: Option<Id>,
    /// External reference (commit sha, ref).
    pub external_ref: String,
    /// Captured content.
    pub content: String,
    /// Capture time.
    pub captured_at: Timestamp,
}

/// Input for recording a snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewSnapshot {
    /// Document.
    pub document_id: Id,
    /// Source integration.
    pub integration_id: Option<Id>,
    /// External reference.
    pub external_ref: String,
    /// Captured content.
    pub content: String,
}
