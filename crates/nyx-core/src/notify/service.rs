//! Notification service (`notification.service.ts`): preference filtering, de-duplication and
//! fan-out to the in-process bus, the OS notifier and the mailer.

use std::sync::Arc;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::bus::{BusEvent, BusMessage, EventBus};
use super::events::NotificationEvent;
use super::mailer::{queue_or_send, Mailer};
use super::notifier::{DesktopNotification, Notifier};
use super::store::{
    InboxPage, InboxQuery, Notification, NotificationPreference, NotificationRepo, PreferenceInput,
    PreferenceUpdate, SqliteNotifications,
};
use super::{Clock, DEDUP_WINDOW_MS};
use crate::error::{Error, Result};
use crate::model::Id;

/// Input for [`NotificationService::create`].
#[derive(Debug, Clone)]
pub struct CreateNotification {
    /// Recipient.
    pub user_id: Id,
    /// Team.
    pub team_id: Id,
    /// Event type wire name (use [`CreateNotification::new`] for a typed event).
    pub event_type: String,
    /// Title.
    pub title: String,
    /// Optional body.
    pub body: Option<String>,
    /// Optional metadata.
    pub metadata: Option<Value>,
    /// Entity id; notifications with the same user, event and entity are merged for 10 minutes.
    pub entity_id: Option<String>,
}

impl CreateNotification {
    /// Typed constructor.
    #[must_use]
    pub fn new(user_id: &str, team_id: &str, event: NotificationEvent, title: &str) -> Self {
        Self {
            user_id: user_id.into(),
            team_id: team_id.into(),
            event_type: event.as_str().into(),
            title: title.into(),
            body: None,
            metadata: None,
            entity_id: None,
        }
    }

    /// Set the body.
    #[must_use]
    pub fn body(mut self, body: &str) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Set the entity id (enables de-duplication).
    #[must_use]
    pub fn entity(mut self, entity_id: &str) -> Self {
        self.entity_id = Some(entity_id.into());
        self
    }

    /// Set metadata.
    #[must_use]
    pub fn metadata(mut self, metadata: Value) -> Self {
        self.metadata = Some(metadata);
        self
    }
}

/// Result of [`NotificationService::create`].
#[derive(Debug, Clone, PartialEq)]
pub enum CreateOutcome {
    /// The user disabled in-app delivery for this event type; nothing was stored.
    Skipped,
    /// A new notification was stored and fanned out.
    Created(Notification),
    /// An unread notification for the same entity was refreshed instead.
    Updated(Notification),
}

impl CreateOutcome {
    /// The stored notification, if any.
    #[must_use]
    pub fn notification(&self) -> Option<&Notification> {
        match self {
            Self::Created(n) | Self::Updated(n) => Some(n),
            Self::Skipped => None,
        }
    }
}

/// Notification service over a connection.
pub struct NotificationService<'c> {
    conn: &'c Connection,
    bus: EventBus,
    notifier: Option<Arc<dyn Notifier>>,
    mailer: Option<Arc<dyn Mailer>>,
    clock: Clock,
}

impl<'c> NotificationService<'c> {
    /// New service publishing to `bus`.
    #[must_use]
    pub fn new(conn: &'c Connection, bus: EventBus) -> Self {
        Self {
            conn,
            bus,
            notifier: None,
            mailer: None,
            clock: Clock::system(),
        }
    }

    /// Show new notifications through the OS notifier.
    #[must_use]
    pub fn with_notifier(mut self, notifier: Arc<dyn Notifier>) -> Self {
        self.notifier = Some(notifier);
        self
    }

    /// Email new notifications according to the recipient's preference.
    #[must_use]
    pub fn with_mailer(mut self, mailer: Arc<dyn Mailer>) -> Self {
        self.mailer = Some(mailer);
        self
    }

