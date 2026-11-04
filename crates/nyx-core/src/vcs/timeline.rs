//! Document timeline. Ports `timeline.service.ts` (stored events) and adds assembly: a single
//! newest-first feed that merges stored events with history derived from versions, branches,
//! snapshots and change proposals, so a timeline is complete even for activity that predates
//! event recording.

use std::collections::HashSet;

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::Result;
use crate::model::{new_id, now_ms, Id, Timestamp};
use crate::store::{db_err, json_col};

/// A stored timeline event (Drizzle `timeline_events`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineEvent {
    /// Id.
    pub id: Id,
    /// Document.
    pub document_id: Id,
    /// Free-form type, e.g. `version_created`.
    pub kind: String,
    /// Event payload.
    pub payload: Value,
    /// Acting user.
    pub actor_id: Option<Id>,
    /// Creation time.
    pub created_at: Timestamp,
}

fn row(r: &Row<'_>) -> rusqlite::Result<TimelineEvent> {
    Ok(TimelineEvent {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        kind: r.get("type")?,
        payload: json_col(r, "payload")?,
        actor_id: r.get("actor_id")?,
        created_at: r.get("created_at")?,
    })
}

/// Append an event.
pub fn record(
    conn: &Connection,
    document_id: &str,
    kind: &str,
    payload: Value,
    actor_id: Option<&str>,
) -> Result<TimelineEvent> {
    let id = new_id();
    conn.execute(
        "INSERT INTO timeline_events (id, document_id, type, payload, actor_id, created_at) VALUES (?1,?2,?3,?4,?5,?6)",
        params![id, document_id, kind, serde_json::to_string(&payload)?, actor_id, now_ms()],
    )
    .map_err(db_err)?;
    Ok(conn.query_row("SELECT * FROM timeline_events WHERE id = ?1", [id], row)?)
}

/// Stored events of a document, newest first (ports `getByDocument`).
pub fn events(conn: &Connection, document_id: &str) -> Result<Vec<TimelineEvent>> {
    let mut s = conn.prepare(
        "SELECT * FROM timeline_events WHERE document_id = ?1 ORDER BY created_at DESC, rowid DESC",
    )?;
    let rows = s
        .query_map([document_id], row)?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

/// Where an assembled entry came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntrySource {
    /// A stored `timeline_events` row.
    Event,
    /// Reconstructed from versions, branches, snapshots or proposals.
    Derived,
}

/// One line of the assembled timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimelineEntry {
    /// Time of the activity.
    pub at: Timestamp,
    /// Entry type: `version_created`, `branch_created`, `branch_merged`, `snapshot_created`,
    /// `proposal_created`, or any stored event type.
    pub kind: String,
    /// Acting user, when known.
    pub actor_id: Option<Id>,
    /// Human-readable one-liner.
    pub summary: String,
    /// Structured details (ids use the TS camelCase keys: `versionId`, `branchId`, ...).
    pub payload: Value,
    /// Stored or derived.
    pub source: EntrySource,
}

/// Filters for [`assemble`].
#[derive(Debug, Clone, Default)]
pub struct TimelineOptions {
    /// Keep at most this many entries (newest first).
    pub limit: Option<usize>,
    /// Keep only these kinds (empty = all).
    pub kinds: Vec<String>,
}

const REF_KEYS: [&str; 4] = ["versionId", "branchId", "snapshotId", "proposalId"];

fn ref_of(payload: &Value) -> Option<String> {
    REF_KEYS
        .iter()
        .find_map(|k| payload.get(*k).and_then(Value::as_str))
        .map(str::to_string)
}

