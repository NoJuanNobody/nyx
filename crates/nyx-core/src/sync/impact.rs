//! Impact map. Two complementary views, both ported from `impact-graph.service.ts` / the
//! `ImpactMap.tsx` data needs:
//!
//! 1. [`ImpactGraph`]: a typed graph of specs, files and tickets with weighted edges
//!    (persisted in `impact_edges` through [`SqliteImpact`]) and traversal queries such as
//!    "what does this change affect" ([`ImpactGraph::affected_by`]).
//! 2. [`build_audit_graph`]: the per-document event graph of the TS service (audit events linked
//!    by `parent_event_id`, with the 14-day "no downstream commit" drift flag and inferred intent).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, AuditEvent, AuditEventType, Id, Timestamp};
use crate::store::db_err;

// ---------------------------------------------------------------------------------------------
// Typed graph
// ---------------------------------------------------------------------------------------------

/// What a graph node refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    /// A document (spec); the ref is the document id.
    Spec,
    /// A code file; the ref is the repo-relative path.
    File,
    /// A ticket; the ref is the ticket id.
    Ticket,
}

impl NodeKind {
    /// Stored string.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Spec => "spec",
            Self::File => "file",
            Self::Ticket => "ticket",
        }
    }

    /// Parse the stored string.
    pub fn parse(s: &str) -> Result<Self> {
        match s {
            "spec" => Ok(Self::Spec),
            "file" => Ok(Self::File),
            "ticket" => Ok(Self::Ticket),
            other => Err(Error::Invalid(format!("unknown node kind `{other}`"))),
        }
    }
}

/// A node identity: kind plus reference.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct NodeRef {
    /// Kind.
    pub kind: NodeKind,
    /// Document id, file path or ticket id.
    pub id: String,
}

impl NodeRef {
    /// Spec node.
    pub fn spec(id: impl Into<String>) -> Self {
        Self {
            kind: NodeKind::Spec,
            id: id.into(),
        }
    }
    /// File node.
    pub fn file(path: impl Into<String>) -> Self {
        Self {
            kind: NodeKind::File,
            id: path.into(),
        }
    }
    /// Ticket node.
    pub fn ticket(id: impl Into<String>) -> Self {
        Self {
            kind: NodeKind::Ticket,
            id: id.into(),
        }
    }
}

/// A directed, weighted edge. `weight` is in `(0, 1]` and decays multiplicatively along a path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    /// Source.
    pub src: NodeRef,
    /// Target.
    pub dst: NodeRef,
    /// Free-text relation, e.g. `implements`, `tracks`, `references`.
    pub relation: String,
    /// Strength in `(0, 1]`.
    pub weight: f32,
}

/// Which way to follow edges.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// Source to target only.
    Out,
    /// Target to source only.
    In,
    /// Both (a change ripples regardless of how the link was authored).
    Both,
}

/// A node reached by a traversal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reached {
    /// The node.
    pub node: NodeRef,
    /// Hops from the nearest start node (start nodes are not reported).
    pub depth: usize,
    /// Product of edge weights along the strongest path found by BFS order.
    pub strength: f32,
    /// Node the traversal arrived from.
    pub via: NodeRef,
}

/// Answer to "what does this change affect".
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Impact {
    /// Affected specs, nearest first.
    pub specs: Vec<Reached>,
    /// Affected files, nearest first.
    pub files: Vec<Reached>,
    /// Affected tickets, nearest first.
    pub tickets: Vec<Reached>,
}

impl Impact {
    /// True when nothing was reached.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.specs.is_empty() && self.files.is_empty() && self.tickets.is_empty()
    }
}

/// In-memory graph of specs, files and tickets.
#[derive(Debug, Clone, Default)]
pub struct ImpactGraph {
    edges: Vec<Edge>,
    out: HashMap<NodeRef, Vec<usize>>,
    inc: HashMap<NodeRef, Vec<usize>>,
}

impl ImpactGraph {
    /// Empty graph.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from edges (duplicates of the same `(src, dst, relation)` collapse to the first).
    #[must_use]
    pub fn from_edges(edges: impl IntoIterator<Item = Edge>) -> Self {
        let mut g = Self::new();
        for e in edges {
            g.add_edge(e);
        }
        g
    }

