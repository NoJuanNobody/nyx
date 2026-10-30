//! Approvals (`approval.service.ts`) with approval rules and required reviewers.
//!
//! TS parity: create/approve/reject/check/list/get, 7 day default expiry, non-pending approvals
//! are returned unchanged, approving an overdue request marks it `expired`. Extensions: an
//! [`ApprovalRule`] can demand several approvals, name reviewers who must all approve, and forbid
//! self-approval; votes are kept in `approval_reviews`.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{Error, Result};
use crate::model::{new_id, string_enum, Id, Timestamp};
use crate::notify::store::savepoint;
use crate::notify::Clock;
use crate::store::db_err;

/// Default approval expiry: 7 days.
pub const DEFAULT_EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

string_enum! {
    /// Approval state. Drizzle enum `approval_status`.
    ApprovalStatus {
        /// Waiting for reviewers.
        Pending => "pending",
        /// Enough approvals collected.
        Approved => "approved",
        /// Rejected by a reviewer.
        Rejected => "rejected",
        /// Expired before completion.
        Expired => "expired",
    }
}

/// A governance rule saying an action needs approval, and from whom.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalRule {
    /// Action this rule applies to (`publish`, `delete`, ...).
    pub action: String,
    /// Minimum number of distinct approvals (at least 1).
    #[serde(default = "one")]
    pub min_approvals: u32,
    /// When non-empty, only these users may review and every one of them must approve.
    #[serde(default)]
    pub reviewer_ids: Vec<Id>,
    /// Whether the requester may approve their own request.
    #[serde(default)]
    pub allow_self_approval: bool,
    /// Expiry override in ms.
    #[serde(default)]
    pub expires_in_ms: Option<i64>,
}

fn one() -> u32 {
    1
}

impl ApprovalRule {
    /// Rule for `action` needing one approval from anyone but the requester.
    #[must_use]
    pub fn new(action: &str) -> Self {
        Self {
            action: action.into(),
            min_approvals: 1,
            reviewer_ids: vec![],
            allow_self_approval: false,
            expires_in_ms: None,
        }
    }

    /// Approvals needed in total: the larger of `min_approvals` and the named reviewers.
    #[must_use]
    pub fn required_count(&self) -> u32 {
        let named = u32::try_from(self.reviewer_ids.len()).unwrap_or(u32::MAX);
        self.min_approvals.max(named).max(1)
    }

    /// TS-compatible behaviour used when no rule matches: one approval, anyone, self allowed.
    #[must_use]
    pub fn default_for(action: &str) -> Self {
        Self {
            allow_self_approval: true,
            ..Self::new(action)
        }
    }
}

/// An approval request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Approval {
    /// Id.
    pub id: Id,
    /// Action being approved.
    pub action: String,
    /// Resource the action targets.
    pub resource_id: String,
    /// Requester.
    pub requested_by_id: Id,
    /// Last reviewer who moved it to a final state.
    pub reviewed_by_id: Option<Id>,
    /// Team.
    pub team_id: Id,
    /// State.
    pub status: ApprovalStatus,
    /// Free-form metadata.
    pub metadata: Value,
    /// Reviewer's reason.
    pub reason: Option<String>,
    /// Approvals needed (snapshot of the rule).
    pub min_approvals: u32,
    /// Named reviewers (snapshot of the rule).
    pub reviewer_ids: Vec<Id>,
    /// Self approval allowed (snapshot of the rule).
    pub allow_self_approval: bool,
    /// Expiry.
    pub expires_at: Timestamp,
    /// When finalised.
    pub reviewed_at: Option<Timestamp>,
    /// Creation.
    pub created_at: Timestamp,
}

/// Input for [`ApprovalService::create`].
#[derive(Debug, Clone)]
pub struct NewApproval {
    /// Action.
    pub action: String,
    /// Resource.
    pub resource_id: String,
    /// Requester.
    pub requested_by_id: Id,
    /// Team.
    pub team_id: Id,
    /// Metadata.
    pub metadata: Value,
    /// Expiry override in ms (beats the rule's).
    pub expires_in_ms: Option<i64>,
}

/// One reviewer vote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalReview {
    /// Reviewer.
    pub reviewer_id: Id,
    /// `approved` or `rejected`.
    pub decision: ApprovalStatus,
    /// Reason given.
    pub reason: Option<String>,
    /// When voted.
    pub created_at: Timestamp,
}

