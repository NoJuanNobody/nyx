//! Local change detection ("file watcher triggers drift check on code change").
//!
//! The core stays free of OS notification APIs: a desktop shell can use any watcher (`notify`,
//! Tauri's fs plugin) as a *wake-up* and call [`Watcher::poll`]; the CLI/MCP can simply poll on a
//! timer. `poll` rescans, hashes file contents and returns a [`ChangeSet`] containing exactly the
//! added, modified and removed paths since the previous poll, with a content-derived run key, so
//! feeding it to [`super::drift::DriftEngine::run`] twice for the same state is a no-op.
//! TODO(AI-74 wiring): hook a `notify` watcher to call `poll` (debounced ~500 ms).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use super::drift::{ChangeSet, CodeSource};
use crate::error::Result;
use crate::security::WorkspaceJail;

/// What to include when scanning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOptions {
    /// Directory names skipped at any depth.
    pub ignore_dirs: Vec<String>,
    /// Files larger than this are ignored.
    pub max_file_bytes: u64,
    /// When set, only files with one of these extensions (without the dot) are tracked.
    pub extensions: Option<Vec<String>>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            ignore_dirs: [
                ".git",
                "node_modules",
                "target",
                "dist",
                "build",
                ".next",
                ".nyx",
            ]
            .map(String::from)
            .to_vec(),
            max_file_bytes: 1024 * 1024,
            extensions: None,
        }
    }
}

/// Path to content-hash map of a tree at one moment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileSnapshot {
    /// Repo-relative `/` paths to sha256 hex.
    pub files: BTreeMap<String, String>,
}

/// Marker hash used for removed files in a change list.
pub const REMOVED: &str = "removed";

fn walk(
    dir: &Path,
    root: &Path,
    opts: &ScanOptions,
    out: &mut BTreeMap<String, String>,
) -> Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<std::io::Result<_>>()?;
    entries.sort_by_key(fs::DirEntry::file_name);
    for e in entries {
        let ft = e.file_type()?;
        if ft.is_symlink() {
            continue; // never follow links out of the tree
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let path = e.path();
        if ft.is_dir() {
            if !opts.ignore_dirs.contains(&name) {
                walk(&path, root, opts, out)?;
            }
        } else if ft.is_file() {
            if let Some(exts) = &opts.extensions {
                let ok = path
                    .extension()
                    .and_then(|x| x.to_str())
                    .is_some_and(|x| exts.iter().any(|w| w.eq_ignore_ascii_case(x)));
                if !ok {
                    continue;
                }
            }
            if e.metadata()?.len() > opts.max_file_bytes {
                continue;
            }
            // A file can vanish between listing and reading; treat that as absent.
            let Ok(bytes) = fs::read(&path) else { continue };
            let rel = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.insert(rel, hex::encode(Sha256::digest(&bytes)));
        }
    }
    Ok(())
}

/// Scan `root`.
pub fn scan(root: &Path, opts: &ScanOptions) -> Result<FileSnapshot> {
    let root = fs::canonicalize(root)?;
    let mut files = BTreeMap::new();
    walk(&root, &root, opts, &mut files)?;
    Ok(FileSnapshot { files })
}

/// Paths that differ between two snapshots with the new hash ([`REMOVED`] for deletions).
#[must_use]
pub fn diff(prev: &FileSnapshot, next: &FileSnapshot) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (p, h) in &next.files {
        if prev.files.get(p) != Some(h) {
            out.push((p.clone(), h.clone()));
        }
    }
    for p in prev.files.keys() {
        if !next.files.contains_key(p) {
            out.push((p.clone(), REMOVED.to_owned()));
        }
    }
    out.sort();
    out
}

/// Poll-based watcher over one directory.
#[derive(Debug)]
pub struct Watcher {
    root: std::path::PathBuf,
    label: String,
    opts: ScanOptions,
    last: Option<FileSnapshot>,
}

impl Watcher {
    /// Watch `root`; `label` namespaces run keys (e.g. the repo name).
    pub fn new(
        root: impl AsRef<Path>,
        label: impl Into<String>,
        opts: ScanOptions,
    ) -> Result<Self> {
        Ok(Self {
            root: fs::canonicalize(root)?,
            label: label.into(),
            opts,
            last: None,
        })
    }

