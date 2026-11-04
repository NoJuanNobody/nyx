//! SQLite persistence for the inbox, preferences and the email delivery log.

use rusqlite::{
    params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension, Row,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::events::EventFilter;
use crate::error::{Error, Result};
use crate::model::{new_id, string_enum, Id, Timestamp};
use crate::store::{db_err, json_col_opt};

string_enum! {
    /// How email is delivered for an event type. Drizzle enum `notification_email_mode`.
    EmailMode {
        /// Send right away.
        Instant => "instant",
        /// Queue for the daily digest (default).
        Daily => "daily",
        /// Queue for the weekly digest.
        Weekly => "weekly",
        /// Never email.
        Off => "off",
    }
}

string_enum! {
    /// Email delivery log status. Drizzle enum `email_delivery_status`.
    EmailDeliveryStatus {
        /// Waiting for a digest.
        Queued => "queued",
        /// Handed to the mailer.
        Sent => "sent",
        /// Mailer failed.
        Failed => "failed",
        /// Bounced.
        Bounced => "bounced",
    }
}

/// An inbox entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Notification {
    /// Id.
    pub id: Id,
    /// Recipient.
    pub user_id: Id,
    /// Team the event belongs to.
    pub team_id: Id,
    /// Event type (a [`super::NotificationEvent`] wire name, free text for forward compatibility).
    pub event_type: String,
    /// Title.
    pub title: String,
    /// Optional body.
    pub body: Option<String>,
    /// Optional metadata.
    pub metadata: Option<Value>,
    /// Entity the notification is about; drives de-duplication.
    pub entity_id: Option<String>,
    /// When read (unread when `None`).
    pub read_at: Option<Timestamp>,
    /// Creation (or last refresh) time.
    pub created_at: Timestamp,
}

/// Per user and event type delivery preference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NotificationPreference {
    /// Id.
    pub id: Id,
    /// Owner.
    pub user_id: Id,
    /// Event type.
    pub event_type: String,
    /// Show in the in-app inbox.
    pub in_app: bool,
    /// Email allowed at all.
    pub email_enabled: bool,
    /// Email mode.
    pub email_mode: EmailMode,
    /// Last change.
    pub updated_at: Timestamp,
}

impl NotificationPreference {
    /// The implicit preference when none is stored: in-app on, email on, daily digest.
    #[must_use]
    pub fn default_for(user_id: &str, event_type: &str, now: Timestamp) -> Self {
        Self {
            id: String::new(),
            user_id: user_id.into(),
            event_type: event_type.into(),
            in_app: true,
            email_enabled: true,
            email_mode: EmailMode::Daily,
            updated_at: now,
        }
    }
}

/// Full preference row for bulk replace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreferenceInput {
    /// Event type.
    pub event_type: String,
    /// In-app flag.
    pub in_app: bool,
    /// Email flag.
    pub email_enabled: bool,
    /// Email mode.
    pub email_mode: EmailMode,
}

/// Partial preference update (PATCH semantics).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreferenceUpdate {
    /// New in-app flag.
    pub in_app: Option<bool>,
    /// New email flag.
    pub email_enabled: Option<bool>,
    /// New email mode.
    pub email_mode: Option<EmailMode>,
}

/// Inbox listing request (`GET /notifications`).
#[derive(Debug, Clone, Default)]
pub struct InboxQuery {
    /// Recipient.
    pub user_id: Id,
    /// `Some(true)` read only, `Some(false)` unread only.
    pub read: Option<bool>,
    /// Event filter.
    pub event: Option<EventFilter>,
    /// Page size, clamped to 1..=50, default 20.
    pub limit: Option<u32>,
    /// Opaque cursor from a previous page.
    pub cursor: Option<String>,
}

/// One page of the inbox.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InboxPage {
    /// Newest first.
    pub items: Vec<Notification>,
    /// Pass back as `cursor` for the next page.
    pub next_cursor: Option<String>,
    /// Total unread for the user, independent of filters.
    pub unread_count: u32,
}

