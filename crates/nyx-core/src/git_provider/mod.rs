//! Git hosting integration: GitHub, GitLab (cloud + self-hosted) and Bitbucket Cloud.
//!
//! Ported from `apps/api/src/services/{git-provider.interface,github.service,
//! gitlab.service,bitbucket.service}.ts` and the signature handling in
//! `routes/webhooks.ts`. See `docs/rust-core/git-provider.md`.
//!
//! Layout:
//! - [`GitProvider`]: the shared trait (owned by AI-66) with normalised types.
//! - [`transport`]: [`HttpTransport`] trait + [`FakeTransport`] for tests.
//! - [`github`], [`gitlab`], [`bitbucket`]: per-provider request builders and
//!   response parsers (pure functions over serde types) plus a provider struct
//!   implementing the trait over a transport.
//! - [`webhook`]: signature verification (HMAC-SHA256 / token) and normalised events.
//! - [`pagination`], [`rate_limit`]: `Link`/`next` pagination and rate-limit headers.
//!
//! Credentials are never stored in providers: they hold an `Arc<dyn SecretStore>`
//! and read the access token (`SecretKey::access_token`) per call. GitHub uses
//! `Provider::GitHub`; GitLab and Bitbucket use `Provider::Other("gitlab"|"bitbucket")`.

#![cfg_attr(
    test,
    allow(clippy::assert_is_empty, clippy::redundant_closure_for_method_calls)
)]

pub mod bitbucket;
mod client;
pub mod github;
pub mod gitlab;
pub mod pagination;
pub mod rate_limit;
pub mod transport;
pub mod util;
pub mod webhook;

use std::fmt;
use std::sync::Arc;

use secrecy::SecretString;
use serde::{Deserialize, Serialize};

pub use bitbucket::BitbucketProvider;
pub use github::GitHubProvider;
pub use gitlab::GitLabProvider;
pub use rate_limit::RateLimit;
pub use transport::{FakeTransport, Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport};
pub use webhook::{CommentEvent, IssueEvent, IssueStatus, PushCommit, PushEvent, WebhookEvent};

use crate::profile::SecretStore;

/// Errors from git provider operations.
#[derive(Debug, thiserror::Error)]
pub enum GitError {
    /// 401: token expired or revoked; user must reconnect.
    #[error("{0} token expired or revoked. Please reconnect your {0} integration.")]
    Unauthorized(&'static str),
    /// 403 that is not a rate limit.
    #[error("{provider} {op} forbidden (403): {body}")]
    Forbidden {
        /// Provider display name.
        provider: &'static str,
        /// Operation name.
        op: &'static str,
        /// First 200 chars of the response body.
        body: String,
    },
    /// 404.
    #[error("{0}")]
    NotFound(String),
    /// Rate limit hit (403/429 with exhausted quota).
    #[error("{provider} API rate limit exceeded. Please wait a few minutes and try again.")]
    RateLimited {
        /// Provider display name.
        provider: &'static str,
        /// Seconds to wait, from `Retry-After`/reset headers when present.
        retry_after_secs: Option<u64>,
    },
    /// Any other non-success status.
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
    /// OAuth endpoint reported an error or no token.
    #[error("{0}")]
    OAuth(String),
    /// No access token stored for this provider.
    #[error("no {0} access token stored; connect the integration first")]
    MissingCredential(&'static str),
    /// Bad caller input or unsupported operation.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// Response body did not match the expected shape.
    #[error("unexpected response: {0}")]
    Parse(String),
    /// Webhook payload/headers malformed.
    #[error("bad webhook: {0}")]
    Webhook(String),
    /// Connection-level failure.
    #[error("transport error: {0}")]
    Transport(String),
    /// Secret store failure.
    #[error("secret store: {0}")]
    Secrets(String),
}

/// Result alias for this module.
pub type GitResult<T> = std::result::Result<T, GitError>;

impl From<GitError> for crate::Error {
    fn from(e: GitError) -> Self {
        match e {
            GitError::NotFound(m) => Self::NotFound(m),
            GitError::Invalid(m) | GitError::Webhook(m) => Self::Invalid(m),
            other => Self::Invalid(other.to_string()),
        }
    }
}

/// Which hosting service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    /// github.com
    GitHub,
    /// gitlab.com or self-hosted
    GitLab,
    /// bitbucket.org
    Bitbucket,
}

impl ProviderKind {
    /// Lowercase slug (`github`, `gitlab`, `bitbucket`), as used in `integrations.type`.
    #[must_use]
    pub fn slug(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
            Self::Bitbucket => "bitbucket",
        }
    }

