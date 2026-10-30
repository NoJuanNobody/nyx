//! Jira webhook handling: signature check and payload parsing.
//!
//! Ports `validateJiraWebhookSignature` (atlassian.service.ts) and the `POST /jira/webhook` route
//! logic (routes/integrations/atlassian.ts). Pure: the caller applies the returned
//! [`JiraWebhookAction`] to its tickets (match `tickets.external_id` to `issue_key`).

use serde::Deserialize;

use super::jira::status_to_ticket_status;
use crate::git_provider::util::{ct_eq, hmac_sha256};
use crate::integrations::{IntegrationError, Result};
use crate::model::TicketStatus;

/// Verify the HMAC-SHA256 signature of a Jira webhook delivery over the RAW body.
///
/// Accepts the bare hex digest (what the TS service compared) or the `sha256=<hex>` form used by
/// the `X-Hub-Signature` header.
///
/// `secret == None` means "no secret configured" and returns `true`, exactly like the TS dev mode.
/// Production callers should refuse to run with no secret instead of relying on that.
#[must_use]
pub fn verify_signature(raw_body: &[u8], signature: Option<&str>, secret: Option<&str>) -> bool {
    let Some(secret) = secret.filter(|s| !s.is_empty()) else {
        return true;
    };
    let Some(sig) = signature else {
        return false;
    };
    let sig = sig.trim();
    let sig = sig.strip_prefix("sha256=").unwrap_or(sig);
    let expected = hex::encode(hmac_sha256(secret.as_bytes(), raw_body));
    ct_eq(sig.to_ascii_lowercase().as_bytes(), expected.as_bytes())
}

/// What a webhook delivery means for Nyx.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JiraWebhookAction {
    /// `jira:issue_updated` carrying a status category: set the linked ticket's status.
    StatusChanged {
        /// Jira issue key, matches `tickets.external_id`.
        issue_key: String,
        /// Mapped Nyx status.
        status: TicketStatus,
    },
    /// `jira:issue_deleted`: close the linked ticket.
    IssueDeleted {
        /// Jira issue key.
        issue_key: String,
    },
    /// Valid payload with nothing to do (other events, updates without a status category).
    Ignored {
        /// The webhook event name.
        event: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    webhook_event: Option<String>,
    issue: Option<Issue>,
}
#[derive(Deserialize)]
struct Issue {
    key: String,
    #[serde(default)]
    fields: Fields,
}
#[derive(Deserialize, Default)]
struct Fields {
    #[serde(default)]
    status: Option<Status>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    #[serde(default)]
    status_category: Option<Cat>,
}
#[derive(Deserialize)]
struct Cat {
    name: String,
}

/// Parse a delivery body.
///
/// # Errors
/// [`IntegrationError::Webhook`] if the body is not JSON or lacks `webhookEvent` / `issue` (the
/// TS route answered 400 `Invalid webhook payload`).
pub fn parse_webhook(body: &[u8]) -> Result<JiraWebhookAction> {
    let invalid = || IntegrationError::Webhook("Invalid webhook payload".into());
    let p: Payload = serde_json::from_slice(body).map_err(|_| invalid())?;
    let (Some(event), Some(issue)) = (p.webhook_event, p.issue) else {
        return Err(invalid());
    };
    Ok(match event.as_str() {
        "jira:issue_updated" => match issue.fields.status.and_then(|s| s.status_category) {
            Some(cat) => JiraWebhookAction::StatusChanged {
                issue_key: issue.key,
                status: status_to_ticket_status(&cat.name),
            },
            None => JiraWebhookAction::Ignored { event },
        },
        "jira:issue_deleted" => JiraWebhookAction::IssueDeleted {
            issue_key: issue.key,
        },
        _ => JiraWebhookAction::Ignored { event },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const UPDATED: &str = r#"{"webhookEvent":"jira:issue_updated","timestamp":1,
      "issue":{"id":"1","key":"NYX-5","fields":{"summary":"s","status":{"name":"Review","statusCategory":{"name":"In Progress","key":"indeterminate"}}}}}"#;

    fn sign(secret: &str, body: &str) -> String {
        hex::encode(hmac_sha256(secret.as_bytes(), body.as_bytes()))
    }

    #[test]
    fn no_secret_is_dev_mode() {
        assert!(verify_signature(b"{}", None, None));
        assert!(verify_signature(b"{}", Some("abc"), None));
        assert!(verify_signature(b"{}", None, Some("")));
    }

    #[test]
    fn signature_checks() {
        let sig = sign("s3", UPDATED);
        assert!(verify_signature(UPDATED.as_bytes(), Some(&sig), Some("s3")));
        assert!(verify_signature(
            UPDATED.as_bytes(),
            Some(&format!("sha256={}", sig.to_uppercase())),
            Some("s3")
        ));
        assert!(!verify_signature(
            UPDATED.as_bytes(),
            Some(&sig),
            Some("other")
        ));
        assert!(!verify_signature(UPDATED.as_bytes(), None, Some("s3")));
        assert!(!verify_signature(b"tampered", Some(&sig), Some("s3")));
        assert!(!verify_signature(
            UPDATED.as_bytes(),
            Some("short"),
            Some("s3")
        ));
    }

    #[test]
    fn status_updates_map() {
        assert_eq!(
            parse_webhook(UPDATED.as_bytes()).unwrap(),
            JiraWebhookAction::StatusChanged {
                issue_key: "NYX-5".into(),
                status: TicketStatus::InProgress
            }
        );
        let done = UPDATED.replace("In Progress", "Done");
        assert!(matches!(
            parse_webhook(done.as_bytes()).unwrap(),
            JiraWebhookAction::StatusChanged {
                status: TicketStatus::Closed,
                ..
            }
        ));
        let todo = UPDATED.replace("In Progress", "To Do");
        assert!(matches!(
            parse_webhook(todo.as_bytes()).unwrap(),
            JiraWebhookAction::StatusChanged {
                status: TicketStatus::Open,
                ..
            }
        ));
    }

    #[test]
    fn delete_and_ignored_events() {
        let del =
            r#"{"webhookEvent":"jira:issue_deleted","issue":{"id":"1","key":"NYX-9","fields":{}}}"#;
        assert_eq!(
            parse_webhook(del.as_bytes()).unwrap(),
            JiraWebhookAction::IssueDeleted {
                issue_key: "NYX-9".into()
            }
        );
        let no_cat = r#"{"webhookEvent":"jira:issue_updated","issue":{"id":"1","key":"NYX-1","fields":{"summary":"x"}}}"#;
        assert!(matches!(
            parse_webhook(no_cat.as_bytes()).unwrap(),
            JiraWebhookAction::Ignored { .. }
        ));
        let other =
            r#"{"webhookEvent":"comment_created","issue":{"id":"1","key":"NYX-1","fields":{}}}"#;
        assert!(matches!(
            parse_webhook(other.as_bytes()).unwrap(),
            JiraWebhookAction::Ignored { event } if event == "comment_created"
        ));
    }

    #[test]
    fn invalid_payloads() {
        for b in [
            "",
            "not json",
            "{}",
            r#"{"webhookEvent":"jira:issue_updated"}"#,
            r#"{"issue":{"key":"A-1"}}"#,
        ] {
            let e = parse_webhook(b.as_bytes()).unwrap_err();
            assert!(matches!(e, IntegrationError::Webhook(_)), "{b}");
        }
    }
}
