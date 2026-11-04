//! The [`TicketTracker`] seam: create / look up / read the status of an issue in an external
//! tracker (GitHub, GitLab, Bitbucket, Jira, Linear).
//!
//! Git hosts go through the shared [`GitProvider`] ([`GitProviderTracker`]); Jira and Linear are
//! request builders + response parsers over an [`HttpTransport`] (see [`super::jira`] and
//! [`super::linear`]). Nothing here touches the network on its own.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::git_provider::{
    GitError, GitIssue, GitProvider, HttpResponse, IssueStateFilter, ProviderKind,
};
use crate::model::{TicketProvider, TicketStatus};

/// Which external system.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackerKind {
    /// GitHub Issues.
    Github,
    /// GitLab issues.
    Gitlab,
    /// Bitbucket issues.
    Bitbucket,
    /// Jira Cloud (REST v3).
    Jira,
    /// Linear (GraphQL).
    Linear,
}

impl TrackerKind {
    /// Lowercase slug.
    #[must_use]
    pub fn slug(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Bitbucket => "bitbucket",
            Self::Jira => "jira",
            Self::Linear => "linear",
        }
    }

    /// Parse a slug.
    ///
    /// # Errors
    /// [`TrackerError::Invalid`] for unknown slugs.
    pub fn from_slug(s: &str) -> Result<Self, TrackerError> {
        match s {
            "github" => Ok(Self::Github),
            "gitlab" => Ok(Self::Gitlab),
            "bitbucket" => Ok(Self::Bitbucket),
            "jira" => Ok(Self::Jira),
            "linear" => Ok(Self::Linear),
            other => Err(TrackerError::Invalid(format!(
                "unknown ticket destination provider {other:?}"
            ))),
        }
    }

    /// The `tickets.provider` value for this tracker (every tracker has one since migration 180
    /// added `linear` to the CHECK constraint).
    #[must_use]
    pub fn ticket_provider(self) -> TicketProvider {
        match self {
            Self::Github => TicketProvider::Github,
            Self::Gitlab => TicketProvider::Gitlab,
            Self::Bitbucket => TicketProvider::Bitbucket,
            Self::Jira => TicketProvider::Jira,
            Self::Linear => TicketProvider::Linear,
        }
    }

    fn from_git(k: ProviderKind) -> Self {
        match k {
            ProviderKind::GitHub => Self::Github,
            ProviderKind::GitLab => Self::Gitlab,
            ProviderKind::Bitbucket => Self::Bitbucket,
        }
    }
}

/// Where a ticket is posted. The TS `TicketDestination { provider, identifier }` with the
/// identifier parsed into its parts (`owner/repo`, Jira project key, Linear team id).
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "provider", rename_all = "lowercase")]
pub enum Destination {
    /// GitHub repository.
    Github {
        /// Owner / organisation.
        owner: String,
        /// Repository name.
        repo: String,
    },
    /// GitLab project (`owner` may be a nested group path).
    Gitlab {
        /// Namespace.
        owner: String,
        /// Project name.
        repo: String,
    },
    /// Bitbucket repository.
    Bitbucket {
        /// Workspace.
        owner: String,
        /// Repository slug.
        repo: String,
    },
    /// Jira project.
    Jira {
        /// Project key (`PROJ`).
        project_key: String,
    },
    /// Linear team.
    Linear {
        /// Team id (uuid) the issue is created in.
        team_id: String,
    },
}

impl Destination {
    /// Build from the TS wire shape `{ provider, identifier }`.
    ///
    /// Git hosts want `owner/repo` (split on the last `/`, so GitLab subgroups work); Jira wants a
    /// project key; Linear a team id.
    ///
    /// # Errors
    /// [`TrackerError::Invalid`] for an unknown provider or an empty / malformed identifier
    /// ("No repository configured" / "No Jira project key configured" in the TS service).
    pub fn from_identifier(provider: &str, identifier: &str) -> Result<Self, TrackerError> {
        let kind = TrackerKind::from_slug(provider)?;
        let id = identifier.trim();
        match kind {
            TrackerKind::Jira => {
                if id.is_empty() {
                    return Err(TrackerError::Invalid(
                        "No Jira project key configured".into(),
                    ));
                }
                Ok(Self::Jira {
                    project_key: id.to_owned(),
                })
            }
            TrackerKind::Linear => {
                if id.is_empty() {
                    return Err(TrackerError::Invalid("No Linear team configured".into()));
                }
                Ok(Self::Linear {
                    team_id: id.to_owned(),
                })
            }
            git => {
                let (owner, repo) = id
                    .rsplit_once('/')
                    .filter(|(o, r)| !o.is_empty() && !r.is_empty())
                    .ok_or_else(|| {
                        TrackerError::Invalid("No repository configured for this team".into())
                    })?;
                let (owner, repo) = (owner.to_owned(), repo.to_owned());
                Ok(match git {
                    TrackerKind::Github => Self::Github { owner, repo },
                    TrackerKind::Gitlab => Self::Gitlab { owner, repo },
                    _ => Self::Bitbucket { owner, repo },
                })
            }
        }
    }

