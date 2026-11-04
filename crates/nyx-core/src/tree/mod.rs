//! Folder / document tree over the store.
//!
//! Documents carry a folder-like `path`; this module adds explicit (possibly empty) folders and a
//! single model for both:
//!
//! - [`path`]: pure path helpers (normalise, parent/join, segment-aware ancestry, rebase).
//! - [`build`]: pure tree construction with deterministic ordering (folders first, then
//!   `(sort_order, name)`), implicit folders, and subtree queries.
//! - [`store`]: [`SqliteTree`] operations: create / rename / move / delete folders (cycle and
//!   name-clash safe, atomic), move documents, resolve paths, reorder siblings.
//!
//! Folders are keyed by `(team_id, path)`; descendants follow a rename or move because paths are
//! rewritten with segment-aware prefix matching (`/A` never matches `/Apple`).

pub mod build;
pub mod path;
pub mod store;

pub use build::{build_tree, DocEntry, FolderEntry, NodeKind, TreeNode};
pub use store::{ChildRef, DeletePolicy, DeleteReport, Folder, Resolved, SqliteTree};
