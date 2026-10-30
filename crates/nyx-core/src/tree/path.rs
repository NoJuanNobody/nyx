//! Pure path helpers for the folder tree. Paths are absolute, `/`-separated, case-sensitive and
//! normalised: a leading `/`, no trailing `/`, no empty, `.` or `..` segments. The root is `/`.

use crate::error::{Error, Result};

/// The root path.
pub const ROOT: &str = "/";

/// Longest accepted folder name, in bytes.
pub const MAX_NAME_BYTES: usize = 255;

fn bad_segment(seg: &str) -> bool {
    seg == "." || seg == ".." || seg.chars().any(char::is_control)
}

/// Normalise a path: add the leading `/`, collapse repeated separators, drop the trailing one.
/// Rejects `.`/`..` segments and control characters. `""` normalises to the root.
pub fn normalize(path: &str) -> Result<String> {
    let mut out = String::new();
    for seg in path.split('/').map(str::trim).filter(|s| !s.is_empty()) {
        if bad_segment(seg) {
            return Err(Error::Invalid(format!("invalid path segment {seg:?}")));
        }
        if seg.len() > MAX_NAME_BYTES {
            return Err(Error::Invalid("path segment too long".into()));
        }
        out.push('/');
        out.push_str(seg);
    }
    Ok(if out.is_empty() { ROOT.into() } else { out })
}

/// Like [`normalize`] but falls back to the root for unusable legacy values.
#[must_use]
pub fn normalize_lenient(path: &str) -> String {
    normalize(path).unwrap_or_else(|_| ROOT.into())
}

/// Validate a single folder name (no separators, not `.`/`..`, no control characters).
pub fn validate_name(name: &str) -> Result<&str> {
    let n = name.trim();
    if n.is_empty() {
        return Err(Error::Invalid("folder name is required".into()));
    }
    if n.contains('/') {
        return Err(Error::Invalid("folder name must not contain '/'".into()));
    }
    if bad_segment(n) {
        return Err(Error::Invalid(format!("invalid folder name {n:?}")));
    }
    if n.len() > MAX_NAME_BYTES {
        return Err(Error::Invalid("folder name too long".into()));
    }
    Ok(n)
}

/// Parent of a normalised path; `None` for the root.
#[must_use]
pub fn parent(path: &str) -> Option<String> {
    if path == ROOT {
        return None;
    }
    let i = path.rfind('/')?;
    Some(if i == 0 {
        ROOT.into()
    } else {
        path[..i].into()
    })
}

/// Last segment of a normalised path (`""` for the root).
#[must_use]
pub fn name(path: &str) -> &str {
    if path == ROOT {
        ""
    } else {
        path.rsplit('/').next().unwrap_or("")
    }
}

/// Join a normalised parent path and a validated name.
#[must_use]
pub fn join(parent: &str, name: &str) -> String {
    if parent == ROOT {
        format!("/{name}")
    } else {
        format!("{parent}/{name}")
    }
}

/// Every non-root ancestor of `path`, outermost first, ending with `path` itself.
/// `"/a/b"` gives `["/a", "/a/b"]`; the root gives an empty list.
#[must_use]
pub fn chain(path: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        cur.push('/');
        cur.push_str(seg);
        out.push(cur.clone());
    }
    out
}

/// True when `ancestor` equals `path` or contains it. The root contains everything.
/// Segment aware: `/A` is not an ancestor of `/Apple`.
#[must_use]
pub fn is_ancestor_or_self(ancestor: &str, path: &str) -> bool {
    ancestor == ROOT
        || path == ancestor
        || path
            .strip_prefix(ancestor)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Re-root `path` from `old` to `new` when it equals or lies under `old`; `None` otherwise.
#[must_use]
pub fn rebase(path: &str, old: &str, new: &str) -> Option<String> {
    if path == old {
        return Some(new.into());
    }
    let rest = path.strip_prefix(old)?.strip_prefix('/')?;
    Some(join(new, rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes() {
        assert_eq!(normalize("").unwrap(), "/");
        assert_eq!(normalize("a//b/").unwrap(), "/a/b");
        assert_eq!(normalize(" /a / b ").unwrap(), "/a/b");
        assert!(normalize("/a/../b").is_err());
        assert!(normalize("/a/./b").is_err());
        assert!(normalize("/a/\u{0}b").is_err());
        assert_eq!(normalize_lenient("/a/../b"), "/");
    }

    #[test]
    fn names() {
        assert_eq!(validate_name(" Specs ").unwrap(), "Specs");
        for bad in ["", "  ", "a/b", ".", "..", "x\ny"] {
            assert!(validate_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_name(&"x".repeat(256)).is_err());
    }

    #[test]
    fn parts() {
        assert_eq!(parent("/a/b").as_deref(), Some("/a"));
        assert_eq!(parent("/a").as_deref(), Some("/"));
        assert_eq!(parent("/"), None);
        assert_eq!(name("/a/b"), "b");
        assert_eq!(name("/"), "");
        assert_eq!(join("/", "a"), "/a");
        assert_eq!(join("/a", "b"), "/a/b");
        assert_eq!(chain("/a/b"), vec!["/a", "/a/b"]);
        assert_eq!(chain("/").len(), 0);
    }

    #[test]
    fn ancestry_is_segment_aware() {
        assert!(is_ancestor_or_self("/A", "/A"));
        assert!(is_ancestor_or_self("/A", "/A/B/C"));
        assert!(!is_ancestor_or_self("/A", "/Apple"));
        assert!(!is_ancestor_or_self("/A/B", "/A"));
        assert!(is_ancestor_or_self("/", "/x"));
    }

    #[test]
    fn rebases() {
        assert_eq!(rebase("/A", "/A", "/B/A").as_deref(), Some("/B/A"));
        assert_eq!(rebase("/A/c/d", "/A", "/B/A").as_deref(), Some("/B/A/c/d"));
        assert_eq!(rebase("/Apple", "/A", "/B"), None);
        assert_eq!(rebase("/A/c", "/A", "/").as_deref(), Some("/c"));
    }
}