/// A queued email waiting for a digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailQueueItem {
    /// Delivery log row.
    pub log_id: Id,
    /// Notification it refers to.
    pub notification_id: Option<Id>,
    /// Title.
    pub title: String,
    /// Body.
    pub body: Option<String>,
    /// Event type.
    pub event_type: String,
}

/// A row for the email delivery log.
#[derive(Debug, Clone, Copy)]
pub struct EmailLogEntry<'a> {
    /// Notification the email is about.
    pub notification_id: Option<&'a str>,
    /// Recipient user.
    pub user_id: &'a str,
    /// Status to record.
    pub status: EmailDeliveryStatus,
    /// When it was sent.
    pub sent_at: Option<Timestamp>,
    /// Provider message id.
    pub provider_id: Option<&'a str>,
    /// Failure text.
    pub error: Option<&'a str>,
    /// Row creation time.
    pub created_at: Timestamp,
}

/// Notification persistence.
pub trait NotificationRepo {
    /// Insert a new notification.
    fn insert(&self, n: &Notification) -> Result<Notification>;
    /// Newest unread notification with the same user, event and entity created after `since`.
    fn find_recent_unread(
        &self,
        user_id: &str,
        event_type: &str,
        entity_id: &str,
        since: Timestamp,
    ) -> Result<Option<Notification>>;
    /// Refresh a de-duplicated notification (new body/metadata, bumps `created_at`).
    fn refresh(
        &self,
        id: &str,
        body: Option<&str>,
        metadata: Option<&Value>,
        now: Timestamp,
    ) -> Result<Notification>;
    /// Fetch one notification owned by `user_id`.
    fn get(&self, user_id: &str, id: &str) -> Result<Notification>;
    /// Paged, filtered listing plus unread count.
    fn list(&self, q: &InboxQuery) -> Result<InboxPage>;
    /// Unread badge count.
    fn unread_count(&self, user_id: &str) -> Result<u32>;
    /// Mark one notification read (idempotent: keeps the first read time).
    fn mark_read(&self, user_id: &str, id: &str, now: Timestamp) -> Result<Notification>;
    /// Mark everything read; returns how many changed.
    fn mark_all_read(&self, user_id: &str, now: Timestamp) -> Result<usize>;
    /// Delete one notification.
    fn delete(&self, user_id: &str, id: &str) -> Result<()>;

    /// All stored preferences of a user.
    fn preferences(&self, user_id: &str) -> Result<Vec<NotificationPreference>>;
    /// One stored preference.
    fn preference(&self, user_id: &str, event_type: &str)
        -> Result<Option<NotificationPreference>>;
    /// Replace all preferences atomically (PUT semantics).
    fn replace_preferences(
        &self,
        user_id: &str,
        prefs: &[PreferenceInput],
        now: Timestamp,
    ) -> Result<Vec<NotificationPreference>>;
    /// Upsert one preference (PATCH semantics; missing fields keep their value or the default).
    fn update_preference(
        &self,
        user_id: &str,
        event_type: &str,
        update: &PreferenceUpdate,
        now: Timestamp,
    ) -> Result<NotificationPreference>;