    /// Take the baseline without reporting anything.
    pub fn baseline(&mut self) -> Result<()> {
        self.last = Some(scan(&self.root, &self.opts)?);
        Ok(())
    }

    /// Rescan; `Some(change set)` when anything changed since the previous poll. The first call
    /// without a baseline only records one and returns `None`.
    pub fn poll(&mut self) -> Result<Option<ChangeSet>> {
        let now = scan(&self.root, &self.opts)?;
        let Some(prev) = self.last.replace(now.clone()) else {
            return Ok(None);
        };
        let changes = diff(&prev, &now);
        if changes.is_empty() {
            return Ok(None);
        }
        Ok(Some(ChangeSet::from_watch(&self.label, &changes)))
    }
}

/// [`CodeSource`] over a local checkout, confined by [`WorkspaceJail`] (no `..`, no symlink
/// escapes, size-capped reads).
#[derive(Debug)]
pub struct DirCodeSource(WorkspaceJail);

impl DirCodeSource {
    /// Read files below `root`.
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        Ok(Self(WorkspaceJail::new(root)?))
    }
}

impl CodeSource for DirCodeSource {
    fn read(&self, path: &str) -> Option<String> {
        self.0.read_to_string(path).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, body).unwrap();
    }

    #[test]
    fn scan_ignores_noise_and_hashes_content() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "src/a.rs", "fn a() {}");
        write(d.path(), "node_modules/x/index.js", "x");
        write(d.path(), ".git/HEAD", "ref");
        write(d.path(), "big.bin", &"x".repeat(2000));
        let opts = ScanOptions {
            max_file_bytes: 1000,
            ..Default::default()
        };
        let s = scan(d.path(), &opts).unwrap();
        assert_eq!(s.files.keys().collect::<Vec<_>>(), ["src/a.rs"]);
        let only_md = ScanOptions {
            extensions: Some(vec!["md".into()]),
            ..Default::default()
        };
        assert!(scan(d.path(), &only_md).unwrap().files.is_empty());
    }

    #[test]
    fn diff_reports_added_modified_removed() {
        let a = FileSnapshot {
            files: [("x", "1"), ("y", "2"), ("z", "3")]
                .map(|(k, v)| (k.into(), v.into()))
                .into(),
        };
        let b = FileSnapshot {
            files: [("x", "1"), ("y", "9"), ("w", "4")]
                .map(|(k, v)| (k.into(), v.into()))
                .into(),
        };
        assert_eq!(
            diff(&a, &b),
            [
                ("w".into(), "4".into()),
                ("y".into(), "9".into()),
                ("z".into(), REMOVED.into())
            ]
        );
        assert!(diff(&a, &a).is_empty());
    }

    #[test]
    fn watcher_emits_stable_keys_and_only_on_change() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "a.rs", "1");
        let mut w = Watcher::new(d.path(), "local", ScanOptions::default()).unwrap();
        assert!(
            w.poll().unwrap().is_none(),
            "first poll only records the baseline"
        );
        assert!(w.poll().unwrap().is_none());

        write(d.path(), "a.rs", "2");
        write(d.path(), "b.rs", "new");
        let c1 = w.poll().unwrap().unwrap();
        assert_eq!(c1.changed_files, ["a.rs", "b.rs"]);
        assert!(c1.run_key.starts_with("watch:local:"));
        assert!(w.poll().unwrap().is_none());

        fs::remove_file(d.path().join("b.rs")).unwrap();
        let c2 = w.poll().unwrap().unwrap();
        assert_eq!(c2.changed_files, ["b.rs"]);
        assert_ne!(c1.run_key, c2.run_key);

        // Same content change reproduces the same key (idempotent replay).
        let r1 = ChangeSet::from_watch("local", &[("a.rs".into(), "h".into())]);
        let r2 = ChangeSet::from_watch("local", &[("./a.rs".into(), "h".into())]);
        assert_eq!(r1.run_key, r2.run_key);
    }

    #[test]
    fn dir_code_source_is_jailed() {
        let d = tempfile::tempdir().unwrap();
        write(d.path(), "src/a.rs", "hello");
        let src = DirCodeSource::new(d.path()).unwrap();
        assert_eq!(src.read("src/a.rs").as_deref(), Some("hello"));
        assert!(src.read("../etc/passwd").is_none());
        assert!(src.read("missing.rs").is_none());
    }
}
