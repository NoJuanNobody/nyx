//! Approval workflow. Ports `approval.service.ts`.
//!
//! State machine (`pending` is the only state with outgoing edges):
//!
//! ```text
//! pending --approve--> approved
//! pending --reject---> rejected
//! pending --expiry---> expired      (detected lazily on approve, or by `expire_overdue`)
//! ```
//!
//! As in the TS service, acting on a non-pending approval is a no-op that returns the approval
//! unchanged, and approving an overdue pending approval marks it `expired` instead of approving.
//! Unlike TS, an unknown id is [`Error::NotFound`] rather than `null`.

use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::atomic;
use crate::error::{Error, Result};
use crate::model::{new_id, now_ms, Id, Timestamp};
use crate::store::{db_err, json_col};

/// Default expiry: 7 days.
pub const DEFAULT_EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// Approval status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    /// Waiting for a reviewer.
    Pending,
    /// Approved.
    Approved,
    /// Rejected.
    Rejected,
    /// Not decided before `expires_at`.
    Expired,
}

impl ApprovalStatus {
    /// Wire/database form.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Approved => "approved",
            Self::Rejected => "rejected",
            Self::Expired => "expired",
        }
    }

    /// Whether `self -> to` is a legal transition.
    pub fn can_transition(self, to: Self) -> bool {
        self == Self::Pending && to != Self::Pending
    }
}

impl std::str::FromStr for ApprovalStatus {
    type Err = Error;
    fn from_str(s: &str) -> Result<Self> {
        match s {
            "pending" => Ok(Self::Pending),
            "approved" => Ok(Self::Approved),
            "rejected" => Ok(Self::Rejected),
            "expired" => Ok(Self::Expired),
            o => Err(Error::Invalid(format!("unknown approval status '{o}'"))),
        }
    }
}

impl std::fmt::Display for ApprovalStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An approval request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Approval {
    /// Id.
    pub id: Id,
    /// Action being gated, e.g. `merge_branch`.
    pub action: String,
    /// Resource the action targets.
    pub resource_id: String,
    /// Requester.
    pub requested_by_id: Id,
    /// Reviewer, once decided.
    pub reviewed_by_id: Option<Id>,
    /// Team.
    pub team_id: Id,
    /// Status.
    pub status: ApprovalStatus,
    /// Free-form details.
    pub metadata: Value,
    /// Reviewer's reason.
    pub reason: Option<String>,
    /// Deadline for a decision.
    pub expires_at: Timestamp,
    /// Decision time.
    pub reviewed_at: Option<Timestamp>,
    /// Creation time.
    pub created_at: Timestamp,
}

/// Input for [`create`].
#[derive(Debug, Clone)]
pub struct NewApproval {
    /// Action being gated.
    pub action: String,
    /// Target resource.
    pub resource_id: String,
    /// Requester.
    pub requested_by_id: Id,
    /// Team.
    pub team_id: Id,
    /// Details (defaults to `{}`).
    pub metadata: Option<Value>,
    /// Time to live; defaults to [`DEFAULT_EXPIRY_MS`].
    pub expires_in_ms: Option<i64>,
}

fn row(r: &Row<'_>) -> rusqlite::Result<Approval> {
    Ok(Approval {
        id: r.get("id")?,
        action: r.get("action")?,
        resource_id: r.get("resource_id")?,
        requested_by_id: r.get("requested_by_id")?,
        reviewed_by_id: r.get("reviewed_by_id")?,
        team_id: r.get("team_id")?,
        status: r
            .get::<_, String>("status")?
            .parse()
            .map_err(|e: Error| rusqlite::Error::ToSqlConversionFailure(Box::new(e)))?,
        metadata: json_col(r, "metadata")?,
        reason: r.get("reason")?,
        expires_at: r.get("expires_at")?,
        reviewed_at: r.get("reviewed_at")?,
        created_at: r.get("created_at")?,
    })
}

/// Create a pending approval.
pub fn create(conn: &Connection, new: &NewApproval) -> Result<Approval> {
    create_at(conn, new, now_ms())
}

/// [`create`] with an explicit clock.
pub fn create_at(conn: &Connection, new: &NewApproval, now: Timestamp) -> Result<Approval> {
    if new.action.trim().is_empty() || new.resource_id.trim().is_empty() {
        return Err(Error::Invalid("action and resource_id are required".into()));
    }
    let ttl = new.expires_in_ms.unwrap_or(DEFAULT_EXPIRY_MS);
    let meta = new
        .metadata
        .clone()
        .unwrap_or_else(|| Value::Object(Map::new()));
    let id = new_id();
    conn.execute(
        "INSERT INTO approvals (id, action, resource_id, requested_by_id, team_id, status, metadata, expires_at, created_at)
         VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8)",
        params![id, new.action, new.resource_id, new.requested_by_id, new.team_id,
                serde_json::to_string(&meta)?, now.saturating_add(ttl), now],
    )
    .map_err(db_err)?;
    get(conn, &id)
}