    /// Tracker.
    #[must_use]
    pub fn kind(&self) -> TrackerKind {
        match self {
            Self::Github { .. } => TrackerKind::Github,
            Self::Gitlab { .. } => TrackerKind::Gitlab,
            Self::Bitbucket { .. } => TrackerKind::Bitbucket,
            Self::Jira { .. } => TrackerKind::Jira,
            Self::Linear { .. } => TrackerKind::Linear,
        }
    }

    /// Stable string identifying the target (`github:owner/repo`, `jira:PROJ`), lowercased for
    /// repo hosts. Used for dedupe scoping and display.
    #[must_use]
    pub fn key(&self) -> String {
        match self {
            Self::Github { owner, repo }
            | Self::Gitlab { owner, repo }
            | Self::Bitbucket { owner, repo } => {
                format!("{}:{}/{}", self.kind().slug(), owner, repo).to_lowercase()
            }
            Self::Jira { project_key } => format!("jira:{project_key}"),
            Self::Linear { team_id } => format!("linear:{team_id}"),
        }
    }
}

/// An issue to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewIssue {
    /// Title / summary.
    pub title: String,
    /// Markdown body.
    pub body: String,
    /// Labels (best effort; Linear needs label ids, so labels are folded into the body there).
    pub labels: Vec<String>,
}

/// An issue as created / found remotely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteIssue {
    /// Tracker.
    pub kind: TrackerKind,
    /// Provider-side id (`123`, `PROJ-7`, `ENG-42`).
    pub external_id: String,
    /// Browser URL.
    pub external_url: String,
    /// Title as the tracker reports it (empty when the tracker did not echo it).
    pub title: String,
}

/// Failure talking to a tracker.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TrackerError {
    /// Missing / expired / forbidden credentials (401, 403).
    #[error("authentication failed: {0}")]
    Auth(String),
    /// 429 or exhausted quota.
    #[error("rate limited by the tracker")]
    RateLimited {
        /// Seconds to wait, if the tracker said.
        retry_after_secs: Option<u64>,
    },
    /// Bad caller input (destination, missing project key, wrong tracker).
    #[error("{0}")]
    Invalid(String),
    /// Other non-success status.
    #[error("tracker rejected the request ({status}): {body}")]
    Rejected {
        /// HTTP status.
        status: u16,
        /// Truncated body.
        body: String,
    },
    /// Connection-level failure. The request may or may not have reached the tracker.
    #[error("transport error: {0}")]
    Transport(String),
    /// A 2xx whose body did not have the expected shape.
    #[error("unexpected response: {0}")]
    Parse(String),
}

impl TrackerError {
    /// Whether retrying the same request later can succeed.
    #[must_use]
    pub fn retryable(&self) -> bool {
        match self {
            Self::RateLimited { .. } | Self::Transport(_) => true,
            Self::Rejected { status, .. } => *status >= 500,
            Self::Auth(_) | Self::Invalid(_) | Self::Parse(_) => false,
        }
    }

    /// Whether the remote side may have created the issue even though we saw an error
    /// (lost response / unparseable 2xx / 5xx). A retry must look for the issue first.
    #[must_use]
    pub fn outcome_unknown(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::Parse(_))
            || matches!(self, Self::Rejected { status, .. } if *status >= 500)
    }
}

