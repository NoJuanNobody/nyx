//! Notifications: typed events, in-process bus, in-app inbox, preferences, email and desktop
//! delivery. Ported from `notification.service.ts`, `notification-events.ts`,
//! `notification-email.service.ts` and `pubsub.service.ts`.
//!
//! - [`events`]: [`NotificationEvent`] (the typed event names) and inbox category filters.
//! - [`bus`]: [`EventBus`], an in-process per-user pub/sub on `std::sync::mpsc` (the core is
//!   synchronous, so no async runtime is needed; the desktop shell forwards messages to the UI).
//! - [`store`]: [`NotificationRepo`] / [`SqliteNotifications`]: inbox, preferences, email log.
//! - [`service`]: [`NotificationService`]: preference filtering, 10 minute de-duplication,
//!   fan-out to the bus, the OS [`Notifier`] and the [`Mailer`].
//! - [`mailer`]: [`Mailer`] trait (no hosted email provider; real SMTP is a documented TODO),
//!   [`FakeMailer`], HTML builders and the digest sender.
//! - [`notifier`]: [`Notifier`] trait for local OS notifications and [`FakeNotifier`].

pub mod bus;
pub mod events;
pub mod mailer;
pub mod notifier;
pub mod service;
pub mod store;

use std::sync::Arc;

pub use bus::{BusEvent, BusMessage, EventBus, Subscription};
pub use events::{EventFilter, NotificationEvent};
pub use mailer::{
    build_digest_email, build_notification_email, queue_or_send, send_digest, DigestItem,
    EmailAction, EmailMessage, FakeMailer, Mailer,
};
pub use notifier::{DesktopNotification, FakeNotifier, Notifier};
pub use service::{CreateNotification, CreateOutcome, NotificationService};
pub use store::{
    EmailDeliveryStatus, EmailLogEntry, EmailMode, EmailQueueItem, InboxPage, InboxQuery,
    Notification, NotificationPreference, NotificationRepo, PreferenceInput, PreferenceUpdate,
    SqliteNotifications,
};

use crate::model::{now_ms, Timestamp};

/// De-duplication window for unread notifications about the same entity (10 minutes).
pub const DEDUP_WINDOW_MS: i64 = 10 * 60 * 1000;

/// Injectable time source so windows and expiries are testable.
#[derive(Clone)]
pub struct Clock(Arc<dyn Fn() -> Timestamp + Send + Sync>);

impl Clock {
    /// Wall clock (unix ms).
    #[must_use]
    pub fn system() -> Self {
        Self(Arc::new(now_ms))
    }

    /// Custom time source.
    #[must_use]
    pub fn new(f: impl Fn() -> Timestamp + Send + Sync + 'static) -> Self {
        Self(Arc::new(f))
    }

    /// Current time in unix ms.
    #[must_use]
    pub fn now(&self) -> Timestamp {
        (self.0)()
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::system()
    }
}

impl std::fmt::Debug for Clock {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Clock")
    }
}