    /// Add an edge; returns false for self-loops, bad weights and duplicates.
    pub fn add_edge(&mut self, edge: Edge) -> bool {
        if edge.src == edge.dst
            || !(edge.weight > 0.0 && edge.weight <= 1.0)
            || self
                .edges
                .iter()
                .any(|e| e.src == edge.src && e.dst == edge.dst && e.relation == edge.relation)
        {
            return false;
        }
        let i = self.edges.len();
        self.out.entry(edge.src.clone()).or_default().push(i);
        self.inc.entry(edge.dst.clone()).or_default().push(i);
        self.edges.push(edge);
        true
    }

    /// All edges in insertion order.
    #[must_use]
    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// Every distinct node that has at least one edge, sorted.
    #[must_use]
    pub fn nodes(&self) -> Vec<NodeRef> {
        let set: BTreeSet<&NodeRef> = self.edges.iter().flat_map(|e| [&e.src, &e.dst]).collect();
        set.into_iter().cloned().collect()
    }

    fn neighbours(&self, n: &NodeRef, dir: Direction) -> Vec<(&NodeRef, f32)> {
        let mut v = Vec::new();
        if matches!(dir, Direction::Out | Direction::Both) {
            for &i in self.out.get(n).into_iter().flatten() {
                v.push((&self.edges[i].dst, self.edges[i].weight));
            }
        }
        if matches!(dir, Direction::In | Direction::Both) {
            for &i in self.inc.get(n).into_iter().flatten() {
                v.push((&self.edges[i].src, self.edges[i].weight));
            }
        }
        v
    }

    /// Breadth-first traversal from `starts` up to `max_depth` hops (cycle-safe). Start nodes are
    /// never reported. Results are ordered by depth, then strength (desc), then node.
    #[must_use]
    pub fn traverse(&self, starts: &[NodeRef], dir: Direction, max_depth: usize) -> Vec<Reached> {
        let mut seen: HashSet<&NodeRef> = starts.iter().collect();
        let mut queue: VecDeque<(&NodeRef, usize, f32)> =
            starts.iter().map(|s| (s, 0, 1.0)).collect();
        let mut out = Vec::new();
        while let Some((node, depth, strength)) = queue.pop_front() {
            if depth >= max_depth {
                continue;
            }
            for (next, w) in self.neighbours(node, dir) {
                if seen.insert(next) {
                    let s = strength * w;
                    out.push(Reached {
                        node: next.clone(),
                        depth: depth + 1,
                        strength: s,
                        via: node.clone(),
                    });
                    queue.push_back((next, depth + 1, s));
                }
            }
        }
        out.sort_by(|a, b| {
            a.depth
                .cmp(&b.depth)
                .then(b.strength.total_cmp(&a.strength))
                .then_with(|| a.node.cmp(&b.node))
        });
        out
    }

    /// "What does this change affect": traverse both ways from the changed nodes and group the
    /// result by kind. `min_strength` drops weakly connected nodes.
    #[must_use]
    pub fn affected_by(&self, changed: &[NodeRef], max_depth: usize, min_strength: f32) -> Impact {
        let mut impact = Impact::default();
        for r in self.traverse(changed, Direction::Both, max_depth) {
            if r.strength < min_strength {
                continue;
            }
            match r.node.kind {
                NodeKind::Spec => impact.specs.push(r),
                NodeKind::File => impact.files.push(r),
                NodeKind::Ticket => impact.tickets.push(r),
            }
        }
        impact
    }

    /// Specs directly linked to any of `paths` (depth 1), with the linking paths.
    #[must_use]
    pub fn specs_for_files(&self, paths: &[String]) -> BTreeMap<String, Vec<String>> {
        let mut map: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for p in paths {
            for (n, _) in self.neighbours(&NodeRef::file(p.clone()), Direction::Both) {
                if n.kind == NodeKind::Spec {
                    let v = map.entry(n.id.clone()).or_default();
                    if !v.contains(p) {
                        v.push(p.clone());
                    }
                }
            }
        }
        map
    }
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

/// Borrowing repository for `impact_edges`.
#[derive(Debug, Clone, Copy)]
pub struct SqliteImpact<'c>(&'c Connection);

