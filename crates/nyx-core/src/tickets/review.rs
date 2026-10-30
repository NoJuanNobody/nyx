//! Bulk ticket review state and idempotent posting.
//!
//! ```text
//!   draft --approve--> approved --post--> posting --ok--> posted
//!     |                   |                  \--err--> failed --retry--> approved
//!     \--dismiss--> dismissed <--dismiss--/                \--dismiss--> dismissed
//! ```
//!
//! Guarantees:
//! - **Claim before call.** `post` flips `approved|failed -> posting` in one conditional UPDATE;
//!   a concurrent second `post` loses the race and gets [`Error::Conflict`] without touching the
//!   tracker.
//! - **Posted is terminal and recorded atomically.** The external ref, `posted` status, the
//!   `tickets` row, the audit event and the timeline event are written in one savepoint. Posting
//!   an already-posted draft returns the recorded ref and never calls the tracker.
//! - **Unknown outcomes are not retried blindly.** After a transport error / 5xx / unparseable
//!   2xx the draft is `failed` with `outcome_unknown = 1`; the next attempt first asks the tracker
//!   whether an issue with that title already exists ([`TicketTracker::find_by_title`]) and adopts
//!   it instead of creating a duplicate. A draft left in `posting` by a crash is moved to
//!   `failed/outcome_unknown` by [`recover_interrupted`].
//! - **Traceability.** Every posted body ends with a footer linking back to the document
//!   ([`super::draft::with_traceability`]).
//! - Dedupe: [`DraftStore::create_batch`] drops candidates that duplicate existing tickets or live
//!   drafts of the document; a unique index backs it up.

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::draft::{
    dedupe_key, find_duplicates, with_traceability, DuplicateOf, TraceRef, DUPLICATE_THRESHOLD,
};
use super::tracker::{
    Destination, NewIssue, RemoteIssue, TicketTracker, TrackerError, TrackerKind, TrackerSet,
};
use crate::ai::parse::TicketDraft;
use crate::error::{Error, Result};
use crate::model::{
    new_id, now_ms, AuditEventType, Id, NewAuditEvent, NewTicket, Ticket, Timestamp,
};
use crate::store::{
    db_err, AuditRepo, DocumentRepo, SqliteAudit, SqliteDocuments, SqliteTickets, TicketRepo,
};
use crate::vcs::{atomic, timeline};

/// Review / posting state of a draft.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftStatus {
    /// Awaiting review.
    Draft,
    /// Reviewed, destination chosen, ready to post.
    Approved,
    /// A post is in flight.
    Posting,
    /// Created in the external tracker.
    Posted,
    /// The last post attempt failed; can be retried.
    Failed,
    /// Rejected by the reviewer.
    Dismissed,
}

impl DraftStatus {
    /// Column value.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Draft => "draft",
            Self::Approved => "approved",
            Self::Posting => "posting",
            Self::Posted => "posted",
            Self::Failed => "failed",
            Self::Dismissed => "dismissed",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "draft" => Self::Draft,
            "approved" => Self::Approved,
            "posting" => Self::Posting,
            "posted" => Self::Posted,
            "failed" => Self::Failed,
            "dismissed" => Self::Dismissed,
            _ => return None,
        })
    }
}

impl std::fmt::Display for DraftStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Where a posted draft lives externally.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalRef {
    /// Tracker.
    pub kind: TrackerKind,
    /// Provider-side id.
    pub id: String,
    /// Browser URL.
    pub url: String,
}

/// A stored draft.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DraftRecord {
    /// Id.
    pub id: Id,
    /// Review batch (one bulk-generate run).
    pub batch_id: Id,
    /// Source document.
    pub document_id: Id,
    /// Title.
    pub title: String,
    /// Markdown body (without the traceability footer; that is added when posting).
    pub body: String,
    /// Labels.
    pub labels: Vec<String>,
    /// Chosen destination.
    pub destination: Option<Destination>,
    /// State.
    pub status: DraftStatus,
    /// Post attempts so far.
    pub attempts: u32,
    /// Error of the last failed attempt.
    pub last_error: Option<String>,
    /// Whether the last failed attempt may have created the issue anyway.
    pub outcome_unknown: bool,
    /// External ref once posted.
    pub external: Option<ExternalRef>,
    /// Board row, if the tracker maps onto `tickets.provider`.
    pub ticket_id: Option<Id>,
    /// Who generated the draft.
    pub created_by_id: Id,
    /// Who last approved / dismissed it.
    pub reviewed_by_id: Option<Id>,
    /// Created (unix ms).
    pub created_at: Timestamp,
    /// Updated (unix ms).
    pub updated_at: Timestamp,
}

fn bad(msg: String) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::other(msg)),
    )
}

fn row(r: &Row<'_>) -> rusqlite::Result<DraftRecord> {
    let labels: String = r.get("labels")?;
    let status: String = r.get("status")?;
    let dest: Option<String> = r.get("destination")?;
    let provider: Option<String> = r.get("external_provider")?;
    let ext_id: Option<String> = r.get("external_id")?;
    let ext_url: Option<String> = r.get("external_url")?;
    let external = match (provider, ext_id, ext_url) {
        (Some(p), Some(id), Some(url)) => Some(ExternalRef {
            kind: TrackerKind::from_slug(&p).map_err(|e| bad(e.to_string()))?,
            id,
            url,
        }),
        _ => None,
    };
    Ok(DraftRecord {
        id: r.get("id")?,
        batch_id: r.get("batch_id")?,
        document_id: r.get("document_id")?,
        title: r.get("title")?,
        body: r.get("body")?,
        labels: serde_json::from_str(&labels).map_err(|e| bad(e.to_string()))?,
        destination: dest
            .map(|d| serde_json::from_str(&d).map_err(|e| bad(e.to_string())))
            .transpose()?,
        status: DraftStatus::parse(&status)
            .ok_or_else(|| bad(format!("bad draft status {status:?}")))?,
        attempts: r
            .get::<_, i64>("attempts")
            .map(|n| u32::try_from(n).unwrap_or(0))?,
        last_error: r.get("last_error")?,
        outcome_unknown: r.get::<_, i64>("outcome_unknown")? != 0,
        external,
        ticket_id: r.get("ticket_id")?,
        created_by_id: r.get("created_by_id")?,
        reviewed_by_id: r.get("reviewed_by_id")?,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
    })
}