impl From<GitError> for TrackerError {
    fn from(e: GitError) -> Self {
        match e {
            GitError::Unauthorized(_)
            | GitError::MissingCredential(_)
            | GitError::Forbidden { .. } => Self::Auth(e.to_string()),
            GitError::RateLimited {
                retry_after_secs, ..
            } => Self::RateLimited { retry_after_secs },
            GitError::NotFound(m) => Self::Rejected {
                status: 404,
                body: m,
            },
            GitError::Api { status, body, .. } => Self::Rejected { status, body },
            GitError::Transport(m) => Self::Transport(m),
            GitError::Parse(m) => Self::Parse(m),
            other => Self::Invalid(other.to_string()),
        }
    }
}

impl From<TrackerError> for crate::Error {
    fn from(e: TrackerError) -> Self {
        Self::Invalid(e.to_string())
    }
}

/// Map a raw HTTP response to `Ok(response)` for 2xx, else a [`TrackerError`].
///
/// # Errors
/// 401/403 -> [`TrackerError::Auth`], 429 -> [`TrackerError::RateLimited`] (honours
/// `Retry-After`), everything else -> [`TrackerError::Rejected`].
pub fn check_response(resp: HttpResponse) -> Result<HttpResponse, TrackerError> {
    if resp.is_success() {
        return Ok(resp);
    }
    let body: String = resp.text().chars().take(200).collect();
    Err(match resp.status {
        401 | 403 => TrackerError::Auth(format!("HTTP {}: {body}", resp.status)),
        429 => TrackerError::RateLimited {
            retry_after_secs: resp
                .headers
                .get("retry-after")
                .and_then(|v| v.trim().parse().ok()),
        },
        status => TrackerError::Rejected { status, body },
    })
}

/// Create / find / read issues in one external tracker.
pub trait TicketTracker: Send + Sync + fmt::Debug {
    /// Which tracker this adapter talks to.
    fn kind(&self) -> TrackerKind;

    /// Create an issue.
    ///
    /// # Errors
    /// [`TrackerError`]; [`TrackerError::Invalid`] if `dest` is not for this tracker.
    fn create_issue(
        &self,
        dest: &Destination,
        issue: &NewIssue,
    ) -> Result<RemoteIssue, TrackerError>;

    /// Look for an already-existing issue with this title in the destination (any state). Used on
    /// retry after an ambiguous failure so a lost response does not create a duplicate.
    /// The default is "cannot tell".
    ///
    /// # Errors
    /// [`TrackerError`].
    fn find_by_title(
        &self,
        dest: &Destination,
        title: &str,
    ) -> Result<Option<RemoteIssue>, TrackerError> {
        let _ = (dest, title);
        Ok(None)
    }

    /// Current status of an issue, mapped to Nyx's three states.
    ///
    /// # Errors
    /// [`TrackerError`].
    fn fetch_status(
        &self,
        dest: &Destination,
        external_id: &str,
    ) -> Result<TicketStatus, TrackerError>;
}

/// Case/space-insensitive title comparison key.
#[must_use]
pub fn title_key(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Map a git host's issue state string to a Nyx status. Port of the TS GitHub rule
/// (`closed` -> closed, anything else open) widened for GitLab / Bitbucket terminal states.
#[must_use]
pub fn git_state_to_status(state: &str) -> TicketStatus {
    match state.to_ascii_lowercase().as_str() {
        "closed" | "resolved" | "invalid" | "wontfix" | "duplicate" => TicketStatus::Closed,
        _ => TicketStatus::Open,
    }
}

/// [`TicketTracker`] over a [`GitProvider`] (GitHub, GitLab, Bitbucket).
#[derive(Debug, Clone)]
pub struct GitProviderTracker {
    provider: Arc<dyn GitProvider>,
}

impl GitProviderTracker {
    /// Wrap a provider.
    #[must_use]
    pub fn new(provider: Arc<dyn GitProvider>) -> Self {
        Self { provider }
    }

    fn target<'d>(&self, dest: &'d Destination) -> Result<(&'d str, &'d str), TrackerError> {
        let kind = self.kind();
        match dest {
            Destination::Github { owner, repo }
            | Destination::Gitlab { owner, repo }
            | Destination::Bitbucket { owner, repo }
                if dest.kind() == kind =>
            {
                Ok((owner, repo))
            }
            other => Err(TrackerError::Invalid(format!(
                "{} tracker cannot post to {}",
                kind.slug(),
                other.key()
            ))),
        }
    }

    /// TS: github `String(issue.number)`, gitlab `String(issue.iid ?? issue.id)`, bitbucket
    /// `String(issue.id)`.
    fn external_id(&self, issue: &GitIssue) -> String {
        let n = match self.kind() {
            TrackerKind::Gitlab => issue.iid.or(issue.number),
            _ => issue.number.or(issue.iid),
        };
        n.map_or_else(|| issue.id.clone(), |n| n.to_string())
    }

    fn remote(&self, issue: &GitIssue) -> RemoteIssue {
        RemoteIssue {
            kind: self.kind(),
            external_id: self.external_id(issue),
            external_url: issue.html_url.clone(),
            title: issue.title.clone(),
        }
    }
}