fn edge_row(r: &Row<'_>) -> rusqlite::Result<Edge> {
    let conv = |e: Error| {
        rusqlite::Error::FromSqlConversionFailure(
            0,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::other(e.to_string())),
        )
    };
    let sk: String = r.get("src_kind")?;
    let dk: String = r.get("dst_kind")?;
    let w: f64 = r.get("weight")?;
    Ok(Edge {
        src: NodeRef {
            kind: NodeKind::parse(&sk).map_err(conv)?,
            id: r.get("src_ref")?,
        },
        dst: NodeRef {
            kind: NodeKind::parse(&dk).map_err(conv)?,
            id: r.get("dst_ref")?,
        },
        relation: r.get("relation")?,
        #[allow(clippy::cast_possible_truncation)]
        weight: w as f32,
    })
}

impl<'c> SqliteImpact<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Create (or confirm) an edge. Returns true when a new row was inserted.
    pub fn link(&self, team_id: &str, edge: &Edge) -> Result<bool> {
        if edge.src == edge.dst {
            return Err(Error::Invalid(
                "an edge cannot connect a node to itself".into(),
            ));
        }
        if !(edge.weight > 0.0 && edge.weight <= 1.0) {
            return Err(Error::Invalid("edge weight must be in (0, 1]".into()));
        }
        let n = self
            .0
            .execute(
                "INSERT OR IGNORE INTO impact_edges (id, team_id, src_kind, src_ref, dst_kind, dst_ref, relation, weight, created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    new_id(),
                    team_id,
                    edge.src.kind.as_str(),
                    edge.src.id,
                    edge.dst.kind.as_str(),
                    edge.dst.id,
                    edge.relation,
                    f64::from(edge.weight),
                    now_ms()
                ],
            )
            .map_err(db_err)?;
        Ok(n > 0)
    }

    /// Remove an edge; returns whether one existed.
    pub fn unlink(
        &self,
        team_id: &str,
        src: &NodeRef,
        dst: &NodeRef,
        relation: &str,
    ) -> Result<bool> {
        Ok(self.0.execute(
            "DELETE FROM impact_edges WHERE team_id=?1 AND src_kind=?2 AND src_ref=?3 AND dst_kind=?4 AND dst_ref=?5 AND relation=?6",
            params![team_id, src.kind.as_str(), src.id, dst.kind.as_str(), dst.id, relation],
        )? > 0)
    }

    /// Remove every edge touching a node (e.g. when a file is deleted).
    pub fn remove_node(&self, team_id: &str, node: &NodeRef) -> Result<usize> {
        Ok(self.0.execute(
            "DELETE FROM impact_edges WHERE team_id=?1 AND ((src_kind=?2 AND src_ref=?3) OR (dst_kind=?2 AND dst_ref=?3))",
            params![team_id, node.kind.as_str(), node.id],
        )?)
    }

    /// Load the team's whole graph.
    pub fn load(&self, team_id: &str) -> Result<ImpactGraph> {
        let mut s = self
            .0
            .prepare("SELECT * FROM impact_edges WHERE team_id = ?1 ORDER BY created_at, rowid")?;
        let edges: Vec<Edge> = s
            .query_map([team_id], edge_row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(ImpactGraph::from_edges(edges))
    }
}

// ---------------------------------------------------------------------------------------------
// Per-document audit event graph (port of buildImpactGraph)
// ---------------------------------------------------------------------------------------------

/// Events older than this with no downstream commit are flagged as drifting.
pub const DRIFT_FLAG_AGE_MS: i64 = 14 * 24 * 60 * 60 * 1000;

/// A node of the audit event graph.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditNode {
    /// Event id.
    pub id: Id,
    /// Event type string.
    pub event_type: String,
    /// Actor display name.
    pub actor_name: Option<String>,
    /// Human-readable intent.
    pub intent: String,
    /// Older than 14 days, not a commit and no commit downstream.
    pub drift_flag: bool,
    /// Commit.
    pub commit_sha: Option<String>,
    /// Ticket.
    pub ticket_id: Option<Id>,
    /// Raw metadata.
    pub metadata: Value,
    /// Creation time.
    pub created_at: Timestamp,
}

/// Parent to child edge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEdge {
    /// Parent event.
    pub source: Id,
    /// Child event.
    pub target: Id,
}

/// The per-document event graph.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct AuditImpactGraph {
    /// Nodes, oldest first.
    pub nodes: Vec<AuditNode>,
    /// Edges whose parent is part of the same document.
    pub edges: Vec<AuditEdge>,
}

