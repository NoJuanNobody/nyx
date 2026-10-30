//! Webhook authenticity checks and normalised event parsing.
//!
//! Ports `verifyGitHubSignature` (routes/webhooks.ts) and `handlePushWebhook`
//! (github.service.ts), and adds the GitLab (`X-Gitlab-Token`) and Bitbucket
//! (`X-Hub-Signature`, HMAC-SHA256) equivalents. Everything here is pure.
//!
//! Always verify against the RAW request bytes, never a re-serialised body.

use serde::Deserialize;

use super::transport::Headers;
use super::util::{ct_eq, hmac_sha256};
use super::{GitError, GitResult, ProviderKind};

// ── Verification ─────────────────────────────────────

/// Verify a `sha256=<hex>` HMAC header (GitHub `X-Hub-Signature-256`,
/// Bitbucket `X-Hub-Signature`) over the raw body. Empty secrets never verify.
#[must_use]
pub fn verify_hmac_sha256_header(body: &[u8], header: &str, secret: &str) -> bool {
    if secret.is_empty() {
        return false;
    }
    let Some(hex_part) = header.trim().strip_prefix("sha256=") else {
        return false;
    };
    let expected = hex::encode(hmac_sha256(secret.as_bytes(), body));
    ct_eq(
        hex_part.to_ascii_lowercase().as_bytes(),
        expected.as_bytes(),
    )
}

/// Verify a GitLab `X-Gitlab-Token` header (shared secret, constant-time compare).
#[must_use]
pub fn verify_token_header(header: &str, secret: &str) -> bool {
    !secret.is_empty() && ct_eq(header.trim().as_bytes(), secret.as_bytes())
}

/// Verify a webhook for `kind` using the standard headers for that provider.
///
/// Bitbucket deliveries without a signature header (webhooks created without a
/// secret) never verify here; callers using the legacy URL-token approach should
/// compare the token themselves with [`verify_token_header`].
#[must_use]
pub fn verify(kind: ProviderKind, headers: &Headers, body: &[u8], secret: &str) -> bool {
    match kind {
        ProviderKind::GitHub => headers
            .get("x-hub-signature-256")
            .is_some_and(|h| verify_hmac_sha256_header(body, h, secret)),
        ProviderKind::GitLab => headers
            .get("x-gitlab-token")
            .is_some_and(|h| verify_token_header(h, secret)),
        ProviderKind::Bitbucket => headers
            .get("x-hub-signature")
            .is_some_and(|h| verify_hmac_sha256_header(body, h, secret)),
    }
}

/// Return the first candidate secret that verifies. Mirrors the TS per-integration
/// lookup: the caller finds integrations whose selected repos contain
/// [`peek_repo_full_name`] and passes their webhook secrets here.
#[must_use]
pub fn find_verified_secret<'a>(
    kind: ProviderKind,
    headers: &Headers,
    body: &[u8],
    candidates: &'a [String],
) -> Option<&'a str> {
    candidates
        .iter()
        .map(String::as_str)
        .find(|s| verify(kind, headers, body, s))
}

/// Read the repository full name from an unverified payload (needed to pick
/// which secret to verify with). Do not trust the result for anything else.
#[must_use]
pub fn peek_repo_full_name(kind: ProviderKind, body: &[u8]) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let s = match kind {
        ProviderKind::GitHub | ProviderKind::Bitbucket => v.pointer("/repository/full_name")?,
        ProviderKind::GitLab => v.pointer("/project/path_with_namespace")?,
    };
    s.as_str().map(str::to_owned)
}

// ── Normalised events ────────────────────────────────

/// Ticket-ish status derived from an issue event (port of the TS mapping).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueStatus {
    /// Open / reopened.
    Open,
    /// In progress (never produced by hosts today; kept for ticket parity).
    InProgress,
    /// Closed.
    Closed,
}

impl IssueStatus {
    /// `closed` -> Closed; `reopened`/`opened` -> Open; otherwise derive from `state`.
    #[must_use]
    pub fn from_action(action: &str, state: &str) -> Self {
        match action {
            "closed" => Self::Closed,
            "reopened" | "opened" => Self::Open,
            _ if state == "closed" => Self::Closed,
            _ => Self::Open,
        }
    }
}

