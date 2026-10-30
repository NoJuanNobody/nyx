//! Workspace-root jail: every file access made on behalf of an untrusted caller
//! (webview, MCP client, CLI argument) goes through [`WorkspaceJail`].
//!
//! Guarantees (see `docs/security/desktop-threat-model.md`, T-FS-1..3):
//! - lexical rejection of `..`, absolute paths outside the root, NUL, `\`, `:`, Windows prefixes;
//! - the deepest existing ancestor is canonicalised (symlinks resolved) and must stay under the
//!   canonical root, so symlink escapes (file or directory) are refused, including dangling links;
//! - writes go to a temp file in the target directory and are renamed into place.
//!
//! Residual risk: a TOCTOU race between resolve and open if another local process swaps a
//! directory for a symlink concurrently. Same-user attackers are out of scope (threat model, R-2).

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use crate::{Error, Result};

/// Default cap for [`WorkspaceJail::read`] (16 MiB).
pub const DEFAULT_MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

/// A canonical directory that file access cannot escape.
#[derive(Debug, Clone)]
pub struct WorkspaceJail {
    root: PathBuf,
    max_read_bytes: u64,
}

fn deny(msg: &str) -> Error {
    Error::Invalid(format!("path rejected: {msg}"))
}

impl WorkspaceJail {
    /// Create a jail rooted at `root` (must exist and be a directory).
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let root = fs::canonicalize(root.as_ref())?;
        if !root.is_dir() {
            return Err(deny("workspace root is not a directory"));
        }
        Ok(Self {
            root,
            max_read_bytes: DEFAULT_MAX_READ_BYTES,
        })
    }

    /// Override the read size cap.
    #[must_use]
    pub fn with_max_read_bytes(mut self, n: u64) -> Self {
        self.max_read_bytes = n;
        self
    }

    /// Canonical root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Resolve `input` (relative to the root, or absolute and already inside it) to a canonical
    /// path that is guaranteed to live under the root. The target need not exist.
    pub fn resolve(&self, input: impl AsRef<Path>) -> Result<PathBuf> {
        let input = input.as_ref();
        let s = input.to_string_lossy();
        if s.is_empty() {
            return Err(deny("empty path"));
        }
        if s.contains('\0') {
            return Err(deny("NUL byte"));
        }
        let rel: PathBuf = if input.is_absolute() {
            // Compare lexically against the canonical root; `..` is rejected below anyway.
            input
                .strip_prefix(&self.root)
                .map_err(|_| deny("absolute path outside workspace"))?
                .to_path_buf()
        } else {
            input.to_path_buf()
        };

        let mut parts: Vec<&std::ffi::OsStr> = Vec::new();
        for c in rel.components() {
            match c {
                Component::Normal(p) => {
                    let ps = p.to_string_lossy();
                    if ps.contains('\\') || ps.contains(':') {
                        return Err(deny("backslash or colon in component"));
                    }
                    parts.push(p);
                }
                Component::CurDir => {}
                Component::ParentDir => return Err(deny("parent traversal")),
                Component::RootDir | Component::Prefix(_) => return Err(deny("rooted path")),
            }
        }

        // Find the longest existing prefix (symlinks count as existing even if dangling).
        let mut existing = self.root.clone();
        let mut idx = 0;
        while idx < parts.len() {
            let next = existing.join(parts[idx]);
            match fs::symlink_metadata(&next) {
                Ok(_) => {
                    existing = next;
                    idx += 1;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
                Err(e) => return Err(e.into()),
            }
        }
        // Resolves every symlink in the prefix; errors on dangling links => refused.
        let mut canon = fs::canonicalize(&existing)
            .map_err(|_| deny("unresolvable path or dangling symlink"))?;
        if !canon.starts_with(&self.root) {
            return Err(deny("escapes workspace root"));
        }
        for p in &parts[idx..] {
            canon.push(p);
        }
        Ok(canon)
    }

    /// Read a file inside the jail, refusing anything larger than the size cap.
    pub fn read(&self, input: impl AsRef<Path>) -> Result<Vec<u8>> {
        let p = self.resolve(input)?;
        let meta = fs::metadata(&p)?;
        if !meta.is_file() {
            return Err(deny("not a regular file"));
        }
        if meta.len() > self.max_read_bytes {
            return Err(Error::Invalid(format!(
                "file exceeds {} bytes",
                self.max_read_bytes
            )));
        }
        Ok(fs::read(p)?)
    }

    /// Read a UTF-8 file inside the jail.
    pub fn read_to_string(&self, input: impl AsRef<Path>) -> Result<String> {
        String::from_utf8(self.read(input)?)
            .map_err(|_| Error::Invalid("file is not valid UTF-8".into()))
    }

    /// Create a directory (and missing parents) inside the jail.
    pub fn create_dir_all(&self, input: impl AsRef<Path>) -> Result<PathBuf> {
        let p = self.resolve(input)?;
        fs::create_dir_all(&p)?;
        // Re-verify after creation (cheap defence against a raced symlink).
        let c = fs::canonicalize(&p)?;
        if !c.starts_with(&self.root) {
            return Err(deny("escapes workspace root"));
        }
        Ok(c)
    }

    /// Atomically write `bytes` to a file inside the jail (parents created).
    pub fn write(&self, input: impl AsRef<Path>, bytes: &[u8]) -> Result<PathBuf> {
        let target = self.resolve(input)?;
        if target.is_dir() {
            return Err(deny("target is a directory"));
        }
        let parent = target.parent().ok_or_else(|| deny("no parent directory"))?;
        let parent = self.create_dir_all(parent)?;
        let name = target.file_name().ok_or_else(|| deny("no file name"))?;
        let tmp = parent.join(format!(
            ".{}.{}.tmp",
            name.to_string_lossy(),
            crate::model::new_id()
        ));
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
        }
        if let Err(e) = fs::rename(&tmp, &target) {
            let _ = fs::remove_file(&tmp);
            return Err(e.into());
        }
        Ok(target)
    }

    /// Path relative to the root, for display and audit logs.
    pub fn display_relative(&self, resolved: &Path) -> String {
        resolved
            .strip_prefix(&self.root)
            .map_or_else(|_| "<outside>".into(), |p| p.display().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jail() -> (tempfile::TempDir, WorkspaceJail) {
        let d = tempfile::tempdir().unwrap();
        fs::create_dir(d.path().join("ws")).unwrap();
        let j = WorkspaceJail::new(d.path().join("ws")).unwrap();
        (d, j)
    }

    #[test]
    fn reads_and_writes_inside() {
        let (_d, j) = jail();
        j.write("notes/a.md", b"hello").unwrap();
        assert_eq!(j.read_to_string("notes/a.md").unwrap(), "hello");
        assert_eq!(j.read_to_string("./notes/./a.md").unwrap(), "hello");
        let abs = j.root().join("notes/a.md");
        assert_eq!(j.read_to_string(&abs).unwrap(), "hello");
        j.write("notes/a.md", b"v2").unwrap();
        assert_eq!(j.read("notes/a.md").unwrap(), b"v2");
        // No temp files left behind.
        let n = fs::read_dir(j.root().join("notes")).unwrap().count();
        assert_eq!(n, 1);
    }

    #[test]
    fn rejects_traversal_variants() {
        let (d, j) = jail();
        fs::write(d.path().join("secret.txt"), "s").unwrap();
        for bad in [
            "../secret.txt",
            "a/../../secret.txt",
            "..",
            "a/..",
            "/etc/passwd",
            "",
            "a\0b",
            "..\\secret.txt",
            "C:\\Windows\\win.ini",
            "file.txt:stream",
        ] {
            assert!(j.resolve(bad).is_err(), "should reject {bad:?}");
            assert!(j.read(bad).is_err(), "should reject read {bad:?}");
            assert!(j.write(bad, b"x").is_err(), "should reject write {bad:?}");
        }
        let outside = d.path().join("secret.txt");
        assert!(j.read(&outside).is_err());
        // A sibling dir sharing the root's string prefix must not pass starts_with.
        fs::create_dir(d.path().join("ws-evil")).unwrap();
        assert!(j.resolve(d.path().join("ws-evil").join("x")).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "s");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escapes() {
        use std::os::unix::fs::symlink;
        let (d, j) = jail();
        let outside = d.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "s").unwrap();

        symlink(&outside, j.root().join("linkdir")).unwrap();
        symlink(outside.join("secret.txt"), j.root().join("linkfile")).unwrap();
        symlink(
            d.path().join("nonexistent-target"),
            j.root().join("dangling"),
        )
        .unwrap();

        assert!(j.read("linkdir/secret.txt").is_err());
        assert!(j.read("linkfile").is_err());
        assert!(j.write("linkdir/new.txt", b"x").is_err());
        assert!(j.write("linkfile", b"x").is_err());
        assert!(j.write("dangling", b"x").is_err());
        assert!(j.create_dir_all("linkdir/sub").is_err());
        assert!(!outside.join("new.txt").exists());
        assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "s");
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_that_stays_inside() {
        use std::os::unix::fs::symlink;
        let (_d, j) = jail();
        j.write("real/a.txt", b"ok").unwrap();
        symlink(j.root().join("real"), j.root().join("alias")).unwrap();
        assert_eq!(j.read_to_string("alias/a.txt").unwrap(), "ok");
    }

    #[test]
    fn read_cap_and_kind() {
        let (_d, j) = jail();
        let j = j.with_max_read_bytes(4);
        j.write("big", b"12345").unwrap();
        assert!(j.read("big").is_err());
        j.write("small", b"1234").unwrap();
        assert!(j.read("small").is_ok());
        j.create_dir_all("dir").unwrap();
        assert!(j.read("dir").is_err());
        assert!(j.write("dir", b"x").is_err());
        assert!(j.read("missing").is_err());
    }

    #[test]
    fn root_must_be_dir() {
        let d = tempfile::tempdir().unwrap();
        let f = d.path().join("f");
        fs::write(&f, "x").unwrap();
        assert!(WorkspaceJail::new(&f).is_err());
        assert!(WorkspaceJail::new(d.path().join("nope")).is_err());
    }
}