fn meta_str<'a>(m: &'a Value, key: &str) -> Option<&'a str> {
    m.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Port of `inferIntent`.
#[must_use]
pub fn infer_intent(event_type: &str, metadata: &Value, commit_sha: Option<&str>) -> String {
    let titled = |prefix: &str, fallback: &str| {
        meta_str(metadata, "title")
            .map_or_else(|| fallback.to_owned(), |t| format!("{prefix}: {t}"))
    };
    match event_type {
        "doc_edit" => match metadata.get("fields").and_then(Value::as_array) {
            Some(f) => {
                let names: Vec<&str> = f.iter().filter_map(Value::as_str).collect();
                format!("Edited fields: {}", names.join(", "))
            }
            None => "Document edited".into(),
        },
        "ticket_created" => titled("Created ticket", "Ticket created"),
        "ticket_updated" => titled("Updated ticket", "Ticket updated"),
        "code_commit" => meta_str(metadata, "message").map_or_else(
            || {
                commit_sha.map_or_else(
                    || "Code committed".to_owned(),
                    |s| format!("Commit {}", s.chars().take(7).collect::<String>()),
                )
            },
            str::to_owned,
        ),
        "proposal_created" => titled("Proposed", "Change proposed"),
        "proposal_approved" => titled("Approved", "Proposal approved"),
        "proposal_pushed" => titled("Pushed", "Proposal pushed to code"),
        "snapshot_created" => meta_str(metadata, "name").map_or_else(
            || "Snapshot created".to_owned(),
            |n| format!("Snapshot: {n}"),
        ),
        other => other.replace('_', " "),
    }
}

/// Build the per-document graph. `actor_names` maps user id to display name; `now` is injected so
/// the 14-day flag is testable. Input order does not matter (events are sorted by time, then id).
#[must_use]
pub fn build_audit_graph(
    events: &[AuditEvent],
    actor_names: &HashMap<Id, String>,
    now: Timestamp,
) -> AuditImpactGraph {
    if events.is_empty() {
        return AuditImpactGraph::default();
    }
    let mut sorted: Vec<&AuditEvent> = events.iter().collect();
    sorted.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let by_id: HashMap<&str, &AuditEvent> = sorted.iter().map(|e| (e.id.as_str(), *e)).collect();

    let mut children: HashMap<&str, Vec<&str>> = HashMap::new();
    for e in &sorted {
        if let Some(p) = &e.parent_event_id {
            children.entry(p.as_str()).or_default().push(e.id.as_str());
        }
    }

    // Iterative DFS with a visited set: cycle-safe like the TS version.
    let has_downstream_commit = |start: &str| -> bool {
        let mut visited: HashSet<&str> = HashSet::from([start]);
        let mut stack: Vec<&str> = vec![start];
        while let Some(cur) = stack.pop() {
            for &c in children.get(cur).into_iter().flatten() {
                let Some(child) = by_id.get(c) else { continue };
                if child.event_type == AuditEventType::CodeCommit {
                    return true;
                }
                if visited.insert(c) {
                    stack.push(c);
                }
            }
        }
        false
    };

    let nodes = sorted
        .iter()
        .map(|e| {
            let age = now - e.created_at;
            let drift_flag = e.event_type != AuditEventType::CodeCommit
                && age > DRIFT_FLAG_AGE_MS
                && !has_downstream_commit(&e.id);
            AuditNode {
                id: e.id.clone(),
                event_type: e.event_type.to_string(),
                actor_name: e
                    .actor_id
                    .as_ref()
                    .and_then(|a| actor_names.get(a))
                    .cloned(),
                intent: infer_intent(
                    &e.event_type.to_string(),
                    &e.metadata,
                    e.commit_sha.as_deref(),
                ),
                drift_flag,
                commit_sha: e.commit_sha.clone(),
                ticket_id: e.ticket_id.clone(),
                metadata: e.metadata.clone(),
                created_at: e.created_at,
            }
        })
        .collect();

    let edges = sorted
        .iter()
        .filter_map(|e| {
            let p = e.parent_event_id.as_ref()?;
            by_id.contains_key(p.as_str()).then(|| AuditEdge {
                source: p.clone(),
                target: e.id.clone(),
            })
        })
        .collect();
    AuditImpactGraph { nodes, edges }
}