/// Result of [`DraftStore::create_batch`].
#[derive(Debug, Clone, PartialEq)]
pub struct BatchCreated {
    /// Batch id shared by all created drafts.
    pub batch_id: Id,
    /// New drafts, in order.
    pub created: Vec<DraftRecord>,
    /// Candidates dropped as duplicates, with what they duplicate.
    pub duplicates: Vec<(TicketDraft, DuplicateOf)>,
}

/// Per-status counts of a batch.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchSummary {
    /// `draft`.
    pub draft: u32,
    /// `approved`.
    pub approved: u32,
    /// `posting`.
    pub posting: u32,
    /// `posted`.
    pub posted: u32,
    /// `failed`.
    pub failed: u32,
    /// `dismissed`.
    pub dismissed: u32,
}

/// Draft persistence and review transitions.
#[derive(Debug, Clone, Copy)]
pub struct DraftStore<'c>(&'c Connection);

impl<'c> DraftStore<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }

    /// Store generated drafts for review as one batch.
    ///
    /// Candidates that duplicate an existing ticket of the document, a live draft of it
    /// (including posted ones) or an earlier candidate are not stored and are reported in
    /// [`BatchCreated::duplicates`]. `destination` pre-selects a target for every draft (the
    /// reviewer can change it per draft).
    ///
    /// # Errors
    /// [`Error::NotFound`] for an unknown document; database failure.
    pub fn create_batch(
        &self,
        document_id: &str,
        actor_id: &str,
        drafts: Vec<TicketDraft>,
        destination: Option<&Destination>,
    ) -> Result<BatchCreated> {
        SqliteDocuments::new(self.0).get(document_id)?;
        let mut known: Vec<String> = SqliteTickets::new(self.0)
            .list_by_document(document_id)?
            .into_iter()
            .map(|t| t.title)
            .collect();
        known.extend(
            self.list_by_document(document_id)?
                .into_iter()
                .filter(|d| d.status != DraftStatus::Dismissed)
                .map(|d| d.title),
        );
        let report = find_duplicates(
            super::draft::sanitize_batch(drafts),
            &known,
            DUPLICATE_THRESHOLD,
        );
        let batch_id = new_id();
        let created = atomic(self.0, || {
            report
                .keep
                .iter()
                .map(|d| self.insert(&batch_id, document_id, actor_id, d, destination))
                .collect::<Result<Vec<_>>>()
        })?;
        Ok(BatchCreated {
            batch_id,
            created,
            duplicates: report.duplicates,
        })
    }

    fn insert(
        &self,
        batch_id: &str,
        document_id: &str,
        actor_id: &str,
        d: &TicketDraft,
        destination: Option<&Destination>,
    ) -> Result<DraftRecord> {
        let (id, now) = (new_id(), now_ms());
        let dest = destination.map(serde_json::to_string).transpose()?;
        self.0
            .execute(
                "INSERT INTO ticket_drafts (id, batch_id, document_id, title, body, labels, dedupe_key,
                    destination, destination_key, status, created_by_id, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'draft',?10,?11,?11)",
                params![
                    id,
                    batch_id,
                    document_id,
                    d.title,
                    d.description,
                    serde_json::to_string(&d.labels)?,
                    dedupe_key(&d.title),
                    dest,
                    destination.map(Destination::key),
                    actor_id,
                    now
                ],
            )
            .map_err(db_err)?;
        self.get(&id)
    }

    /// Fetch one.
    ///
    /// # Errors
    /// [`Error::NotFound`].
    pub fn get(&self, id: &str) -> Result<DraftRecord> {
        self.0
            .query_row("SELECT * FROM ticket_drafts WHERE id = ?1", [id], row)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("ticket draft {id}")))
    }

    /// Drafts of a document, oldest first.
    ///
    /// # Errors
    /// Database failure.
    pub fn list_by_document(&self, document_id: &str) -> Result<Vec<DraftRecord>> {
        self.query("WHERE document_id = ?1", document_id)
    }

    /// Drafts of a batch, in creation order.
    ///
    /// # Errors
    /// Database failure.
    pub fn list_by_batch(&self, batch_id: &str) -> Result<Vec<DraftRecord>> {
        self.query("WHERE batch_id = ?1", batch_id)
    }

    fn query(&self, filter: &str, arg: &str) -> Result<Vec<DraftRecord>> {
        let mut s = self.0.prepare(&format!(
            "SELECT * FROM ticket_drafts {filter} ORDER BY created_at, rowid"
        ))?;
        let rows = s
            .query_map([arg], row)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    /// Counts per status for a batch.
    ///
    /// # Errors
    /// Database failure.
    pub fn summary(&self, batch_id: &str) -> Result<BatchSummary> {
        let mut out = BatchSummary::default();
        for d in self.list_by_batch(batch_id)? {
            let slot = match d.status {
                DraftStatus::Draft => &mut out.draft,
                DraftStatus::Approved => &mut out.approved,
                DraftStatus::Posting => &mut out.posting,
                DraftStatus::Posted => &mut out.posted,
                DraftStatus::Failed => &mut out.failed,
                DraftStatus::Dismissed => &mut out.dismissed,
            };
            *slot += 1;
        }
        Ok(out)
    }

    /// Conditional status change: succeeds only if the draft is currently in one of `from`.
    fn move_to(
        &self,
        id: &str,
        from: &[DraftStatus],
        to: DraftStatus,
        reviewer: Option<&str>,
    ) -> Result<DraftRecord> {
        let cur = self.get(id)?;
        if !from.contains(&cur.status) {
            return Err(Error::Conflict(format!(
                "ticket draft {id} is {}, cannot move to {to}",
                cur.status
            )));
        }
        let n = self
            .0
            .execute(
                "UPDATE ticket_drafts SET status = ?2, reviewed_by_id = COALESCE(?3, reviewed_by_id), updated_at = ?4
                 WHERE id = ?1 AND status = ?5",
                params![id, to.as_str(), reviewer, now_ms(), cur.status.as_str()],
            )
            .map_err(db_err)?;
        if n == 0 {
            return Err(Error::Conflict(format!(
                "ticket draft {id} changed concurrently"
            )));
        }
        self.get(id)
    }

    /// Edit title / body / labels during review. Allowed on `draft`, `approved` (which goes back
    /// to `draft`: the reviewer approved different content) and `failed`.
    ///
    /// # Errors
    /// [`Error::Conflict`] in other states; [`Error::Invalid`] for an empty title or a title that
    /// collides with another live draft of the document.
    pub fn edit(
        &self,
        id: &str,
        title: Option<&str>,
        body: Option<&str>,
        labels: Option<&[String]>,
    ) -> Result<DraftRecord> {
        let cur = self.get(id)?;
        if !matches!(
            cur.status,
            DraftStatus::Draft | DraftStatus::Approved | DraftStatus::Failed
        ) {
            return Err(Error::Conflict(format!(
                "ticket draft {id} is {} and can no longer be edited",
                cur.status
            )));
        }
        let title = title.map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "));
        if title.as_deref() == Some("") {
            return Err(Error::Invalid("ticket title must not be empty".into()));
        }
        let key = title.as_deref().map(dedupe_key);
        let new_status = if cur.status == DraftStatus::Approved {
            DraftStatus::Draft
        } else {
            cur.status
        };
        self.0
            .execute(
                "UPDATE ticket_drafts SET title = COALESCE(?2, title), body = COALESCE(?3, body),
                    labels = COALESCE(?4, labels), dedupe_key = COALESCE(?5, dedupe_key),
                    status = ?6, updated_at = ?7 WHERE id = ?1",
                params![
                    id,
                    title,
                    body,
                    labels.map(serde_json::to_string).transpose()?,
                    key,
                    new_status.as_str(),
                    now_ms()
                ],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    Error::Invalid("another draft of this document already has that title".into())
                }
                other => db_err(other),
            })?;
        self.get(id)
    }

    /// Choose where the draft will be posted. Allowed on `draft`, `approved` (stays approved) and
    /// `failed`.
    ///
    /// # Errors
    /// [`Error::Conflict`] in other states.
    pub fn set_destination(&self, id: &str, dest: &Destination) -> Result<DraftRecord> {
        let cur = self.get(id)?;
        if !matches!(
            cur.status,
            DraftStatus::Draft | DraftStatus::Approved | DraftStatus::Failed
        ) {
            return Err(Error::Conflict(format!(
                "ticket draft {id} is {}; its destination can no longer change",
                cur.status
            )));
        }
        self.0.execute(
            "UPDATE ticket_drafts SET destination = ?2, destination_key = ?3, updated_at = ?4 WHERE id = ?1",
            params![id, serde_json::to_string(dest)?, dest.key(), now_ms()],
        )?;
        self.get(id)
    }

    /// `draft -> approved`. `destination` (if given) is set first; the draft must end up with
    /// one ("No repository configured").
    ///
    /// # Errors
    /// [`Error::Invalid`] without a destination; [`Error::Conflict`] unless the draft is `draft`.
    pub fn approve(
        &self,
        id: &str,
        reviewer_id: &str,
        destination: Option<&Destination>,
    ) -> Result<DraftRecord> {
        atomic(self.0, || {
            let cur = self.get(id)?;
            if cur.status != DraftStatus::Draft {
                return Err(Error::Conflict(format!(
                    "ticket draft {id} is {}, only drafts can be approved",
                    cur.status
                )));
            }
            if let Some(d) = destination {
                self.set_destination(id, d)?;
            } else if cur.destination.is_none() {
                return Err(Error::Invalid(
                    "choose a destination before approving".into(),
                ));
            }
            self.move_to(
                id,
                &[DraftStatus::Draft],
                DraftStatus::Approved,
                Some(reviewer_id),
            )
        })
    }

    /// Approve several drafts. Like the TS bulk approve this validates up front that every id is a
    /// `draft` (all-or-nothing on state errors).
    ///
    /// # Errors
    /// First state / destination error; nothing is approved in that case.
    pub fn approve_many(
        &self,
        ids: &[String],
        reviewer_id: &str,
        destination: Option<&Destination>,
    ) -> Result<Vec<DraftRecord>> {
        if ids.is_empty() {
            return Err(Error::Invalid("No tickets selected".into()));
        }
        atomic(self.0, || {
            let not_draft = ids
                .iter()
                .map(|i| self.get(i))
                .collect::<Result<Vec<_>>>()?
                .into_iter()
                .filter(|d| d.status != DraftStatus::Draft)
                .count();
            if not_draft > 0 {
                return Err(Error::Conflict(format!(
                    "{not_draft} ticket draft(s) are not in draft status"
                )));
            }
            ids.iter()
                .map(|i| self.approve(i, reviewer_id, destination))
                .collect()
        })
    }

    /// Reject a draft (`draft | approved | failed -> dismissed`).
    ///
    /// # Errors
    /// [`Error::Conflict`] for posted / posting / dismissed drafts.
    pub fn dismiss(&self, id: &str, reviewer_id: &str) -> Result<DraftRecord> {
        self.move_to(
            id,
            &[
                DraftStatus::Draft,
                DraftStatus::Approved,
                DraftStatus::Failed,
            ],
            DraftStatus::Dismissed,
            Some(reviewer_id),
        )
    }

    /// `failed -> approved`, ready for another [`post`].
    ///
    /// # Errors
    /// [`Error::Conflict`] unless the draft is `failed`.
    pub fn retry(&self, id: &str) -> Result<DraftRecord> {
        self.move_to(id, &[DraftStatus::Failed], DraftStatus::Approved, None)
    }

    fn claim(&self, id: &str) -> Result<DraftRecord> {
        let n = self
            .0
            .execute(
                "UPDATE ticket_drafts SET status = 'posting', attempts = attempts + 1, updated_at = ?2
                 WHERE id = ?1 AND status IN ('approved','failed')",
                params![id, now_ms()],
            )
            .map_err(db_err)?;
        if n == 0 {
            let cur = self.get(id)?;
            return Err(Error::Conflict(format!(
                "ticket draft {id} is {} and cannot be posted",
                cur.status
            )));
        }
        self.get(id)
    }

    fn fail(&self, id: &str, error: &str, outcome_unknown: bool) -> Result<DraftRecord> {
        self.0.execute(
            "UPDATE ticket_drafts SET status = 'failed', last_error = ?2, outcome_unknown = ?3, updated_at = ?4
             WHERE id = ?1 AND status = 'posting'",
            params![id, error, i64::from(outcome_unknown), now_ms()],
        )?;
        self.get(id)
    }
}

