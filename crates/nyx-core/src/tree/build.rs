//! Pure tree construction: explicit folders + documents become one ordered tree. Folders implied
//! only by document paths (or by deeper folders) are materialised as `implicit` nodes.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::path::{self, ROOT};

/// An explicit folder row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FolderEntry {
    /// Folder id.
    pub id: String,
    /// Normalised absolute path.
    pub path: String,
    /// Manual order among siblings.
    pub sort_order: i64,
}

/// The slice of a document the tree needs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocEntry {
    /// Document id.
    pub id: String,
    /// Title (display name).
    pub title: String,
    /// Containing folder path (any legacy spelling; normalised on build).
    pub path: String,
    /// Lifecycle stage slug.
    pub stage: Option<String>,
    /// Manual order among siblings.
    pub sort_order: i64,
}

/// Node kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    /// A folder (or the root).
    Folder,
    /// A document leaf.
    Document,
}

/// One node of the tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TreeNode {
    /// Folder or document.
    pub kind: NodeKind,
    /// Folder row id or document id; `None` for implicit folders and the root.
    pub id: Option<String>,
    /// Display name (folder name, document title; empty for the root).
    pub name: String,
    /// Folder path; for documents, the path of the containing folder.
    pub path: String,
    /// Stage slug (documents only).
    pub stage: Option<String>,
    /// Manual order among siblings.
    pub sort_order: i64,
    /// True for folders that exist only because something lives beneath them.
    pub implicit: bool,
    /// Children, already ordered: folders first, then documents; each by `(sort_order, name)`.
    pub children: Vec<TreeNode>,
}

impl TreeNode {
    fn folder(path: &str) -> Self {
        Self {
            kind: NodeKind::Folder,
            id: None,
            name: path::name(path).into(),
            path: path.into(),
            stage: None,
            sort_order: 0,
            implicit: true,
            children: Vec::new(),
        }
    }

    /// Find a folder node by normalised path in this subtree.
    #[must_use]
    pub fn find_folder(&self, folder_path: &str) -> Option<&TreeNode> {
        if self.kind != NodeKind::Folder {
            return None;
        }
        if self.path == folder_path {
            return Some(self);
        }
        if !path::is_ancestor_or_self(&self.path, folder_path) {
            return None;
        }
        self.children
            .iter()
            .find_map(|c| c.find_folder(folder_path))
    }

    /// Ids of every document in this subtree, in tree (display) order.
    #[must_use]
    pub fn document_ids(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.walk(&mut |n| {
            if n.kind == NodeKind::Document {
                out.extend(n.id.clone());
            }
        });
        out
    }

    /// Paths of every folder in this subtree including itself, in pre-order.
    #[must_use]
    pub fn folder_paths(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.walk(&mut |n| {
            if n.kind == NodeKind::Folder {
                out.push(n.path.clone());
            }
        });
        out
    }

    /// Pre-order visit.
    pub fn walk(&self, f: &mut impl FnMut(&TreeNode)) {
        f(self);
        for c in &self.children {
            c.walk(f);
        }
    }

    /// Total number of nodes below (not counting) this one.
    #[must_use]
    pub fn descendant_count(&self) -> usize {
        self.children.iter().map(|c| 1 + c.descendant_count()).sum()
    }
}

fn sort_key(n: &TreeNode) -> (u8, i64, String, String) {
    (
        u8::from(n.kind == NodeKind::Document),
        n.sort_order,
        n.name.to_lowercase(),
        format!("{}\u{0}{}", n.name, n.id.as_deref().unwrap_or("")),
    )
}

fn sort_rec(node: &mut TreeNode) {
    node.children.sort_by_key(sort_key);
    for c in &mut node.children {
        sort_rec(c);
    }
}