    /// Recipient email address.
    fn user_email(&self, user_id: &str) -> Result<Option<String>>;
    /// Record an email delivery attempt or queue entry.
    fn log_email(&self, entry: &EmailLogEntry<'_>) -> Result<Id>;
    /// Queued digest entries of a user, oldest first.
    fn queued_emails(&self, user_id: &str) -> Result<Vec<EmailQueueItem>>;
    /// Settle queued log rows after a digest attempt.
    fn finish_queued(
        &self,
        log_ids: &[Id],
        status: EmailDeliveryStatus,
        sent_at: Option<Timestamp>,
        provider_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<()>;
    /// Delivery log of a user, newest first.
    fn email_log(&self, user_id: &str) -> Result<Vec<(Id, EmailDeliveryStatus, Option<String>)>>;
}

/// SQLite [`NotificationRepo`].
#[derive(Debug, Clone, Copy)]
pub struct SqliteNotifications<'c>(&'c Connection);

impl<'c> SqliteNotifications<'c> {
    /// Wrap a connection or transaction.
    #[must_use]
    pub fn new(conn: &'c Connection) -> Self {
        Self(conn)
    }
}

fn notif(r: &Row<'_>) -> rusqlite::Result<Notification> {
    Ok(Notification {
        id: r.get("id")?,
        user_id: r.get("user_id")?,
        team_id: r.get("team_id")?,
        event_type: r.get("event_type")?,
        title: r.get("title")?,
        body: r.get("body")?,
        metadata: json_col_opt(r, "metadata")?,
        entity_id: r.get("entity_id")?,
        read_at: r.get("read_at")?,
        created_at: r.get("created_at")?,
    })
}

fn pref(r: &Row<'_>) -> rusqlite::Result<NotificationPreference> {
    Ok(NotificationPreference {
        id: r.get("id")?,
        user_id: r.get("user_id")?,
        event_type: r.get("event_type")?,
        in_app: r.get("in_app")?,
        email_enabled: r.get("email_enabled")?,
        email_mode: r.get("email_mode")?,
        updated_at: r.get("updated_at")?,
    })
}

fn meta_text(m: Option<&Value>) -> Result<Option<String>> {
    Ok(m.map(serde_json::to_string).transpose()?)
}

/// Run `f` inside a savepoint so it nests inside any caller transaction.
pub(crate) fn savepoint<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("SAVEPOINT nyx_notify")?;
    match f() {
        Ok(v) => {
            conn.execute_batch("RELEASE nyx_notify")?;
            Ok(v)
        }
        Err(e) => {
            conn.execute_batch("ROLLBACK TO nyx_notify; RELEASE nyx_notify")?;
            Err(e)
        }
    }
}