    /// Human-readable name for messages.
    #[must_use]
    pub fn display_name(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
            Self::Bitbucket => "Bitbucket",
        }
    }

    /// Parse a slug.
    ///
    /// # Errors
    /// [`GitError::Invalid`] for unknown slugs.
    pub fn from_slug(s: &str) -> GitResult<Self> {
        match s {
            "github" => Ok(Self::GitHub),
            "gitlab" => Ok(Self::GitLab),
            "bitbucket" => Ok(Self::Bitbucket),
            other => Err(GitError::Invalid(format!(
                "unknown git provider: {other:?}"
            ))),
        }
    }

    /// The [`crate::profile::Provider`] under which this provider's token is stored.
    #[must_use]
    pub fn secret_provider(self) -> crate::profile::Provider {
        match self {
            Self::GitHub => crate::profile::Provider::GitHub,
            Self::GitLab => crate::profile::Provider::Other("gitlab".into()),
            Self::Bitbucket => crate::profile::Provider::Other("bitbucket".into()),
        }
    }
}

/// A repository, normalised across providers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitRepo {
    /// Provider id (numeric id or Bitbucket UUID) as a string.
    pub id: String,
    /// Short name.
    pub name: String,
    /// `owner/name` (GitLab: `path_with_namespace`).
    pub full_name: String,
    /// Private visibility.
    pub is_private: bool,
    /// Browser URL.
    pub html_url: String,
    /// Default branch (`main` if the provider reports none).
    pub default_branch: String,
}

/// Tree entry kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TreeEntryKind {
    /// File.
    Blob,
    /// Directory (or submodule/other non-file).
    Tree,
}

/// One path in a repository tree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitTreeEntry {
    /// Repo-relative path.
    pub path: String,
    /// File or directory.
    pub kind: TreeEntryKind,
    /// Size in bytes when the provider reports it.
    pub size: Option<u64>,
}

/// File content as returned by the provider (usually base64).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitFileContent {
    /// File name.
    pub name: String,
    /// Repo-relative path.
    pub path: String,
    /// Size in bytes.
    pub size: u64,
    /// Encoded content (see `encoding`).
    pub content: String,
    /// `base64` or `utf-8`.
    pub encoding: String,
    /// Browser URL.
    pub html_url: String,
}

impl GitFileContent {
    /// Decode to raw bytes (handles the newline-wrapped base64 GitHub returns).
    ///
    /// # Errors
    /// [`GitError::Parse`] on invalid base64.
    pub fn decode(&self) -> GitResult<Vec<u8>> {
        use base64::Engine as _;
        if self.encoding.eq_ignore_ascii_case("base64") {
            let compact: String = self
                .content
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            base64::engine::general_purpose::STANDARD
                .decode(compact)
                .map_err(|e| GitError::Parse(format!("bad base64 content: {e}")))
        } else {
            Ok(self.content.clone().into_bytes())
        }
    }
}

/// Issue, normalised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitIssue {
    /// Provider id as string.
    pub id: String,
    /// GitHub/Bitbucket issue number.
    pub number: Option<u64>,
    /// GitLab project-scoped iid.
    pub iid: Option<u64>,
    /// Title.
    pub title: String,
    /// Browser URL.
    pub html_url: String,
    /// Provider state string (`open`, `opened`, `closed`, `new`, ...).
    pub state: String,
}

/// Issue state filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueStateFilter {
    /// Open issues.
    Open,
    /// Closed issues.
    Closed,
    /// Both.
    All,
}

/// Registered webhook handle.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitWebhook {
    /// Provider hook id (number or UUID) as string.
    pub id: String,
}

