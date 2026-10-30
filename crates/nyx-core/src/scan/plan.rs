//! Scan planning: compare a repository listing with the manifest of the last scan.
//!
//! Incremental re-scan is by revision token. When the source reports a per-file `sha` (blob sha /
//! content hash) an unchanged file is recognised from the listing alone and never fetched. When it
//! does not (current provider trees carry no blob sha) every known file is planned as
//! [`PlannedFile::needs_verify`] and the indexer compares a content hash after reading it, which
//! saves chunking, embedding and credits but not the fetch. A repo-level `head_token` match skips
//! the listing entirely.

use std::collections::{BTreeMap, BTreeSet};

use super::filter::{Decision, FileFilter, Language, SkipReason};
use super::source::SourceEntry;
use super::store::ManifestEntry;

/// Default cap on files indexed per repository (TS `MAX_FILES`).
pub const DEFAULT_MAX_FILES: usize = 200;

/// A file that needs (re)indexing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedFile {
    /// Repo-relative path.
    pub path: String,
    /// Size when known.
    pub size: Option<u64>,
    /// Revision token from the listing, when known.
    pub sha: Option<String>,
    /// Detected language.
    pub language: Language,
    /// True when the file is in the manifest and the listing cannot prove it changed: the indexer
    /// must read it and compare tokens before doing any work.
    pub needs_verify: bool,
}

/// Result of [`plan_scan`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanPlan {
    /// Files not seen before.
    pub added: Vec<PlannedFile>,
    /// Known files whose token differs or cannot be compared.
    pub modified: Vec<PlannedFile>,
    /// Known files proven unchanged by token.
    pub unchanged: Vec<String>,
    /// In the manifest but gone from the listing, or now filtered out.
    pub removed: Vec<String>,
    /// Listed files rejected by the filter.
    pub skipped: Vec<(String, SkipReason)>,
    /// Eligible files dropped because of the `max_files` cap.
    pub over_limit: Vec<String>,
}

impl ScanPlan {
    /// Files that must be read.
    pub fn to_index(&self) -> impl Iterator<Item = &PlannedFile> {
        self.added.iter().chain(self.modified.iter())
    }

    /// True if nothing needs reading or deleting.
    #[must_use]
    pub fn is_noop(&self) -> bool {
        self.added.is_empty() && self.modified.is_empty() && self.removed.is_empty()
    }
}

/// Sampling priority when a repo has more eligible files than `max_files`: shallow paths first
/// (entry points, READMEs, top-level config), then lexicographic. Deterministic, so successive
/// scans of an unchanged tree choose the same files.
fn priority_key(path: &str) -> (usize, String) {
    (path.matches('/').count(), path.to_string())
}