impl TicketTracker for GitProviderTracker {
    fn kind(&self) -> TrackerKind {
        TrackerKind::from_git(self.provider.kind())
    }

    fn create_issue(
        &self,
        dest: &Destination,
        issue: &NewIssue,
    ) -> Result<RemoteIssue, TrackerError> {
        let (owner, repo) = self.target(dest)?;
        let created =
            self.provider
                .create_issue(owner, repo, &issue.title, &issue.body, &issue.labels)?;
        Ok(self.remote(&created))
    }

    fn find_by_title(
        &self,
        dest: &Destination,
        title: &str,
    ) -> Result<Option<RemoteIssue>, TrackerError> {
        let (owner, repo) = self.target(dest)?;
        let want = title_key(title);
        Ok(self
            .provider
            .list_issues(owner, repo, IssueStateFilter::All)?
            .iter()
            .find(|i| title_key(&i.title) == want)
            .map(|i| self.remote(i)))
    }

    fn fetch_status(
        &self,
        dest: &Destination,
        external_id: &str,
    ) -> Result<TicketStatus, TrackerError> {
        let (owner, repo) = self.target(dest)?;
        let issues = self
            .provider
            .list_issues(owner, repo, IssueStateFilter::All)?;
        issues
            .iter()
            .find(|i| self.external_id(i) == external_id)
            .map(|i| git_state_to_status(&i.state))
            .ok_or_else(|| TrackerError::Rejected {
                status: 404,
                body: format!("issue {external_id} not found in {}", dest.key()),
            })
    }
}

/// Trackers available to the posting pipeline, one per [`TrackerKind`].
#[derive(Debug, Default, Clone)]
pub struct TrackerSet {
    by_kind: HashMap<TrackerKind, Arc<dyn TicketTracker>>,
}

impl TrackerSet {
    /// Empty set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a tracker (replaces one of the same kind).
    #[must_use]
    pub fn with(mut self, tracker: Arc<dyn TicketTracker>) -> Self {
        self.by_kind.insert(tracker.kind(), tracker);
        self
    }

    /// Tracker for a destination.
    ///
    /// # Errors
    /// [`TrackerError::Invalid`] when none is configured ("No github integration configured").
    pub fn for_destination(&self, dest: &Destination) -> Result<&dyn TicketTracker, TrackerError> {
        self.by_kind
            .get(&dest.kind())
            .map(AsRef::as_ref)
            .ok_or_else(|| {
                TrackerError::Invalid(format!("No {} integration configured", dest.kind().slug()))
            })
    }
}

/// Test double: records created issues, can be told to fail, and can simulate a lost response
/// (issue created remotely but the call reports a transport error).
#[derive(Debug, Default)]
pub struct FakeTracker {
    inner: std::sync::Mutex<FakeState>,
    kind_override: Option<TrackerKind>,
}

#[derive(Debug, Default)]
struct FakeState {
    created: Vec<(Destination, NewIssue, RemoteIssue)>,
    failures: std::collections::VecDeque<FakeFailure>,
    statuses: HashMap<String, TicketStatus>,
    calls: usize,
}

/// A scripted failure for [`FakeTracker`].
#[derive(Debug, Clone)]
pub enum FakeFailure {
    /// Fail before creating anything.
    Before(TrackerError),
    /// Create the issue, then report this error (lost response).
    After(TrackerError),
}

impl FakeTracker {
    /// Fake for `kind`.
    #[must_use]
    pub fn new(kind: TrackerKind) -> Self {
        Self {
            inner: std::sync::Mutex::default(),
            kind_override: Some(kind),
        }
    }

    /// Queue a failure for the next `create_issue` call.
    pub fn fail_next(&self, f: FakeFailure) {
        self.state().failures.push_back(f);
    }