/// Build the ordered tree rooted at `/`.
///
/// Folders with unusable paths are ignored; documents with unusable paths land in the root.
#[must_use]
pub fn build_tree(folders: &[FolderEntry], docs: &[DocEntry]) -> TreeNode {
    let mut by_path: BTreeMap<String, TreeNode> = BTreeMap::new();
    let mut root = TreeNode::folder(ROOT);

    let ensure = |p: &str, by_path: &mut BTreeMap<String, TreeNode>| {
        for step in path::chain(p) {
            by_path
                .entry(step.clone())
                .or_insert_with(|| TreeNode::folder(&step));
        }
    };

    for f in folders {
        let Ok(p) = path::normalize(&f.path) else {
            continue;
        };
        if p == ROOT {
            continue;
        }
        ensure(&p, &mut by_path);
        if let Some(n) = by_path.get_mut(&p) {
            n.id = Some(f.id.clone());
            n.sort_order = f.sort_order;
            n.implicit = false;
        }
    }
    for d in docs {
        ensure(&path::normalize_lenient(&d.path), &mut by_path);
    }

    // Attach deepest folders first so each child is complete before its parent takes it.
    let mut paths: Vec<String> = by_path.keys().cloned().collect();
    paths.sort_by_key(|p| std::cmp::Reverse(p.matches('/').count()));
    for d in docs {
        let p = path::normalize_lenient(&d.path);
        let leaf = TreeNode {
            kind: NodeKind::Document,
            id: Some(d.id.clone()),
            name: d.title.clone(),
            path: p.clone(),
            stage: d.stage.clone(),
            sort_order: d.sort_order,
            implicit: false,
            children: Vec::new(),
        };
        match by_path.get_mut(&p) {
            Some(n) => n.children.push(leaf),
            None => root.children.push(leaf),
        }
    }
    for p in paths {
        let Some(node) = by_path.remove(&p) else {
            continue;
        };
        let parent_path = path::parent(&p).unwrap_or_else(|| ROOT.into());
        match by_path.get_mut(&parent_path) {
            Some(parent) => parent.children.push(node),
            None => root.children.push(node),
        }
    }
    sort_rec(&mut root);
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(id: &str, p: &str, o: i64) -> FolderEntry {
        FolderEntry {
            id: id.into(),
            path: p.into(),
            sort_order: o,
        }
    }
    fn d(id: &str, title: &str, p: &str, o: i64) -> DocEntry {
        DocEntry {
            id: id.into(),
            title: title.into(),
            path: p.into(),
            stage: None,
            sort_order: o,
        }
    }

    #[test]
    fn folders_first_then_alphabetical_case_insensitive() {
        let t = build_tree(
            &[f("1", "/beta", 0), f("2", "/Alpha", 0)],
            &[d("a", "zed", "/", 0), d("b", "Apple", "/", 0)],
        );
        let names: Vec<_> = t.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "beta", "Apple", "zed"]);
    }

    #[test]
    fn sort_order_beats_name() {
        let t = build_tree(&[f("1", "/a", 2), f("2", "/b", 1)], &[]);
        let names: Vec<_> = t.children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["b", "a"]);
    }

    #[test]
    fn implicit_folders_come_from_documents_and_deep_folders() {
        let t = build_tree(&[f("1", "/x/y/z", 0)], &[d("a", "Doc", "/p/q", 0)]);
        let x = t.find_folder("/x").unwrap();
        assert!(x.implicit && x.id.is_none());
        let z = t.find_folder("/x/y/z").unwrap();
        assert!(!z.implicit);
        assert_eq!(t.find_folder("/p/q").unwrap().children[0].name, "Doc");
        assert!(t.find_folder("/nope").is_none());
        assert!(t.find_folder("/Apple").is_none());
    }

    #[test]
    fn legacy_paths_are_normalised_and_bad_ones_go_to_root() {
        let t = build_tree(
            &[],
            &[
                d("a", "A", "a//b/", 0),
                d("b", "B", "/../x", 0),
                d("c", "C", "", 0),
            ],
        );
        assert_eq!(t.find_folder("/a/b").unwrap().document_ids(), ["a"]);
        let root_docs: Vec<_> = t
            .children
            .iter()
            .filter(|c| c.kind == NodeKind::Document)
            .map(|c| c.id.clone().unwrap())
            .collect();
        assert_eq!(root_docs, ["b", "c"]);
    }

    #[test]
    fn subtree_queries() {
        let t = build_tree(
            &[f("1", "/a", 0), f("2", "/a/b", 0)],
            &[
                d("1", "One", "/a", 0),
                d("2", "Two", "/a/b", 0),
                d("3", "Out", "/", 0),
            ],
        );
        let a = t.find_folder("/a").unwrap();
        assert_eq!(a.document_ids(), ["2", "1"]);
        assert_eq!(a.folder_paths(), ["/a", "/a/b"]);
        assert_eq!(a.descendant_count(), 3);
        assert_eq!(t.document_ids(), ["2", "1", "3"]);
    }
}
