//! Where a scan reads files from: a git host, a local folder (offline) or memory (tests).
//!
//! [`RepoSource`] is the seam between the scan pipeline and file access. Entries carry an
//! optional *revision token* (`sha`): the git blob sha when the source knows it (local folders
//! and in-memory sources compute it without any network), so unchanged files are detected from
//! the listing alone. Git hosts report the blob sha in the tree (`git-blob:<sha>`), so unchanged
//! files are skipped without being fetched. Sources that cannot know it (Bitbucket Cloud) return
//! `None` and the indexer falls back to a content hash after fetching.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::git_provider::{GitProvider, TreeEntryKind};
use crate::security::WorkspaceJail;

/// One file in a repository listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceEntry {
    /// Repo-relative path with `/` separators.
    pub path: String,
    /// Size in bytes when known.
    pub size: Option<u64>,
    /// Revision token of the content (blob sha / content hash) when known without reading it.
    pub sha: Option<String>,
}

/// Read access to one repository snapshot.
pub trait RepoSource: Send + Sync {
    /// Token identifying the whole snapshot (commit / tree sha). Equal tokens mean nothing changed.
    fn head_token(&self) -> Result<Option<String>>;
    /// All files (not directories) in the snapshot.
    fn list(&self) -> Result<Vec<SourceEntry>>;
    /// Raw bytes of one file.
    fn read(&self, path: &str) -> Result<Vec<u8>>;
}

/// Git blob id (`sha1("blob <len>\0" + data)`) is what git itself reports. We only depend on
/// sha2, so local sources use a prefixed SHA-256 of the content instead; it plays the same role
/// (stable revision token) and is documented as such.
#[must_use]
pub fn content_token(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

// ---------------------------------------------------------------- git provider

/// [`RepoSource`] over any [`GitProvider`] (GitHub, GitLab, Bitbucket).
pub struct GitProviderSource<'a> {
    provider: &'a dyn GitProvider,
    owner: String,
    repo: String,
    git_ref: Option<String>,
}

impl<'a> GitProviderSource<'a> {
    /// Build a source for `owner/repo` at `git_ref` (default branch when `None`).
    #[must_use]
    pub fn new(
        provider: &'a dyn GitProvider,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
    ) -> Self {
        Self {
            provider,
            owner: owner.to_string(),
            repo: repo.to_string(),
            git_ref: git_ref.map(str::to_string),
        }
    }
}

impl RepoSource for GitProviderSource<'_> {
    fn head_token(&self) -> Result<Option<String>> {
        let commits =
            self.provider
                .list_commits(&self.owner, &self.repo, self.git_ref.as_deref(), 1)?;
        Ok(commits.into_iter().next().map(|c| c.sha))
    }

    fn list(&self) -> Result<Vec<SourceEntry>> {
        let tree = self
            .provider
            .get_file_tree(&self.owner, &self.repo, self.git_ref.as_deref())?;
        Ok(tree
            .into_iter()
            .filter(|e| e.kind == TreeEntryKind::Blob)
            .map(|e| SourceEntry {
                path: e.path,
                size: e.size,
                // Namespaced so it can never collide with a `sha256:` content token.
                sha: e.sha.map(|s| format!("git-blob:{s}")),
            })
            .collect())
    }

    fn read(&self, path: &str) -> Result<Vec<u8>> {
        let f = self.provider.get_file_content(
            &self.owner,
            &self.repo,
            path,
            self.git_ref.as_deref(),
        )?;
        Ok(f.decode()?)
    }
}

// ---------------------------------------------------------------- local folder

/// [`RepoSource`] over a local directory. Works fully offline. Symlinks are never followed and all
/// reads go through a [`WorkspaceJail`].
pub struct LocalFolderSource {
    jail: WorkspaceJail,
    ignored_dirs: Vec<String>,
}

impl LocalFolderSource {
    /// Open `root`. Directories named in [`super::filter::IGNORED_DIRS`] are not descended into
    /// (this keeps `node_modules` / `target` walks cheap).
    ///
    /// # Errors
    /// [`Error::Invalid`] when `root` is not a directory.
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        Ok(Self {
            jail: WorkspaceJail::new(root)?,
            ignored_dirs: super::filter::IGNORED_DIRS
                .iter()
                .map(|s| (*s).to_string())
                .collect(),
        })
    }

    fn walk(&self, dir: &Path, out: &mut Vec<SourceEntry>) -> Result<()> {
        let mut names: Vec<PathBuf> = fs::read_dir(dir)?
            .filter_map(std::result::Result::ok)
            .map(|e| e.path())
            .collect();
        names.sort();
        for p in names {
            let meta = fs::symlink_metadata(&p)?;
            if meta.file_type().is_symlink() {
                continue;
            }
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or_default();
            if meta.is_dir() {
                if self.ignored_dirs.iter().any(|d| d == name) {
                    continue;
                }
                self.walk(&p, out)?;
            } else if meta.is_file() {
                let Ok(rel) = p.strip_prefix(self.jail.root()) else {
                    continue;
                };
                let Some(rel) = rel.to_str() else { continue };
                out.push(SourceEntry {
                    path: rel.replace(std::path::MAIN_SEPARATOR, "/"),
                    size: Some(meta.len()),
                    sha: None,
                });
            }
        }
        Ok(())
    }
}