/// Authenticated user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitUser {
    /// Username.
    pub login: String,
    /// Provider id as string.
    pub id: String,
    /// Avatar URL.
    pub avatar_url: String,
    /// Display name.
    pub name: Option<String>,
}

/// OAuth token response. Secrets are wrapped so `Debug` redacts them.
#[derive(Debug)]
pub struct OAuthToken {
    /// Access token.
    pub access_token: SecretString,
    /// Token type (default `bearer`).
    pub token_type: String,
    /// Granted scopes.
    pub scope: String,
    /// Refresh token (GitLab, Bitbucket).
    pub refresh_token: Option<SecretString>,
}

/// A commit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GitCommit {
    /// Full SHA.
    pub sha: String,
    /// Commit message.
    pub message: String,
    /// Author name.
    pub author_name: String,
    /// Author email when known (Bitbucket only gives a raw `Name <email>`).
    pub author_email: Option<String>,
    /// Timestamp as reported (ISO 8601).
    pub timestamp: String,
    /// Browser URL when known.
    pub html_url: Option<String>,
}

/// File change kind in a diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    /// New file.
    Added,
    /// Changed file.
    Modified,
    /// Deleted file.
    Removed,
    /// Renamed (possibly with edits).
    Renamed,
}

/// One file's diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileDiff {
    /// Path before the change (same as `path` unless renamed).
    pub old_path: String,
    /// Path after the change.
    pub path: String,
    /// Kind of change.
    pub kind: ChangeKind,
    /// Unified-diff hunks; absent for binary/oversized files.
    pub patch: Option<String>,
    /// Added line count.
    pub additions: u64,
    /// Removed line count.
    pub deletions: u64,
}

/// A branch reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchRef {
    /// Branch name.
    pub name: String,
    /// Head commit SHA.
    pub sha: String,
}

/// Pull request creation input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewPullRequest {
    /// Title.
    pub title: String,
    /// Description.
    pub body: String,
    /// Source branch.
    pub head: String,
    /// Target branch.
    pub base: String,
    /// Create as draft where supported (GitHub; GitLab uses a `Draft:` prefix).
    pub draft: bool,
}

/// Pull / merge request, normalised.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullRequest {
    /// Provider id as string.
    pub id: String,
    /// PR number (GitLab: MR iid).
    pub number: u64,
    /// Title.
    pub title: String,
    /// Browser URL.
    pub html_url: String,
    /// Provider state string.
    pub state: String,
    /// Source branch.
    pub head: String,
    /// Target branch.
    pub base: String,
}

/// Repository creation input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewRepo {
    /// Repository name.
    pub name: String,
    /// Description.
    pub description: Option<String>,
    /// Private (default true where the TS did so).
    pub is_private: bool,
    /// Bitbucket workspace (required there, ignored elsewhere).
    pub workspace: Option<String>,
}

/// Common interface for git hosting providers (port of `GitProvider` in
/// `git-provider.interface.ts`, extended with commits/diffs/branches/PRs and
/// webhook parsing). Synchronous; tokens come from the injected `SecretStore`.
pub trait GitProvider: Send + Sync + fmt::Debug {
    /// Which provider this is.
    fn kind(&self) -> ProviderKind;

    /// List repositories accessible to the authenticated user (all pages, capped).
    fn list_repos(&self) -> GitResult<Vec<GitRepo>>;

    /// Create a repository.
    fn create_repo(&self, new: &NewRepo) -> GitResult<GitRepo>;

    /// Recursive file tree at `git_ref` (default `HEAD`).
    fn get_file_tree(
        &self,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
    ) -> GitResult<Vec<GitTreeEntry>>;