/// Move drafts stranded in `posting` (crash mid-call) to `failed` with `outcome_unknown`, so the
/// next attempt looks for an existing remote issue first. Call once at startup.
///
/// # Errors
/// Database failure.
pub fn recover_interrupted(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE ticket_drafts SET status = 'failed', outcome_unknown = 1,
            last_error = 'interrupted while posting', updated_at = ?1 WHERE status = 'posting'",
        [now_ms()],
    )?)
}

/// What [`post`] did.
#[derive(Debug, Clone, PartialEq)]
pub enum PostResult {
    /// The draft is posted.
    Posted {
        /// Updated draft.
        draft: DraftRecord,
        /// Board row (none for Linear).
        ticket: Option<Ticket>,
        /// The draft was already posted; the tracker was not called.
        already_posted: bool,
        /// An issue with the same title already existed remotely and was linked instead of
        /// creating a new one.
        adopted_existing: bool,
    },
    /// The tracker refused or was unreachable; the draft is `failed` and can be retried.
    Failed {
        /// Updated draft.
        draft: DraftRecord,
        /// Why.
        error: TrackerError,
    },
}

impl PostResult {
    /// The draft after the call.
    #[must_use]
    pub fn draft(&self) -> &DraftRecord {
        match self {
            Self::Posted { draft, .. } | Self::Failed { draft, .. } => draft,
        }
    }
}