/// One commit in a push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushCommit {
    /// SHA.
    pub id: String,
    /// Message.
    pub message: String,
    /// Timestamp as sent.
    pub timestamp: String,
    /// Author name.
    pub author_name: String,
    /// Author email (empty if unknown).
    pub author_email: String,
}

/// Push event (port of `PushWebhookResult`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PushEvent {
    /// Repo full name when present.
    pub repo_full_name: Option<String>,
    /// Full ref, e.g. `refs/heads/main`.
    pub git_ref: String,
    /// Commits in the push.
    pub commits: Vec<PushCommit>,
    /// De-duplicated added/removed/modified paths in first-seen order (empty on Bitbucket).
    pub changed_files: Vec<String>,
}

/// Issue opened/closed/etc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IssueEvent {
    /// Repo full name when present.
    pub repo_full_name: Option<String>,
    /// Normalised action: `opened`, `closed`, `reopened`, or the provider's other action.
    pub action: String,
    /// Issue number (GitLab: iid) — matches `tickets.external_id`.
    pub number: u64,
    /// Title.
    pub title: String,
    /// Provider state string.
    pub state: String,
    /// Derived ticket status.
    pub status: IssueStatus,
}

/// Issue comment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommentEvent {
    /// Repo full name when present.
    pub repo_full_name: Option<String>,
    /// Owner/namespace part.
    pub owner: String,
    /// Repo name part.
    pub repo: String,
    /// Issue number.
    pub issue_number: u64,
    /// `created`, `edited`, ...
    pub action: String,
    /// Comment id as string.
    pub comment_id: String,
    /// Comment text.
    pub body: String,
    /// Comment author.
    pub author: String,
}

/// A parsed webhook delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WebhookEvent {
    /// Connectivity ping (GitHub).
    Ping,
    /// Push (or tag push).
    Push(PushEvent),
    /// Issue lifecycle.
    Issue(IssueEvent),
    /// Issue comment.
    IssueComment(CommentEvent),
    /// Acknowledged but not interpreted.
    Other {
        /// Event name from the headers.
        event: String,
    },
}

fn dedupe_push(mut ev: PushEvent, files: impl Iterator<Item = String>) -> PushEvent {
    for f in files {
        if !ev.changed_files.contains(&f) {
            ev.changed_files.push(f);
        }
    }
    ev
}

fn split_full_name(full: &str) -> (String, String) {
    match full.rsplit_once('/') {
        Some((o, r)) => (o.to_owned(), r.to_owned()),
        None => (String::new(), full.to_owned()),
    }
}

fn bad(e: &serde_json::Error) -> GitError {
    GitError::Webhook(e.to_string())
}

// ── GitHub ───────────────────────────────────────────

#[derive(Deserialize, Default)]
struct GhAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
}

#[derive(Deserialize)]
struct GhCommit {
    id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    author: GhAuthor,
    #[serde(default)]
    added: Vec<String>,
    #[serde(default)]
    removed: Vec<String>,
    #[serde(default)]
    modified: Vec<String>,
}

#[derive(Deserialize, Default)]
struct GhRepo {
    #[serde(default)]
    full_name: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    owner: Option<GhLogin>,
}

#[derive(Deserialize, Default)]
struct GhLogin {
    #[serde(default)]
    login: String,
}

#[derive(Deserialize)]
struct GhPush {
    #[serde(rename = "ref", default)]
    git_ref: String,
    #[serde(default)]
    commits: Vec<GhCommit>,
    #[serde(default)]
    repository: Option<GhRepo>,
}

