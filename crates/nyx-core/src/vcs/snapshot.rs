//! Snapshots. Ports `snapshot.service.ts`: capture the current content of documents under a name
//! and restore it later. Restore differs from the TS service on purpose: it appends a new
//! document version (`Restored snapshot "name"`) instead of silently overwriting the head, so
//! history stays intact and the restore itself can be undone.

use std::collections::HashSet;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::diff::{diff_lines, LineDiff, DEFAULT_CONTEXT};
use super::{atomic, timeline};
use crate::error::{Error, Result};
use crate::model::{AuditEventType, DocumentVersion, NewAuditEvent, NewSnapshot, Snapshot};
use crate::store::{
    AuditRepo, DocumentRepo, SnapshotRepo, SqliteAudit, SqliteDocuments, SqliteSnapshots,
};

/// Snapshot the current head of each document, using `name` as the external reference.
///
/// Unknown document ids are skipped (the TS service did the same and returned `[]` when nothing
/// matched); duplicates are captured once. Records an audit `snapshot_created` event and a
/// timeline event per snapshot.
pub fn create(
    conn: &Connection,
    name: &str,
    document_ids: &[String],
    actor_id: Option<&str>,
) -> Result<Vec<Snapshot>> {
    if name.trim().is_empty() {
        return Err(Error::Invalid("snapshot name is required".into()));
    }
    atomic(conn, || {
        let docs = SqliteDocuments::new(conn);
        let snaps = SqliteSnapshots::new(conn);
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for id in document_ids {
            if !seen.insert(id.clone()) {
                continue;
            }
            let doc = match docs.get(id) {
                Ok(d) => d,
                Err(Error::NotFound(_)) => continue,
                Err(e) => return Err(e),
            };
            let s = snaps.create(&NewSnapshot {
                document_id: doc.id.clone(),
                integration_id: None,
                external_ref: name.to_string(),
                content: doc.content.clone(),
            })?;
            let mut ev = NewAuditEvent::new(&doc.team_id, AuditEventType::SnapshotCreated);
            ev.actor_id = actor_id.map(str::to_string);
            ev.document_id = Some(doc.id.clone());
            ev.snapshot_id = Some(s.id.clone());
            ev.metadata = json!({"name": name});
            SqliteAudit::new(conn).append(&ev)?;
            timeline::record(
                conn,
                &doc.id,
                "snapshot_created",
                json!({"snapshotId": s.id, "name": name}),
                actor_id,
            )?;
            out.push(s);
        }
        Ok(out)
    })
}

/// Fetch a snapshot.
pub fn get(conn: &Connection, snapshot_id: &str) -> Result<Snapshot> {
    SqliteSnapshots::new(conn).get(snapshot_id)
}

/// Snapshots of one document, newest first.
pub fn list_for_document(conn: &Connection, document_id: &str) -> Result<Vec<Snapshot>> {
    SqliteSnapshots::new(conn).list(document_id)
}

/// Snapshots of every document of a team (including soft-deleted ones), newest first.
pub fn list_for_team(conn: &Connection, team_id: &str) -> Result<Vec<Snapshot>> {
    let mut s = conn.prepare(
        "SELECT sn.id FROM snapshots sn JOIN documents d ON d.id = sn.document_id
         WHERE d.team_id = ?1 ORDER BY sn.captured_at DESC, sn.rowid DESC",
    )?;
    let ids: Vec<String> = s
        .query_map([team_id], |r| r.get(0))?
        .collect::<std::result::Result<_, _>>()?;
    let repo = SqliteSnapshots::new(conn);
    ids.iter().map(|id| repo.get(id)).collect()
}

/// Outcome of a restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RestoreResult {
    /// Restored document.
    pub document_id: String,
    /// Snapshot used.
    pub restored_from: String,
    /// The version that now holds the snapshot content (existing head if it already matched).
    pub version: DocumentVersion,
}