/// Assemble the full newest-first timeline of a document.
///
/// Derived entries are skipped when a stored event of the same kind already references the same
/// id, so nothing appears twice.
pub fn assemble(
    conn: &Connection,
    document_id: &str,
    opts: &TimelineOptions,
) -> Result<Vec<TimelineEntry>> {
    let stored = events(conn, document_id)?;
    let seen: HashSet<(String, String)> = stored
        .iter()
        .filter_map(|e| Some((e.kind.clone(), ref_of(&e.payload)?)))
        .collect();
    let mut out: Vec<TimelineEntry> = Vec::new();
    let mut derive = |at: Timestamp,
                      kind: &str,
                      actor: Option<String>,
                      summary: String,
                      payload: Value,
                      id: &str| {
        if !seen.contains(&(kind.to_string(), id.to_string())) {
            out.push(TimelineEntry {
                at,
                kind: kind.into(),
                actor_id: actor,
                summary,
                payload,
                source: EntrySource::Derived,
            });
        }
    };

    let mut s = conn.prepare(
        "SELECT id, version, message, created_by_id, created_at FROM document_versions WHERE document_id = ?1 ORDER BY version",
    )?;
    let versions = s.query_map([document_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
        ))
    })?;
    for v in versions {
        let (id, n, msg, by, at) = v?;
        let summary = match &msg {
            Some(m) if !m.is_empty() => format!("Version {n}: {m}"),
            _ => format!("Version {n}"),
        };
        derive(
            at,
            "version_created",
            Some(by),
            summary,
            json!({"versionId": id, "version": n, "message": msg}),
            &id,
        );
    }

    let mut s = conn.prepare(
        "SELECT id, name, created_by_id, created_at, merged_at FROM document_branches WHERE document_id = ?1 ORDER BY created_at",
    )?;
    let branches = s.query_map([document_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<i64>>(4)?,
        ))
    })?;
    for b in branches {
        let (id, name, by, created, merged) = b?;
        derive(
            created,
            "branch_created",
            Some(by),
            format!("Branch \"{name}\" created"),
            json!({"branchId": id, "name": name}),
            &id,
        );
        if let Some(at) = merged {
            derive(
                at,
                "branch_merged",
                None,
                format!("Branch \"{name}\" merged"),
                json!({"branchId": id, "name": name}),
                &id,
            );
        }
    }

    let mut s = conn.prepare(
        "SELECT id, external_ref, captured_at FROM snapshots WHERE document_id = ?1 ORDER BY captured_at",
    )?;
    let snaps = s.query_map([document_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
        ))
    })?;
    for sn in snaps {
        let (id, name, at) = sn?;
        derive(
            at,
            "snapshot_created",
            None,
            format!("Snapshot \"{name}\" captured"),
            json!({"snapshotId": id, "name": name}),
            &id,
        );
    }

    let mut s = conn.prepare(
        "SELECT id, title, created_by_id, created_at FROM change_proposals WHERE document_id = ?1 ORDER BY created_at",
    )?;
    let props = s.query_map([document_id], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
        ))
    })?;
    for p in props {
        let (id, title, by, at) = p?;
        derive(
            at,
            "proposal_created",
            Some(by),
            format!("Change proposal: {title}"),
            json!({"proposalId": id, "title": title}),
            &id,
        );
    }

    // Stored events were returned newest first; add them chronologically then sort everything.
    for e in stored.into_iter().rev() {
        out.push(TimelineEntry {
            at: e.created_at,
            summary: summarize(&e),
            kind: e.kind,
            actor_id: e.actor_id,
            payload: e.payload,
            source: EntrySource::Event,
        });
    }
    out.sort_by_key(|e| e.at); // stable: ties keep insertion order
    out.reverse();
    if !opts.kinds.is_empty() {
        out.retain(|e| opts.kinds.contains(&e.kind));
    }
    if let Some(n) = opts.limit {
        out.truncate(n);
    }
    Ok(out)
}

fn summarize(e: &TimelineEvent) -> String {
    let name = e.payload.get("name").and_then(Value::as_str);
    match (e.kind.as_str(), name) {
        ("version_created", _) => format!(
            "Version {} created",
            e.payload
                .get("version")
                .and_then(Value::as_i64)
                .unwrap_or(0)
        ),
        (k, Some(n)) => format!("{} \"{n}\"", k.replace('_', " ")),
        (k, None) => k.replace('_', " "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcs::testutil::{doc, fx};

    #[test]
    fn record_and_list_newest_first() {
        let f = fx();
        let d = doc(&f, "x");
        let c = f.db.conn();
        record(c, &d.id, "a", json!({}), Some(&f.user.id)).unwrap();
        record(c, &d.id, "b", json!({"n": 1}), None).unwrap();
        let ev = events(c, &d.id).unwrap();
        assert_eq!(
            ev.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        assert_eq!(ev[1].actor_id.as_deref(), Some(f.user.id.as_str()));
        assert_eq!(ev[0].payload["n"], 1);
    }

    #[test]
    fn assemble_derives_history_and_dedupes_stored_events() {
        use crate::store::{DocumentRepo, SqliteDocuments};
        let f = fx();
        let d = doc(&f, "one");
        let c = f.db.conn();
        let v2 = SqliteDocuments::new(c)
            .save_content(&d.id, "two", Some("edit"), &f.user.id)
            .unwrap();
        // A stored event that references v2 suppresses the derived entry for v2 only.
        record(
            c,
            &d.id,
            "version_created",
            json!({"versionId": v2.id, "version": 2}),
            Some(&f.user.id),
        )
        .unwrap();
        record(c, &d.id, "custom", json!({"name": "launch"}), None).unwrap();

        let all = assemble(c, &d.id, &TimelineOptions::default()).unwrap();
        let versions: Vec<_> = all.iter().filter(|e| e.kind == "version_created").collect();
        assert_eq!(versions.len(), 2);
        assert_eq!(
            versions
                .iter()
                .filter(|e| e.source == EntrySource::Derived)
                .count(),
            1
        );
        assert!(all.windows(2).all(|w| w[0].at >= w[1].at), "newest first");
        assert!(all
            .iter()
            .any(|e| e.kind == "custom" && e.summary == "custom \"launch\""));

        let only = assemble(
            c,
            &d.id,
            &TimelineOptions {
                limit: Some(1),
                kinds: vec!["custom".into()],
            },
        )
        .unwrap();
        assert_eq!(only.len(), 1);
        assert_eq!(only[0].kind, "custom");
    }
}