/// Link (or create) the board row for a posted draft. Reuses a ticket of the document with the
/// same external URL so re-linking after a partial failure never duplicates.
fn link_ticket(
    conn: &Connection,
    draft: &DraftRecord,
    ext: &ExternalRef,
    body: &str,
    actor_id: &str,
) -> Result<Option<Ticket>> {
    let Some(provider) = ext.kind.ticket_provider() else {
        return Ok(None);
    };
    let tickets = SqliteTickets::new(conn);
    let existing = tickets
        .list_by_document(&draft.document_id)?
        .into_iter()
        .find(|t| t.provider == provider && t.external_url == ext.url);
    let t = match existing {
        Some(t) => t,
        None => tickets.create(&NewTicket {
            document_id: draft.document_id.clone(),
            provider,
            external_id: ext.id.clone(),
            external_url: ext.url.clone(),
            title: draft.title.clone(),
            body: body.to_owned(),
            insights: Some(json!({
                "draftId": draft.id,
                "batchId": draft.batch_id,
                "labels": draft.labels,
            })),
            created_by_id: actor_id.to_owned(),
        })?,
    };
    conn.execute(
        "UPDATE ticket_drafts SET ticket_id = ?2 WHERE id = ?1",
        params![draft.id, t.id],
    )?;
    Ok(Some(t))
}