    /// Set the status `fetch_status` reports for an id.
    pub fn set_status(&self, external_id: &str, status: TicketStatus) {
        self.state().statuses.insert(external_id.to_owned(), status);
    }

    /// Issues created so far.
    #[must_use]
    pub fn created(&self) -> Vec<(Destination, NewIssue, RemoteIssue)> {
        self.state().created.clone()
    }

    /// Number of `create_issue` calls (including failed ones).
    #[must_use]
    pub fn create_calls(&self) -> usize {
        self.state().calls
    }

    fn state(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

impl TicketTracker for FakeTracker {
    fn kind(&self) -> TrackerKind {
        self.kind_override.unwrap_or(TrackerKind::Github)
    }

    fn create_issue(
        &self,
        dest: &Destination,
        issue: &NewIssue,
    ) -> Result<RemoteIssue, TrackerError> {
        let kind = self.kind();
        let mut s = self.state();
        s.calls += 1;
        let failure = s.failures.pop_front();
        if let Some(FakeFailure::Before(e)) = failure {
            return Err(e);
        }
        let n = s.created.len() + 1;
        let remote = RemoteIssue {
            kind,
            external_id: match kind {
                TrackerKind::Jira => format!("PROJ-{n}"),
                TrackerKind::Linear => format!("ENG-{n}"),
                _ => n.to_string(),
            },
            external_url: format!("https://tracker.test/{}/{n}", dest.key()),
            title: issue.title.clone(),
        };
        s.created
            .push((dest.clone(), issue.clone(), remote.clone()));
        match failure {
            Some(FakeFailure::After(e)) => Err(e),
            _ => Ok(remote),
        }
    }

    fn find_by_title(
        &self,
        dest: &Destination,
        title: &str,
    ) -> Result<Option<RemoteIssue>, TrackerError> {
        let want = title_key(title);
        Ok(self
            .state()
            .created
            .iter()
            .find(|(d, i, _)| d == dest && title_key(&i.title) == want)
            .map(|(_, _, r)| r.clone()))
    }

    fn fetch_status(
        &self,
        _dest: &Destination,
        external_id: &str,
    ) -> Result<TicketStatus, TrackerError> {
        Ok(self
            .state()
            .statuses
            .get(external_id)
            .copied()
            .unwrap_or(TicketStatus::Open))
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::git_provider::Headers;

    #[test]
    fn destination_parses_identifiers_like_the_ts_service() {
        assert_eq!(
            Destination::from_identifier("github", "acme/web").unwrap(),
            Destination::Github {
                owner: "acme".into(),
                repo: "web".into()
            }
        );
        // GitLab subgroups keep the full namespace.
        assert_eq!(
            Destination::from_identifier("gitlab", "grp/sub/proj").unwrap(),
            Destination::Gitlab {
                owner: "grp/sub".into(),
                repo: "proj".into()
            }
        );
        assert!(Destination::from_identifier("github", "").is_err());
        assert!(Destination::from_identifier("github", "justone").is_err());
        assert!(Destination::from_identifier("github", "/repo").is_err());
        assert!(Destination::from_identifier("jira", "  ").is_err());
        assert!(Destination::from_identifier("trello", "x").is_err());
        assert_eq!(
            Destination::from_identifier("jira", "PROJ").unwrap().key(),
            "jira:PROJ"
        );
        assert_eq!(
            Destination::from_identifier("github", "Acme/Web")
                .unwrap()
                .key(),
            "github:acme/web"
        );
    }

    #[test]
    fn destination_serde_roundtrip() {
        let d = Destination::Jira {
            project_key: "PROJ".into(),
        };
        let j = serde_json::to_string(&d).unwrap();
        assert_eq!(j, r#"{"provider":"jira","project_key":"PROJ"}"#);
        assert_eq!(serde_json::from_str::<Destination>(&j).unwrap(), d);
    }

    #[test]
    fn check_response_classifies_statuses() {
        let r = |s: u16, h: &[(&str, &str)]| {
            check_response(HttpResponse::new(
                s,
                Headers::from_pairs(h.iter().copied()),
                "boom",
            ))
        };
        assert!(r(201, &[]).is_ok());
        assert!(matches!(r(401, &[]), Err(TrackerError::Auth(_))));
        assert!(matches!(r(403, &[]), Err(TrackerError::Auth(_))));
        assert_eq!(
            r(429, &[("Retry-After", "30")]).unwrap_err(),
            TrackerError::RateLimited {
                retry_after_secs: Some(30)
            }
        );
        let e = r(502, &[]).unwrap_err();
        assert!(e.retryable() && e.outcome_unknown());
        let e = r(422, &[]).unwrap_err();
        assert!(!e.retryable() && !e.outcome_unknown());
    }

    #[test]
    fn git_state_mapping() {
        assert_eq!(git_state_to_status("closed"), TicketStatus::Closed);
        assert_eq!(git_state_to_status("CLOSED"), TicketStatus::Closed);
        assert_eq!(git_state_to_status("open"), TicketStatus::Open);
        assert_eq!(git_state_to_status("opened"), TicketStatus::Open);
        assert_eq!(git_state_to_status("wontfix"), TicketStatus::Closed);
    }

    #[test]
    fn tracker_set_reports_missing_integration() {
        let set = TrackerSet::new();
        let dest = Destination::Linear {
            team_id: "t".into(),
        };
        let e = set.for_destination(&dest).map(|_| ()).unwrap_err();
        assert_eq!(e.to_string(), "No linear integration configured");
    }

    #[test]
    fn git_provider_tracker_posts_finds_and_reads_status_through_real_github_provider() {
        use crate::git_provider::{FakeTransport, GitHubProvider};
        use crate::profile::{MemorySecretStore, Provider, SecretKey, SecretStore};
        use secrecy::SecretString;

        let t = Arc::new(FakeTransport::new());
        let store = Arc::new(MemorySecretStore::default());
        store
            .set(
                &SecretKey::access_token(Provider::GitHub),
                SecretString::from("ghp_test".to_owned()),
            )
            .unwrap();
        let tracker = GitProviderTracker::new(Arc::new(GitHubProvider::new(t.clone(), store)));
        assert_eq!(tracker.kind(), TrackerKind::Github);
        let dest = Destination::Github {
            owner: "acme".into(),
            repo: "web".into(),
        };

        t.push_json(
            201,
            &[],
            r#"{"id":11,"number":5,"title":"Bug","html_url":"https://github.com/acme/web/issues/5","state":"open"}"#,
        );
        let issue = NewIssue {
            title: "Bug".into(),
            body: "b".into(),
            labels: vec!["x".into()],
        };
        let r = tracker.create_issue(&dest, &issue).unwrap();
        assert_eq!(r.external_id, "5");
        assert_eq!(r.external_url, "https://github.com/acme/web/issues/5");
        let req = &t.requests()[0];
        assert!(req.url.ends_with("/repos/acme/web/issues"));
        assert!(req.body_text().unwrap().contains(r#""labels":["x"]"#));

        // find_by_title / fetch_status read the issue list (any state).
        let list = r#"[{"id":1,"number":4,"title":"other","html_url":"u4","state":"open"},
                       {"id":2,"number":5,"title":"  bug ","html_url":"u5","state":"closed"}]"#;
        t.push_json(200, &[], list);
        assert_eq!(
            tracker
                .find_by_title(&dest, "Bug")
                .unwrap()
                .unwrap()
                .external_id,
            "5"
        );
        t.push_json(200, &[], list);
        assert_eq!(
            tracker.fetch_status(&dest, "5").unwrap(),
            TicketStatus::Closed
        );
        t.push_json(200, &[], list);
        assert!(matches!(
            tracker.fetch_status(&dest, "99"),
            Err(TrackerError::Rejected { status: 404, .. })
        ));

        // Provider errors map onto tracker errors.
        t.push_json(401, &[], "");
        assert!(matches!(
            tracker.create_issue(&dest, &issue),
            Err(TrackerError::Auth(_))
        ));
        t.push_json(500, &[], "boom");
        assert!(tracker
            .create_issue(&dest, &issue)
            .unwrap_err()
            .outcome_unknown());
        // Wrong destination kind never reaches the transport.
        let n = t.requests().len();
        let jira = Destination::Jira {
            project_key: "P".into(),
        };
        assert!(matches!(
            tracker.create_issue(&jira, &issue),
            Err(TrackerError::Invalid(_))
        ));
        assert_eq!(t.requests().len(), n);
    }
}
