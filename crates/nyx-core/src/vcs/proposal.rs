//! Change proposals. Ports `change-proposal.service.ts` and adds the branch-applying path.
//!
//! Two kinds of proposal share one lifecycle:
//!
//! - **Ticket proposals** (the TS feature): [`generate`] summarises document versions that no
//!   earlier proposal covered into suggested tickets; once approved, [`push`] files them through a
//!   [`TicketSink`].
//! - **Content proposals**: [`propose`] suggests new content for a branch. Accepting applies it to
//!   the branch with a three-way merge against the branch's current content, so edits made to the
//!   branch after the proposal are preserved and true overlaps surface as conflicts.
//!
//! ```text
//! pending --approve--> approved --push-------> pushed     (ticket proposals)
//!    |                    |  \--apply_to_branch-> applied  (content proposals)
//!    \------reject------> rejected <-----reject-/
//! ```
//!
//! `accept` = approve + apply in one step. The TS service did not enforce transitions; here
//! illegal ones fail with [`Error::Conflict`].
//!
//! The TS `generate` called the in-app AI service. That is replaced by the [`ChangeAnalyzer`]
//! trait; [`HeuristicAnalyzer`] is a deterministic, offline implementation and an LLM-backed one
//! can be plugged in later.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::branch;
use super::merge::{merge3, MergeLabels, Resolution, ThreeWayMerge};
use super::{atomic, timeline};
use crate::error::{Error, Result};
use crate::model::{
    new_id, now_ms, AuditEventType, BranchStatus, DocumentVersion, Id, NewAuditEvent, NewTicket,
    Ticket, TicketProvider, Timestamp,
};
use crate::store::{
    db_err, json_col, AuditRepo, BranchRepo, DocumentRepo, SqliteAudit, SqliteBranches,
    SqliteDocuments, SqliteTickets, TicketRepo,
};

/// Proposal status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalStatus {
    /// Awaiting review.
    Pending,
    /// Accepted by a reviewer.
    Approved,
    /// Declined.
    Rejected,
    /// Tickets were filed.
    Pushed,
    /// Content was applied to its branch.
    Applied,
}

impl ProposalStatus {
    /// Wire/database form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Pushed => "pushed",
            Self::Applied => "applied",
        }
    }

    /// Whether `self -> to` is a legal transition.
    pub fn can_transition(self, to: Self) -> bool {
        use ProposalStatus::{Applied, Approved, Pending, Pushed, Rejected};
        matches!(
            (self, to),
            (Pending, Approved | Rejected) | (Approved, Pushed | Applied | Rejected)
        )
    }
}

impl std::str::FromStr for ProposalStatus {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        Ok(match s {
            "pending" => Self::Pending,
            "approved" => Self::Approved,
            "rejected" => Self::Rejected,
            "pushed" => Self::Pushed,
            "applied" => Self::Applied,
            o => return Err(Error::Invalid(format!("unknown proposal status '{o}'"))),
        })
    }
}

impl std::fmt::Display for ProposalStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// A ticket suggested by a proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SuggestedTicket {
    /// Title.
    pub title: String,
    /// Body.
    pub description: String,
    /// Priority label (free text, e.g. `high`).
    pub priority: String,
    /// Labels.
    pub labels: Vec<String>,
}

/// A stored change proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeProposal {
    /// Id.
    pub id: Id,
    /// Document.
    pub document_id: Id,
    /// Team.
    pub team_id: Id,
    /// Author.
    pub created_by_id: Id,
    /// Title.
    pub title: String,
    /// Description.
    pub description: String,
    /// Status.
    pub status: ProposalStatus,
    /// Tickets to file on push.
    pub suggested_tickets: Vec<SuggestedTicket>,
    /// Version ids this proposal covers.
    pub source_versions: Vec<Id>,
    /// Branch a content proposal applies to.
    pub target_branch_id: Option<Id>,
    /// Branch content when the content proposal was made (merge ancestor).
    pub base_content: Option<String>,
    /// Proposed branch content.
    pub proposed_content: Option<String>,
    /// Creation time.
    pub created_at: Timestamp,
    /// Last change.
    pub updated_at: Timestamp,
}