    /// Single file content at `git_ref`.
    fn get_file_content(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> GitResult<GitFileContent>;

    /// Most recent commits on `git_ref` (default branch when `None`), newest first, at most `limit`.
    fn list_commits(
        &self,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
        limit: usize,
    ) -> GitResult<Vec<GitCommit>>;

    /// Per-file diffs introduced by one commit.
    fn get_commit_diff(&self, owner: &str, repo: &str, sha: &str) -> GitResult<Vec<FileDiff>>;

    /// Create `name` branching from `from_ref` (branch name or SHA).
    fn create_branch(
        &self,
        owner: &str,
        repo: &str,
        name: &str,
        from_ref: &str,
    ) -> GitResult<BranchRef>;

    /// Open a pull / merge request.
    fn create_pull_request(
        &self,
        owner: &str,
        repo: &str,
        pr: &NewPullRequest,
    ) -> GitResult<PullRequest>;

    /// Create an issue.
    fn create_issue(
        &self,
        owner: &str,
        repo: &str,
        title: &str,
        body: &str,
        labels: &[String],
    ) -> GitResult<GitIssue>;

    /// List issues.
    fn list_issues(
        &self,
        owner: &str,
        repo: &str,
        state: IssueStateFilter,
    ) -> GitResult<Vec<GitIssue>>;

    /// Register a webhook for push/issue events.
    fn create_webhook(
        &self,
        owner: &str,
        repo: &str,
        url: &str,
        secret: &str,
    ) -> GitResult<GitWebhook>;

    /// Delete a webhook (a 404 is treated as success).
    fn delete_webhook(&self, owner: &str, repo: &str, hook_id: &str) -> GitResult<()>;

    /// Exchange an OAuth authorisation code for tokens.
    fn exchange_code_for_token(
        &self,
        client_id: &str,
        client_secret: &SecretString,
        code: &str,
        redirect_uri: Option<&str>,
    ) -> GitResult<OAuthToken>;

    /// The user the stored token belongs to.
    fn get_authenticated_user(&self) -> GitResult<GitUser>;

    /// Verify an incoming webhook's authenticity against `secret`.
    fn verify_webhook(&self, headers: &Headers, body: &[u8], secret: &str) -> bool;

    /// Parse an (already verified) webhook into a normalised event.
    fn parse_webhook(&self, headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent>;

    /// Rate-limit info from the most recent response, if the provider sent any.
    fn last_rate_limit(&self) -> Option<RateLimit>;
}

/// Options for [`new_provider`].
#[derive(Debug, Clone, Default)]
pub struct ProviderOptions {
    /// Self-hosted GitLab base URL (e.g. `https://git.example.com`); ignored elsewhere.
    pub gitlab_base_url: Option<String>,
}

/// Construct a boxed provider of `kind`.
#[must_use]
pub fn new_provider(
    kind: ProviderKind,
    transport: Arc<dyn HttpTransport>,
    secrets: Arc<dyn SecretStore>,
    opts: &ProviderOptions,
) -> Box<dyn GitProvider> {
    match kind {
        ProviderKind::GitHub => Box::new(GitHubProvider::new(transport, secrets)),
        ProviderKind::GitLab => Box::new(GitLabProvider::new(
            transport,
            secrets,
            opts.gitlab_base_url.as_deref(),
        )),
        ProviderKind::Bitbucket => Box::new(BitbucketProvider::new(transport, secrets)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_roundtrip() {
        for k in [
            ProviderKind::GitHub,
            ProviderKind::GitLab,
            ProviderKind::Bitbucket,
        ] {
            assert_eq!(ProviderKind::from_slug(k.slug()).unwrap(), k);
        }
        assert!(ProviderKind::from_slug("svn").is_err());
    }

    #[test]
    fn decode_base64_with_newlines() {
        let c = GitFileContent {
            name: "a".into(),
            path: "a".into(),
            size: 5,
            content: "aGVs\nbG8=\n".into(),
            encoding: "base64".into(),
            html_url: String::new(),
        };
        assert_eq!(c.decode().unwrap(), b"hello");
    }

    #[test]
    fn error_messages_match_ts() {
        assert_eq!(
            GitError::Unauthorized("GitHub").to_string(),
            "GitHub token expired or revoked. Please reconnect your GitHub integration."
        );
        let e: crate::Error = GitError::NotFound("x".into()).into();
        assert!(matches!(e, crate::Error::NotFound(_)));
    }
}