/// Fetch by id.
pub fn get(conn: &Connection, id: &str) -> Result<Approval> {
    conn.query_row("SELECT * FROM approvals WHERE id = ?1", [id], row)
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Error::NotFound(format!("approval {id}")),
            e => e.into(),
        })
}

/// Approve a pending approval (see module docs for the no-op and expiry rules).
pub fn approve(
    conn: &Connection,
    id: &str,
    reviewer_id: &str,
    reason: Option<&str>,
) -> Result<Approval> {
    approve_at(conn, id, reviewer_id, reason, now_ms())
}

/// [`approve`] with an explicit clock.
pub fn approve_at(
    conn: &Connection,
    id: &str,
    reviewer_id: &str,
    reason: Option<&str>,
    now: Timestamp,
) -> Result<Approval> {
    atomic(conn, || {
        let a = get(conn, id)?;
        if a.status != ApprovalStatus::Pending {
            return Ok(a);
        }
        if a.expires_at < now {
            conn.execute(
                "UPDATE approvals SET status = 'expired' WHERE id = ?1",
                [id],
            )?;
            return get(conn, id);
        }
        decide(conn, id, ApprovalStatus::Approved, reviewer_id, reason, now)
    })
}

/// Reject a pending approval. Non-pending approvals are returned unchanged.
pub fn reject(
    conn: &Connection,
    id: &str,
    reviewer_id: &str,
    reason: Option<&str>,
) -> Result<Approval> {
    reject_at(conn, id, reviewer_id, reason, now_ms())
}

/// [`reject`] with an explicit clock.
pub fn reject_at(
    conn: &Connection,
    id: &str,
    reviewer_id: &str,
    reason: Option<&str>,
    now: Timestamp,
) -> Result<Approval> {
    atomic(conn, || {
        let a = get(conn, id)?;
        if a.status != ApprovalStatus::Pending {
            return Ok(a);
        }
        decide(conn, id, ApprovalStatus::Rejected, reviewer_id, reason, now)
    })
}

fn decide(
    conn: &Connection,
    id: &str,
    to: ApprovalStatus,
    reviewer: &str,
    reason: Option<&str>,
    now: Timestamp,
) -> Result<Approval> {
    conn.execute(
        "UPDATE approvals SET status = ?2, reviewed_by_id = ?3, reviewed_at = ?4, reason = ?5 WHERE id = ?1",
        params![id, to.as_str(), reviewer, now, reason],
    )
    .map_err(db_err)?;
    get(conn, id)
}

/// Mark every pending approval past its deadline as `expired`; returns how many changed.
pub fn expire_overdue(conn: &Connection, now: Timestamp) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE approvals SET status = 'expired' WHERE status = 'pending' AND expires_at < ?1",
        [now],
    )?)
}

/// Most recent approval for `(action, resource, team)`, any status (TS `check`).
pub fn check(
    conn: &Connection,
    action: &str,
    resource_id: &str,
    team_id: &str,
) -> Result<Option<Approval>> {
    let mut s = conn.prepare(
        "SELECT * FROM approvals WHERE action = ?1 AND resource_id = ?2 AND team_id = ?3
         ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )?;
    let mut rows = s.query_map(params![action, resource_id, team_id], row)?;
    rows.next().transpose().map_err(Into::into)
}

/// Whether the most recent approval for the action is `approved`. Use as a gate.
pub fn is_approved(
    conn: &Connection,
    action: &str,
    resource_id: &str,
    team_id: &str,
) -> Result<bool> {
    Ok(check(conn, action, resource_id, team_id)?
        .is_some_and(|a| a.status == ApprovalStatus::Approved))
}