impl NotificationRepo for SqliteNotifications<'_> {
    fn insert(&self, n: &Notification) -> Result<Notification> {
        let id = if n.id.is_empty() {
            new_id()
        } else {
            n.id.clone()
        };
        self.0
            .execute(
                "INSERT INTO notifications (id,user_id,team_id,event_type,title,body,metadata,entity_id,read_at,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    id, n.user_id, n.team_id, n.event_type, n.title, n.body,
                    meta_text(n.metadata.as_ref())?, n.entity_id, n.read_at, n.created_at
                ],
            )
            .map_err(db_err)?;
        self.get(&n.user_id, &id)
    }

    fn find_recent_unread(
        &self,
        user_id: &str,
        event_type: &str,
        entity_id: &str,
        since: Timestamp,
    ) -> Result<Option<Notification>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM notifications WHERE user_id=?1 AND event_type=?2 AND entity_id=?3
                 AND read_at IS NULL AND created_at > ?4 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                params![user_id, event_type, entity_id, since],
                notif,
            )
            .optional()?)
    }

    fn refresh(
        &self,
        id: &str,
        body: Option<&str>,
        metadata: Option<&Value>,
        now: Timestamp,
    ) -> Result<Notification> {
        // COALESCE keeps the previous value when the caller supplies none (TS `input ?? existing`).
        self.0.execute(
            "UPDATE notifications SET body = COALESCE(?2, body), metadata = COALESCE(?3, metadata), created_at = ?4 WHERE id = ?1",
            params![id, body, meta_text(metadata)?, now],
        )?;
        self.0
            .query_row("SELECT * FROM notifications WHERE id = ?1", [id], notif)
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("notification {id}")))
    }

    fn get(&self, user_id: &str, id: &str) -> Result<Notification> {
        self.0
            .query_row(
                "SELECT * FROM notifications WHERE id = ?1 AND user_id = ?2",
                params![id, user_id],
                notif,
            )
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("notification {id}")))
    }

    fn list(&self, q: &InboxQuery) -> Result<InboxPage> {
        let limit = q.limit.unwrap_or(20).clamp(1, 50);
        let mut sql = String::from("SELECT rowid AS rid, * FROM notifications WHERE user_id = ?");
        let mut args: Vec<SqlValue> = vec![q.user_id.clone().into()];
        match q.read {
            Some(true) => sql.push_str(" AND read_at IS NOT NULL"),
            Some(false) => sql.push_str(" AND read_at IS NULL"),
            None => {}
        }
        match &q.event {
            Some(EventFilter::Review) => {
                sql.push_str(
                    " AND (event_type LIKE 'approval.%' OR event_type LIKE 'change_proposal.%')",
                );
            }
            Some(EventFilter::Exact(e)) => {
                sql.push_str(" AND event_type = ?");
                args.push(e.clone().into());
            }
            Some(EventFilter::Category(c)) => {
                // Escape LIKE wildcards in user input.
                let escaped = c
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                sql.push_str(" AND event_type LIKE ? ESCAPE '\\'");
                args.push(format!("{escaped}.%").into());
            }
            None => {}
        }
        if let Some(cursor) = &q.cursor {
            let (ts, rid) = cursor
                .split_once(':')
                .and_then(|(a, b)| Some((a.parse::<i64>().ok()?, b.parse::<i64>().ok()?)))
                .ok_or_else(|| Error::Invalid(format!("bad cursor '{cursor}'")))?;
            sql.push_str(" AND (created_at < ? OR (created_at = ? AND rowid < ?))");
            args.extend([ts.into(), ts.into(), rid.into()]);
        }
        sql.push_str(" ORDER BY created_at DESC, rowid DESC LIMIT ?");
        args.push(i64::from(limit + 1).into());

        let mut stmt = self.0.prepare(&sql)?;
        let mut rows: Vec<(i64, Notification)> = stmt
            .query_map(params_from_iter(args), |r| {
                Ok((r.get::<_, i64>("rid")?, notif(r)?))
            })?
            .collect::<std::result::Result<_, _>>()?;
        let mut next_cursor = None;
        if rows.len() > limit as usize {
            rows.pop();
            if let Some((rid, last)) = rows.last() {
                next_cursor = Some(format!("{}:{rid}", last.created_at));
            }
        }
        Ok(InboxPage {
            items: rows.into_iter().map(|(_, n)| n).collect(),
            next_cursor,
            unread_count: self.unread_count(&q.user_id)?,
        })
    }

    fn unread_count(&self, user_id: &str) -> Result<u32> {
        let n: i64 = self.0.query_row(
            "SELECT COUNT(*) FROM notifications WHERE user_id=?1 AND read_at IS NULL",
            [user_id],
            |r| r.get(0),
        )?;
        Ok(u32::try_from(n).unwrap_or(u32::MAX))
    }

    fn mark_read(&self, user_id: &str, id: &str, now: Timestamp) -> Result<Notification> {
        self.0.execute(
            "UPDATE notifications SET read_at = COALESCE(read_at, ?3) WHERE id = ?1 AND user_id = ?2",
            params![id, user_id, now],
        )?;
        self.get(user_id, id)
    }

    fn mark_all_read(&self, user_id: &str, now: Timestamp) -> Result<usize> {
        Ok(self.0.execute(
            "UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL",
            params![user_id, now],
        )?)
    }

    fn delete(&self, user_id: &str, id: &str) -> Result<()> {
        let n = self.0.execute(
            "DELETE FROM notifications WHERE id = ?1 AND user_id = ?2",
            params![id, user_id],
        )?;
        if n == 0 {
            return Err(Error::NotFound(format!("notification {id}")));
        }
        Ok(())
    }

    fn preferences(&self, user_id: &str) -> Result<Vec<NotificationPreference>> {
        let mut s = self.0.prepare(
            "SELECT * FROM notification_preferences WHERE user_id = ?1 ORDER BY event_type",
        )?;
        let rows = s
            .query_map([user_id], pref)?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn preference(
        &self,
        user_id: &str,
        event_type: &str,
    ) -> Result<Option<NotificationPreference>> {
        Ok(self
            .0
            .query_row(
                "SELECT * FROM notification_preferences WHERE user_id=?1 AND event_type=?2",
                params![user_id, event_type],
                pref,
            )
            .optional()?)
    }

    fn replace_preferences(
        &self,
        user_id: &str,
        prefs: &[PreferenceInput],
        now: Timestamp,
    ) -> Result<Vec<NotificationPreference>> {
        savepoint(self.0, || {
            self.0.execute(
                "DELETE FROM notification_preferences WHERE user_id = ?1",
                [user_id],
            )?;
            for p in prefs {
                self.0
                    .execute(
                        "INSERT INTO notification_preferences (id,user_id,event_type,in_app,email_enabled,email_mode,updated_at)
                         VALUES (?1,?2,?3,?4,?5,?6,?7)",
                        params![new_id(), user_id, p.event_type, p.in_app, p.email_enabled, p.email_mode, now],
                    )
                    .map_err(db_err)?;
            }
            Ok(())
        })?;
        self.preferences(user_id)
    }

    fn update_preference(
        &self,
        user_id: &str,
        event_type: &str,
        u: &PreferenceUpdate,
        now: Timestamp,
    ) -> Result<NotificationPreference> {
        let base = self
            .preference(user_id, event_type)?
            .unwrap_or_else(|| NotificationPreference::default_for(user_id, event_type, now));
        let in_app = u.in_app.unwrap_or(base.in_app);
        let email_enabled = u.email_enabled.unwrap_or(base.email_enabled);
        let email_mode = u.email_mode.unwrap_or(base.email_mode);
        self.0
            .execute(
                "INSERT INTO notification_preferences (id,user_id,event_type,in_app,email_enabled,email_mode,updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7)
                 ON CONFLICT(user_id,event_type) DO UPDATE SET in_app=?4, email_enabled=?5, email_mode=?6, updated_at=?7",
                params![new_id(), user_id, event_type, in_app, email_enabled, email_mode, now],
            )
            .map_err(db_err)?;
        self.preference(user_id, event_type)?
            .ok_or_else(|| Error::NotFound(format!("preference {event_type}")))
    }

    fn user_email(&self, user_id: &str) -> Result<Option<String>> {
        Ok(self
            .0
            .query_row("SELECT email FROM users WHERE id = ?1", [user_id], |r| {
                r.get(0)
            })
            .optional()?)
    }

    fn log_email(&self, e: &EmailLogEntry<'_>) -> Result<Id> {
        let id = new_id();
        self.0
            .execute(
                "INSERT INTO email_delivery_log (id,notification_id,user_id,provider_id,status,sent_at,error,created_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
                params![id, e.notification_id, e.user_id, e.provider_id, e.status, e.sent_at, e.error, e.created_at],
            )
            .map_err(db_err)?;
        Ok(id)
    }

    fn queued_emails(&self, user_id: &str) -> Result<Vec<EmailQueueItem>> {
        let mut s = self.0.prepare(
            "SELECT l.id AS log_id, l.notification_id, n.title, n.body, n.event_type
             FROM email_delivery_log l JOIN notifications n ON n.id = l.notification_id
             WHERE l.user_id = ?1 AND l.status = 'queued' ORDER BY l.created_at, l.rowid",
        )?;
        let rows = s
            .query_map([user_id], |r| {
                Ok(EmailQueueItem {
                    log_id: r.get("log_id")?,
                    notification_id: r.get("notification_id")?,
                    title: r.get("title")?,
                    body: r.get("body")?,
                    event_type: r.get("event_type")?,
                })
            })?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }

    fn finish_queued(
        &self,
        log_ids: &[Id],
        status: EmailDeliveryStatus,
        sent_at: Option<Timestamp>,
        provider_id: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        savepoint(self.0, || {
            for id in log_ids {
                self.0.execute(
                    "UPDATE email_delivery_log SET status=?2, sent_at=?3, provider_id=?4, error=?5 WHERE id=?1",
                    params![id, status, sent_at, provider_id, error],
                )?;
            }
            Ok(())
        })
    }

    fn email_log(&self, user_id: &str) -> Result<Vec<(Id, EmailDeliveryStatus, Option<String>)>> {
        let mut s = self.0.prepare(
            "SELECT id, status, error FROM email_delivery_log WHERE user_id = ?1 ORDER BY created_at, rowid",
        )?;
        let rows = s
            .query_map([user_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<std::result::Result<_, _>>()?;
        Ok(rows)
    }
}
