//! Local OS notifications. Replaces the TS Slack delivery: the desktop shell implements
//! [`Notifier`] with the Tauri notification plugin; tests use [`FakeNotifier`].

use std::sync::Mutex;

use crate::error::Result;

/// What to show in the OS notification center.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopNotification {
    /// Title line.
    pub title: String,
    /// Optional body text.
    pub body: Option<String>,
    /// Event type, so the shell can deep-link.
    pub event_type: String,
}

/// Sink for local desktop notifications. Failures are best-effort and never fail a notification.
pub trait Notifier: Send + Sync {
    /// Show a notification.
    fn show(&self, notification: &DesktopNotification) -> Result<()>;
}

/// Records notifications instead of showing them.
#[derive(Debug, Default)]
pub struct FakeNotifier {
    shown: Mutex<Vec<DesktopNotification>>,
    fail: bool,
}

impl FakeNotifier {
    /// New recording notifier.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A notifier whose `show` always errors (to test best-effort handling).
    #[must_use]
    pub fn failing() -> Self {
        Self {
            shown: Mutex::default(),
            fail: true,
        }
    }

    /// Everything shown so far.
    #[must_use]
    pub fn shown(&self) -> Vec<DesktopNotification> {
        self.shown.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Notifier for FakeNotifier {
    fn show(&self, n: &DesktopNotification) -> Result<()> {
        if self.fail {
            return Err(crate::error::Error::Invalid(
                "desktop notifier unavailable".into(),
            ));
        }
        if let Ok(mut g) = self.shown.lock() {
            g.push(n.clone());
        }
        Ok(())
    }
}
