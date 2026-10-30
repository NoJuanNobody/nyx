//! SQLite-backed folder operations over `folders` + `documents`.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::build::{build_tree, DocEntry, FolderEntry, NodeKind, TreeNode};
use super::path::{self, ROOT};
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Document};
use crate::store::db_err;

/// What to do with a folder's contents on delete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeletePolicy {
    /// Fail with [`Error::Conflict`] when anything lives inside.
    RefuseIfNotEmpty,
    /// Remove sub-folders and soft-delete every contained document.
    Cascade,
}

/// Outcome of [`SqliteTree::delete_folder`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DeleteReport {
    /// Explicit folder rows removed (the folder itself and its sub-folders).
    pub folders_removed: usize,
    /// Documents soft-deleted.
    pub documents_deleted: usize,
}

/// A sibling to place in [`SqliteTree::reorder`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChildRef {
    /// A child folder, by path.
    Folder(String),
    /// A child document, by id.
    Document(String),
}

/// What a path points at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolved {
    /// The root.
    Root,
    /// A folder (explicit row or implied by contents).
    Folder {
        /// Normalised path.
        path: String,
        /// Row id when the folder is explicit.
        id: Option<String>,
    },
    /// A document addressed as `<folder path>/<title>`.
    Document(Document),
}

/// Explicit folder row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Folder {
    /// Id.
    pub id: String,
    /// Owning team.
    pub team_id: String,
    /// Normalised path.
    pub path: String,
    /// Manual order among siblings.
    pub sort_order: i64,
    /// Creation time.
    pub created_at: i64,
    /// Last update time.
    pub updated_at: i64,
}

/// Folder/document tree operations. Borrows a connection (or a transaction); every multi-row
/// operation runs inside a savepoint, so it is atomic and also composes inside an outer
/// transaction.
#[derive(Debug, Clone, Copy)]
pub struct SqliteTree<'c>(&'c Connection);