/// Build the plan.
#[must_use]
pub fn plan_scan(
    entries: &[SourceEntry],
    manifest: &BTreeMap<String, ManifestEntry>,
    filter: &FileFilter,
    max_files: usize,
) -> ScanPlan {
    let mut plan = ScanPlan::default();
    let mut eligible: Vec<(&SourceEntry, Language)> = Vec::new();
    for e in entries {
        match filter.check_path(&e.path, e.size) {
            Decision::Include(l) => eligible.push((e, l)),
            Decision::Skip(r) => plan.skipped.push((e.path.clone(), r)),
        }
    }
    eligible.sort_by_key(|(e, _)| priority_key(&e.path));
    if eligible.len() > max_files {
        plan.over_limit = eligible[max_files..]
            .iter()
            .map(|(e, _)| e.path.clone())
            .collect();
        eligible.truncate(max_files);
    }

    let mut kept: BTreeSet<&str> = BTreeSet::new();
    for (e, language) in eligible {
        kept.insert(e.path.as_str());
        let planned = |needs_verify| PlannedFile {
            path: e.path.clone(),
            size: e.size,
            sha: e.sha.clone(),
            language,
            needs_verify,
        };
        match manifest.get(&e.path) {
            None => plan.added.push(planned(false)),
            Some(m) => match &e.sha {
                Some(sha) if *sha == m.fingerprint => plan.unchanged.push(e.path.clone()),
                Some(_) => plan.modified.push(planned(false)),
                None => {
                    // No token. A different size proves a change; equal size needs a read.
                    let proven = e.size.is_some_and(|s| s != m.size);
                    plan.modified.push(planned(!proven));
                }
            },
        }
    }
    plan.removed = manifest
        .keys()
        .filter(|p| !kept.contains(p.as_str()))
        .cloned()
        .collect();
    plan.skipped.sort_by(|a, b| a.0.cmp(&b.0));
    plan
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn entry(path: &str, size: u64, sha: Option<&str>) -> SourceEntry {
        SourceEntry {
            path: path.into(),
            size: Some(size),
            sha: sha.map(str::to_string),
        }
    }

    fn man(path: &str, fp: &str, size: u64) -> (String, ManifestEntry) {
        (
            path.into(),
            ManifestEntry {
                path: path.into(),
                fingerprint: fp.into(),
                size,
                language: "rust".into(),
                chunk_count: 1,
            },
        )
    }

    #[test]
    fn classifies_added_modified_unchanged_removed() {
        let manifest: BTreeMap<_, _> = [
            man("same.rs", "s1", 10),
            man("changed.rs", "c1", 10),
            man("gone.rs", "g1", 10),
            man("now_ignored.rs", "i1", 10),
        ]
        .into();
        let entries = vec![
            entry("same.rs", 10, Some("s1")),
            entry("changed.rs", 11, Some("c2")),
            entry("new.rs", 5, Some("n1")),
            entry("node_modules/now_ignored.rs", 1, None),
            entry("logo.png", 1, None),
        ];
        let p = plan_scan(&entries, &manifest, &FileFilter::for_index(), 200);
        assert_eq!(p.unchanged, vec!["same.rs"]);
        assert_eq!(p.modified.len(), 1);
        assert_eq!(p.modified[0].path, "changed.rs");
        assert!(!p.modified[0].needs_verify);
        assert_eq!(p.added[0].path, "new.rs");
        assert_eq!(p.removed, vec!["gone.rs", "now_ignored.rs"]);
        assert_eq!(p.skipped.len(), 2);
        assert!(!p.is_noop());
    }

    #[test]
    fn missing_tokens_need_verification_unless_size_differs() {
        let manifest: BTreeMap<_, _> = [man("a.rs", "x", 10), man("b.rs", "y", 10)].into();
        let entries = vec![entry("a.rs", 10, None), entry("b.rs", 12, None)];
        let p = plan_scan(&entries, &manifest, &FileFilter::for_index(), 200);
        let a = p.modified.iter().find(|f| f.path == "a.rs").unwrap();
        let b = p.modified.iter().find(|f| f.path == "b.rs").unwrap();
        assert!(a.needs_verify);
        assert!(!b.needs_verify);
    }

    #[test]
    fn identical_listing_is_a_noop() {
        let manifest: BTreeMap<_, _> = [man("a.rs", "x", 10)].into();
        let p = plan_scan(
            &[entry("a.rs", 10, Some("x"))],
            &manifest,
            &FileFilter::for_index(),
            200,
        );
        assert!(p.is_noop());
        assert_eq!(p.to_index().count(), 0);
    }

    #[test]
    fn cap_prefers_shallow_paths_and_is_deterministic() {
        let entries = vec![
            entry("a/b/c/deep.rs", 1, None),
            entry("main.rs", 1, None),
            entry("src/lib.rs", 1, None),
            entry("README.md", 1, None),
        ];
        let p = plan_scan(&entries, &BTreeMap::new(), &FileFilter::for_index(), 2);
        let kept: Vec<&str> = p.added.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(kept, vec!["README.md", "main.rs"]);
        assert_eq!(p.over_limit, vec!["src/lib.rs", "a/b/c/deep.rs"]);
    }
}