    /// Override the clock (tests).
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    fn repo(&self) -> SqliteNotifications<'c> {
        SqliteNotifications::new(self.conn)
    }

    /// Create a notification.
    ///
    /// - Skipped when the user's `in_app` preference for the event type is false.
    /// - An unread notification with the same user, event type and entity id from the last
    ///   10 minutes is refreshed (new body/metadata, new timestamp) instead of duplicated.
    /// - New notifications are pushed to the bus (`notification.created`), shown via the OS
    ///   [`Notifier`] and emailed per preference. Delivery side effects are best-effort.
    pub fn create(&self, input: &CreateNotification) -> Result<CreateOutcome> {
        let repo = self.repo();
        let now = self.clock.now();
        if let Some(p) = repo.preference(&input.user_id, &input.event_type)? {
            if !p.in_app {
                return Ok(CreateOutcome::Skipped);
            }
        }

        if let Some(entity) = &input.entity_id {
            if let Some(existing) = repo.find_recent_unread(
                &input.user_id,
                &input.event_type,
                entity,
                now - DEDUP_WINDOW_MS,
            )? {
                let updated = repo.refresh(
                    &existing.id,
                    input.body.as_deref(),
                    input.metadata.as_ref(),
                    now,
                )?;
                self.publish(BusEvent::NotificationUpdated, &updated);
                return Ok(CreateOutcome::Updated(updated));
            }
        }

        let created = repo.insert(&Notification {
            id: String::new(),
            user_id: input.user_id.clone(),
            team_id: input.team_id.clone(),
            event_type: input.event_type.clone(),
            title: input.title.clone(),
            body: input.body.clone(),
            metadata: input.metadata.clone(),
            entity_id: input.entity_id.clone(),
            read_at: None,
            created_at: now,
        })?;
        self.publish(BusEvent::NotificationCreated, &created);
        self.deliver_side_effects(&created);
        Ok(CreateOutcome::Created(created))
    }

    fn publish(&self, event: BusEvent, n: &Notification) {
        self.bus.publish(
            &n.user_id,
            &BusMessage {
                event,
                payload: json!({ "notification": n }),
            },
        );
    }

    fn deliver_side_effects(&self, n: &Notification) {
        if let Some(notifier) = &self.notifier {
            // Best-effort: a missing OS notification service must not fail the notification.
            let _ = notifier.show(&DesktopNotification {
                title: n.title.clone(),
                body: n.body.clone(),
                event_type: n.event_type.clone(),
            });
        }
        if let Some(mailer) = &self.mailer {
            let _ = self.email(mailer.as_ref(), n);
        }
    }

    fn email(&self, mailer: &dyn Mailer, n: &Notification) -> Result<()> {
        let repo = self.repo();
        let Some(email) = repo.user_email(&n.user_id)? else {
            return Ok(());
        };
        let pref = repo
            .preference(&n.user_id, &n.event_type)?
            .unwrap_or_else(|| {
                NotificationPreference::default_for(&n.user_id, &n.event_type, self.clock.now())
            });
        queue_or_send(&repo, mailer, &self.clock, n, &email, &pref)?;
        Ok(())
    }

    /// Inbox page (filters, cursor, unread count).
    pub fn inbox(&self, query: &InboxQuery) -> Result<InboxPage> {
        self.repo().list(query)
    }

    /// Unread badge count.
    pub fn unread_count(&self, user_id: &str) -> Result<u32> {
        self.repo().unread_count(user_id)
    }

    /// Mark one notification read. `NotFound` if it does not belong to the user.
    pub fn mark_read(&self, user_id: &str, id: &str) -> Result<Notification> {
        self.repo().mark_read(user_id, id, self.clock.now())
    }

    /// Mark all of the user's notifications read; returns how many changed.
    pub fn mark_all_read(&self, user_id: &str) -> Result<usize> {
        self.repo().mark_all_read(user_id, self.clock.now())
    }

    /// Delete a notification.
    pub fn delete(&self, user_id: &str, id: &str) -> Result<()> {
        self.repo().delete(user_id, id)
    }

    /// All stored preferences.
    pub fn preferences(&self, user_id: &str) -> Result<Vec<NotificationPreference>> {
        self.repo().preferences(user_id)
    }

    /// Replace all preferences (bulk PUT).
    pub fn replace_preferences(
        &self,
        user_id: &str,
        prefs: &[PreferenceInput],
    ) -> Result<Vec<NotificationPreference>> {
        if let Some(p) = prefs.iter().find(|p| p.event_type.trim().is_empty()) {
            return Err(Error::Invalid(format!(
                "empty event type in preference {p:?}"
            )));
        }
        self.repo()
            .replace_preferences(user_id, prefs, self.clock.now())
    }

    /// Update one preference (created with defaults when missing).
    pub fn update_preference(
        &self,
        user_id: &str,
        event_type: &str,
        update: &PreferenceUpdate,
    ) -> Result<NotificationPreference> {
        if event_type.trim().is_empty() {
            return Err(Error::Invalid("event type is required".into()));
        }
        self.repo()
            .update_preference(user_id, event_type, update, self.clock.now())
    }

    /// Send the queued digest for a user (needs a mailer and a stored email address).
    pub fn send_digest(&self, user_id: &str) -> Result<usize> {
        let Some(mailer) = &self.mailer else {
            return Ok(0);
        };
        let Some(email) = self.repo().user_email(user_id)? else {
            return Ok(0);
        };
        super::mailer::send_digest(&self.repo(), mailer.as_ref(), &self.clock, user_id, &email)
    }
}