fn row(r: &Row<'_>) -> rusqlite::Result<Approval> {
    let reviewers: String = r.get("reviewer_ids")?;
    let meta: String = r.get("metadata")?;
    let conv = |e: serde_json::Error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
    };
    Ok(Approval {
        id: r.get("id")?,
        action: r.get("action")?,
        resource_id: r.get("resource_id")?,
        requested_by_id: r.get("requested_by_id")?,
        reviewed_by_id: r.get("reviewed_by_id")?,
        team_id: r.get("team_id")?,
        status: r.get("status")?,
        metadata: serde_json::from_str(&meta).map_err(conv)?,
        reason: r.get("reason")?,
        min_approvals: r.get("min_approvals")?,
        reviewer_ids: serde_json::from_str(&reviewers).map_err(conv)?,
        allow_self_approval: r.get("allow_self_approval")?,
        expires_at: r.get("expires_at")?,
        reviewed_at: r.get("reviewed_at")?,
        created_at: r.get("created_at")?,
    })
}

/// Approval workflow over a connection.
pub struct ApprovalService<'c> {
    conn: &'c Connection,
    rules: Vec<ApprovalRule>,
    clock: Clock,
}

impl<'c> ApprovalService<'c> {
    /// New service with no rules (TS behaviour: one approval from anyone).
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self {
            conn,
            rules: vec![],
            clock: Clock::system(),
        }
    }

    /// Use these approval rules.
    #[must_use]
    pub fn with_rules(mut self, rules: Vec<ApprovalRule>) -> Self {
        self.rules = rules;
        self
    }

    /// Override the clock (tests).
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    /// Rule that applies to an action.
    #[must_use]
    pub fn rule_for(&self, action: &str) -> ApprovalRule {
        self.rules
            .iter()
            .find(|r| r.action == action)
            .cloned()
            .unwrap_or_else(|| ApprovalRule::default_for(action))
    }

    /// Create a pending request under the matching rule.
    pub fn create(&self, new: &NewApproval) -> Result<Approval> {
        let rule = self.rule_for(&new.action);
        let now = self.clock.now();
        let expires = now
            + new
                .expires_in_ms
                .or(rule.expires_in_ms)
                .unwrap_or(DEFAULT_EXPIRY_MS);
        let id = new_id();
        self.conn
            .execute(
                "INSERT INTO approvals (id,action,resource_id,requested_by_id,team_id,status,metadata,min_approvals,reviewer_ids,allow_self_approval,expires_at,created_at)
                 VALUES (?1,?2,?3,?4,?5,'pending',?6,?7,?8,?9,?10,?11)",
                params![
                    id, new.action, new.resource_id, new.requested_by_id, new.team_id,
                    serde_json::to_string(&new.metadata)?, rule.required_count(),
                    serde_json::to_string(&rule.reviewer_ids)?, rule.allow_self_approval, expires, now
                ],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    /// Fetch by id.
    pub fn get(&self, id: &str) -> Result<Approval> {
        self.conn
            .query_row("SELECT * FROM approvals WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("approval {id}")))
    }

    fn assert_named(a: &Approval, reviewer_id: &str) -> Result<()> {
        if !a.reviewer_ids.is_empty() && !a.reviewer_ids.iter().any(|r| r == reviewer_id) {
            return Err(Error::Invalid(format!(
                "user {reviewer_id} is not a required reviewer for approval {}",
                a.id
            )));
        }
        Ok(())
    }

    /// Record an approval vote. Returns the approval; it only turns `approved` once the rule is
    /// satisfied (enough distinct approvals and every named reviewer). Non-pending approvals are
    /// returned unchanged; an overdue pending one becomes `expired`.
    pub fn approve(&self, id: &str, reviewer_id: &str, reason: Option<&str>) -> Result<Approval> {
        let a = self.get(id)?;
        if a.status != ApprovalStatus::Pending {
            return Ok(a);
        }
        let now = self.clock.now();
        if a.expires_at < now {
            self.conn
                .execute("UPDATE approvals SET status='expired' WHERE id=?1", [id])?;
            return self.get(id);
        }
        Self::assert_named(&a, reviewer_id)?;
        if !a.allow_self_approval && reviewer_id == a.requested_by_id {
            return Err(Error::Invalid(
                "requesters cannot approve their own request".into(),
            ));
        }
        savepoint(self.conn, || {
            self.conn
                .execute(
                    "INSERT INTO approval_reviews (id,approval_id,reviewer_id,decision,reason,created_at) VALUES (?1,?2,?3,'approved',?4,?5)",
                    params![new_id(), id, reviewer_id, reason, now],
                )
                .map_err(|e| match db_err(e) {
                    Error::Conflict(_) => Error::Conflict(format!("{reviewer_id} already reviewed approval {id}")),
                    other => other,
                })?;
            let approvers = self.approvers(id)?;
            let enough = approvers.len() >= a.min_approvals.max(1) as usize
                && a.reviewer_ids.iter().all(|r| approvers.contains(r));
            if enough {
                self.conn.execute(
                    "UPDATE approvals SET status='approved', reviewed_by_id=?2, reviewed_at=?3, reason=?4 WHERE id=?1",
                    params![id, reviewer_id, now, reason],
                )?;
            }
            Ok(())
        })?;
        self.get(id)
    }

    /// Reject: any single (eligible) reviewer ends the request. Non-pending approvals are
    /// returned unchanged.
    pub fn reject(&self, id: &str, reviewer_id: &str, reason: Option<&str>) -> Result<Approval> {
        let a = self.get(id)?;
        if a.status != ApprovalStatus::Pending {
            return Ok(a);
        }
        Self::assert_named(&a, reviewer_id)?;
        let now = self.clock.now();
        savepoint(self.conn, || {
            self.conn.execute(
                "INSERT INTO approval_reviews (id,approval_id,reviewer_id,decision,reason,created_at) VALUES (?1,?2,?3,'rejected',?4,?5)
                 ON CONFLICT(approval_id,reviewer_id) DO UPDATE SET decision='rejected', reason=?4, created_at=?5",
                params![new_id(), id, reviewer_id, reason, now],
            )?;
            self.conn.execute(
                "UPDATE approvals SET status='rejected', reviewed_by_id=?2, reviewed_at=?3, reason=?4 WHERE id=?1",
                params![id, reviewer_id, now, reason],
            )?;
            Ok(())
        })?;
        self.get(id)
    }

    fn approvers(&self, id: &str) -> Result<Vec<Id>> {
        let mut s = self.conn.prepare(
            "SELECT reviewer_id FROM approval_reviews WHERE approval_id=?1 AND decision='approved'",
        )?;
        let v = s
            .query_map([id], |r| r.get(0))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(v)
    }

    /// All votes on an approval, oldest first.
    pub fn reviews(&self, id: &str) -> Result<Vec<ApprovalReview>> {
        let mut s = self.conn.prepare(
            "SELECT reviewer_id, decision, reason, created_at FROM approval_reviews WHERE approval_id=?1 ORDER BY created_at, rowid",
        )?;
        let v = s
            .query_map([id], |r| {
                Ok(ApprovalReview {
                    reviewer_id: r.get(0)?,
                    decision: r.get(1)?,
                    reason: r.get(2)?,
                    created_at: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(v)
    }

    /// Most recent approval for an action and resource, or `None`.
    pub fn check(
        &self,
        action: &str,
        resource_id: &str,
        team_id: &str,
    ) -> Result<Option<Approval>> {
        Ok(self
            .conn
            .query_row(
                "SELECT * FROM approvals WHERE action=?1 AND resource_id=?2 AND team_id=?3 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![action, resource_id, team_id],
                row,
            )
            .optional()?)
    }

    /// Team approvals, newest first, optionally filtered by status.
    pub fn list_by_team(
        &self,
        team_id: &str,
        status: Option<ApprovalStatus>,
    ) -> Result<Vec<Approval>> {
        let mut s = self.conn.prepare(
            "SELECT * FROM approvals WHERE team_id=?1 AND (?2 IS NULL OR status=?2) ORDER BY created_at DESC, rowid DESC",
        )?;
        let v = s
            .query_map(params![team_id, status], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(v)
    }

    /// Mark every overdue pending approval `expired`; returns how many changed.
    pub fn expire_overdue(&self) -> Result<usize> {
        Ok(self.conn.execute(
            "UPDATE approvals SET status='expired' WHERE status='pending' AND expires_at < ?1",
            [self.clock.now()],
        )?)
    }
}