#[derive(Deserialize)]
struct GhIssueObj {
    number: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct GhIssues {
    #[serde(default)]
    action: String,
    issue: Option<GhIssueObj>,
    #[serde(default)]
    repository: Option<GhRepo>,
}

#[derive(Deserialize)]
struct GhComment {
    id: u64,
    #[serde(default)]
    body: String,
    #[serde(default)]
    user: Option<GhLogin>,
}

#[derive(Deserialize)]
struct GhIssueComment {
    #[serde(default)]
    action: String,
    comment: Option<GhComment>,
    issue: Option<GhIssueObj>,
    #[serde(default)]
    repository: Option<GhRepo>,
}

/// Parse a GitHub delivery (`X-GitHub-Event` + raw JSON body).
///
/// # Errors
/// [`GitError::Webhook`] when the header is missing or the payload is malformed.
pub fn parse_github(headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
    let event = headers
        .get("x-github-event")
        .ok_or_else(|| GitError::Webhook("missing X-GitHub-Event header".into()))?;
    match event {
        "ping" => Ok(WebhookEvent::Ping),
        "push" => {
            let p: GhPush = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let files: Vec<String> = p
                .commits
                .iter()
                .flat_map(|c| c.added.iter().chain(&c.removed).chain(&c.modified).cloned())
                .collect();
            let ev = PushEvent {
                repo_full_name: p.repository.and_then(|r| r.full_name),
                git_ref: p.git_ref,
                commits: p
                    .commits
                    .into_iter()
                    .map(|c| PushCommit {
                        id: c.id,
                        message: c.message,
                        timestamp: c.timestamp,
                        author_name: c.author.name,
                        author_email: c.author.email,
                    })
                    .collect(),
                changed_files: Vec::new(),
            };
            Ok(WebhookEvent::Push(dedupe_push(ev, files.into_iter())))
        }
        "issues" => {
            let p: GhIssues = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let issue = p
                .issue
                .ok_or_else(|| GitError::Webhook("issues event without issue".into()))?;
            Ok(WebhookEvent::Issue(IssueEvent {
                repo_full_name: p.repository.and_then(|r| r.full_name),
                status: IssueStatus::from_action(&p.action, &issue.state),
                action: p.action,
                number: issue.number,
                title: issue.title,
                state: issue.state,
            }))
        }
        "issue_comment" => {
            let p: GhIssueComment = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let (Some(comment), Some(issue), Some(repo)) = (p.comment, p.issue, p.repository)
            else {
                return Err(GitError::Webhook(
                    "issue_comment missing comment/issue/repository".into(),
                ));
            };
            let owner = repo.owner.map(|o| o.login).unwrap_or_default();
            let name = repo.name.unwrap_or_default();
            Ok(WebhookEvent::IssueComment(CommentEvent {
                repo_full_name: repo.full_name,
                owner,
                repo: name,
                issue_number: issue.number,
                action: p.action,
                comment_id: comment.id.to_string(),
                body: comment.body,
                author: comment.user.map(|u| u.login).unwrap_or_default(),
            }))
        }
        other => Ok(WebhookEvent::Other {
            event: other.to_owned(),
        }),
    }
}

// ── GitLab ───────────────────────────────────────────

#[derive(Deserialize)]
struct GlCommit {
    id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    author: GhAuthor,
    #[serde(default)]
    added: Vec<String>,
    #[serde(default)]
    removed: Vec<String>,
    #[serde(default)]
    modified: Vec<String>,
}

#[derive(Deserialize, Default)]
struct GlProject {
    #[serde(default)]
    path_with_namespace: Option<String>,
}

#[derive(Deserialize)]
struct GlPush {
    #[serde(rename = "ref", default)]
    git_ref: String,
    #[serde(default)]
    commits: Vec<GlCommit>,
    #[serde(default)]
    project: Option<GlProject>,
}

#[derive(Deserialize)]
struct GlIssueAttrs {
    iid: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    action: String,
}

#[derive(Deserialize)]
struct GlIssueHook {
    object_attributes: GlIssueAttrs,
    #[serde(default)]
    project: Option<GlProject>,
}

#[derive(Deserialize)]
struct GlNoteAttrs {
    id: u64,
    #[serde(default)]
    note: String,
    #[serde(default)]
    noteable_type: String,
    #[serde(default)]
    action: Option<String>,
}

#[derive(Deserialize)]
struct GlNoteIssue {
    iid: u64,
}

#[derive(Deserialize, Default)]
struct GlUser {
    #[serde(default)]
    username: String,
}

#[derive(Deserialize)]
struct GlNoteHook {
    object_attributes: GlNoteAttrs,
    #[serde(default)]
    issue: Option<GlNoteIssue>,
    #[serde(default)]
    project: Option<GlProject>,
    #[serde(default)]
    user: Option<GlUser>,
}

/// Normalise GitLab issue actions (`open`/`close`/`reopen`/`update`) to GitHub-style names.
fn gitlab_action(a: &str) -> String {
    match a {
        "open" => "opened",
        "close" => "closed",
        "reopen" => "reopened",
        other => other,
    }
    .to_owned()
}

/// Parse a GitLab delivery (`X-Gitlab-Event` + raw JSON body).
///
/// # Errors
/// [`GitError::Webhook`] when the header is missing or the payload is malformed.
pub fn parse_gitlab(headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
    let event = headers
        .get("x-gitlab-event")
        .ok_or_else(|| GitError::Webhook("missing X-Gitlab-Event header".into()))?;
    match event {
        "Push Hook" | "Tag Push Hook" => {
            let p: GlPush = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let files: Vec<String> = p
                .commits
                .iter()
                .flat_map(|c| c.added.iter().chain(&c.removed).chain(&c.modified).cloned())
                .collect();
            let ev = PushEvent {
                repo_full_name: p.project.and_then(|r| r.path_with_namespace),
                git_ref: p.git_ref,
                commits: p
                    .commits
                    .into_iter()
                    .map(|c| PushCommit {
                        id: c.id,
                        message: c.message,
                        timestamp: c.timestamp,
                        author_name: c.author.name,
                        author_email: c.author.email,
                    })
                    .collect(),
                changed_files: Vec::new(),
            };
            Ok(WebhookEvent::Push(dedupe_push(ev, files.into_iter())))
        }
        "Issue Hook" => {
            let p: GlIssueHook = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let a = p.object_attributes;
            let action = gitlab_action(&a.action);
            // GitLab states: opened | closed.
            let state = if a.state == "opened" {
                "open".to_owned()
            } else {
                a.state
            };
            Ok(WebhookEvent::Issue(IssueEvent {
                repo_full_name: p.project.and_then(|r| r.path_with_namespace),
                status: IssueStatus::from_action(&action, &state),
                action,
                number: a.iid,
                title: a.title,
                state,
            }))
        }
        "Note Hook" => {
            let p: GlNoteHook = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            if p.object_attributes.noteable_type != "Issue" {
                return Ok(WebhookEvent::Other {
                    event: event.to_owned(),
                });
            }
            let issue = p
                .issue
                .ok_or_else(|| GitError::Webhook("Note Hook without issue".into()))?;
            let full = p.project.and_then(|r| r.path_with_namespace);
            let (owner, repo) = full.as_deref().map(split_full_name).unwrap_or_default();
            Ok(WebhookEvent::IssueComment(CommentEvent {
                repo_full_name: full,
                owner,
                repo,
                issue_number: issue.iid,
                action: match p.object_attributes.action.as_deref() {
                    Some("update") => "edited".to_owned(),
                    _ => "created".to_owned(),
                },
                comment_id: p.object_attributes.id.to_string(),
                body: p.object_attributes.note,
                author: p.user.map(|u| u.username).unwrap_or_default(),
            }))
        }
        other => Ok(WebhookEvent::Other {
            event: other.to_owned(),
        }),
    }
}

// ── Bitbucket ────────────────────────────────────────

#[derive(Deserialize, Default)]
struct BbRepo {
    #[serde(default)]
    full_name: Option<String>,
}

#[derive(Deserialize, Default)]
struct BbUser {
    #[serde(default)]
    display_name: String,
}

#[derive(Deserialize, Default)]
struct BbCommitAuthor {
    #[serde(default)]
    raw: String,
    #[serde(default)]
    user: Option<BbUser>,
}

#[derive(Deserialize)]
struct BbCommit {
    hash: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    author: BbCommitAuthor,
}

#[derive(Deserialize)]
struct BbRefTarget {
    name: String,
    #[serde(rename = "type", default)]
    kind: String,
}

#[derive(Deserialize)]
struct BbChange {
    #[serde(default)]
    new: Option<BbRefTarget>,
    #[serde(default)]
    old: Option<BbRefTarget>,
    #[serde(default)]
    commits: Vec<BbCommit>,
}

#[derive(Deserialize, Default)]
struct BbPushInner {
    #[serde(default)]
    changes: Vec<BbChange>,
}

#[derive(Deserialize)]
struct BbPush {
    #[serde(default)]
    push: BbPushInner,
    #[serde(default)]
    repository: Option<BbRepo>,
}

#[derive(Deserialize)]
struct BbIssueObj {
    id: u64,
    #[serde(default)]
    title: String,
    #[serde(default)]
    state: String,
}

#[derive(Deserialize)]
struct BbIssueHook {
    issue: BbIssueObj,
    #[serde(default)]
    repository: Option<BbRepo>,
}

#[derive(Deserialize, Default)]
struct BbContent {
    #[serde(default)]
    raw: String,
}

#[derive(Deserialize)]
struct BbComment {
    id: u64,
    #[serde(default)]
    content: BbContent,
    #[serde(default)]
    user: Option<BbUser>,
}

#[derive(Deserialize)]
struct BbCommentHook {
    comment: BbComment,
    issue: BbIssueObj,
    #[serde(default)]
    repository: Option<BbRepo>,
}

/// Split Bitbucket's `Name <email>` author string.
fn split_raw_author(raw: &str) -> (String, String) {
    match (raw.rfind('<'), raw.rfind('>')) {
        (Some(l), Some(r)) if l < r => {
            (raw[..l].trim().to_owned(), raw[l + 1..r].trim().to_owned())
        }
        _ => (raw.trim().to_owned(), String::new()),
    }
}

/// Parse a Bitbucket Cloud delivery (`X-Event-Key` + raw JSON body).
///
/// Push payloads carry no per-file lists, so `changed_files` is empty.
///
/// # Errors
/// [`GitError::Webhook`] when the header is missing or the payload is malformed.
pub fn parse_bitbucket(headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
    let event = headers
        .get("x-event-key")
        .ok_or_else(|| GitError::Webhook("missing X-Event-Key header".into()))?;
    match event {
        "repo:push" => {
            let p: BbPush = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let git_ref = p
                .push
                .changes
                .iter()
                .find_map(|c| c.new.as_ref().or(c.old.as_ref()))
                .map(|t| {
                    let ns = if t.kind == "tag" { "tags" } else { "heads" };
                    format!("refs/{ns}/{}", t.name)
                })
                .unwrap_or_default();
            let commits = p
                .push
                .changes
                .into_iter()
                .flat_map(|c| c.commits)
                .map(|c| {
                    let (raw_name, email) = split_raw_author(&c.author.raw);
                    let name = c.author.user.map_or(raw_name, |u| u.display_name);
                    PushCommit {
                        id: c.hash,
                        message: c.message,
                        timestamp: c.date,
                        author_name: name,
                        author_email: email,
                    }
                })
                .collect();
            Ok(WebhookEvent::Push(PushEvent {
                repo_full_name: p.repository.and_then(|r| r.full_name),
                git_ref,
                commits,
                changed_files: Vec::new(),
            }))
        }
        "issue:created" | "issue:updated" => {
            let p: BbIssueHook = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let closed = matches!(
                p.issue.state.as_str(),
                "resolved" | "closed" | "invalid" | "duplicate" | "wontfix"
            );
            let action = if event == "issue:created" {
                "opened"
            } else if closed {
                "closed"
            } else {
                "updated"
            };
            Ok(WebhookEvent::Issue(IssueEvent {
                repo_full_name: p.repository.and_then(|r| r.full_name),
                status: if closed {
                    IssueStatus::Closed
                } else {
                    IssueStatus::Open
                },
                action: action.to_owned(),
                number: p.issue.id,
                title: p.issue.title,
                state: p.issue.state,
            }))
        }
        "issue:comment_created" => {
            let p: BbCommentHook = serde_json::from_slice(body).map_err(|e| bad(&e))?;
            let full = p.repository.and_then(|r| r.full_name);
            let (owner, repo) = full.as_deref().map(split_full_name).unwrap_or_default();
            Ok(WebhookEvent::IssueComment(CommentEvent {
                repo_full_name: full,
                owner,
                repo,
                issue_number: p.issue.id,
                action: "created".into(),
                comment_id: p.comment.id.to_string(),
                body: p.comment.content.raw,
                author: p.comment.user.map(|u| u.display_name).unwrap_or_default(),
            }))
        }
        other => Ok(WebhookEvent::Other {
            event: other.to_owned(),
        }),
    }
}

/// Parse a delivery for `kind`.
///
/// # Errors
/// See the per-provider parsers.
pub fn parse(kind: ProviderKind, headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
    match kind {
        ProviderKind::GitHub => parse_github(headers, body),
        ProviderKind::GitLab => parse_gitlab(headers, body),
        ProviderKind::Bitbucket => parse_bitbucket(headers, body),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sign(body: &[u8], secret: &str) -> String {
        format!(
            "sha256={}",
            hex::encode(hmac_sha256(secret.as_bytes(), body))
        )
    }

    #[test]
    fn github_signature_accept_and_reject() {
        let body = br#"{"zen":"Keep it logically awesome."}"#;
        let sig = sign(body, "s3cret");
        assert!(verify_hmac_sha256_header(body, &sig, "s3cret"));
        assert!(!verify_hmac_sha256_header(body, &sig, "other"));
        assert!(!verify_hmac_sha256_header(b"tampered", &sig, "s3cret"));
        assert!(!verify_hmac_sha256_header(body, "sha1=abcd", "s3cret"));
        assert!(!verify_hmac_sha256_header(body, "", "s3cret"));
        assert!(!verify_hmac_sha256_header(body, &sig, ""));
        // Truncated / wrong-length signature must not panic or verify.
        assert!(!verify_hmac_sha256_header(body, "sha256=abcd", "s3cret"));
        // Uppercase hex is accepted.
        let up = format!("sha256={}", sig[7..].to_ascii_uppercase());
        assert!(verify_hmac_sha256_header(body, &up, "s3cret"));
    }

    #[test]
    fn known_github_docs_vector() {
        // From GitHub's "Validating webhook deliveries" docs.
        let sig = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
        assert!(verify_hmac_sha256_header(
            b"Hello, World!",
            sig,
            "It's a Secret to Everybody"
        ));
    }

    #[test]
    fn verify_dispatch_per_provider() {
        let body = b"{}";
        let gh = Headers::from_pairs([("X-Hub-Signature-256", sign(body, "k"))]);
        assert!(verify(ProviderKind::GitHub, &gh, body, "k"));
        assert!(!verify(ProviderKind::GitHub, &Headers::new(), body, "k"));
        let gl = Headers::from_pairs([("X-Gitlab-Token", "tok")]);
        assert!(verify(ProviderKind::GitLab, &gl, body, "tok"));
        assert!(!verify(ProviderKind::GitLab, &gl, body, "tok2"));
        assert!(!verify(ProviderKind::GitLab, &gl, body, ""));
        let bb = Headers::from_pairs([("X-Hub-Signature", sign(body, "k"))]);
        assert!(verify(ProviderKind::Bitbucket, &bb, body, "k"));
        assert!(!verify(ProviderKind::Bitbucket, &gh, body, "k"));
    }

    #[test]
    fn candidate_secret_lookup() {
        let body = br#"{"repository":{"full_name":"acme/app"}}"#;
        let h = Headers::from_pairs([("X-Hub-Signature-256", sign(body, "two"))]);
        let cands = vec!["one".to_owned(), "two".to_owned()];
        assert_eq!(
            find_verified_secret(ProviderKind::GitHub, &h, body, &cands),
            Some("two")
        );
        assert_eq!(
            find_verified_secret(ProviderKind::GitHub, &h, body, &cands[..1]),
            None
        );
        assert_eq!(
            peek_repo_full_name(ProviderKind::GitHub, body).as_deref(),
            Some("acme/app")
        );
        assert_eq!(
            peek_repo_full_name(
                ProviderKind::GitLab,
                br#"{"project":{"path_with_namespace":"g/p"}}"#
            )
            .as_deref(),
            Some("g/p")
        );
        assert_eq!(peek_repo_full_name(ProviderKind::GitHub, b"nope"), None);
    }

    const GH_PUSH: &str = r#"{
      "ref": "refs/heads/main",
      "repository": {"full_name": "acme/app", "name": "app", "owner": {"login": "acme"}},
      "commits": [
        {"id":"a1","message":"one","timestamp":"2024-01-01T00:00:00Z",
         "author":{"name":"Ann","email":"ann@x.io"},
         "added":["a.ts"],"removed":[],"modified":["b.ts"]},
        {"id":"b2","message":"two","timestamp":"2024-01-02T00:00:00Z",
         "author":{"name":"Bob","email":"bob@x.io"},
         "added":[],"removed":["c.ts"],"modified":["b.ts","a.ts"]}
      ]
    }"#;

    #[test]
    fn github_push_dedupes_changed_files_in_order() {
        let h = Headers::from_pairs([("X-GitHub-Event", "push")]);
        let WebhookEvent::Push(p) = parse_github(&h, GH_PUSH.as_bytes()).unwrap() else {
            panic!("expected push");
        };
        assert_eq!(p.git_ref, "refs/heads/main");
        assert_eq!(p.commits.len(), 2);
        assert_eq!(p.commits[1].author_name, "Bob");
        assert_eq!(p.changed_files, vec!["a.ts", "b.ts", "c.ts"]);
        assert_eq!(p.repo_full_name.as_deref(), Some("acme/app"));
    }

    #[test]
    fn github_push_empty_defaults() {
        let h = Headers::from_pairs([("X-GitHub-Event", "push")]);
        let WebhookEvent::Push(p) = parse_github(&h, b"{}").unwrap() else {
            panic!()
        };
        assert_eq!(p.git_ref, "");
        assert!(p.commits.is_empty() && p.changed_files.is_empty());
    }

    #[test]
    fn github_issue_status_mapping() {
        let h = Headers::from_pairs([("X-GitHub-Event", "issues")]);
        let mk = |action: &str, state: &str| {
            format!(
                r#"{{"action":"{action}","issue":{{"number":7,"title":"t","state":"{state}"}}}}"#
            )
        };
        for (action, state, want) in [
            ("closed", "closed", IssueStatus::Closed),
            ("reopened", "open", IssueStatus::Open),
            ("opened", "open", IssueStatus::Open),
            ("labeled", "closed", IssueStatus::Closed),
            ("assigned", "open", IssueStatus::Open),
        ] {
            let WebhookEvent::Issue(i) = parse_github(&h, mk(action, state).as_bytes()).unwrap()
            else {
                panic!()
            };
            assert_eq!(i.status, want, "{action}/{state}");
            assert_eq!(i.number, 7);
        }
        assert!(parse_github(&h, br#"{"action":"closed"}"#).is_err());
    }

    #[test]
    fn github_comment_and_ping_and_other() {
        let h = Headers::from_pairs([("X-GitHub-Event", "issue_comment")]);
        let body = br#"{"action":"created","comment":{"id":99,"body":"hi","user":{"login":"ann"}},
            "issue":{"number":3},"repository":{"full_name":"acme/app","name":"app","owner":{"login":"acme"}}}"#;
        let WebhookEvent::IssueComment(c) = parse_github(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!(
            (c.owner.as_str(), c.repo.as_str(), c.issue_number),
            ("acme", "app", 3)
        );
        assert_eq!(c.comment_id, "99");
        assert!(parse_github(&h, br#"{"action":"created"}"#).is_err());
        let ping = Headers::from_pairs([("X-GitHub-Event", "ping")]);
        assert_eq!(parse_github(&ping, b"{}").unwrap(), WebhookEvent::Ping);
        let star = Headers::from_pairs([("X-GitHub-Event", "star")]);
        assert_eq!(
            parse_github(&star, b"{}").unwrap(),
            WebhookEvent::Other {
                event: "star".into()
            }
        );
        assert!(parse_github(&Headers::new(), b"{}").is_err());
        assert!(parse_github(&ping, b"not json").is_ok()); // ping ignores body
        let push = Headers::from_pairs([("X-GitHub-Event", "push")]);
        assert!(matches!(
            parse_github(&push, b"not json"),
            Err(GitError::Webhook(_))
        ));
    }

    #[test]
    fn gitlab_push_issue_note() {
        let h = Headers::from_pairs([("X-Gitlab-Event", "Push Hook")]);
        let body = br#"{"ref":"refs/heads/dev","project":{"path_with_namespace":"grp/proj"},
          "commits":[{"id":"c1","message":"m","timestamp":"2024-02-01T10:00:00+00:00",
          "author":{"name":"Z","email":"z@x"},"added":["x"],"modified":["y"],"removed":[]}]}"#;
        let WebhookEvent::Push(p) = parse_gitlab(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!(p.repo_full_name.as_deref(), Some("grp/proj"));
        assert_eq!(p.changed_files, vec!["x", "y"]);

        let h = Headers::from_pairs([("X-Gitlab-Event", "Issue Hook")]);
        let body =
            br#"{"object_attributes":{"iid":12,"title":"T","state":"closed","action":"close"},
          "project":{"path_with_namespace":"grp/proj"}}"#;
        let WebhookEvent::Issue(i) = parse_gitlab(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!(
            (i.number, i.status, i.action.as_str()),
            (12, IssueStatus::Closed, "closed")
        );
        let body =
            br#"{"object_attributes":{"iid":12,"title":"T","state":"opened","action":"reopen"}}"#;
        let WebhookEvent::Issue(i) = parse_gitlab(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!(i.status, IssueStatus::Open);

        let h = Headers::from_pairs([("X-Gitlab-Event", "Note Hook")]);
        let body = br#"{"object_attributes":{"id":5,"note":"hello","noteable_type":"Issue"},
          "issue":{"iid":4},"project":{"path_with_namespace":"grp/sub/proj"},"user":{"username":"zed"}}"#;
        let WebhookEvent::IssueComment(c) = parse_gitlab(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!((c.owner.as_str(), c.repo.as_str()), ("grp/sub", "proj"));
        assert_eq!((c.issue_number, c.author.as_str()), (4, "zed"));
        let mr = br#"{"object_attributes":{"id":5,"note":"x","noteable_type":"MergeRequest"}}"#;
        assert!(matches!(
            parse_gitlab(&h, mr).unwrap(),
            WebhookEvent::Other { .. }
        ));
    }

    #[test]
    fn bitbucket_push_and_issue() {
        let h = Headers::from_pairs([("X-Event-Key", "repo:push")]);
        let body = br#"{"repository":{"full_name":"ws/repo"},"push":{"changes":[
          {"new":{"type":"branch","name":"main"},"old":null,"commits":[
            {"hash":"h1","message":"msg","date":"2024-03-01T00:00:00+00:00",
             "author":{"raw":"Ann Lee <ann@x.io>"}}]}]}}"#;
        let WebhookEvent::Push(p) = parse_bitbucket(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!(p.git_ref, "refs/heads/main");
        assert_eq!(p.commits[0].author_name, "Ann Lee");
        assert_eq!(p.commits[0].author_email, "ann@x.io");
        assert!(p.changed_files.is_empty());

        let del =
            br#"{"push":{"changes":[{"new":null,"old":{"type":"tag","name":"v1"},"commits":[]}]}}"#;
        let WebhookEvent::Push(p) = parse_bitbucket(&h, del).unwrap() else {
            panic!()
        };
        assert_eq!(p.git_ref, "refs/tags/v1");

        let h = Headers::from_pairs([("X-Event-Key", "issue:updated")]);
        let body = br#"{"issue":{"id":8,"title":"T","state":"resolved"},"repository":{"full_name":"ws/repo"}}"#;
        let WebhookEvent::Issue(i) = parse_bitbucket(&h, body).unwrap() else {
            panic!()
        };
        assert_eq!((i.number, i.status), (8, IssueStatus::Closed));

        let h = Headers::from_pairs([("X-Event-Key", "pullrequest:created")]);
        assert!(matches!(
            parse_bitbucket(&h, b"{}").unwrap(),
            WebhookEvent::Other { .. }
        ));
    }

    #[test]
    fn raw_author_split() {
        assert_eq!(
            split_raw_author("A B <a@b.c>"),
            ("A B".into(), "a@b.c".into())
        );
        assert_eq!(split_raw_author("solo"), ("solo".into(), String::new()));
    }
}
