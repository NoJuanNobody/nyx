//! Jira, Confluence and Slack integrations (AI-71).
//!
//! Ported from `apps/api/src/services/{atlassian,jira,slack}.service.ts`,
//! `routes/integrations/atlassian.ts` and `routes/slack.ts`. See `docs/rust-core/integrations.md`.
//!
//! Layout:
//! - [`http`]: retrying HTTP wrapper over the shared [`HttpTransport`] seam (`Retry-After`
//!   handling, status classification).
//! - [`oauth`]: PKCE, state tokens, loopback redirect parsing, pending-authorisation store.
//! - [`atlassian`]: Atlassian OAuth 3LO, [`atlassian::jira`] (REST v3), [`atlassian::confluence`]
//!   (REST v2 + labels), Markdown to ADF / storage format, Jira webhook handling, token lifecycle.
//! - [`slack`]: Web API client, Block Kit helpers, request signature verification, events and
//!   slash-command parsing, workspace link persistence.
//!
//! Design rules:
//! - Request builders and response parsers are pure functions over [`HttpRequest`] /
//!   [`HttpResponse`]; the `*Client` structs only glue them to a transport.
//! - Tokens live in [`crate::profile::SecretStore`], never in SQLite. `store::integrations` (and
//!   the `slack_connections` table) hold metadata only.
//! - No network access in tests: everything goes through [`HttpTransport`] with a fake.
//! - `social-publish.service.ts` is skipped: it is a stub that returns mock post URLs.
//!
//! TODO(AI-74 wiring): a real [`HttpTransport`] (reqwest/ureq) and the loopback HTTP listener that
//! feeds [`oauth::parse_callback`]. Slack requires an HTTPS redirect URL for OAuth v2, so the
//! Slack install flow needs a relay or manual token entry on the desktop; see the docs.

#![allow(clippy::items_after_statements)]
#![cfg_attr(
    test,
    allow(
        clippy::assert_is_empty,
        clippy::default_trait_access,
        clippy::redundant_closure_for_method_calls
    )
)]

pub mod atlassian;
pub mod http;
pub mod oauth;
pub mod slack;

use crate::git_provider::GitError;

pub use crate::net::{Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport};

/// Errors from the integrations module. Converts into [`crate::Error`].
#[derive(Debug, thiserror::Error)]
pub enum IntegrationError {
    /// 401: token expired or revoked.
    #[error("{0} token expired or revoked. Please reconnect your {0} integration.")]
    Unauthorized(&'static str),
    /// 403 (permission or scope problem).
    #[error("{provider} {op} forbidden (403): {body}")]
    Forbidden {
        /// Provider display name.
        provider: &'static str,
        /// Operation name.
        op: &'static str,
        /// Truncated response body.
        body: String,
    },
    /// 404.
    #[error("{0}")]
    NotFound(String),
    /// 409 (for example a Confluence page version conflict).
    #[error("{0}")]
    Conflict(String),
    /// 429 (after retries were exhausted or the wait exceeded the policy cap).
    #[error("{provider} API rate limit exceeded. Please wait and try again.")]
    RateLimited {
        /// Provider display name.
        provider: &'static str,
        /// Seconds to wait from `Retry-After`, when sent.
        retry_after_secs: Option<u64>,
    },
    /// Any other non-success HTTP status.
    #[error("{provider} {op} failed: {status} {body}")]
    Api {
        /// Provider display name.
        provider: &'static str,
        /// Operation name.
        op: &'static str,
        /// HTTP status.
        status: u16,
        /// Truncated response body.
        body: String,
    },
    /// Slack answered HTTP 200 with `ok: false`.
    #[error("slack {method} failed: {code}")]
    SlackApi {
        /// Web API method, for example `chat.postMessage`.
        method: &'static str,
        /// Slack error code, for example `channel_not_found`.
        code: String,
    },
    /// OAuth endpoint reported an error, or the redirect was invalid (state mismatch, denied).
    #[error("{0}")]
    OAuth(String),
    /// The refresh token is invalid or expired; the user must re-authorise.
    #[error("{0} refresh token is invalid or expired; please reconnect")]
    TokenExpired(&'static str),
    /// No token stored for this service.
    #[error("no {0} token stored; connect the integration first")]
    MissingCredential(&'static str),
    /// Bad caller input.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// Response body did not match the expected shape.
    #[error("unexpected response: {0}")]
    Parse(String),
    /// Webhook payload or headers malformed.
    #[error("bad webhook: {0}")]
    Webhook(String),
    /// Connection-level failure.
    #[error("transport error: {0}")]
    Transport(String),
    /// Secret store failure.
    #[error("secret store: {0}")]
    Secrets(String),
    /// Metadata persistence failure.
    #[error(transparent)]
    Core(Box<crate::Error>),
}

/// Result alias for this module.
pub type Result<T> = std::result::Result<T, IntegrationError>;

impl From<GitError> for IntegrationError {
    fn from(e: GitError) -> Self {
        match e {
            GitError::Transport(m) => Self::Transport(m),
            other => Self::Transport(other.to_string()),
        }
    }
}

impl From<crate::net::NetError> for IntegrationError {
    fn from(e: crate::net::NetError) -> Self {
        match e {
            crate::net::NetError::Parse(m) => Self::Parse(m),
            crate::net::NetError::Transport(m) => Self::Transport(m),
            other => Self::Transport(other.to_string()),
        }
    }
}

impl From<crate::Error> for IntegrationError {
    fn from(e: crate::Error) -> Self {
        Self::Core(Box::new(e))
    }
}

impl From<IntegrationError> for crate::Error {
    fn from(e: IntegrationError) -> Self {
        match e {
            IntegrationError::NotFound(m) => Self::NotFound(m),
            IntegrationError::Conflict(m) => Self::Conflict(m),
            IntegrationError::Invalid(m) | IntegrationError::Webhook(m) => Self::Invalid(m),
            IntegrationError::Core(inner) => *inner,
            other => Self::Invalid(other.to_string()),
        }
    }
}