impl RepoSource for LocalFolderSource {
    fn head_token(&self) -> Result<Option<String>> {
        // A folder has no commit; every scan lists and compares per file.
        Ok(None)
    }

    fn list(&self) -> Result<Vec<SourceEntry>> {
        let mut out = Vec::new();
        self.walk(self.jail.root(), &mut out)?;
        Ok(out)
    }

    fn read(&self, path: &str) -> Result<Vec<u8>> {
        self.jail.read(path)
    }
}

// ---------------------------------------------------------------- in memory

/// In-memory repository for tests and fixtures. Entries get a content-derived `sha`, like a
/// local checkout would; set [`MemorySource::hide_shas`] to behave like a provider tree without
/// blob shas. Reads can be made to fail to exercise retry paths.
#[derive(Default)]
pub struct MemorySource {
    state: Mutex<MemState>,
}

#[derive(Default)]
struct MemState {
    files: BTreeMap<String, Vec<u8>>,
    head: Option<String>,
    hide_shas: bool,
    failing: BTreeMap<String, u32>,
    reads: Vec<String>,
}

impl MemorySource {
    /// Empty repo.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn st(&self) -> std::sync::MutexGuard<'_, MemState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Add or replace a file.
    pub fn put(&self, path: &str, content: impl AsRef<[u8]>) {
        self.st()
            .files
            .insert(path.to_string(), content.as_ref().to_vec());
    }

    /// Delete a file.
    pub fn remove(&self, path: &str) {
        self.st().files.remove(path);
    }

    /// Set the snapshot token returned by [`RepoSource::head_token`].
    pub fn set_head(&self, head: Option<&str>) {
        self.st().head = head.map(str::to_string);
    }

    /// Do not report per-file shas in listings.
    pub fn hide_shas(&self, hide: bool) {
        self.st().hide_shas = hide;
    }

    /// Make the next `times` reads of `path` fail.
    pub fn fail_reads(&self, path: &str, times: u32) {
        self.st().failing.insert(path.to_string(), times);
    }

    /// Paths read so far, in order.
    #[must_use]
    pub fn reads(&self) -> Vec<String> {
        self.st().reads.clone()
    }

    /// Forget recorded reads.
    pub fn clear_reads(&self) {
        self.st().reads.clear();
    }
}

impl RepoSource for MemorySource {
    fn head_token(&self) -> Result<Option<String>> {
        Ok(self.st().head.clone())
    }

    fn list(&self) -> Result<Vec<SourceEntry>> {
        let st = self.st();
        Ok(st
            .files
            .iter()
            .map(|(p, c)| SourceEntry {
                path: p.clone(),
                size: Some(c.len() as u64),
                sha: (!st.hide_shas).then(|| content_token(c)),
            })
            .collect())
    }

    fn read(&self, path: &str) -> Result<Vec<u8>> {
        let mut st = self.st();
        st.reads.push(path.to_string());
        if let Some(n) = st.failing.get_mut(path) {
            if *n > 0 {
                *n -= 1;
                return Err(Error::Invalid(format!("simulated read failure for {path}")));
            }
        }
        st.files
            .get(path)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("file {path}")))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn local_folder_lists_relative_paths_and_skips_ignored_dirs() {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir_all(d.path().join("src")).unwrap();
        fs::create_dir_all(d.path().join("node_modules/x")).unwrap();
        fs::write(d.path().join("src/a.rs"), "fn a() {}").unwrap();
        fs::write(d.path().join("README.md"), "hi").unwrap();
        fs::write(d.path().join("node_modules/x/i.js"), "x").unwrap();
        let s = LocalFolderSource::new(d.path()).unwrap();
        let paths: Vec<String> = s.list().unwrap().into_iter().map(|e| e.path).collect();
        assert_eq!(paths, vec!["README.md", "src/a.rs"]);
        assert_eq!(s.read("src/a.rs").unwrap(), b"fn a() {}");
        assert!(s.read("../outside").is_err());
        assert_eq!(s.head_token().unwrap(), None);
    }

    #[cfg(unix)]
    #[test]
    fn local_folder_does_not_follow_symlinks() {
        let d = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.rs"), "secret").unwrap();
        std::os::unix::fs::symlink(outside.path(), d.path().join("link")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.rs"), d.path().join("s.rs"))
            .unwrap();
        let s = LocalFolderSource::new(d.path()).unwrap();
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn memory_source_tokens_follow_content() {
        let m = MemorySource::new();
        m.put("a.rs", "one");
        let a = m.list().unwrap()[0].sha.clone();
        m.put("a.rs", "two");
        assert_ne!(a, m.list().unwrap()[0].sha);
        m.hide_shas(true);
        assert_eq!(m.list().unwrap()[0].sha, None);
    }
}
