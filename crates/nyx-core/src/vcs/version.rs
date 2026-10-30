//! Document versions. Ports `version.service.ts`: list, create, get, diff and restore, with the
//! diff computed in core instead of left to the client.

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::diff::{diff_lines, diff_words, LineDiff, WordDiff, DEFAULT_CONTEXT};
use super::{atomic, timeline};
use crate::error::{Error, Result};
use crate::model::{Document, DocumentVersion};
use crate::store::{DocumentRepo, SqliteDocuments};

/// Comparison of two versions of the same or different documents.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VersionDiff {
    /// Old side.
    pub a: DocumentVersion,
    /// New side.
    pub b: DocumentVersion,
    /// Line diff from `a` to `b`.
    pub lines: LineDiff,
}

/// Versions of a document, newest first (TS `listByDocument` ordered by version desc).
pub fn list(conn: &Connection, document_id: &str) -> Result<Vec<DocumentVersion>> {
    let mut v = SqliteDocuments::new(conn).versions(document_id)?;
    v.reverse();
    Ok(v)
}

/// Fetch one version.
pub fn get(conn: &Connection, version_id: &str) -> Result<DocumentVersion> {
    SqliteDocuments::new(conn).version_by_id(version_id)
}

/// Create a version. With `content = None` the current document content is used (TS route
/// behaviour). Saving content identical to the head returns the existing latest version rather
/// than appending a duplicate (the TS service appended anyway). Records a `version_created`
/// timeline event when a version was actually added.
pub fn create(
    conn: &Connection,
    document_id: &str,
    content: Option<&str>,
    message: Option<&str>,
    author_id: &str,
) -> Result<DocumentVersion> {
    atomic(conn, || {
        let docs = SqliteDocuments::new(conn);
        let doc: Document = docs.get(document_id)?;
        let before = docs.latest_version(document_id)?;
        let v = docs.save_content(
            document_id,
            content.unwrap_or(&doc.content),
            message,
            author_id,
        )?;
        if v.id != before.id {
            timeline::record(
                conn,
                document_id,
                "version_created",
                json!({"versionId": v.id, "version": v.version, "message": v.message}),
                Some(author_id),
            )?;
        }
        Ok(v)
    })
}

/// Line diff between two versions (TS returned both rows; they are included here too).
/// Unknown ids yield [`Error::NotFound`] where TS returned `null`.
pub fn diff(conn: &Connection, version_a: &str, version_b: &str) -> Result<VersionDiff> {
    let (a, b) = (get(conn, version_a)?, get(conn, version_b)?);
    let lines = diff_lines(&a.content, &b.content, DEFAULT_CONTEXT);
    Ok(VersionDiff { a, b, lines })
}

/// Word diff between two versions.
pub fn diff_words_between(conn: &Connection, version_a: &str, version_b: &str) -> Result<WordDiff> {
    let (a, b) = (get(conn, version_a)?, get(conn, version_b)?);
    Ok(diff_words(&a.content, &b.content))
}

/// Make an older version the head again by appending a new version `Restored to v{n}`.
/// Fails with [`Error::Invalid`] when the version belongs to another document.
pub fn restore_to_version(
    conn: &Connection,
    document_id: &str,
    version_id: &str,
    user_id: &str,
) -> Result<DocumentVersion> {
    atomic(conn, || {
        let docs = SqliteDocuments::new(conn);
        let old = docs.version_by_id(version_id)?;
        if old.document_id != document_id {
            return Err(Error::Invalid(
                "version does not belong to this document".into(),
            ));
        }
        let before = docs.latest_version(document_id)?;
        let msg = format!("Restored to v{}", old.version);
        let v = docs.save_content(document_id, &old.content, Some(&msg), user_id)?;
        if v.id != before.id {
            timeline::record(
                conn,
                document_id,
                "version_restored",
                json!({"versionId": v.id, "version": v.version, "restoredFrom": old.version}),
                Some(user_id),
            )?;
        }
        Ok(v)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcs::testutil::{doc, fx};

    #[test]
    fn list_is_newest_first_and_create_defaults_to_head() {
        let f = fx();
        let d = doc(&f, "one");
        let c = f.db.conn();
        let docs = SqliteDocuments::new(c);
        docs.save_content(&d.id, "two", None, &f.user.id).unwrap();
        // Head is "two"; create with no content, identical to head: no duplicate version.
        let same = create(c, &d.id, None, Some("noop"), &f.user.id).unwrap();
        assert_eq!(same.version, 2);
        let v3 = create(c, &d.id, Some("three"), Some("third"), &f.user.id).unwrap();
        assert_eq!(v3.version, 3);
        let nums: Vec<_> = list(c, &d.id).unwrap().iter().map(|v| v.version).collect();
        assert_eq!(nums, [3, 2, 1]);
        let ev = timeline::events(c, &d.id).unwrap();
        assert_eq!(ev.len(), 1);
        assert_eq!(ev[0].payload["version"], 3);
    }

    #[test]
    fn diff_between_versions() {
        let f = fx();
        let d = doc(&f, "a\nb\n");
        let c = f.db.conn();
        let v2 = create(c, &d.id, Some("a\nc\n"), None, &f.user.id).unwrap();
        let v1 = SqliteDocuments::new(c).version(&d.id, 1).unwrap();
        let r = diff(c, &v1.id, &v2.id).unwrap();
        assert_eq!((r.lines.stats.added, r.lines.stats.removed), (1, 1));
        assert!(diff_words_between(c, &v1.id, &v2.id).unwrap().removed > 0);
        assert!(matches!(diff(c, &v1.id, "nope"), Err(Error::NotFound(_))));
    }

    #[test]
    fn restore_appends_and_validates_ownership() {
        let f = fx();
        let d = doc(&f, "one");
        let other = doc(&f, "zzz");
        let c = f.db.conn();
        create(c, &d.id, Some("two"), None, &f.user.id).unwrap();
        let v1 = SqliteDocuments::new(c).version(&d.id, 1).unwrap();
        let r = restore_to_version(c, &d.id, &v1.id, &f.user.id).unwrap();
        assert_eq!((r.version, r.content.as_str()), (3, "one"));
        assert_eq!(r.message.as_deref(), Some("Restored to v1"));
        assert_eq!(SqliteDocuments::new(c).get(&d.id).unwrap().content, "one");
        let foreign = SqliteDocuments::new(c).version(&other.id, 1).unwrap();
        assert!(matches!(
            restore_to_version(c, &d.id, &foreign.id, &f.user.id),
            Err(Error::Invalid(_))
        ));
    }
}
