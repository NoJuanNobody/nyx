//! Email delivery (`notification-email.service.ts`). No hosted email provider: sending goes through the
//! [`Mailer`] trait. Tests use [`FakeMailer`].
//!
//! TODO(real impl): an SMTP `Mailer` (for example `lettre`) configured from the user's profile,
//! with the password in the OS keychain via [`crate::profile`]. Until then the desktop app relies
//! on the in-app inbox and OS notifications; the delivery log and digest logic are complete.

use std::fmt::Write as _;
use std::sync::Mutex;

use super::store::{
    EmailDeliveryStatus, EmailLogEntry, EmailMode, Notification, NotificationPreference,
    NotificationRepo,
};
use super::Clock;
use crate::error::{Error, Result};

/// An outgoing email.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailMessage {
    /// Recipient address.
    pub to: String,
    /// Subject line.
    pub subject: String,
    /// HTML body.
    pub html: String,
}

/// Outbound email transport.
pub trait Mailer: Send + Sync {
    /// Send a message. `Ok(provider_id)` on success; `Err` is recorded as a failed delivery.
    fn send(&self, message: &EmailMessage) -> Result<Option<String>>;
}

/// Records messages instead of sending them.
#[derive(Debug, Default)]
pub struct FakeMailer {
    sent: Mutex<Vec<EmailMessage>>,
    fail: bool,
}

impl FakeMailer {
    /// Recording mailer that always succeeds.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Mailer whose `send` always fails.
    #[must_use]
    pub fn failing() -> Self {
        Self {
            sent: Mutex::default(),
            fail: true,
        }
    }

    /// Messages "sent" so far.
    #[must_use]
    pub fn sent(&self) -> Vec<EmailMessage> {
        self.sent.lock().map(|g| g.clone()).unwrap_or_default()
    }
}

impl Mailer for FakeMailer {
    fn send(&self, m: &EmailMessage) -> Result<Option<String>> {
        if self.fail {
            return Err(Error::Invalid("mailer unavailable".into()));
        }
        let mut g = self
            .sent
            .lock()
            .map_err(|_| Error::Invalid("mailer lock poisoned".into()))?;
        g.push(m.clone());
        Ok(Some(format!("fake-{}", g.len())))
    }
}

/// Escape text for HTML element and attribute context.
#[must_use]
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

const PAGE_HEAD: &str = "<!DOCTYPE html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\"/></head>\n<body style=\"margin:0;padding:0;background:#0f0f1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;\">\n  <div style=\"max-width:560px;margin:0 auto;\">";
const FOOTER: &str = "<p style=\"color:#475569;font-size:12px;margin-top:32px;\">You received this because of your notification settings in Nyx.</p>";

/// Single-notification email. Unlike the TS builder, title, body and CTA are HTML-escaped. Only
/// `http(s)` CTA links are rendered.
#[must_use]
pub fn build_notification_email(
    title: &str,
    body: &str,
    cta_url: Option<&str>,
    cta_text: Option<&str>,
) -> String {
    let cta = cta_url
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        .map(|u| {
            format!(
                "<a href=\"{}\" style=\"display:inline-block;background:#6366f1;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;margin:24px 0;\">{}</a>",
                escape_html(u),
                escape_html(cta_text.unwrap_or("View in Nyx"))
            )
        })
        .unwrap_or_default();
    format!(
        "{PAGE_HEAD}\n    <div style=\"background:#1a1a2e;padding:20px 24px;border-radius:12px 12px 0 0;\">\n      <span style=\"color:#a78bfa;font-weight:700;font-size:18px;\">Nyx</span>\n    </div>\n    <div style=\"background:#16162a;padding:24px;border-radius:0 0 12px 12px;\">\n      <h2 style=\"color:#e2e8f0;margin:0 0 12px;\">{}</h2>\n      <p style=\"color:#94a3b8;line-height:1.6;margin:0 0 16px;\">{}</p>\n      {cta}\n      {FOOTER}\n    </div>\n  </div>\n</body>\n</html>",
        escape_html(title),
        escape_html(body)
    )
}

/// One item of a digest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DigestItem {
    /// Title.
    pub title: String,
    /// Body text.
    pub body: String,
    /// Event type used for grouping.
    pub event_type: String,
}

/// `approval_requested` -> `Approval Requested` (TS: `_` to space, capitalise each word start).
fn label(event_type: &str) -> String {
    let mut out = String::new();
    let mut prev_word = false;
    for c in event_type.replace('_', " ").chars() {
        let is_word = c.is_alphanumeric() || c == '_';
        if is_word && !prev_word {
            out.extend(c.to_uppercase());
        } else {
            out.push(c);
        }
        prev_word = is_word;
    }
    out
}