/// Put a snapshot's content back as the document head. Fails with [`Error::Conflict`] if the
/// document is soft-deleted.
pub fn restore(conn: &Connection, snapshot_id: &str, user_id: &str) -> Result<RestoreResult> {
    atomic(conn, || {
        let snap = get(conn, snapshot_id)?;
        let docs = SqliteDocuments::new(conn);
        let msg = format!("Restored snapshot \"{}\"", snap.external_ref);
        let version = docs.save_content(&snap.document_id, &snap.content, Some(&msg), user_id)?;
        timeline::record(
            conn,
            &snap.document_id,
            "snapshot_restored",
            json!({"snapshotId": snap.id, "name": snap.external_ref, "versionId": version.id}),
            Some(user_id),
        )?;
        Ok(RestoreResult {
            document_id: snap.document_id,
            restored_from: snap.id,
            version,
        })
    })
}

/// What changed in the document since the snapshot was taken (snapshot -> head).
pub fn diff_with_head(conn: &Connection, snapshot_id: &str) -> Result<LineDiff> {
    let snap = get(conn, snapshot_id)?;
    let doc = SqliteDocuments::new(conn).get(&snap.document_id)?;
    Ok(diff_lines(&snap.content, &doc.content, DEFAULT_CONTEXT))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcs::testutil::{doc, fx};

    #[test]
    fn create_captures_head_and_skips_unknown_and_duplicates() {
        let f = fx();
        let d1 = doc(&f, "alpha");
        let d2 = doc(&f, "beta");
        let c = f.db.conn();
        let ids = vec![
            d1.id.clone(),
            d2.id.clone(),
            d1.id.clone(),
            "missing".into(),
        ];
        let out = create(c, "release-1", &ids, Some(&f.user.id)).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].content, "alpha");
        assert_eq!(out[1].external_ref, "release-1");
        assert_eq!(
            create(c, "none", &["missing".into()], None).unwrap().len(),
            0
        );
        assert!(matches!(create(c, " ", &ids, None), Err(Error::Invalid(_))));
        assert_eq!(list_for_team(c, &f.team.id).unwrap().len(), 2);
        assert_eq!(list_for_document(c, &d1.id).unwrap().len(), 1);
        // audit + timeline side effects
        let audit = SqliteAudit::new(c).list_by_document(&d1.id, 10).unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].event_type, AuditEventType::SnapshotCreated);
        assert_eq!(audit[0].metadata["name"], "release-1");
        assert_eq!(timeline::events(c, &d1.id).unwrap().len(), 1);
    }

    #[test]
    fn restore_appends_a_version_and_keeps_history() {
        let f = fx();
        let d = doc(&f, "v1 text");
        let c = f.db.conn();
        let snap = create(c, "before-rewrite", std::slice::from_ref(&d.id), None)
            .unwrap()
            .remove(0);
        let docs = SqliteDocuments::new(c);
        docs.save_content(&d.id, "rewritten", None, &f.user.id)
            .unwrap();
        assert!(!diff_with_head(c, &snap.id).unwrap().identical);

        let r = restore(c, &snap.id, &f.user.id).unwrap();
        assert_eq!(r.restored_from, snap.id);
        assert_eq!(r.version.version, 3);
        assert_eq!(r.version.content, "v1 text");
        assert_eq!(docs.get(&d.id).unwrap().content, "v1 text");
        assert_eq!(docs.versions(&d.id).unwrap().len(), 3);
        assert!(diff_with_head(c, &snap.id).unwrap().identical);

        // restoring when the head already matches adds nothing
        let again = restore(c, &snap.id, &f.user.id).unwrap();
        assert_eq!(again.version.id, r.version.id);
    }

    #[test]
    fn restore_refuses_deleted_document_and_unknown_snapshot() {
        let f = fx();
        let d = doc(&f, "x");
        let c = f.db.conn();
        let snap = create(c, "s", std::slice::from_ref(&d.id), None)
            .unwrap()
            .remove(0);
        SqliteDocuments::new(c).soft_delete(&d.id).unwrap();
        assert!(matches!(
            restore(c, &snap.id, &f.user.id),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            restore(c, "nope", &f.user.id),
            Err(Error::NotFound(_))
        ));
    }
}