/// Approvals of a team, newest first, optionally filtered by status.
pub fn list_by_team(
    conn: &Connection,
    team_id: &str,
    status: Option<ApprovalStatus>,
) -> Result<Vec<Approval>> {
    let mut s = conn.prepare(
        "SELECT * FROM approvals WHERE team_id = ?1 AND (?2 IS NULL OR status = ?2)
         ORDER BY created_at DESC, rowid DESC",
    )?;
    let rows = s
        .query_map(params![team_id, status.map(ApprovalStatus::as_str)], row)?
        .collect::<std::result::Result<_, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vcs::testutil::{fx, Fx};
    use serde_json::json;

    fn na(f: &Fx, ttl: Option<i64>) -> NewApproval {
        NewApproval {
            action: "merge_branch".into(),
            resource_id: "branch-1".into(),
            requested_by_id: f.user.id.clone(),
            team_id: f.team.id.clone(),
            metadata: Some(json!({"why": "ship"})),
            expires_in_ms: ttl,
        }
    }

    #[test]
    fn create_defaults_to_pending_with_seven_day_expiry() {
        let f = fx();
        let a = create_at(f.db.conn(), &na(&f, None), 1_000).unwrap();
        assert_eq!(a.status, ApprovalStatus::Pending);
        assert_eq!(a.expires_at, 1_000 + DEFAULT_EXPIRY_MS);
        assert_eq!(a.metadata["why"], "ship");
        assert!(a.reviewed_at.is_none());
    }

    #[test]
    fn approve_records_reviewer_and_is_idempotent_after() {
        let f = fx();
        let c = f.db.conn();
        let a = create_at(c, &na(&f, Some(10_000)), 0).unwrap();
        let ok = approve_at(c, &a.id, &f.other.id, Some("lgtm"), 5).unwrap();
        assert_eq!(ok.status, ApprovalStatus::Approved);
        assert_eq!(ok.reviewed_by_id.as_deref(), Some(f.other.id.as_str()));
        assert_eq!(ok.reviewed_at, Some(5));
        assert_eq!(ok.reason.as_deref(), Some("lgtm"));
        // terminal: reject after approve changes nothing
        let again = reject_at(c, &a.id, &f.user.id, Some("nope"), 6).unwrap();
        assert_eq!(again.status, ApprovalStatus::Approved);
        assert_eq!(again.reason.as_deref(), Some("lgtm"));
    }

    #[test]
    fn reject_is_terminal() {
        let f = fx();
        let c = f.db.conn();
        let a = create_at(c, &na(&f, None), 0).unwrap();
        let r = reject_at(c, &a.id, &f.other.id, Some("risky"), 1).unwrap();
        assert_eq!(r.status, ApprovalStatus::Rejected);
        let after = approve_at(c, &a.id, &f.other.id, None, 2).unwrap();
        assert_eq!(after.status, ApprovalStatus::Rejected);
    }

    #[test]
    fn approving_an_overdue_request_expires_it() {
        let f = fx();
        let c = f.db.conn();
        let a = create_at(c, &na(&f, Some(100)), 0).unwrap();
        let r = approve_at(c, &a.id, &f.other.id, None, 101).unwrap();
        assert_eq!(r.status, ApprovalStatus::Expired);
        assert!(r.reviewed_by_id.is_none());
        // deadline itself is still valid
        let b = create_at(c, &na(&f, Some(100)), 0).unwrap();
        assert_eq!(
            approve_at(c, &b.id, &f.other.id, None, 100).unwrap().status,
            ApprovalStatus::Approved
        );
    }

    #[test]
    fn sweep_expires_only_overdue_pending() {
        let f = fx();
        let c = f.db.conn();
        let late = create_at(c, &na(&f, Some(10)), 0).unwrap();
        let fresh = create_at(c, &na(&f, Some(1000)), 0).unwrap();
        let done = create_at(c, &na(&f, Some(10)), 0).unwrap();
        approve_at(c, &done.id, &f.other.id, None, 1).unwrap();
        assert_eq!(expire_overdue(c, 50).unwrap(), 1);
        assert_eq!(get(c, &late.id).unwrap().status, ApprovalStatus::Expired);
        assert_eq!(get(c, &fresh.id).unwrap().status, ApprovalStatus::Pending);
        assert_eq!(get(c, &done.id).unwrap().status, ApprovalStatus::Approved);
    }

    #[test]
    fn transition_table() {
        use ApprovalStatus::*;
        for to in [Approved, Rejected, Expired] {
            assert!(Pending.can_transition(to));
            for from in [Approved, Rejected, Expired] {
                assert!(!from.can_transition(to));
            }
        }
        assert!(!Pending.can_transition(Pending));
    }

    #[test]
    fn check_returns_latest_and_gate_follows_it() {
        let f = fx();
        let c = f.db.conn();
        assert!(check(c, "merge_branch", "branch-1", &f.team.id)
            .unwrap()
            .is_none());
        let first = create_at(c, &na(&f, None), 1).unwrap();
        approve_at(c, &first.id, &f.other.id, None, 2).unwrap();
        assert!(is_approved(c, "merge_branch", "branch-1", &f.team.id).unwrap());
        // a newer pending request supersedes the older approval
        let second = create_at(c, &na(&f, None), 3).unwrap();
        assert_eq!(
            check(c, "merge_branch", "branch-1", &f.team.id)
                .unwrap()
                .unwrap()
                .id,
            second.id
        );
        assert!(!is_approved(c, "merge_branch", "branch-1", &f.team.id).unwrap());
        assert!(!is_approved(c, "other", "branch-1", &f.team.id).unwrap());
    }

    #[test]
    fn list_filters_by_status_newest_first() {
        let f = fx();
        let c = f.db.conn();
        let a = create_at(c, &na(&f, None), 1).unwrap();
        let b = create_at(c, &na(&f, None), 2).unwrap();
        reject_at(c, &a.id, &f.other.id, None, 3).unwrap();
        let all = list_by_team(c, &f.team.id, None).unwrap();
        assert_eq!(
            all.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(),
            [b.id.as_str(), a.id.as_str()]
        );
        let pending = list_by_team(c, &f.team.id, Some(ApprovalStatus::Pending)).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, b.id);
    }

    #[test]
    fn validation_and_not_found() {
        let f = fx();
        let c = f.db.conn();
        let mut bad = na(&f, None);
        bad.action = " ".into();
        assert!(matches!(create(c, &bad), Err(Error::Invalid(_))));
        assert!(matches!(
            approve(c, "nope", &f.user.id, None),
            Err(Error::NotFound(_))
        ));
    }
}