fn parse_col<T: serde::de::DeserializeOwned>(r: &Row<'_>, name: &str) -> rusqlite::Result<T> {
    let v: Value = json_col(r, name)?;
    serde_json::from_value(v).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    })
}

fn row(r: &Row<'_>) -> rusqlite::Result<ChangeProposal> {
    Ok(ChangeProposal {
        id: r.get("id")?,
        document_id: r.get("document_id")?,
        team_id: r.get("team_id")?,
        created_by_id: r.get("created_by_id")?,
        title: r.get("title")?,
        description: r.get("description")?,
        status: r
            .get::<_, String>("status")?
            .parse()
            .map_err(|e: Error| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        suggested_tickets: parse_col(r, "suggested_tickets")?,
        source_versions: parse_col(r, "source_versions")?,
        target_branch_id: r.get("target_branch_id")?,
        base_content: r.get("base_content")?,
        proposed_content: r.get("proposed_content")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// Fetch by id.
pub fn get(conn: &Connection, id: &str) -> Result<ChangeProposal> {
    conn.query_row("SELECT * FROM change_proposals WHERE id = ?1", [id], row)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Error::NotFound(format!("proposal {id}")),
            e => e.into(),
        })
}

/// Proposals of a document, newest first, optionally by status.
pub fn list(
    conn: &Connection,
    document_id: &str,
    status: Option<ProposalStatus>,
) -> Result<Vec<ChangeProposal>> {
    let mut s = conn.prepare(
        "SELECT * FROM change_proposals WHERE document_id = ?1 AND (?2 IS NULL OR status = ?2)
         ORDER BY created_at DESC, rowid DESC",
    )?;
    let rows = s
        .query_map(
            params![document_id, status.map(ProposalStatus::as_str)],
            row,
        )?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------- generation

/// What an analyzer returns for a batch of new versions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProposalDraft {
    /// Proposal title.
    pub title: String,
    /// Proposal description.
    pub description: String,
    /// Suggested tickets.
    pub suggested_tickets: Vec<SuggestedTicket>,
}

/// Turns document changes into a proposal draft. The TS implementation was an LLM call; this
/// trait keeps the core offline. TODO(AI-75): add an `LlmProvider`-backed implementation.
pub trait ChangeAnalyzer {
    /// `versions` are in chronological order (the TS service passed them newest first).
    fn analyze(&self, document_title: &str, versions: &[DocumentVersion]) -> Result<ProposalDraft>;
}

/// Deterministic analyzer: one medium-priority ticket per version that carries a message.
#[derive(Debug, Clone, Copy, Default)]
pub struct HeuristicAnalyzer;

impl ChangeAnalyzer for HeuristicAnalyzer {
    fn analyze(&self, document_title: &str, versions: &[DocumentVersion]) -> Result<ProposalDraft> {
        let tickets: Vec<SuggestedTicket> = versions
            .iter()
            .filter_map(|v| {
                let m = v.message.as_deref()?.trim();
                (!m.is_empty()).then(|| SuggestedTicket {
                    title: m.to_string(),
                    description: format!(
                        "Implement the change described in \"{document_title}\" v{}: {m}",
                        v.version
                    ),
                    priority: "medium".into(),
                    labels: vec!["docs-change".into()],
                })
            })
            .collect();
        Ok(ProposalDraft {
            title: format!("Changes to {document_title}"),
            description: format!(
                "{} new version(s) of \"{document_title}\" since the last proposal.",
                versions.len()
            ),
            suggested_tickets: tickets,
        })
    }
}

/// Create a ticket proposal from versions not covered by any earlier proposal of the document.
/// Fails with [`Error::Conflict`] when every version is already covered.
pub fn generate(
    conn: &Connection,
    analyzer: &dyn ChangeAnalyzer,
    document_id: &str,
    team_id: &str,
    user_id: &str,
) -> Result<ChangeProposal> {
    atomic(conn, || {
        let docs = SqliteDocuments::new(conn);
        let doc = docs.get(document_id)?;
        let used: std::collections::HashSet<String> = list(conn, document_id, None)?
            .into_iter()
            .flat_map(|p| p.source_versions)
            .collect();
        let fresh: Vec<DocumentVersion> = docs
            .versions(document_id)?
            .into_iter()
            .filter(|v| !used.contains(&v.id))
            .collect();
        if fresh.is_empty() {
            return Err(Error::Conflict(
                "No new versions to analyze. All versions are already covered by existing proposals.".into(),
            ));
        }
        let draft = analyzer.analyze(&doc.title, &fresh)?;
        insert(
            conn,
            document_id,
            team_id,
            user_id,
            &draft.title,
            &draft.description,
            &draft.suggested_tickets,
            &fresh.iter().map(|v| v.id.clone()).collect::<Vec<_>>(),
            None,
        )
    })
}

#[allow(clippy::too_many_arguments)]
fn insert(
    conn: &Connection,
    document_id: &str,
    team_id: &str,
    user_id: &str,
    title: &str,
    description: &str,
    tickets: &[SuggestedTicket],
    sources: &[String],
    content: Option<(&str, &str, &str)>, // (branch id, base content, proposed content)
) -> Result<ChangeProposal> {
    let (id, now) = (new_id(), now_ms());
    conn.execute(
        "INSERT INTO change_proposals (id, document_id, team_id, created_by_id, title, description, status,
            suggested_tickets, source_versions, target_branch_id, base_content, proposed_content, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,'pending',?7,?8,?9,?10,?11,?12,?12)",
        params![
            id, document_id, team_id, user_id, title, description,
            serde_json::to_string(tickets)?, serde_json::to_string(sources)?,
            content.map(|c| c.0), content.map(|c| c.1), content.map(|c| c.2), now
        ],
    )
    .map_err(db_err)?;
    let mut ev = NewAuditEvent::new(team_id, AuditEventType::ProposalCreated);
    ev.actor_id = Some(user_id.to_string());
    ev.document_id = Some(document_id.to_string());
    ev.metadata = json!({"proposalId": id, "title": title});
    SqliteAudit::new(conn).append(&ev)?;
    timeline::record(
        conn,
        document_id,
        "proposal_created",
        json!({"proposalId": id, "title": title}),
        Some(user_id),
    )?;
    get(conn, &id)
}

/// Input for [`propose`].
#[derive(Debug, Clone)]
pub struct ContentProposal {
    /// Branch to change.
    pub branch_id: Id,
    /// Team.
    pub team_id: Id,
    /// Author.
    pub author_id: Id,
    /// Title.
    pub title: String,
    /// Description.
    pub description: String,
    /// New content for the branch.
    pub proposed_content: String,
}

/// Propose new content for a branch. The branch's current content is recorded as the merge
/// ancestor. The branch must still be editable (not merged or rejected).
pub fn propose(conn: &Connection, p: &ContentProposal) -> Result<ChangeProposal> {
    if p.title.trim().is_empty() {
        return Err(Error::Invalid("proposal title is required".into()));
    }
    atomic(conn, || {
        let b = SqliteBranches::new(conn).get(&p.branch_id)?;
        ensure_editable(&b.status, &b.name)?;
        insert(
            conn,
            &b.document_id,
            &p.team_id,
            &p.author_id,
            &p.title,
            &p.description,
            &[],
            &[],
            Some((&b.id, &b.content, &p.proposed_content)),
        )
    })
}

fn ensure_editable(status: &BranchStatus, name: &str) -> Result<()> {
    if matches!(status, BranchStatus::Merged | BranchStatus::Rejected) {
        return Err(Error::Conflict(format!(
            "branch {name} is {status}; it cannot take changes"
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------- review

fn transition(conn: &Connection, id: &str, to: ProposalStatus) -> Result<ChangeProposal> {
    let p = get(conn, id)?;
    if !p.status.can_transition(to) {
        return Err(Error::Conflict(format!(
            "cannot move proposal from {} to {}",
            p.status, to
        )));
    }
    conn.execute(
        "UPDATE change_proposals SET status = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, to.as_str(), now_ms()],
    )
    .map_err(db_err)?;
    get(conn, id)
}

fn audit(
    conn: &Connection,
    p: &ChangeProposal,
    kind: AuditEventType,
    actor: Option<&str>,
) -> Result<()> {
    let mut ev = NewAuditEvent::new(&p.team_id, kind);
    ev.actor_id = actor.map(str::to_string);
    ev.document_id = Some(p.document_id.clone());
    ev.metadata = json!({"proposalId": p.id, "title": p.title});
    SqliteAudit::new(conn).append(&ev)?;
    Ok(())
}

/// Approve a pending proposal, optionally replacing its suggested tickets with a reviewed list.
pub fn approve(
    conn: &Connection,
    id: &str,
    reviewer_id: &str,
    edited_tickets: Option<&[SuggestedTicket]>,
) -> Result<ChangeProposal> {
    atomic(conn, || {
        let p = transition(conn, id, ProposalStatus::Approved)?;
        if let Some(t) = edited_tickets {
            conn.execute(
                "UPDATE change_proposals SET suggested_tickets = ?2 WHERE id = ?1",
                params![id, serde_json::to_string(t)?],
            )?;
        }
        audit(
            conn,
            &p,
            AuditEventType::ProposalApproved,
            Some(reviewer_id),
        )?;
        timeline::record(
            conn,
            &p.document_id,
            "proposal_approved",
            json!({"proposalId": p.id}),
            Some(reviewer_id),
        )?;
        get(conn, id)
    })
}

/// Reject a pending or approved proposal.
pub fn reject(conn: &Connection, id: &str, reviewer_id: &str) -> Result<ChangeProposal> {
    atomic(conn, || {
        let p = transition(conn, id, ProposalStatus::Rejected)?;
        timeline::record(
            conn,
            &p.document_id,
            "proposal_rejected",
            json!({"proposalId": p.id}),
            Some(reviewer_id),
        )?;
        Ok(p)
    })
}

// ---------------------------------------------------------------- apply to branch

/// Result of applying a content proposal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ApplyOutcome {
    /// The branch content was updated and the proposal is `applied`.
    Applied {
        /// The proposal, now `applied`.
        proposal: Box<ChangeProposal>,
        /// Final branch content.
        content: String,
    },
    /// The branch changed in the same place as the proposal. Nothing was written.
    Conflicted {
        /// Structured conflicts (ours = branch now, theirs = proposal).
        merge: Box<ThreeWayMerge>,
        /// Content with conflict markers.
        marked_content: String,
    },
}

fn content_parts(p: &ChangeProposal) -> Result<(&str, &str, &str)> {
    match (&p.target_branch_id, &p.base_content, &p.proposed_content) {
        (Some(b), Some(base), Some(new)) => Ok((b, base, new)),
        _ => Err(Error::Invalid(format!(
            "proposal {} has no branch content to apply",
            p.id
        ))),
    }
}

/// Apply an `approved` content proposal to its branch. With `resolutions` (one per conflict) a
/// conflicted merge is settled and applied; without, conflicts are returned and nothing changes.
pub fn apply_to_branch(
    conn: &Connection,
    id: &str,
    actor_id: &str,
    resolutions: Option<&[Resolution]>,
) -> Result<ApplyOutcome> {
    atomic(conn, || {
        let p = get(conn, id)?;
        if p.status != ProposalStatus::Approved {
            return Err(Error::Conflict(format!(
                "proposal must be approved before applying (is {})",
                p.status
            )));
        }
        apply_inner(conn, p, actor_id, resolutions)
    })
}

fn apply_inner(
    conn: &Connection,
    p: ChangeProposal,
    actor_id: &str,
    resolutions: Option<&[Resolution]>,
) -> Result<ApplyOutcome> {
    let (branch_id, base, proposed) = content_parts(&p)?;
    let b = SqliteBranches::new(conn).get(branch_id)?;
    ensure_editable(&b.status, &b.name)?;
    let m = merge3(base, &b.content, proposed);
    let content = if let Some(c) = m.clean_text() {
        c
    } else {
        let Some(r) = resolutions else {
            let marked = m.render(&MergeLabels {
                ours: format!("branch {}", b.name),
                base: "proposal base".into(),
                theirs: format!("proposal {}", p.title),
                show_base: false,
            });
            return Ok(ApplyOutcome::Conflicted {
                merge: Box::new(m),
                marked_content: marked,
            });
        };
        m.resolve(r)?
    };
    branch::update_content(conn, branch_id, &content)?;
    let done = transition(conn, &p.id, ProposalStatus::Applied)?;
    timeline::record(
        conn,
        &p.document_id,
        "proposal_applied",
        json!({"proposalId": p.id, "branchId": branch_id}),
        Some(actor_id),
    )?;
    Ok(ApplyOutcome::Applied {
        proposal: Box::new(done),
        content,
    })
}

/// Accept a content proposal: approve (if still pending) and apply to its branch in one step.
/// On conflict nothing changes, the proposal stays as it was and the conflicts are returned.
pub fn accept(
    conn: &Connection,
    id: &str,
    reviewer_id: &str,
    resolutions: Option<&[Resolution]>,
) -> Result<ApplyOutcome> {
    atomic(conn, || {
        let mut p = get(conn, id)?;
        content_parts(&p)?;
        if p.status == ProposalStatus::Pending {
            p = approve(conn, id, reviewer_id, None)?;
        }
        let out = apply_to_branch(conn, &p.id, reviewer_id, resolutions)?;
        if matches!(out, ApplyOutcome::Conflicted { .. }) {
            // Undo the approval made above by failing the savepoint, then report the conflicts.
            return Err(Error::Conflict(CONFLICT_SENTINEL.into()));
        }
        Ok(out)
    })
    .or_else(|e| match e {
        Error::Conflict(m) if m == CONFLICT_SENTINEL => {
            let p = get(conn, id)?;
            let (b, base, new) = content_parts(&p)?;
            let br = SqliteBranches::new(conn).get(b)?;
            let m = merge3(base, &br.content, new);
            let marked = m.render(&MergeLabels {
                ours: format!("branch {}", br.name),
                base: "proposal base".into(),
                theirs: format!("proposal {}", p.title),
                show_base: false,
            });
            Ok(ApplyOutcome::Conflicted {
                merge: Box::new(m),
                marked_content: marked,
            })
        }
        e => Err(e),
    })
}

const CONFLICT_SENTINEL: &str = "__proposal_apply_conflict__";

// ---------------------------------------------------------------- push

/// A ticket created in an external tracker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalTicket {
    /// Provider.
    pub provider: TicketProvider,
    /// Provider-side id.
    pub external_id: String,
    /// Provider-side URL.
    pub external_url: String,
}

/// Files a suggested ticket with an issue tracker. The TS code hard-wired GitHub with an empty
/// destination; real implementations belong with the integrations (TODO: AI-66 `GitProvider`).
pub trait TicketSink {
    /// Create the ticket externally.
    fn create_ticket(&self, document_id: &str, ticket: &SuggestedTicket) -> Result<ExternalTicket>;
}

/// Result of [`push`].
#[derive(Debug, Clone, PartialEq)]
pub struct PushOutcome {
    /// The proposal, now `pushed`.
    pub proposal: ChangeProposal,
    /// Tickets recorded locally.
    pub created: Vec<Ticket>,
    /// `(title, error)` for tickets the sink failed on. As in TS, failures do not stop the others
    /// or block the status change.
    pub failed: Vec<(String, String)>,
}

/// File the suggested tickets of an `approved` proposal and mark it `pushed`.
pub fn push(
    conn: &Connection,
    id: &str,
    user_id: &str,
    sink: &dyn TicketSink,
) -> Result<PushOutcome> {
    atomic(conn, || {
        let p = get(conn, id)?;
        if p.status != ProposalStatus::Approved {
            return Err(Error::Conflict(format!(
                "proposal must be approved before pushing (is {})",
                p.status
            )));
        }
        let tickets = SqliteTickets::new(conn);
        let (mut created, mut failed) = (Vec::new(), Vec::new());
        for s in &p.suggested_tickets {
            match sink.create_ticket(&p.document_id, s) {
                Ok(ext) => created.push(tickets.create(&NewTicket {
                    document_id: p.document_id.clone(),
                    provider: ext.provider,
                    external_id: ext.external_id,
                    external_url: ext.external_url,
                    title: s.title.clone(),
                    body: s.description.clone(),
                    insights: Some(
                        json!({"priority": s.priority, "labels": s.labels, "proposalId": p.id}),
                    ),
                    created_by_id: user_id.to_string(),
                })?),
                Err(e) => failed.push((s.title.clone(), e.to_string())),
            }
        }
        let proposal = transition(conn, id, ProposalStatus::Pushed)?;
        audit(
            conn,
            &proposal,
            AuditEventType::ProposalPushed,
            Some(user_id),
        )?;
        timeline::record(
            conn,
            &p.document_id,
            "proposal_pushed",
            json!({"proposalId": p.id, "tickets": created.len()}),
            Some(user_id),
        )?;
        Ok(PushOutcome {
            proposal,
            created,
            failed,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::NewBranch;
    use crate::vcs::testutil::{doc, fx, Fx};
    use std::cell::RefCell;

    struct FakeSink {
        fail_on: Option<&'static str>,
        seen: RefCell<Vec<String>>,
    }

    impl TicketSink for FakeSink {
        fn create_ticket(&self, _doc: &str, t: &SuggestedTicket) -> Result<ExternalTicket> {
            self.seen.borrow_mut().push(t.title.clone());
            if self.fail_on == Some(t.title.as_str()) {
                return Err(Error::Invalid("provider down".into()));
            }
            let n = self.seen.borrow().len();
            Ok(ExternalTicket {
                provider: TicketProvider::Github,
                external_id: format!("#{n}"),
                external_url: format!("https://example.test/{n}"),
            })
        }
    }

    fn branch_with(f: &Fx, doc_id: &str, content: &str) -> crate::model::DocumentBranch {
        let c = f.db.conn();
        let b = branch::create(
            c,
            &NewBranch {
                document_id: doc_id.into(),
                name: "feat".into(),
                base_version_id: None,
                created_by_id: f.user.id.clone(),
            },
        )
        .unwrap();
        branch::update_content(c, &b.id, content).unwrap()
    }

    fn cp(f: &Fx, branch_id: &str, new: &str) -> ContentProposal {
        ContentProposal {
            branch_id: branch_id.into(),
            team_id: f.team.id.clone(),
            author_id: f.other.id.clone(),
            title: "Tighten intro".into(),
            description: String::new(),
            proposed_content: new.into(),
        }
    }

    #[test]
    fn status_transition_table() {
        use ProposalStatus::*;
        assert!(Pending.can_transition(Approved));
        assert!(Pending.can_transition(Rejected));
        assert!(!Pending.can_transition(Pushed));
        assert!(Approved.can_transition(Pushed));
        assert!(Approved.can_transition(Applied));
        assert!(Approved.can_transition(Rejected));
        for done in [Rejected, Pushed, Applied] {
            for to in [Pending, Approved, Rejected, Pushed, Applied] {
                assert!(!done.can_transition(to));
            }
        }
    }

    #[test]
    fn generate_covers_only_new_versions() {
        let f = fx();
        let d = doc(&f, "one");
        let c = f.db.conn();
        let docs = SqliteDocuments::new(c);
        docs.save_content(&d.id, "two", Some("Add retries"), &f.user.id)
            .unwrap();
        let p = generate(c, &HeuristicAnalyzer, &d.id, &f.team.id, &f.user.id).unwrap();
        assert_eq!(p.status, ProposalStatus::Pending);
        assert_eq!(p.source_versions.len(), 2);
        assert_eq!(p.title, "Changes to Spec");
        // "Initial version" and "Add retries" both carry messages.
        assert_eq!(p.suggested_tickets.len(), 2);
        // everything covered now
        assert!(matches!(
            generate(c, &HeuristicAnalyzer, &d.id, &f.team.id, &f.user.id),
            Err(Error::Conflict(_))
        ));
        docs.save_content(&d.id, "three", None, &f.user.id).unwrap();
        let p2 = generate(c, &HeuristicAnalyzer, &d.id, &f.team.id, &f.user.id).unwrap();
        assert_eq!(p2.source_versions.len(), 1);
        assert_eq!(p2.suggested_tickets.len(), 0);
        assert_eq!(list(c, &d.id, None).unwrap().len(), 2);
        assert_eq!(
            list(c, &d.id, Some(ProposalStatus::Rejected))
                .unwrap()
                .len(),
            0
        );
        let kinds: Vec<_> = SqliteAudit::new(c)
            .list_by_team(&f.team.id, 10)
            .unwrap()
            .into_iter()
            .map(|e| e.event_type)
            .collect();
        assert_eq!(
            kinds,
            [
                AuditEventType::ProposalCreated,
                AuditEventType::ProposalCreated
            ]
        );
    }

    #[test]
    fn approve_edit_push_lifecycle() {
        let f = fx();
        let d = doc(&f, "one");
        let c = f.db.conn();
        SqliteDocuments::new(c)
            .save_content(&d.id, "two", Some("Add retries"), &f.user.id)
            .unwrap();
        let p = generate(c, &HeuristicAnalyzer, &d.id, &f.team.id, &f.user.id).unwrap();
        let sink = FakeSink {
            fail_on: None,
            seen: RefCell::default(),
        };
        // cannot push before approval
        assert!(matches!(
            push(c, &p.id, &f.user.id, &sink),
            Err(Error::Conflict(_))
        ));
        let edited = vec![
            SuggestedTicket {
                title: "A".into(),
                description: "a".into(),
                priority: "high".into(),
                labels: vec!["x".into()],
            },
            SuggestedTicket {
                title: "B".into(),
                description: "b".into(),
                priority: "low".into(),
                labels: vec![],
            },
        ];
        let a = approve(c, &p.id, &f.other.id, Some(&edited)).unwrap();
        assert_eq!(a.status, ProposalStatus::Approved);
        assert_eq!(a.suggested_tickets, edited);
        // approving twice is illegal
        assert!(matches!(
            approve(c, &p.id, &f.other.id, None),
            Err(Error::Conflict(_))
        ));

        let sink = FakeSink {
            fail_on: Some("A"),
            seen: RefCell::default(),
        };
        let out = push(c, &p.id, &f.user.id, &sink).unwrap();
        assert_eq!(out.proposal.status, ProposalStatus::Pushed);
        assert_eq!(out.created.len(), 1);
        assert_eq!(out.created[0].title, "B");
        assert_eq!(
            out.failed,
            vec![("A".to_string(), "invalid input: provider down".to_string())]
        );
        // terminal
        assert!(matches!(
            reject(c, &p.id, &f.other.id),
            Err(Error::Conflict(_))
        ));
        let audit: Vec<_> = SqliteAudit::new(c)
            .list_by_document(&d.id, 10)
            .unwrap()
            .into_iter()
            .map(|e| e.event_type)
            .collect();
        assert!(audit.contains(&AuditEventType::ProposalApproved));
        assert!(audit.contains(&AuditEventType::ProposalPushed));
    }

    #[test]
    fn reject_from_pending_and_approved() {
        let f = fx();
        let d = doc(&f, "one");
        let c = f.db.conn();
        SqliteDocuments::new(c)
            .save_content(&d.id, "two", Some("m"), &f.user.id)
            .unwrap();
        let p = generate(c, &HeuristicAnalyzer, &d.id, &f.team.id, &f.user.id).unwrap();
        assert_eq!(
            reject(c, &p.id, &f.other.id).unwrap().status,
            ProposalStatus::Rejected
        );
        assert_eq!(get(c, &p.id).unwrap().status, ProposalStatus::Rejected);
        assert!(matches!(
            approve(c, &p.id, &f.other.id, None),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn accept_applies_content_to_branch_cleanly() {
        let f = fx();
        let d = doc(&f, "a\nb\nc\nd\ne\n");
        let b = branch_with(&f, &d.id, "a\nb\nc\nd\ne\n");
        let c = f.db.conn();
        let p = propose(c, &cp(&f, &b.id, "A\nb\nc\nd\ne\n")).unwrap();
        // The branch moved elsewhere after the proposal was made.
        branch::update_content(c, &b.id, "a\nb\nc\nd\nE\n").unwrap();
        let ApplyOutcome::Applied { proposal, content } =
            accept(c, &p.id, &f.user.id, None).unwrap()
        else {
            panic!("expected applied");
        };
        assert_eq!(proposal.status, ProposalStatus::Applied);
        assert_eq!(content, "A\nb\nc\nd\nE\n");
        assert_eq!(branch::get(c, &b.id).unwrap().content, "A\nb\nc\nd\nE\n");
        // cannot accept twice
        assert!(matches!(
            accept(c, &p.id, &f.user.id, None),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn accept_conflict_leaves_everything_untouched_until_resolved() {
        let f = fx();
        let d = doc(&f, "a\nb\nc\n");
        let b = branch_with(&f, &d.id, "a\nb\nc\n");
        let c = f.db.conn();
        let p = propose(c, &cp(&f, &b.id, "a\nPROPOSED\nc\n")).unwrap();
        branch::update_content(c, &b.id, "a\nEDITED\nc\n").unwrap();

        let ApplyOutcome::Conflicted {
            merge,
            marked_content,
        } = accept(c, &p.id, &f.user.id, None).unwrap()
        else {
            panic!("expected conflict");
        };
        assert_eq!(merge.conflicts().len(), 1);
        assert!(marked_content.contains("<<<<<<< branch feat"));
        assert_eq!(
            get(c, &p.id).unwrap().status,
            ProposalStatus::Pending,
            "approval rolled back"
        );
        assert_eq!(branch::get(c, &b.id).unwrap().content, "a\nEDITED\nc\n");

        let ApplyOutcome::Applied { content, .. } =
            accept(c, &p.id, &f.user.id, Some(&[Resolution::Both])).unwrap()
        else {
            panic!("expected applied");
        };
        assert_eq!(content, "a\nEDITED\nPROPOSED\nc\n");
        assert_eq!(get(c, &p.id).unwrap().status, ProposalStatus::Applied);
    }

    #[test]
    fn apply_requires_approval_and_editable_branch() {
        let f = fx();
        let d = doc(&f, "x\n");
        let b = branch_with(&f, &d.id, "x\n");
        let c = f.db.conn();
        let p = propose(c, &cp(&f, &b.id, "y\n")).unwrap();
        assert!(matches!(
            apply_to_branch(c, &p.id, &f.user.id, None),
            Err(Error::Conflict(_))
        ));
        approve(c, &p.id, &f.user.id, None).unwrap();
        branch::submit_for_review(c, &b.id).unwrap();
        branch::reject(c, &b.id, &f.other.id).unwrap();
        assert!(matches!(
            apply_to_branch(c, &p.id, &f.user.id, None),
            Err(Error::Conflict(_))
        ));
        // and a rejected branch cannot receive new proposals
        assert!(matches!(
            propose(c, &cp(&f, &b.id, "z\n")),
            Err(Error::Conflict(_))
        ));
    }

    #[test]
    fn ticket_proposal_has_no_content_to_apply() {
        let f = fx();
        let d = doc(&f, "one");
        let c = f.db.conn();
        let p = generate(c, &HeuristicAnalyzer, &d.id, &f.team.id, &f.user.id).unwrap();
        assert!(matches!(
            accept(c, &p.id, &f.user.id, None),
            Err(Error::Invalid(_))
        ));
        assert_eq!(get(c, &p.id).unwrap().status, ProposalStatus::Pending);
    }
}