impl<'c> SqliteTree<'c> {
    /// Wrap a connection.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    fn atomic<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        self.0.execute_batch("SAVEPOINT nyx_tree")?;
        match f() {
            Ok(v) => {
                self.0.execute_batch("RELEASE nyx_tree")?;
                Ok(v)
            }
            Err(e) => {
                let _ = self
                    .0
                    .execute_batch("ROLLBACK TO nyx_tree; RELEASE nyx_tree");
                Err(e)
            }
        }
    }

    // ---- reads ----

    /// The full ordered tree of a team (live documents only).
    pub fn tree(&self, team_id: &str) -> Result<TreeNode> {
        Ok(build_tree(
            &self.folder_entries(team_id)?,
            &self.doc_entries(team_id)?,
        ))
    }

    /// The subtree rooted at a folder.
    pub fn subtree(&self, team_id: &str, folder_path: &str) -> Result<TreeNode> {
        let p = path::normalize(folder_path)?;
        self.tree(team_id)?
            .find_folder(&p)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("folder {p}")))
    }

    /// Ids of all live documents under a folder (recursive), in display order.
    pub fn subtree_document_ids(&self, team_id: &str, folder_path: &str) -> Result<Vec<String>> {
        Ok(self.subtree(team_id, folder_path)?.document_ids())
    }

    /// Whether a folder exists, explicitly or because something lives inside it.
    pub fn folder_exists(&self, team_id: &str, folder_path: &str) -> Result<bool> {
        let p = path::normalize(folder_path)?;
        Ok(p == ROOT || self.tree(team_id)?.find_folder(&p).is_some())
    }

    /// Resolve a path to the root, a folder, or a document (`/folder/Title`). Folders win over
    /// documents with the same path. A title shared by several documents is a conflict.
    pub fn resolve(&self, team_id: &str, raw: &str) -> Result<Resolved> {
        let p = path::normalize(raw)?;
        if p == ROOT {
            return Ok(Resolved::Root);
        }
        let tree = self.tree(team_id)?;
        if let Some(n) = tree.find_folder(&p) {
            return Ok(Resolved::Folder {
                path: p,
                id: n.id.clone(),
            });
        }
        let parent = path::parent(&p).unwrap_or_else(|| ROOT.into());
        let title = path::name(&p);
        let hits: Vec<&TreeNode> = tree
            .find_folder(&parent)
            .map(|f| {
                f.children
                    .iter()
                    .filter(|c| c.kind == NodeKind::Document && c.name == title)
                    .collect()
            })
            .unwrap_or_default();
        match hits.as_slice() {
            [] => Err(Error::NotFound(format!("path {p}"))),
            [one] => {
                use crate::store::{DocumentRepo, SqliteDocuments};
                let id = one.id.as_deref().unwrap_or_default();
                Ok(Resolved::Document(SqliteDocuments::new(self.0).get(id)?))
            }
            _ => Err(Error::Conflict(format!("ambiguous path {p}"))),
        }
    }

    /// Explicit folder row by path.
    pub fn get_folder(&self, team_id: &str, folder_path: &str) -> Result<Folder> {
        let p = path::normalize(folder_path)?;
        self.folder_row(team_id, &p)?
            .ok_or_else(|| Error::NotFound(format!("folder {p}")))
    }

    // ---- folder operations ----

    /// Create `name` inside `parent_path`. The parent must exist. Creating a folder that is only
    /// implied by its contents materialises it; an existing explicit folder is a conflict.
    pub fn create_folder(&self, team_id: &str, parent_path: &str, name: &str) -> Result<Folder> {
        let parent = path::normalize(parent_path)?;
        let target = path::join(&parent, path::validate_name(name)?);
        self.atomic(|| {
            if !self.folder_exists(team_id, &parent)? {
                return Err(Error::NotFound(format!("folder {parent}")));
            }
            if self.folder_row(team_id, &target)?.is_some() {
                return Err(Error::Conflict(format!("folder {target} already exists")));
            }
            self.insert_folder(team_id, &target, 0)
        })
    }

    /// `mkdir -p`: create every missing folder along `folder_path`; returns the ones created.
    pub fn ensure_folder_path(&self, team_id: &str, folder_path: &str) -> Result<Vec<Folder>> {
        let p = path::normalize(folder_path)?;
        self.atomic(|| {
            let mut created = Vec::new();
            for step in path::chain(&p) {
                if self.folder_row(team_id, &step)?.is_none() {
                    created.push(self.insert_folder(team_id, &step, 0)?);
                }
            }
            Ok(created)
        })
    }

    /// Rename a folder in place; returns the new path. Descendant folders and the paths of all
    /// documents beneath it follow.
    pub fn rename_folder(
        &self,
        team_id: &str,
        folder_path: &str,
        new_name: &str,
    ) -> Result<String> {
        let old = path::normalize(folder_path)?;
        let parent = path::parent(&old)
            .ok_or_else(|| Error::Invalid("the root cannot be renamed".into()))?;
        let new = path::join(&parent, path::validate_name(new_name)?);
        self.relocate(team_id, &old, &new)
    }

    /// Move a folder under `new_parent`; returns the new path. Moving a folder into itself or one
    /// of its descendants is rejected, as is a name clash at the destination.
    pub fn move_folder(
        &self,
        team_id: &str,
        folder_path: &str,
        new_parent: &str,
    ) -> Result<String> {
        let old = path::normalize(folder_path)?;
        let dest = path::normalize(new_parent)?;
        if old == ROOT {
            return Err(Error::Invalid("the root cannot be moved".into()));
        }
        if path::is_ancestor_or_self(&old, &dest) {
            return Err(Error::Invalid(format!(
                "cannot move {old} into itself or its descendant {dest}"
            )));
        }
        let new = path::join(&dest, path::name(&old));
        self.relocate(team_id, &old, &new)
    }

    /// Delete a folder per `policy`. The root cannot be deleted.
    pub fn delete_folder(
        &self,
        team_id: &str,
        folder_path: &str,
        policy: DeletePolicy,
    ) -> Result<DeleteReport> {
        let p = path::normalize(folder_path)?;
        if p == ROOT {
            return Err(Error::Invalid("the root cannot be deleted".into()));
        }
        self.atomic(|| {
            let tree = self.tree(team_id)?;
            let node = tree
                .find_folder(&p)
                .ok_or_else(|| Error::NotFound(format!("folder {p}")))?;
            if policy == DeletePolicy::RefuseIfNotEmpty && !node.children.is_empty() {
                return Err(Error::Conflict(format!("folder {p} is not empty")));
            }
            let mut report = DeleteReport::default();
            let now = now_ms();
            for id in node.document_ids() {
                report.documents_deleted += self.0.execute(
                    "UPDATE documents SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
                    params![id, now],
                )?;
            }
            for (id, _) in self.rows_under(team_id, &p)? {
                report.folders_removed +=
                    self.0.execute("DELETE FROM folders WHERE id = ?1", [id])?;
            }
            Ok(report)
        })
    }

    // ---- documents ----

    /// Move a document into an existing folder (`/` for the root).
    pub fn move_document(&self, document_id: &str, new_parent: &str) -> Result<Document> {
        use crate::store::{DocumentRepo, SqliteDocuments};
        let dest = path::normalize(new_parent)?;
        let docs = SqliteDocuments::new(self.0);
        let doc = docs.get(document_id)?;
        if doc.deleted_at.is_some() {
            return Err(Error::Conflict(format!(
                "document {document_id} is deleted"
            )));
        }
        if !self.folder_exists(&doc.team_id, &dest)? {
            return Err(Error::NotFound(format!("folder {dest}")));
        }
        docs.update_meta(document_id, None, Some(&dest))
    }

    // ---- ordering ----

    /// Put the listed children of `parent_path` first, in the given order; unlisted children keep
    /// their current relative order after them. Listed entries must be direct children.
    pub fn reorder(&self, team_id: &str, parent_path: &str, order: &[ChildRef]) -> Result<()> {
        let parent = path::normalize(parent_path)?;
        self.atomic(|| {
            let tree = self.tree(team_id)?;
            let node = tree
                .find_folder(&parent)
                .ok_or_else(|| Error::NotFound(format!("folder {parent}")))?;
            let key = |c: &TreeNode| match c.kind {
                NodeKind::Folder => ChildRef::Folder(c.path.clone()),
                NodeKind::Document => ChildRef::Document(c.id.clone().unwrap_or_default()),
            };
            let current: Vec<ChildRef> = node.children.iter().map(key).collect();
            let mut final_order: Vec<ChildRef> = Vec::with_capacity(current.len());
            for r in order {
                let r = match r {
                    ChildRef::Folder(p) => ChildRef::Folder(path::normalize(p)?),
                    other @ ChildRef::Document(_) => other.clone(),
                };
                if !current.contains(&r) {
                    return Err(Error::Invalid(format!("{r:?} is not a child of {parent}")));
                }
                if final_order.contains(&r) {
                    return Err(Error::Invalid(format!("{r:?} listed twice")));
                }
                final_order.push(r);
            }
            let rest: Vec<ChildRef> = current
                .iter()
                .filter(|c| !final_order.contains(c))
                .cloned()
                .collect();
            final_order.extend(rest);

            let now = now_ms();
            for (i, r) in final_order.iter().enumerate() {
                let i = i64::try_from(i).unwrap_or(i64::MAX);
                match r {
                    ChildRef::Folder(p) => {
                        if self.folder_row(team_id, p)?.is_none() {
                            self.insert_folder(team_id, p, i)?;
                        } else {
                            self.0.execute(
                                "UPDATE folders SET sort_order = ?3, updated_at = ?4 WHERE team_id = ?1 AND path = ?2",
                                params![team_id, p, i, now],
                            )?;
                        }
                    }
                    ChildRef::Document(id) => {
                        self.0.execute(
                            "UPDATE documents SET sort_order = ?2 WHERE id = ?1",
                            params![id, i],
                        )?;
                    }
                }
            }
            Ok(())
        })
    }

    // ---- internals ----

    fn relocate(&self, team_id: &str, old: &str, new: &str) -> Result<String> {
        if old == new {
            return Ok(new.into());
        }
        self.atomic(|| {
            if !self.folder_exists(team_id, old)? {
                return Err(Error::NotFound(format!("folder {old}")));
            }
            let parent = path::parent(new).unwrap_or_else(|| ROOT.into());
            if !self.folder_exists(team_id, &parent)? {
                return Err(Error::NotFound(format!("folder {parent}")));
            }
            if self.folder_exists(team_id, new)? {
                return Err(Error::Conflict(format!("folder {new} already exists")));
            }
            // Materialise the folder so its identity (and order) survives even when implicit.
            if self.folder_row(team_id, old)?.is_none() {
                self.insert_folder(team_id, old, 0)?;
            }
            let now = now_ms();
            for (id, p) in self.rows_under(team_id, old)? {
                if let Some(np) = path::rebase(&p, old, new) {
                    self.0.execute(
                        "UPDATE folders SET path = ?2, updated_at = ?3 WHERE id = ?1",
                        params![id, np, now],
                    )?;
                }
            }
            // Includes soft-deleted documents so a later restore lands in the moved folder.
            let mut s = self.0.prepare(
                "SELECT id, path FROM documents WHERE team_id = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4))",
            )?;
            let docs: Vec<(String, String)> = s
                .query_map(
                    params![team_id, old, format!("{old}/"), format!("{old}0")],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )?
                .collect::<std::result::Result<_, _>>()?;
            for (id, p) in docs {
                if let Some(np) = path::rebase(&p, old, new) {
                    self.0.execute(
                        "UPDATE documents SET path = ?2, updated_at = ?3 WHERE id = ?1",
                        params![id, np, now],
                    )?;
                }
            }
            Ok(new.to_string())
        })
    }

    /// `(id, path)` of explicit folder rows equal to or under `p`.
    fn rows_under(&self, team_id: &str, p: &str) -> Result<Vec<(String, String)>> {
        // '0' is the character after '/', so [p/, p0) is exactly the descendants of p.
        let mut s = self.0.prepare(
            "SELECT id, path FROM folders WHERE team_id = ?1 AND (path = ?2 OR (path >= ?3 AND path < ?4)) ORDER BY path",
        )?;
        let rows = s
            .query_map(params![team_id, p, format!("{p}/"), format!("{p}0")], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn folder_row(&self, team_id: &str, p: &str) -> Result<Option<Folder>> {
        Ok(self
            .0
            .query_row(
                "SELECT id, team_id, path, sort_order, created_at, updated_at FROM folders WHERE team_id = ?1 AND path = ?2",
                params![team_id, p],
                |r| {
                    Ok(Folder {
                        id: r.get(0)?,
                        team_id: r.get(1)?,
                        path: r.get(2)?,
                        sort_order: r.get(3)?,
                        created_at: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    fn insert_folder(&self, team_id: &str, p: &str, sort_order: i64) -> Result<Folder> {
        let (id, now) = (new_id(), now_ms());
        self.0
            .execute(
                "INSERT INTO folders (id, team_id, path, sort_order, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?5)",
                params![id, team_id, p, sort_order, now],
            )
            .map_err(db_err)?;
        Ok(Folder {
            id,
            team_id: team_id.into(),
            path: p.into(),
            sort_order,
            created_at: now,
            updated_at: now,
        })
    }

    fn folder_entries(&self, team_id: &str) -> Result<Vec<FolderEntry>> {
        let mut s = self
            .0
            .prepare("SELECT id, path, sort_order FROM folders WHERE team_id = ?1")?;
        let rows = s
            .query_map([team_id], |r| {
                Ok(FolderEntry {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    sort_order: r.get(2)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn doc_entries(&self, team_id: &str) -> Result<Vec<DocEntry>> {
        let mut s = self.0.prepare(
            "SELECT id, title, path, stage, sort_order FROM documents WHERE team_id = ?1 AND deleted_at IS NULL",
        )?;
        let rows = s
            .query_map([team_id], |r| {
                Ok(DocEntry {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    path: r.get(2)?,
                    stage: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
}
