//! Trace linking. Port of `trace.service.ts`: a document's audit events as a causal chain
//! (`parent_event_id` links), a readable label per event and a plain-English summary.

use std::collections::HashMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::Result;
use crate::model::{AuditEvent, Id, Timestamp};

/// One trace entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceNode {
    /// Event id.
    pub id: Id,
    /// Event type string.
    #[serde(rename = "type")]
    pub kind: String,
    /// `Base label[: detail]`.
    pub label: String,
    /// Actor name, `System` when unknown.
    pub actor_name: String,
    /// Unix ms.
    pub timestamp: Timestamp,
    /// Raw metadata.
    pub metadata: Value,
}

/// Parent to child link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TraceEdge {
    /// Parent.
    pub from: Id,
    /// Child.
    pub to: Id,
}

/// Trace of one document.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Trace {
    /// Newest first (as the TS service returned them).
    pub nodes: Vec<TraceNode>,
    /// Links; the parent may be outside the document (kept, as in the TS).
    pub edges: Vec<TraceEdge>,
}

fn base_label(event_type: &str) -> &str {
    match event_type {
        "doc_edit" => "Document edited",
        "snapshot_created" => "Snapshot created",
        "ticket_created" => "Ticket created",
        "ticket_updated" => "Ticket updated",
        "code_commit" => "Commit pushed",
        "proposal_created" => "Proposal created",
        "proposal_approved" => "Proposal approved",
        "proposal_pushed" => "Proposal pushed",
        other => other,
    }
}

/// Label for an event: `Base` plus `: message|title|commitMessage` when one is a non-empty string.
#[must_use]
pub fn build_label(event_type: &str, metadata: &Value) -> String {
    let detail = ["message", "title", "commitMessage"]
        .iter()
        .filter_map(|k| metadata.get(*k))
        .find(|v| !v.is_null() && v.as_str() != Some(""))
        .and_then(Value::as_str);
    match detail {
        Some(d) => format!("{}: {d}", base_label(event_type)),
        None => base_label(event_type).to_owned(),
    }
}

/// Build a trace from events (any order; output is newest first, ties by id).
#[must_use]
pub fn build_trace(events: &[AuditEvent], actor_names: &HashMap<Id, String>) -> Trace {
    let mut sorted: Vec<&AuditEvent> = events.iter().collect();
    sorted.sort_by(|a, b| {
        b.created_at
            .cmp(&a.created_at)
            .then_with(|| b.id.cmp(&a.id))
    });
    let nodes = sorted
        .iter()
        .map(|e| {
            let ty = e.event_type.to_string();
            TraceNode {
                id: e.id.clone(),
                label: build_label(&ty, &e.metadata),
                kind: ty,
                actor_name: e
                    .actor_id
                    .as_ref()
                    .and_then(|a| actor_names.get(a))
                    .cloned()
                    .unwrap_or_else(|| "System".into()),
                timestamp: e.created_at,
                metadata: e.metadata.clone(),
            }
        })
        .collect();
    let edges = sorted
        .iter()
        .filter_map(|e| {
            e.parent_event_id.as_ref().map(|p| TraceEdge {
                from: p.clone(),
                to: e.id.clone(),
            })
        })
        .collect();
    Trace { nodes, edges }
}

impl Trace {
    /// Chain from the root cause to `event_id` (inclusive), following parents that are in the
    /// trace. Cycle-safe.
    #[must_use]
    pub fn lineage(&self, event_id: &str) -> Vec<&TraceNode> {
        let parent: HashMap<&str, &str> = self
            .edges
            .iter()
            .map(|e| (e.to.as_str(), e.from.as_str()))
            .collect();
        let by_id: HashMap<&str, &TraceNode> =
            self.nodes.iter().map(|n| (n.id.as_str(), n)).collect();
        let mut chain = Vec::new();
        let mut cur = event_id;
        while let Some(n) = by_id.get(cur) {
            if chain.iter().any(|c: &&TraceNode| c.id == n.id) {
                break;
            }
            chain.push(*n);
            match parent.get(cur) {
                Some(p) => cur = p,
                None => break,
            }
        }
        chain.reverse();
        chain
    }

    /// Port of `getTraceSummary`.
    #[must_use]
    pub fn summary(&self) -> String {
        if self.nodes.is_empty() {
            return "No trace events yet for this document.".into();
        }
        let mut asc: Vec<&TraceNode> = self.nodes.iter().collect();
        asc.sort_by_key(|n| n.timestamp);
        let steps: Vec<String> = asc
            .iter()
            .enumerate()
            .map(|(i, n)| {
                format!(
                    "{}. {} {} ({})",
                    i + 1,
                    n.actor_name,
                    n.label.to_lowercase(),
                    short_date(n.timestamp)
                )
            })
            .collect();
        let n = self.nodes.len();
        format!(
            "This document has {n} trace event{}:\n{}",
            if n == 1 { "" } else { "s" },
            steps.join("\n")
        )
    }
}