/// Digest email grouped by event type (groups keep first-seen order).
#[must_use]
pub fn build_digest_email(items: &[DigestItem]) -> String {
    let mut groups: Vec<(&str, Vec<&DigestItem>)> = Vec::new();
    for item in items {
        match groups.iter_mut().find(|(k, _)| *k == item.event_type) {
            Some((_, v)) => v.push(item),
            None => groups.push((&item.event_type, vec![item])),
        }
    }
    let mut sections = String::new();
    for (event_type, group) in &groups {
        let mut rows = String::new();
        for item in group {
            let _ = write!(
                rows,
                "\n        <tr>\n          <td style=\"padding:8px 0;border-bottom:1px solid #1e293b;\">\n            <strong style=\"color:#e2e8f0;\">{}</strong>\n            <br/><span style=\"color:#94a3b8;font-size:13px;\">{}</span>\n          </td>\n        </tr>",
                escape_html(&item.title),
                escape_html(&item.body)
            );
        }
        let _ = write!(
            sections,
            "\n      <h3 style=\"color:#a78bfa;margin:24px 0 8px;font-size:14px;text-transform:uppercase;letter-spacing:0.05em;\">{} ({})</h3>\n      <table style=\"width:100%;border-collapse:collapse;\">{rows}</table>",
            escape_html(&label(event_type)),
            group.len()
        );
    }
    format!(
        "{PAGE_HEAD}\n    <div style=\"background:#1a1a2e;padding:20px 24px;border-radius:12px 12px 0 0;\">\n      <span style=\"color:#a78bfa;font-weight:700;font-size:18px;\">Nyx</span>\n      <span style=\"color:#64748b;margin-left:8px;font-size:14px;\">Notification Digest</span>\n    </div>\n    <div style=\"background:#16162a;padding:24px;border-radius:0 0 12px 12px;\">\n      <p style=\"color:#94a3b8;margin:0 0 8px;\">Here's a summary of what happened since your last digest:</p>\n      {sections}\n      {FOOTER}\n    </div>\n  </div>\n</body>\n</html>"
    )
}

/// What [`queue_or_send`] did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmailAction {
    /// Preference says no email.
    Skipped,
    /// Sent immediately; the flag tells whether the mailer accepted it.
    Sent(bool),
    /// Queued for the daily or weekly digest.
    Queued,
}

/// Send now, queue for the digest, or skip, depending on the preference.
pub fn queue_or_send(
    repo: &dyn NotificationRepo,
    mailer: &dyn Mailer,
    clock: &Clock,
    notification: &Notification,
    user_email: &str,
    preference: &NotificationPreference,
) -> Result<EmailAction> {
    if preference.email_mode == EmailMode::Off || !preference.email_enabled {
        return Ok(EmailAction::Skipped);
    }
    let now = clock.now();
    if preference.email_mode == EmailMode::Instant {
        let html = build_notification_email(
            &notification.title,
            notification.body.as_deref().unwrap_or(""),
            None,
            None,
        );
        let result = mailer.send(&EmailMessage {
            to: user_email.into(),
            subject: notification.title.clone(),
            html,
        });
        let ok = result.is_ok();
        let (provider, error) = match &result {
            Ok(p) => (p.clone(), None),
            Err(e) => (None, Some(e.to_string())),
        };
        repo.log_email(&EmailLogEntry {
            notification_id: Some(&notification.id),
            user_id: &notification.user_id,
            status: if ok {
                EmailDeliveryStatus::Sent
            } else {
                EmailDeliveryStatus::Failed
            },
            sent_at: ok.then_some(now),
            provider_id: provider.as_deref(),
            error: error.as_deref(),
            created_at: now,
        })?;
        Ok(EmailAction::Sent(ok))
    } else {
        repo.log_email(&EmailLogEntry {
            notification_id: Some(&notification.id),
            user_id: &notification.user_id,
            status: EmailDeliveryStatus::Queued,
            sent_at: None,
            provider_id: None,
            error: None,
            created_at: now,
        })?;
        Ok(EmailAction::Queued)
    }
}

/// Send all queued entries of a user as one digest and settle the log rows. Returns the number
/// of items included (0 when nothing was queued).
pub fn send_digest(
    repo: &dyn NotificationRepo,
    mailer: &dyn Mailer,
    clock: &Clock,
    user_id: &str,
    user_email: &str,
) -> Result<usize> {
    let queued = repo.queued_emails(user_id)?;
    if queued.is_empty() {
        return Ok(0);
    }
    let items: Vec<DigestItem> = queued
        .iter()
        .map(|q| DigestItem {
            title: q.title.clone(),
            body: q.body.clone().unwrap_or_default(),
            event_type: q.event_type.clone(),
        })
        .collect();
    let subject = format!(
        "Nyx digest \u{2014} {} notification{}",
        items.len(),
        if items.len() > 1 { "s" } else { "" }
    );
    let result = mailer.send(&EmailMessage {
        to: user_email.into(),
        subject,
        html: build_digest_email(&items),
    });
    let ids: Vec<_> = queued.iter().map(|q| q.log_id.clone()).collect();
    match result {
        Ok(provider) => repo.finish_queued(
            &ids,
            EmailDeliveryStatus::Sent,
            Some(clock.now()),
            provider.as_deref(),
            None,
        )?,
        Err(e) => repo.finish_queued(
            &ids,
            EmailDeliveryStatus::Failed,
            None,
            None,
            Some(&e.to_string()),
        )?,
    }
    Ok(items.len())
}