/// Load a document's audit events and names, then [`build_audit_graph`] (the TS service entry).
pub fn document_audit_graph(
    conn: &Connection,
    document_id: &str,
    now: Timestamp,
) -> Result<AuditImpactGraph> {
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
    Ok(build_audit_graph(&events, &names, now))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn e(src: NodeRef, dst: NodeRef, w: f32) -> Edge {
        Edge {
            src,
            dst,
            relation: "relates".into(),
            weight: w,
        }
    }

    fn graph() -> ImpactGraph {
        // spec:a -> file:x, file:y ; spec:b -> file:y ; ticket:t -> spec:b ; file:z -> file:x (cycle-ish)
        ImpactGraph::from_edges([
            e(NodeRef::spec("a"), NodeRef::file("x"), 1.0),
            e(NodeRef::spec("a"), NodeRef::file("y"), 0.5),
            e(NodeRef::spec("b"), NodeRef::file("y"), 1.0),
            e(NodeRef::ticket("t"), NodeRef::spec("b"), 1.0),
            e(NodeRef::file("x"), NodeRef::spec("a"), 1.0),
        ])
    }

    #[test]
    fn add_edge_rejects_loops_dupes_bad_weights() {
        let mut g = ImpactGraph::new();
        assert!(g.add_edge(e(NodeRef::spec("a"), NodeRef::file("x"), 1.0)));
        assert!(!g.add_edge(e(NodeRef::spec("a"), NodeRef::file("x"), 1.0)));
        assert!(!g.add_edge(e(NodeRef::spec("a"), NodeRef::spec("a"), 1.0)));
        assert!(!g.add_edge(e(NodeRef::spec("a"), NodeRef::file("q"), 0.0)));
        assert!(!g.add_edge(e(NodeRef::spec("a"), NodeRef::file("q"), 1.5)));
        assert_eq!(g.edges().len(), 1);
    }

    #[test]
    fn traversal_respects_direction_and_depth() {
        let g = graph();
        let out = g.traverse(&[NodeRef::spec("a")], Direction::Out, 1);
        let ids: Vec<_> = out.iter().map(|r| r.node.id.as_str()).collect();
        assert_eq!(ids, ["x", "y"]);
        let inc = g.traverse(&[NodeRef::file("y")], Direction::In, 1);
        assert_eq!(inc.len(), 2);
        let deep = g.traverse(&[NodeRef::ticket("t")], Direction::Out, 3);
        // t -> b -> y, and y is a sink on the out side.
        assert_eq!(deep.iter().map(|r| r.depth).collect::<Vec<_>>(), [1, 2]);
        assert!(g
            .traverse(&[NodeRef::ticket("t")], Direction::Out, 0)
            .is_empty());
    }

    #[test]
    fn traversal_terminates_on_cycles_and_skips_starts() {
        let g = graph();
        let r = g.traverse(&[NodeRef::spec("a")], Direction::Both, 10);
        assert!(r.iter().all(|x| x.node != NodeRef::spec("a")));
        let unique: HashSet<_> = r.iter().map(|x| &x.node).collect();
        assert_eq!(unique.len(), r.len());
    }

    #[test]
    fn affected_by_groups_and_decays_strength() {
        let g = graph();
        let imp = g.affected_by(&[NodeRef::file("y")], 3, 0.0);
        let spec_ids: Vec<_> = imp.specs.iter().map(|r| r.node.id.as_str()).collect();
        assert_eq!(spec_ids, ["b", "a"]); // b strength 1.0 beats a strength 0.5 at depth 1
        assert_eq!(imp.tickets.len(), 1);
        assert_eq!(imp.tickets[0].node.id, "t");
        assert_eq!(imp.tickets[0].depth, 2);
        assert!(imp.files.iter().any(|r| r.node.id == "x"));
        // Strength threshold removes the weak path through spec a.
        let strong = g.affected_by(&[NodeRef::file("y")], 3, 0.9);
        assert!(strong.specs.iter().all(|r| r.node.id != "a"));
        assert!(g.affected_by(&[NodeRef::file("nope")], 3, 0.0).is_empty());
    }

    #[test]
    fn specs_for_files_maps_direct_links() {
        let g = graph();
        let m = g.specs_for_files(&["x".into(), "y".into(), "q".into()]);
        assert_eq!(m["a"], ["x", "y"]);
        assert_eq!(m["b"], ["y"]);
        assert_eq!(m.len(), 2);
    }

    // --- audit graph -------------------------------------------------------------------------

    fn ev(id: &str, ty: AuditEventType, parent: Option<&str>, at: i64, meta: Value) -> AuditEvent {
        AuditEvent {
            id: id.into(),
            team_id: "t".into(),
            event_type: ty,
            actor_id: Some("u1".into()),
            document_id: Some("d".into()),
            snapshot_id: None,
            ticket_id: None,
            commit_sha: (ty == AuditEventType::CodeCommit).then(|| "abcdef1234".into()),
            parent_event_id: parent.map(Into::into),
            metadata: meta,
            created_at: at,
        }
    }

    #[test]
    fn intent_inference_matches_ts() {
        assert_eq!(
            infer_intent("doc_edit", &json!({"fields":["a","b"]}), None),
            "Edited fields: a, b"
        );
        assert_eq!(
            infer_intent("doc_edit", &json!({}), None),
            "Document edited"
        );
        assert_eq!(
            infer_intent("ticket_created", &json!({"title":"T"}), None),
            "Created ticket: T"
        );
        assert_eq!(
            infer_intent("code_commit", &json!({}), Some("abcdef1234")),
            "Commit abcdef1"
        );
        assert_eq!(
            infer_intent("code_commit", &json!({}), None),
            "Code committed"
        );
        assert_eq!(
            infer_intent("code_commit", &json!({"message":"fix"}), Some("x")),
            "fix"
        );
        assert_eq!(
            infer_intent("snapshot_created", &json!({"name":"v1"}), None),
            "Snapshot: v1"
        );
        assert_eq!(
            infer_intent("proposal_pushed", &json!({}), None),
            "Proposal pushed to code"
        );
        assert_eq!(
            infer_intent("some_new_event", &json!({}), None),
            "some new event"
        );
    }

    #[test]
    fn audit_graph_flags_stale_events_without_downstream_commit() {
        let day = 24 * 60 * 60 * 1000;
        let now = 100 * day;
        let events = vec![
            ev(
                "edit_old_ok",
                AuditEventType::DocEdit,
                None,
                now - 30 * day,
                json!({}),
            ),
            ev(
                "prop",
                AuditEventType::ProposalCreated,
                Some("edit_old_ok"),
                now - 29 * day,
                json!({}),
            ),
            ev(
                "commit",
                AuditEventType::CodeCommit,
                Some("prop"),
                now - 28 * day,
                json!({}),
            ),
            ev(
                "edit_old_drift",
                AuditEventType::DocEdit,
                None,
                now - 20 * day,
                json!({}),
            ),
            ev(
                "edit_recent",
                AuditEventType::DocEdit,
                None,
                now - 2 * day,
                json!({}),
            ),
            ev(
                "orphan_child",
                AuditEventType::DocEdit,
                Some("missing"),
                now - day,
                json!({}),
            ),
        ];
        let names = HashMap::from([("u1".to_string(), "Ada".to_string())]);
        let g = build_audit_graph(&events, &names, now);
        let flag = |id: &str| g.nodes.iter().find(|n| n.id == id).unwrap().drift_flag;
        assert!(!flag("edit_old_ok")); // commit is two hops downstream
        assert!(!flag("prop"));
        assert!(!flag("commit")); // commits are never flagged
        assert!(flag("edit_old_drift"));
        assert!(!flag("edit_recent"));
        assert_eq!(g.nodes[0].id, "edit_old_ok");
        assert_eq!(g.nodes[0].actor_name.as_deref(), Some("Ada"));
        // Edge to a parent outside the document is dropped.
        assert_eq!(g.edges.len(), 2);
        assert!(g.edges.iter().all(|e| e.target != "orphan_child"));
        assert!(build_audit_graph(&[], &names, now).nodes.is_empty());
    }

    #[test]
    fn audit_graph_survives_parent_cycles() {
        let day = 24 * 60 * 60 * 1000;
        let events = vec![
            ev("a", AuditEventType::DocEdit, Some("b"), 0, json!({})),
            ev("b", AuditEventType::DocEdit, Some("a"), 1, json!({})),
        ];
        let g = build_audit_graph(&events, &HashMap::new(), 100 * day);
        assert!(g.nodes.iter().all(|n| n.drift_flag));
    }
}