/// `Jan 5` (en-US short month + day, UTC), no external date crate needed.
fn short_date(ms: Timestamp) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    // Howard Hinnant's civil_from_days.
    let z = ms.div_euclid(86_400_000) + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    format!("{} {day}", MONTHS[usize::try_from(month - 1).unwrap_or(0)])
}

/// Load and build the trace of a document.
pub fn document_trace(conn: &Connection, document_id: &str) -> Result<Trace> {
    use crate::store::{AuditRepo, SqliteAudit, SqliteUsers, UserRepo};
    let events = SqliteAudit::new(conn).list_by_document(document_id, u32::MAX)?;
    let users = SqliteUsers::new(conn);
    let mut names = HashMap::new();
    for a in events.iter().filter_map(|e| e.actor_id.as_ref()) {
        if !names.contains_key(a) {
            if let Ok(u) = users.get(a) {
                names.insert(a.clone(), u.name);
            }
        }
    }
    Ok(build_trace(&events, &names))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AuditEventType;
    use serde_json::json;

    fn ev(id: &str, ty: AuditEventType, parent: Option<&str>, at: i64, meta: Value) -> AuditEvent {
        AuditEvent {
            id: id.into(),
            team_id: "t".into(),
            event_type: ty,
            actor_id: (id != "sys").then(|| "u".into()),
            document_id: Some("d".into()),
            snapshot_id: None,
            ticket_id: None,
            commit_sha: None,
            parent_event_id: parent.map(Into::into),
            metadata: meta,
            created_at: at,
        }
    }

    #[test]
    fn labels() {
        assert_eq!(build_label("doc_edit", &json!({})), "Document edited");
        assert_eq!(
            build_label("code_commit", &json!({"message":"fix bug"})),
            "Commit pushed: fix bug"
        );
        assert_eq!(
            build_label("ticket_created", &json!({"title":"T","message":""})),
            "Ticket created: T"
        );
        assert_eq!(
            build_label("weird", &json!({"commitMessage":"m"})),
            "weird: m"
        );
        assert_eq!(
            build_label("doc_edit", &json!({"message": 5})),
            "Document edited"
        );
    }

    #[test]
    fn trace_orders_links_and_summarises() {
        let day = 86_400_000;
        let jan5 = 19_727 * day; // 2024-01-05
        let events = vec![
            ev("a", AuditEventType::DocEdit, None, jan5, json!({})),
            ev(
                "b",
                AuditEventType::ProposalCreated,
                Some("a"),
                jan5 + 1000,
                json!({"title":"P"}),
            ),
            ev(
                "sys",
                AuditEventType::CodeCommit,
                Some("b"),
                jan5 + 2000,
                json!({"message":"Ship"}),
            ),
        ];
        let names = HashMap::from([("u".to_string(), "Ada".to_string())]);
        let t = build_trace(&events, &names);
        assert_eq!(
            t.nodes.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["sys", "b", "a"]
        );
        assert_eq!(t.nodes[0].actor_name, "System");
        assert_eq!(t.edges.len(), 2);
        let lineage: Vec<_> = t.lineage("sys").iter().map(|n| n.id.as_str()).collect();
        assert_eq!(lineage, ["a", "b", "sys"]);
        assert_eq!(
            t.summary(),
            "This document has 3 trace events:\n1. Ada document edited (Jan 5)\n2. Ada proposal created: p (Jan 5)\n3. System commit pushed: ship (Jan 5)"
        );
        assert_eq!(
            Trace::default().summary(),
            "No trace events yet for this document."
        );
    }

    #[test]
    fn single_event_is_singular_and_cycles_do_not_hang() {
        let t = build_trace(
            &[ev("a", AuditEventType::DocEdit, Some("a"), 0, json!({}))],
            &HashMap::new(),
        );
        assert!(t.summary().starts_with("This document has 1 trace event:"));
        assert_eq!(t.lineage("a").len(), 1);
    }

    #[test]
    fn short_date_handles_epoch_and_leap_day() {
        assert_eq!(short_date(0), "Jan 1");
        assert_eq!(short_date(1_709_164_800_000), "Feb 29"); // 2024-02-29
        assert_eq!(short_date(-86_400_000), "Dec 31");
    }
}