/// Post one `approved` or `failed` draft. See the module docs for the guarantees.
///
/// Tracker problems are returned as [`PostResult::Failed`] (state is saved); only state / storage
/// problems are `Err`.
///
/// # Errors
/// [`Error::Conflict`] when the draft is not postable (or another caller is posting it),
/// [`Error::Invalid`] without a destination, [`Error::NotFound`], database failure.
pub fn post(
    conn: &Connection,
    trackers: &TrackerSet,
    draft_id: &str,
    actor_id: &str,
) -> Result<PostResult> {
    let store = DraftStore::new(conn);
    let cur = store.get(draft_id)?;
    if cur.status == DraftStatus::Posted {
        // Idempotent replay; also heals a crash between "posted" and the ticket link.
        let ticket = match (&cur.ticket_id, &cur.external) {
            (Some(tid), _) => Some(SqliteTickets::new(conn).get(tid)?),
            (None, Some(ext)) => link_ticket(conn, &cur, ext, &cur.body, actor_id)?,
            (None, None) => None,
        };
        return Ok(PostResult::Posted {
            draft: store.get(draft_id)?,
            ticket,
            already_posted: true,
            adopted_existing: false,
        });
    }
    let Some(dest) = cur.destination.clone() else {
        return Err(Error::Invalid("choose a destination before posting".into()));
    };
    let doc = SqliteDocuments::new(conn).get(&cur.document_id)?;
    let claimed = store.claim(draft_id)?;

    let outcome = (|| -> std::result::Result<(RemoteIssue, bool, String), TrackerError> {
        let tracker: &dyn TicketTracker = trackers.for_destination(&dest)?;
        let body = with_traceability(
            &claimed.body,
            &doc.title,
            &TraceRef {
                document_id: claimed.document_id.clone(),
                draft_id: claimed.id.clone(),
            },
        );
        if cur.outcome_unknown {
            if let Some(found) = tracker.find_by_title(&dest, &claimed.title)? {
                return Ok((found, true, body));
            }
        }
        let issue = tracker.create_issue(
            &dest,
            &NewIssue {
                title: claimed.title.clone(),
                body: body.clone(),
                labels: claimed.labels.clone(),
            },
        )?;
        Ok((issue, false, body))
    })();

    match outcome {
        Err(e) => {
            let draft = store.fail(draft_id, &e.to_string(), e.outcome_unknown())?;
            Ok(PostResult::Failed { draft, error: e })
        }
        Ok((issue, adopted, body)) => {
            let dest_key = dest.key();
            let ext = ExternalRef {
                kind: issue.kind,
                id: issue.external_id,
                url: issue.external_url,
            };
            let clash: Option<String> = conn
                .query_row(
                    "SELECT id FROM ticket_drafts WHERE destination_key = ?1 AND external_id = ?2 AND id <> ?3",
                    params![dest_key, ext.id, draft_id],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(other) = clash {
                let msg = format!("{} {} is already linked to draft {other}", dest_key, ext.id);
                let draft = store.fail(draft_id, &msg, false)?;
                return Ok(PostResult::Failed {
                    draft,
                    error: TrackerError::Invalid(msg),
                });
            }
            let (draft, ticket) = atomic(conn, || {
                conn.execute(
                    "UPDATE ticket_drafts SET status = 'posted', external_provider = ?2, external_id = ?3,
                        external_url = ?4, last_error = NULL, outcome_unknown = 0, updated_at = ?5
                     WHERE id = ?1 AND status = 'posting'",
                    params![draft_id, ext.kind.slug(), ext.id, ext.url, now_ms()],
                )
                .map_err(db_err)?;
                let posted = store.get(draft_id)?;
                let ticket = link_ticket(conn, &posted, &ext, &body, actor_id)?;
                let mut ev = NewAuditEvent::new(&doc.team_id, AuditEventType::TicketCreated);
                ev.actor_id = Some(actor_id.to_owned());
                ev.document_id = Some(posted.document_id.clone());
                ev.ticket_id = ticket.as_ref().map(|t| t.id.clone());
                ev.metadata = json!({
                    "provider": ext.kind.slug(), "title": posted.title,
                    "externalUrl": ext.url, "draftId": posted.id, "adopted": adopted,
                });
                SqliteAudit::new(conn).append(&ev)?;
                timeline::record(
                    conn,
                    &posted.document_id,
                    "ticket_created",
                    json!({
                        "draftId": posted.id, "ticketId": ticket.as_ref().map(|t| &t.id),
                        "provider": ext.kind.slug(), "title": posted.title, "externalUrl": ext.url,
                    }),
                    Some(actor_id),
                )?;
                Ok((store.get(draft_id)?, ticket))
            })?;
            Ok(PostResult::Posted {
                draft,
                ticket,
                already_posted: false,
                adopted_existing: adopted,
            })
        }
    }
}

/// Outcome of [`post_batch`].
#[derive(Debug, Clone, PartialEq, Default)]
pub struct BatchPostReport {
    /// One result per attempted draft, in order.
    pub results: Vec<PostResult>,
    /// Set when the batch stopped early (rate limit / authentication failure): the remaining
    /// drafts were left `approved` and untouched. Carries the reason; the caller should wait
    /// (rate limit) or reconnect (auth) and call again.
    pub halted: Option<String>,
}

/// Post every `approved` draft of a batch (and, with `include_failed`, retry the `failed` ones),
/// in creation order. Sequential on purpose: the TS service paused 500 ms between calls to stay
/// under tracker rate limits; pacing is the caller's job, but a rate-limit or auth failure halts
/// the run instead of burning through the rest.
///
/// # Errors
/// Storage failures only; per-draft tracker failures are in the report.
pub fn post_batch(
    conn: &Connection,
    trackers: &TrackerSet,
    batch_id: &str,
    actor_id: &str,
    include_failed: bool,
) -> Result<BatchPostReport> {
    let store = DraftStore::new(conn);
    let mut report = BatchPostReport::default();
    for d in store.list_by_batch(batch_id)? {
        let postable = d.status == DraftStatus::Approved
            || (include_failed && d.status == DraftStatus::Failed);
        if !postable {
            continue;
        }
        let r = post(conn, trackers, &d.id, actor_id)?;
        let halt = match &r {
            PostResult::Failed {
                error: e @ (TrackerError::RateLimited { .. } | TrackerError::Auth(_)),
                ..
            } => Some(e.to_string()),
            _ => None,
        };
        report.results.push(r);
        if halt.is_some() {
            report.halted = halt;
            break;
        }
    }
    Ok(report)
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::tickets::tracker::{FakeFailure, FakeTracker};
    use crate::vcs::testutil::{doc, fx, Fx};
    use std::sync::Arc;

    fn td(title: &str) -> TicketDraft {
        TicketDraft {
            title: title.into(),
            description: format!("Body of {title}"),
            labels: vec!["backend".into()],
        }
    }

    fn gh() -> Destination {
        Destination::Github {
            owner: "acme".into(),
            repo: "web".into(),
        }
    }

    struct T {
        f: Fx,
        doc_id: String,
        tracker: Arc<FakeTracker>,
        set: TrackerSet,
    }

    fn setup() -> T {
        let f = fx();
        let d = doc(&f, "# Spec\nSome content");
        let tracker = Arc::new(FakeTracker::new(TrackerKind::Github));
        let set = TrackerSet::new().with(tracker.clone());
        T {
            doc_id: d.id,
            f,
            tracker,
            set,
        }
    }

    fn batch(t: &T, titles: &[&str]) -> BatchCreated {
        DraftStore::new(t.f.db.conn())
            .create_batch(
                &t.doc_id,
                &t.f.user.id,
                titles.iter().map(|x| td(x)).collect(),
                Some(&gh()),
            )
            .unwrap()
    }

    fn approve_all(t: &T, b: &BatchCreated) {
        let ids: Vec<_> = b.created.iter().map(|d| d.id.clone()).collect();
        DraftStore::new(t.f.db.conn())
            .approve_many(&ids, &t.f.user.id, None)
            .unwrap();
    }

    #[test]
    fn happy_path_draft_to_posted_with_traceability_and_board_row() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(&t, &["Add login", "Add logout"]);
        assert_eq!(b.created.len(), 2);
        assert!(b.created.iter().all(|d| d.status == DraftStatus::Draft));
        approve_all(&t, &b);
        let r = post(c, &t.set, &b.created[0].id, &t.f.user.id).unwrap();
        let PostResult::Posted {
            draft,
            ticket,
            already_posted,
            adopted_existing,
        } = r
        else {
            panic!("expected posted")
        };
        assert!(!already_posted && !adopted_existing);
        assert_eq!(draft.status, DraftStatus::Posted);
        assert_eq!(draft.attempts, 1);
        let ext = draft.external.clone().unwrap();
        assert_eq!(ext.kind, TrackerKind::Github);
        let ticket = ticket.unwrap();
        assert_eq!(draft.ticket_id.as_deref(), Some(ticket.id.as_str()));
        assert_eq!(ticket.external_url, ext.url);
        // Traceability footer went to the tracker and into the board row.
        let sent = &t.tracker.created()[0].1;
        assert!(sent.body.contains(&format!("nyx://document/{}", t.doc_id)));
        assert!(sent
            .body
            .contains(&format!("nyx-ref:doc={};draft={}", t.doc_id, draft.id)));
        assert_eq!(ticket.body, sent.body);
        assert_eq!(sent.labels, ["backend"]);
        // Audit + timeline recorded.
        let audit = SqliteAudit::new(c).list_by_document(&t.doc_id, 10).unwrap();
        assert!(audit
            .iter()
            .any(|e| e.event_type == AuditEventType::TicketCreated));
        assert!(timeline::events(c, &t.doc_id)
            .unwrap()
            .iter()
            .any(|e| e.kind == "ticket_created"));
    }

    #[test]
    fn posting_twice_is_idempotent() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(&t, &["Add login"]);
        approve_all(&t, &b);
        let id = &b.created[0].id;
        let first = post(c, &t.set, id, &t.f.user.id).unwrap();
        let second = post(c, &t.set, id, &t.f.user.id).unwrap();
        assert_eq!(t.tracker.create_calls(), 1);
        let PostResult::Posted {
            already_posted,
            draft,
            ..
        } = &second
        else {
            panic!()
        };
        assert!(*already_posted);
        assert_eq!(draft.external, first.draft().external);
        assert_eq!(
            SqliteTickets::new(c)
                .list_by_document(&t.doc_id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn replay_heals_missing_ticket_link() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(&t, &["Add login"]);
        approve_all(&t, &b);
        let id = b.created[0].id.clone();
        let PostResult::Posted { ticket, .. } = post(c, &t.set, &id, &t.f.user.id).unwrap() else {
            panic!()
        };
        // Simulate a crash after "posted" but before the link: drop the link and the board row's
        // reference, keep the row (FK order), then replay.
        c.execute(
            "UPDATE ticket_drafts SET ticket_id = NULL WHERE id = ?1",
            [&id],
        )
        .unwrap();
        let r = post(c, &t.set, &id, &t.f.user.id).unwrap();
        let PostResult::Posted { ticket: healed, .. } = r else {
            panic!()
        };
        assert_eq!(healed.unwrap().id, ticket.unwrap().id); // reused, not duplicated
        assert_eq!(
            SqliteTickets::new(c)
                .list_by_document(&t.doc_id)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(t.tracker.create_calls(), 1);
    }

    #[test]
    fn state_machine_rejects_illegal_moves() {
        let t = setup();
        let c = t.f.db.conn();
        let s = DraftStore::new(c);
        let b = batch(&t, &["A thing", "Other thing"]);
        let (a, o) = (&b.created[0].id, &b.created[1].id);
        // draft cannot be posted
        assert!(matches!(post(c, &t.set, a, "u"), Err(Error::Conflict(_))));
        // retry only from failed
        assert!(matches!(s.retry(a), Err(Error::Conflict(_))));
        // dismiss -> terminal
        s.dismiss(o, &t.f.user.id).unwrap();
        assert!(matches!(
            s.dismiss(o, &t.f.user.id),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            s.approve(o, &t.f.user.id, None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            s.edit(o, Some("x"), None, None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(post(c, &t.set, o, "u"), Err(Error::Conflict(_))));
        // approve twice
        s.approve(a, &t.f.user.id, None).unwrap();
        assert!(matches!(
            s.approve(a, &t.f.user.id, None),
            Err(Error::Conflict(_))
        ));
        // posted drafts cannot be dismissed or edited
        post(c, &t.set, a, &t.f.user.id).unwrap();
        assert!(matches!(
            s.dismiss(a, &t.f.user.id),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            s.edit(a, None, Some("b"), None),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(
            s.set_destination(a, &gh()),
            Err(Error::Conflict(_))
        ));
        assert!(matches!(s.get("nope"), Err(Error::NotFound(_))));
    }

    #[test]
    fn approve_requires_destination_and_edit_unapproves() {
        let t = setup();
        let c = t.f.db.conn();
        let s = DraftStore::new(c);
        let b = s
            .create_batch(&t.doc_id, &t.f.user.id, vec![td("No dest yet")], None)
            .unwrap();
        let id = &b.created[0].id;
        assert!(matches!(
            s.approve(id, &t.f.user.id, None),
            Err(Error::Invalid(_))
        ));
        let a = s.approve(id, &t.f.user.id, Some(&gh())).unwrap();
        assert_eq!(a.status, DraftStatus::Approved);
        assert_eq!(a.reviewed_by_id.as_deref(), Some(t.f.user.id.as_str()));
        // Editing an approved draft sends it back to review.
        let e = s
            .edit(
                id,
                Some("  New   title "),
                Some("new body"),
                Some(&["x".to_string()]),
            )
            .unwrap();
        assert_eq!(e.status, DraftStatus::Draft);
        assert_eq!(
            (e.title.as_str(), e.body.as_str()),
            ("New title", "new body")
        );
        assert_eq!(e.labels, ["x"]);
        assert!(matches!(
            s.edit(id, Some("  "), None, None),
            Err(Error::Invalid(_))
        ));
        // Posting without destination at all is rejected.
        let b2 = s
            .create_batch(
                &t.doc_id,
                &t.f.user.id,
                vec![td("Totally different work")],
                None,
            )
            .unwrap();
        c.execute(
            "UPDATE ticket_drafts SET status = 'approved' WHERE id = ?1",
            [&b2.created[0].id],
        )
        .unwrap();
        assert!(matches!(
            post(c, &t.set, &b2.created[0].id, "u"),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn approve_many_is_all_or_nothing() {
        let t = setup();
        let s = DraftStore::new(t.f.db.conn());
        let b = batch(&t, &["One thing", "Two thing", "Three thing"]);
        let ids: Vec<_> = b.created.iter().map(|d| d.id.clone()).collect();
        s.dismiss(&ids[1], &t.f.user.id).unwrap();
        assert!(matches!(
            s.approve_many(&ids, &t.f.user.id, None),
            Err(Error::Conflict(_))
        ));
        assert_eq!(s.get(&ids[0]).unwrap().status, DraftStatus::Draft);
        assert!(matches!(
            s.approve_many(&[], "u", None),
            Err(Error::Invalid(_))
        ));
        // Missing destination rolls back the whole approval.
        let b2 = s
            .create_batch(&t.doc_id, &t.f.user.id, vec![td("Four"), td("Five")], None)
            .unwrap();
        let ids2: Vec<_> = b2.created.iter().map(|d| d.id.clone()).collect();
        assert!(s.approve_many(&ids2, &t.f.user.id, None).is_err());
        assert!(ids2
            .iter()
            .all(|i| s.get(i).unwrap().status == DraftStatus::Draft));
        let ok = s.approve_many(&ids2, &t.f.user.id, Some(&gh())).unwrap();
        assert!(ok.iter().all(|d| d.status == DraftStatus::Approved));
    }

    #[test]
    fn failure_then_retry_succeeds_once() {
        let t = setup();
        let c = t.f.db.conn();
        let s = DraftStore::new(c);
        let b = batch(&t, &["Flaky one"]);
        approve_all(&t, &b);
        let id = &b.created[0].id;
        t.tracker
            .fail_next(FakeFailure::Before(TrackerError::Rejected {
                status: 422,
                body: "bad".into(),
            }));
        let r = post(c, &t.set, id, &t.f.user.id).unwrap();
        let PostResult::Failed { draft, error } = r else {
            panic!()
        };
        assert_eq!(draft.status, DraftStatus::Failed);
        assert!(!draft.outcome_unknown);
        assert!(draft.last_error.unwrap().contains("422"));
        assert!(!error.retryable());
        assert!(draft.external.is_none());
        // Retry: failed -> approved -> posted.
        assert_eq!(s.retry(id).unwrap().status, DraftStatus::Approved);
        let PostResult::Posted { draft, .. } = post(c, &t.set, id, &t.f.user.id).unwrap() else {
            panic!()
        };
        assert_eq!(draft.attempts, 2);
        assert_eq!(draft.last_error, None);
        assert_eq!(t.tracker.created().len(), 1);
    }

    #[test]
    fn lost_response_does_not_create_a_duplicate_on_retry() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(&t, &["Lost response"]);
        approve_all(&t, &b);
        let id = &b.created[0].id;
        // The tracker creates the issue, but we only see a transport error.
        t.tracker
            .fail_next(FakeFailure::After(TrackerError::Transport(
                "reset by peer".into(),
            )));
        let PostResult::Failed { draft, error } = post(c, &t.set, id, &t.f.user.id).unwrap() else {
            panic!()
        };
        assert!(draft.outcome_unknown && error.retryable());
        assert_eq!(t.tracker.created().len(), 1);
        // Posting a failed draft directly retries; it adopts the existing remote issue.
        let PostResult::Posted {
            draft,
            adopted_existing,
            ticket,
            ..
        } = post(c, &t.set, id, &t.f.user.id).unwrap()
        else {
            panic!()
        };
        assert!(adopted_existing);
        assert_eq!(t.tracker.created().len(), 1, "no second issue was created");
        assert_eq!(t.tracker.create_calls(), 1);
        assert_eq!(draft.external.unwrap().id, "1");
        assert!(ticket.is_some());
    }

    #[test]
    fn crash_mid_post_is_recovered_without_duplicate() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(&t, &["Crashy"]);
        approve_all(&t, &b);
        let id = &b.created[0].id;
        // Simulate: claimed (posting) and the process died; remote issue exists.
        c.execute(
            "UPDATE ticket_drafts SET status = 'posting', attempts = 1 WHERE id = ?1",
            [id],
        )
        .unwrap();
        assert!(matches!(post(c, &t.set, id, "u"), Err(Error::Conflict(_))));
        assert_eq!(recover_interrupted(c).unwrap(), 1);
        let d = DraftStore::new(c).get(id).unwrap();
        assert_eq!((d.status, d.outcome_unknown), (DraftStatus::Failed, true));
        // Nothing remote yet -> a fresh issue is created after the lookup comes back empty.
        let PostResult::Posted {
            adopted_existing, ..
        } = post(c, &t.set, id, &t.f.user.id).unwrap()
        else {
            panic!()
        };
        assert!(!adopted_existing);
        assert_eq!(t.tracker.created().len(), 1);
    }

    #[test]
    fn missing_integration_fails_the_draft_not_the_call() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(&t, &["Nowhere to go"]);
        approve_all(&t, &b);
        let empty = TrackerSet::new();
        let PostResult::Failed { draft, error } = post(c, &empty, &b.created[0].id, "u").unwrap()
        else {
            panic!()
        };
        assert_eq!(draft.status, DraftStatus::Failed);
        assert_eq!(error.to_string(), "No github integration configured");
    }

    #[test]
    fn batch_post_continues_past_failures_and_halts_on_rate_limit() {
        let t = setup();
        let c = t.f.db.conn();
        let b = batch(
            &t,
            &["First item", "Second item", "Third item", "Fourth item"],
        );
        approve_all(&t, &b);
        t.tracker
            .fail_next(FakeFailure::Before(TrackerError::Rejected {
                status: 422,
                body: String::new(),
            }));
        let rep = post_batch(c, &t.set, &b.batch_id, &t.f.user.id, false).unwrap();
        assert_eq!(rep.results.len(), 4);
        assert!(rep.halted.is_none());
        let s = DraftStore::new(c).summary(&b.batch_id).unwrap();
        assert_eq!((s.posted, s.failed), (3, 1));
        // Second pass: nothing approved; include_failed retries the failed one only.
        let rep = post_batch(c, &t.set, &b.batch_id, &t.f.user.id, false).unwrap();
        assert!(rep.results.is_empty());
        let rep = post_batch(c, &t.set, &b.batch_id, &t.f.user.id, true).unwrap();
        assert_eq!(rep.results.len(), 1);
        assert_eq!(DraftStore::new(c).summary(&b.batch_id).unwrap().posted, 4);

        // Rate limit halts the run and leaves the rest approved.
        let b2 = batch(&t, &["Rate one", "Rate two", "Rate three"]);
        approve_all(&t, &b2);
        t.tracker
            .fail_next(FakeFailure::Before(TrackerError::RateLimited {
                retry_after_secs: Some(60),
            }));
        let rep = post_batch(c, &t.set, &b2.batch_id, &t.f.user.id, false).unwrap();
        assert_eq!(rep.results.len(), 1);
        assert!(rep.halted.unwrap().contains("rate limited"));
        let s = DraftStore::new(c).summary(&b2.batch_id).unwrap();
        assert_eq!((s.failed, s.approved), (1, 2));
    }

    #[test]
    fn dedupe_on_create_against_tickets_drafts_and_batch() {
        let t = setup();
        let c = t.f.db.conn();
        let s = DraftStore::new(c);
        let b = batch(&t, &["Add OAuth login flow"]);
        assert_eq!(b.created.len(), 1);
        // Same title again (different case/size tag), plus a repeat inside the new batch.
        let b2 = s
            .create_batch(
                &t.doc_id,
                &t.f.user.id,
                vec![
                    td("[M] add oauth LOGIN flow"),
                    td("Brand new work"),
                    td("brand new work"),
                ],
                None,
            )
            .unwrap();
        assert_eq!(b2.created.len(), 1);
        assert_eq!(b2.created[0].title, "Brand new work");
        assert_eq!(b2.duplicates.len(), 1); // the OAuth repeat; the in-batch repeat is collapsed by sanitize_batch
                                            // Posted tickets are also deduped against.
        approve_all(&t, &b);
        post(c, &t.set, &b.created[0].id, &t.f.user.id).unwrap();
        let b3 = s
            .create_batch(
                &t.doc_id,
                &t.f.user.id,
                vec![td("Add OAuth login flow")],
                None,
            )
            .unwrap();
        assert!(b3.created.is_empty());
        assert_eq!(b3.duplicates.len(), 1);
        // A dismissed draft may be proposed again.
        s.dismiss(&b2.created[0].id, &t.f.user.id).unwrap();
        let b4 = s
            .create_batch(&t.doc_id, &t.f.user.id, vec![td("Brand new work")], None)
            .unwrap();
        assert_eq!(b4.created.len(), 1);
        // Unknown document.
        assert!(matches!(
            s.create_batch("nope", &t.f.user.id, vec![td("x y z")], None),
            Err(Error::NotFound(_))
        ));
    }

    #[test]
    fn linear_posts_without_a_board_row() {
        let f = fx();
        let d = doc(&f, "# Spec");
        let lin = Arc::new(FakeTracker::new(TrackerKind::Linear));
        let set = TrackerSet::new().with(lin.clone());
        let dest = Destination::Linear {
            team_id: "team-1".into(),
        };
        let s = DraftStore::new(f.db.conn());
        let b = s
            .create_batch(&d.id, &f.user.id, vec![td("Linear work")], Some(&dest))
            .unwrap();
        s.approve(&b.created[0].id, &f.user.id, None).unwrap();
        let PostResult::Posted { draft, ticket, .. } =
            post(f.db.conn(), &set, &b.created[0].id, &f.user.id).unwrap()
        else {
            panic!()
        };
        assert!(ticket.is_none());
        assert_eq!(draft.ticket_id, None);
        assert_eq!(draft.external.unwrap().kind, TrackerKind::Linear);
    }

    #[test]
    fn same_issue_number_in_two_repos_does_not_clash_but_same_repo_does() {
        let t = setup();
        let c = t.f.db.conn();
        let s = DraftStore::new(c);
        let other = Destination::Github {
            owner: "acme".into(),
            repo: "api".into(),
        };
        let b = batch(&t, &["Work in web", "Work in api"]);
        s.set_destination(&b.created[1].id, &other).unwrap();
        approve_all(&t, &b);
        // FakeTracker numbers issues 1, 2: force both to "1" by making the second adopt-free.
        post(c, &t.set, &b.created[0].id, &t.f.user.id).unwrap();
        // Pretend the second repo's first issue is also number 1 by rewriting the fake output.
        let r = post(c, &t.set, &b.created[1].id, &t.f.user.id).unwrap();
        assert!(matches!(r, PostResult::Posted { .. }));
        // Clash detection: a third draft in the first repo that "creates" an already-recorded id.
        let b3 = s
            .create_batch(
                &t.doc_id,
                &t.f.user.id,
                vec![td("Third unrelated item")],
                Some(&gh()),
            )
            .unwrap();
        s.approve(&b3.created[0].id, &t.f.user.id, None).unwrap();
        c.execute(
            "UPDATE ticket_drafts SET external_id = '3' WHERE id = ?1",
            [&b.created[0].id],
        )
        .unwrap();
        let PostResult::Failed { draft, error } =
            post(c, &t.set, &b3.created[0].id, &t.f.user.id).unwrap()
        else {
            panic!()
        };
        assert!(error.to_string().contains("already linked"));
        assert_eq!(draft.status, DraftStatus::Failed);
    }
}
