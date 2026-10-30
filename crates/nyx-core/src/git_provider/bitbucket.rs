//! Bitbucket Cloud (REST 2.0). Port of `bitbucket.service.ts`.
//!
//! Differences from the TS service (documented in `docs/rust-core/git-provider.md`):
//! the tree listing requests `max_depth` so it is recursive like the other
//! providers, list endpoints follow the body-level `next` URL, and webhooks are
//! registered with a `secret` so deliveries carry an `X-Hub-Signature` HMAC.

use std::sync::Arc;

use base64::Engine as _;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::json;

use super::client::{parse_oauth, Client};
use super::pagination::next_bitbucket;
use super::rate_limit::RateLimit;
use super::transport::{Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport};
use super::util::{count_patch_lines, encode_component, encode_path, query};
use super::webhook::{self, WebhookEvent};
use super::{
    BranchRef, ChangeKind, FileDiff, GitCommit, GitError, GitFileContent, GitIssue, GitProvider,
    GitRepo, GitResult, GitTreeEntry, GitUser, GitWebhook, IssueStateFilter, NewPullRequest,
    NewRepo, OAuthToken, ProviderKind, PullRequest, TreeEntryKind,
};
use crate::profile::SecretStore;

/// API root.
pub const API_BASE: &str = "https://api.bitbucket.org/2.0";
/// OAuth token endpoint.
pub const OAUTH_TOKEN_URL: &str = "https://bitbucket.org/site/oauth2/access_token";

// ── Raw response types ───────────────────────────────

#[derive(Debug, Deserialize)]
struct Page<T> {
    #[serde(default = "Vec::new")]
    values: Vec<T>,
}

#[derive(Debug, Deserialize)]
struct Href {
    href: String,
}

#[derive(Debug, Deserialize, Default)]
struct Links {
    #[serde(default)]
    html: Option<Href>,
    #[serde(default)]
    avatar: Option<Href>,
}

impl Links {
    fn html(&self) -> String {
        self.html
            .as_ref()
            .map(|h| h.href.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Deserialize)]
struct RawRepo {
    uuid: String,
    name: String,
    full_name: String,
    #[serde(default)]
    is_private: bool,
    #[serde(default)]
    links: Links,
    #[serde(default)]
    mainbranch: Option<RawName>,
}

#[derive(Debug, Deserialize)]
struct RawName {
    name: String,
}

impl From<RawRepo> for GitRepo {
    fn from(r: RawRepo) -> Self {
        Self {
            id: r.uuid,
            name: r.name,
            full_name: r.full_name,
            is_private: r.is_private,
            html_url: r.links.html(),
            default_branch: r.mainbranch.map_or_else(|| "main".into(), |b| b.name),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    id: u64,
    title: String,
    #[serde(default)]
    links: Links,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Deserialize)]
struct RawCommit {
    hash: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    date: String,
    #[serde(default)]
    author: RawAuthor,
    #[serde(default)]
    links: Links,
}

#[derive(Debug, Deserialize, Default)]
struct RawAuthor {
    #[serde(default)]
    raw: String,
    #[serde(default)]
    user: Option<RawDisplay>,
}

#[derive(Debug, Deserialize, Default)]
struct RawDisplay {
    #[serde(default)]
    display_name: String,
}

#[derive(Debug, Deserialize)]
struct RawBranch {
    name: String,
    target: RawTarget,
}

#[derive(Debug, Deserialize)]
struct RawTarget {
    hash: String,
}

#[derive(Debug, Deserialize)]
struct RawPr {
    id: u64,
    title: String,
    #[serde(default)]
    links: Links,
    #[serde(default)]
    state: String,
    source: RawPrSide,
    destination: RawPrSide,
}

#[derive(Debug, Deserialize)]
struct RawPrSide {
    branch: RawName,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
    uuid: String,
    #[serde(default)]
    display_name: String,
    #[serde(default)]
    links: Links,
}

#[derive(Debug, Deserialize)]
struct RawHook {
    uuid: String,
}

// ── Request builders ─────────────────────────────────

fn authed(method: HttpMethod, url: String, token: &str) -> HttpRequest {
    HttpRequest::new(method, url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
}

fn repo_url(base: &str, owner: &str, repo: &str) -> String {
    format!(
        "{base}/repositories/{}/{}",
        encode_component(owner),
        encode_component(repo)
    )
}

/// Repository slug the TS derived from a display name: lowercase, `[^a-z0-9_.-]` -> `-`.
#[must_use]
pub fn slugify(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.' | '-') {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// `GET /repositories?role=member&pagelen=100&sort=-updated_on`
#[must_use]
pub fn list_repos_request(base: &str, token: &str) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!("{base}/repositories?role=member&pagelen=100&sort=-updated_on"),
        token,
    )
}

/// `POST /repositories/{workspace}/{slug}`.
///
/// # Errors
/// [`GitError::Invalid`] when no workspace is given.
pub fn create_repo_request(base: &str, token: &str, new: &NewRepo) -> GitResult<HttpRequest> {
    let ws = new
        .workspace
        .as_deref()
        .filter(|w| !w.is_empty())
        .ok_or_else(|| GitError::Invalid("Bitbucket createRepo requires a workspace".into()))?;
    Ok(authed(
        HttpMethod::Post,
        format!(
            "{base}/repositories/{}/{}",
            encode_component(ws),
            encode_component(&slugify(&new.name))
        ),
        token,
    )
    .json(&json!({
        "scm": "git",
        "name": new.name,
        "description": new.description.clone().unwrap_or_default(),
        "is_private": new.is_private,
    })))
}

/// `GET /repositories/{o}/{r}/src/{ref}/?pagelen=100&max_depth=20`
#[must_use]
pub fn file_tree_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/src/{}/?pagelen=100&max_depth=20",
            repo_url(base, owner, repo),
            encode_component(git_ref.unwrap_or("HEAD"))
        ),
        token,
    )
}

/// `GET /repositories/{o}/{r}/src/{ref}/{path}` (raw file body).
#[must_use]
pub fn file_content_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    path: &str,
    git_ref: Option<&str>,
) -> HttpRequest {
    HttpRequest::new(
        HttpMethod::Get,
        format!(
            "{}/src/{}/{}",
            repo_url(base, owner, repo),
            encode_component(git_ref.unwrap_or("HEAD")),
            encode_path(path)
        ),
    )
    .header("Authorization", format!("Bearer {token}"))
}

/// `GET /repositories/{o}/{r}/commits[/{ref}]?pagelen=`
#[must_use]
pub fn list_commits_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
    per_page: usize,
) -> HttpRequest {
    let mut url = format!("{}/commits", repo_url(base, owner, repo));
    if let Some(r) = git_ref {
        url.push('/');
        url.push_str(&encode_component(r));
    }
    url.push_str("?pagelen=");
    url.push_str(&per_page.clamp(1, 100).to_string());
    authed(HttpMethod::Get, url, token)
}

/// `GET /repositories/{o}/{r}/diff/{sha}` (raw unified diff).
#[must_use]
pub fn commit_diff_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    sha: &str,
) -> HttpRequest {
    HttpRequest::new(
        HttpMethod::Get,
        format!(
            "{}/diff/{}",
            repo_url(base, owner, repo),
            encode_component(sha)
        ),
    )
    .header("Authorization", format!("Bearer {token}"))
}

/// `GET /repositories/{o}/{r}/refs/branches/{name}` — step 1 of branch creation.
#[must_use]
pub fn branch_lookup_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    branch: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/refs/branches/{}",
            repo_url(base, owner, repo),
            encode_path(branch)
        ),
        token,
    )
}

/// `POST /repositories/{o}/{r}/refs/branches` — step 2 of branch creation.
#[must_use]
pub fn create_branch_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    name: &str,
    hash: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!("{}/refs/branches", repo_url(base, owner, repo)),
        token,
    )
    .json(&json!({ "name": name, "target": { "hash": hash } }))
}

/// `POST /repositories/{o}/{r}/pullrequests`
#[must_use]
pub fn create_pr_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    pr: &NewPullRequest,
) -> HttpRequest {
    let mut payload = json!({
        "title": pr.title,
        "description": pr.body,
        "source": { "branch": { "name": pr.head } },
        "destination": { "branch": { "name": pr.base } },
    });
    if pr.draft {
        payload["draft"] = json!(true);
    }
    authed(
        HttpMethod::Post,
        format!("{}/pullrequests", repo_url(base, owner, repo)),
        token,
    )
    .json(&payload)
}

/// `POST /repositories/{o}/{r}/issues` (markdown body, `task`/`major`; labels unsupported).
#[must_use]
pub fn create_issue_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!("{}/issues", repo_url(base, owner, repo)),
        token,
    )
    .json(&json!({
        "title": title,
        "content": { "raw": body, "markup": "markdown" },
        "kind": "task",
        "priority": "major",
    }))
}

/// `GET /repositories/{o}/{r}/issues[?q=...]`
#[must_use]
pub fn list_issues_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    state: IssueStateFilter,
) -> HttpRequest {
    let q = match state {
        IssueStateFilter::Open => Some("state=\"new\" OR state=\"open\""),
        IssueStateFilter::Closed => Some("state=\"resolved\" OR state=\"closed\""),
        IssueStateFilter::All => None,
    };
    let mut url = format!("{}/issues?pagelen=100", repo_url(base, owner, repo));
    if let Some(q) = q {
        url.push('&');
        url.push_str(&query(&[("q", q)]));
    }
    authed(HttpMethod::Get, url, token)
}

/// `POST /repositories/{o}/{r}/hooks`; `secret` enables `X-Hub-Signature` deliveries.
#[must_use]
pub fn create_webhook_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    url: &str,
    secret: &str,
) -> HttpRequest {
    let mut payload = json!({
        "description": "Nyx push notifications",
        "url": url,
        "active": true,
        "events": ["repo:push", "issue:created", "issue:updated", "issue:comment_created"],
    });
    if !secret.is_empty() {
        payload["secret"] = json!(secret);
    }
    authed(
        HttpMethod::Post,
        format!("{}/hooks", repo_url(base, owner, repo)),
        token,
    )
    .json(&payload)
}

/// `DELETE /repositories/{o}/{r}/hooks/{uuid}` (braces in the uuid are percent-encoded).
#[must_use]
pub fn delete_webhook_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    hook_id: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Delete,
        format!(
            "{}/hooks/{}",
            repo_url(base, owner, repo),
            encode_component(hook_id)
        ),
        token,
    )
}

/// OAuth code exchange: HTTP Basic `client_id:client_secret`, form-encoded body.
#[must_use]
pub fn oauth_exchange_request(client_id: &str, client_secret: &str, code: &str) -> HttpRequest {
    let creds =
        base64::engine::general_purpose::STANDARD.encode(format!("{client_id}:{client_secret}"));
    let mut req = HttpRequest::new(HttpMethod::Post, OAUTH_TOKEN_URL)
        .header("Authorization", format!("Basic {creds}"))
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json");
    req.body = Some(query(&[("grant_type", "authorization_code"), ("code", code)]).into_bytes());
    req
}

/// `GET /user`
#[must_use]
pub fn user_request(base: &str, token: &str) -> HttpRequest {
    authed(HttpMethod::Get, format!("{base}/user"), token)
}

// ── Response parsers ─────────────────────────────────

/// Parse a repositories page.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_repos(resp: &HttpResponse) -> GitResult<Vec<GitRepo>> {
    Ok(resp
        .json::<Page<RawRepo>>()?
        .values
        .into_iter()
        .map(Into::into)
        .collect())
}

/// Parse one repository.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_repo(resp: &HttpResponse) -> GitResult<GitRepo> {
    Ok(resp.json::<RawRepo>()?.into())
}

/// Parse a `src` listing page: `commit_file` -> file, anything else -> directory.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_tree(resp: &HttpResponse) -> GitResult<Vec<GitTreeEntry>> {
    Ok(resp
        .json::<Page<RawEntry>>()?
        .values
        .into_iter()
        .map(|e| GitTreeEntry {
            kind: if e.kind == "commit_file" {
                TreeEntryKind::Blob
            } else {
                TreeEntryKind::Tree
            },
            path: e.path,
            size: e.size,
        })
        .collect())
}

/// Wrap a raw file body as base64 content (as the TS did).
#[must_use]
pub fn file_from_raw(
    resp: &HttpResponse,
    owner: &str,
    repo: &str,
    path: &str,
    git_ref: Option<&str>,
) -> GitFileContent {
    let revision = git_ref.unwrap_or("HEAD");
    GitFileContent {
        name: path.rsplit('/').next().unwrap_or(path).to_owned(),
        path: path.to_owned(),
        size: resp.body.len() as u64,
        content: base64::engine::general_purpose::STANDARD.encode(&resp.body),
        encoding: "base64".into(),
        html_url: format!("https://bitbucket.org/{owner}/{repo}/src/{revision}/{path}"),
    }
}

fn issue_from(i: RawIssue) -> GitIssue {
    GitIssue {
        id: i.id.to_string(),
        number: Some(i.id),
        iid: None,
        title: i.title,
        html_url: i.links.html(),
        state: i.state,
    }
}

/// Parse an issues page.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_issues(resp: &HttpResponse) -> GitResult<Vec<GitIssue>> {
    Ok(resp
        .json::<Page<RawIssue>>()?
        .values
        .into_iter()
        .map(issue_from)
        .collect())
}

/// Parse one issue.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_issue(resp: &HttpResponse) -> GitResult<GitIssue> {
    Ok(issue_from(resp.json()?))
}

/// Split `Name <email>`.
fn split_author(raw: &str) -> (String, Option<String>) {
    match (raw.rfind('<'), raw.rfind('>')) {
        (Some(l), Some(r)) if l < r => (
            raw[..l].trim().to_owned(),
            Some(raw[l + 1..r].trim().to_owned()),
        ),
        _ => (raw.trim().to_owned(), None),
    }
}

/// Parse a commits page.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_commits(resp: &HttpResponse) -> GitResult<Vec<GitCommit>> {
    Ok(resp
        .json::<Page<RawCommit>>()?
        .values
        .into_iter()
        .map(|c| {
            let (raw_name, email) = split_author(&c.author.raw);
            GitCommit {
                sha: c.hash,
                message: c.message,
                author_name: c.author.user.map_or(raw_name, |u| u.display_name),
                author_email: email.filter(|e| !e.is_empty()),
                timestamp: c.date,
                html_url: c.links.html.map(|h| h.href),
            }
        })
        .collect())
}

fn strip_ab(p: &str) -> &str {
    p.strip_prefix("a/")
        .or_else(|| p.strip_prefix("b/"))
        .unwrap_or(p)
}

/// Split a raw multi-file unified diff (`diff --git ...`) into per-file diffs.
#[must_use]
pub fn parse_unified_diff(text: &str) -> Vec<FileDiff> {
    let mut sections: Vec<Vec<&str>> = Vec::new();
    for line in text.lines() {
        if line.starts_with("diff --git ") {
            sections.push(vec![line]);
        } else if let Some(cur) = sections.last_mut() {
            cur.push(line);
        }
    }
    sections
        .into_iter()
        .map(|s| parse_diff_section(&s))
        .collect()
}

fn parse_diff_section(lines: &[&str]) -> FileDiff {
    let mut old_path: Option<String> = None;
    let mut new_path: Option<String> = None;
    let (mut added, mut deleted, mut renamed) = (false, false, false);
    let mut hunk_start = None;
    for (i, l) in lines.iter().enumerate().skip(1) {
        if hunk_start.is_some() {
            break;
        }
        if l.starts_with("@@") {
            hunk_start = Some(i);
        } else if l.starts_with("new file mode") {
            added = true;
        } else if l.starts_with("deleted file mode") {
            deleted = true;
        } else if let Some(p) = l.strip_prefix("rename from ") {
            renamed = true;
            old_path = Some(p.to_owned());
        } else if let Some(p) = l.strip_prefix("rename to ") {
            new_path = Some(p.to_owned());
        } else if let Some(p) = l.strip_prefix("--- ") {
            if p != "/dev/null" && old_path.is_none() {
                old_path = Some(strip_ab(p).to_owned());
            }
        } else if let Some(p) = l.strip_prefix("+++ ") {
            if p != "/dev/null" && new_path.is_none() {
                new_path = Some(strip_ab(p).to_owned());
            }
        }
    }
    // Fall back to the `diff --git a/X b/Y` header (binary files, pure mode changes).
    let header = lines[0].trim_start_matches("diff --git ");
    let (h_old, h_new) = header
        .split_once(" b/")
        .map_or((header, header), |(a, b)| (strip_ab(a), b));
    let path = new_path
        .or_else(|| old_path.clone())
        .unwrap_or_else(|| h_new.to_owned());
    let old = old_path.unwrap_or_else(|| {
        if added {
            path.clone()
        } else {
            h_old.to_owned()
        }
    });
    let patch = hunk_start.map(|i| lines[i..].join("\n"));
    let (additions, deletions) = patch.as_deref().map_or((0, 0), count_patch_lines);
    FileDiff {
        old_path: old,
        path,
        kind: if added {
            ChangeKind::Added
        } else if deleted {
            ChangeKind::Removed
        } else if renamed {
            ChangeKind::Renamed
        } else {
            ChangeKind::Modified
        },
        patch,
        additions,
        deletions,
    }
}

/// Parse a branch (lookup or create response).
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_branch(resp: &HttpResponse) -> GitResult<BranchRef> {
    let b: RawBranch = resp.json()?;
    Ok(BranchRef {
        name: b.name,
        sha: b.target.hash,
    })
}

/// Parse a pull request.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_pr(resp: &HttpResponse) -> GitResult<PullRequest> {
    let p: RawPr = resp.json()?;
    Ok(PullRequest {
        id: p.id.to_string(),
        number: p.id,
        title: p.title,
        html_url: p.links.html(),
        state: p.state,
        head: p.source.branch.name,
        base: p.destination.branch.name,
    })
}

/// Parse `/user`.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_user(resp: &HttpResponse) -> GitResult<GitUser> {
    let u: RawUser = resp.json()?;
    Ok(GitUser {
        login: u
            .username
            .or(u.nickname)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| u.display_name.clone()),
        id: u.uuid,
        avatar_url: u.links.avatar.map(|a| a.href).unwrap_or_default(),
        name: Some(u.display_name).filter(|n| !n.is_empty()),
    })
}

/// Parse a created hook.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_hook(resp: &HttpResponse) -> GitResult<GitWebhook> {
    Ok(GitWebhook {
        id: resp.json::<RawHook>()?.uuid,
    })
}

fn looks_like_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ── Provider ─────────────────────────────────────────

/// Bitbucket Cloud implementation of [`GitProvider`].
#[derive(Debug)]
pub struct BitbucketProvider {
    c: Client,
    api_base: String,
}

impl BitbucketProvider {
    /// Provider for bitbucket.org.
    #[must_use]
    pub fn new(transport: Arc<dyn HttpTransport>, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            c: Client::new(ProviderKind::Bitbucket, transport, secrets),
            api_base: API_BASE.to_owned(),
        }
    }
}

impl GitProvider for BitbucketProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Bitbucket
    }

    fn list_repos(&self) -> GitResult<Vec<GitRepo>> {
        let t = self.c.token()?;
        let req = list_repos_request(&self.api_base, t.expose_secret());
        self.c.pages(req, "listRepos", next_bitbucket, parse_repos)
    }

    fn create_repo(&self, new: &NewRepo) -> GitResult<GitRepo> {
        let t = self.c.token()?;
        let req = create_repo_request(&self.api_base, t.expose_secret(), new)?;
        parse_repo(&self.c.send_ok(&req, "createRepo", None)?)
    }

    fn get_file_tree(
        &self,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
    ) -> GitResult<Vec<GitTreeEntry>> {
        let t = self.c.token()?;
        let req = file_tree_request(&self.api_base, t.expose_secret(), owner, repo, git_ref);
        self.c.pages(req, "getFileTree", next_bitbucket, parse_tree)
    }

    fn get_file_content(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> GitResult<GitFileContent> {
        let t = self.c.token()?;
        let req = file_content_request(
            &self.api_base,
            t.expose_secret(),
            owner,
            repo,
            path,
            git_ref,
        );
        let nf = format!("File not found: \"{path}\". Check the path and try again.");
        let resp = self.c.send_ok(&req, "getFileContent", Some(&nf))?;
        Ok(file_from_raw(&resp, owner, repo, path, git_ref))
    }

    fn list_commits(
        &self,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
        limit: usize,
    ) -> GitResult<Vec<GitCommit>> {
        if limit == 0 {
            return Ok(Vec::new());
        }
        let t = self.c.token()?;
        let req = list_commits_request(
            &self.api_base,
            t.expose_secret(),
            owner,
            repo,
            git_ref,
            limit,
        );
        let mut out = self.c.pages_capped(
            req,
            "listCommits",
            limit.div_ceil(100),
            next_bitbucket,
            parse_commits,
        )?;
        out.truncate(limit);
        Ok(out)
    }

    fn get_commit_diff(&self, owner: &str, repo: &str, sha: &str) -> GitResult<Vec<FileDiff>> {
        let t = self.c.token()?;
        let req = commit_diff_request(&self.api_base, t.expose_secret(), owner, repo, sha);
        let resp = self
            .c
            .send_ok(&req, "getCommitDiff", Some("Commit not found."))?;
        Ok(parse_unified_diff(&resp.text()))
    }

    fn create_branch(
        &self,
        owner: &str,
        repo: &str,
        name: &str,
        from_ref: &str,
    ) -> GitResult<BranchRef> {
        let t = self.c.token()?;
        let tok = t.expose_secret();
        let hash = if looks_like_sha(from_ref) {
            from_ref.to_owned()
        } else {
            let req = branch_lookup_request(&self.api_base, tok, owner, repo, from_ref);
            parse_branch(
                &self
                    .c
                    .send_ok(&req, "createBranch", Some("Base branch not found."))?,
            )?
            .sha
        };
        let req = create_branch_request(&self.api_base, tok, owner, repo, name, &hash);
        parse_branch(&self.c.send_ok(&req, "createBranch", None)?)
    }

    fn create_pull_request(
        &self,
        owner: &str,
        repo: &str,
        pr: &NewPullRequest,
    ) -> GitResult<PullRequest> {
        let t = self.c.token()?;
        let req = create_pr_request(&self.api_base, t.expose_secret(), owner, repo, pr);
        parse_pr(&self.c.send_ok(&req, "createPullRequest", None)?)
    }

    fn create_issue(
        &self,
        owner: &str,
        repo: &str,
        title: &str,
        body: &str,
        _labels: &[String],
    ) -> GitResult<GitIssue> {
        // Bitbucket issues have no labels; they are ignored (as in the TS service).
        let t = self.c.token()?;
        let req = create_issue_request(&self.api_base, t.expose_secret(), owner, repo, title, body);
        parse_issue(&self.c.send_ok(&req, "createIssue", None)?)
    }

    fn list_issues(
        &self,
        owner: &str,
        repo: &str,
        state: IssueStateFilter,
    ) -> GitResult<Vec<GitIssue>> {
        let t = self.c.token()?;
        let req = list_issues_request(&self.api_base, t.expose_secret(), owner, repo, state);
        self.c
            .pages(req, "listIssues", next_bitbucket, parse_issues)
    }

    fn create_webhook(
        &self,
        owner: &str,
        repo: &str,
        url: &str,
        secret: &str,
    ) -> GitResult<GitWebhook> {
        let t = self.c.token()?;
        let req =
            create_webhook_request(&self.api_base, t.expose_secret(), owner, repo, url, secret);
        parse_hook(&self.c.send_ok(&req, "createWebhook", None)?)
    }

    fn delete_webhook(&self, owner: &str, repo: &str, hook_id: &str) -> GitResult<()> {
        let t = self.c.token()?;
        let req = delete_webhook_request(&self.api_base, t.expose_secret(), owner, repo, hook_id);
        let resp = self.c.send(&req)?;
        if resp.status == 404 {
            return Ok(());
        }
        self.c.check(resp, "deleteWebhook", None).map(|_| ())
    }

    fn exchange_code_for_token(
        &self,
        client_id: &str,
        client_secret: &SecretString,
        code: &str,
        _redirect_uri: Option<&str>,
    ) -> GitResult<OAuthToken> {
        let req = oauth_exchange_request(client_id, client_secret.expose_secret(), code);
        let resp = self.c.send(&req)?;
        parse_oauth(ProviderKind::Bitbucket, &resp, "scopes")
    }

    fn get_authenticated_user(&self) -> GitResult<GitUser> {
        let t = self.c.token()?;
        let req = user_request(&self.api_base, t.expose_secret());
        parse_user(&self.c.send_ok(&req, "getUser", None)?)
    }

    fn verify_webhook(&self, headers: &Headers, body: &[u8], secret: &str) -> bool {
        webhook::verify(ProviderKind::Bitbucket, headers, body, secret)
    }

    fn parse_webhook(&self, headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
        webhook::parse_bitbucket(headers, body)
    }

    fn last_rate_limit(&self) -> Option<RateLimit> {
        self.c.last_rate_limit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_provider::transport::FakeTransport;
    use crate::profile::{MemorySecretStore, Provider, SecretKey};

    fn setup() -> (Arc<FakeTransport>, BitbucketProvider) {
        let t = Arc::new(FakeTransport::new());
        let s = Arc::new(MemorySecretStore::default());
        s.set(
            &SecretKey::access_token(Provider::Other("bitbucket".into())),
            SecretString::from("bb-token".to_owned()),
        )
        .unwrap();
        (t.clone(), BitbucketProvider::new(t, s))
    }

    #[test]
    fn slug() {
        assert_eq!(slugify("My Cool Repo!"), "my-cool-repo-");
        assert_eq!(slugify("a_b.c-d"), "a_b.c-d");
    }

    #[test]
    fn list_repos_follows_next_and_maps() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"pagelen":100,"values":[{"uuid":"{u1}","name":"R","full_name":"ws/r","is_private":true,
               "links":{"html":{"href":"https://bitbucket.org/ws/r"}},"mainbranch":{"name":"master"}}],
               "next":"https://api.bitbucket.org/2.0/repositories?page=2"}"#,
        );
        t.push_json(
            200,
            &[],
            r#"{"values":[{"uuid":"{u2}","name":"S","full_name":"ws/s","is_private":false,
               "links":{"html":{"href":"https://bitbucket.org/ws/s"}}}]}"#,
        );
        let r = p.list_repos().unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(
            (r[0].default_branch.as_str(), r[1].default_branch.as_str()),
            ("master", "main")
        );
        assert_eq!(r[0].id, "{u1}");
        assert_eq!(
            t.requests()[0].headers.get("authorization"),
            Some("Bearer bb-token")
        );
        assert!(t.requests()[1].url.ends_with("page=2"));
    }

    #[test]
    fn tree_is_recursive_and_maps_types() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"values":[{"path":"src","type":"commit_directory"},{"path":"src/a.rs","type":"commit_file","size":10}]}"#,
        );
        let tree = p.get_file_tree("ws", "r", Some("main")).unwrap();
        assert_eq!(
            (tree[0].kind, tree[1].kind, tree[1].size),
            (TreeEntryKind::Tree, TreeEntryKind::Blob, Some(10))
        );
        assert!(t.requests()[0]
            .url
            .ends_with("/repositories/ws/r/src/main/?pagelen=100&max_depth=20"));
    }

    #[test]
    fn file_content_is_base64_wrapped() {
        let (t, p) = setup();
        t.push_json(200, &[], "hello");
        let f = p
            .get_file_content("ws", "r", "docs/readme.md", None)
            .unwrap();
        assert_eq!(f.name, "readme.md");
        assert_eq!(f.decode().unwrap(), b"hello");
        assert_eq!(f.size, 5);
        assert_eq!(
            f.html_url,
            "https://bitbucket.org/ws/r/src/HEAD/docs/readme.md"
        );
        assert!(t.requests()[0].url.ends_with("/src/HEAD/docs/readme.md"));
        t.push_json(404, &[], "{}");
        assert!(matches!(
            p.get_file_content("ws", "r", "x", None),
            Err(GitError::NotFound(_))
        ));
    }

    #[test]
    fn issues() {
        let (t, p) = setup();
        t.push_json(
            201,
            &[],
            r#"{"id":3,"title":"T","state":"new","links":{"html":{"href":"https://bitbucket.org/ws/r/issues/3"}}}"#,
        );
        let i = p
            .create_issue("ws", "r", "T", "body", &["ignored".into()])
            .unwrap();
        assert_eq!((i.number, i.id.as_str()), (Some(3), "3"));
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[0].body_text().unwrap()).unwrap();
        assert_eq!(sent["content"]["markup"], "markdown");
        assert_eq!(sent["kind"], "task");

        t.push_json(200, &[], r#"{"values":[]}"#);
        p.list_issues("ws", "r", IssueStateFilter::Open).unwrap();
        assert!(t.requests()[1]
            .url
            .contains("q=state%3D%22new%22%20OR%20state%3D%22open%22"));
        t.push_json(200, &[], r#"{"values":[]}"#);
        p.list_issues("ws", "r", IssueStateFilter::All).unwrap();
        assert!(!t.requests()[2].url.contains("q="));
    }

    #[test]
    fn commits_and_unified_diff() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"values":[{"hash":"h1","message":"m","date":"2024-01-01T00:00:00+00:00",
              "author":{"raw":"Ann <ann@x.io>","user":{"display_name":"Ann Lee"}},
              "links":{"html":{"href":"https://bitbucket.org/ws/r/commits/h1"}}}]}"#,
        );
        let c = p.list_commits("ws", "r", Some("main"), 10).unwrap();
        assert_eq!(
            (c[0].author_name.as_str(), c[0].author_email.as_deref()),
            ("Ann Lee", Some("ann@x.io"))
        );
        assert!(t.requests()[0].url.contains("/commits/main?pagelen=10"));

        let raw = "diff --git a/src/a.rs b/src/a.rs\nindex 1..2 100644\n--- a/src/a.rs\n+++ b/src/a.rs\n@@ -1,2 +1,2 @@\n-old\n+new\n ctx\n\
diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0..1\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n\
diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex 1..0\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n\
diff --git a/o.rs b/n.rs\nsimilarity index 100%\nrename from o.rs\nrename to n.rs\n\
diff --git a/img.png b/img.png\nindex 1..2 100644\nBinary files a/img.png and b/img.png differ\n";
        t.push_json(200, &[], raw);
        let d = p.get_commit_diff("ws", "r", "h1").unwrap();
        assert_eq!(d.len(), 5);
        assert_eq!(
            (d[0].path.as_str(), d[0].additions, d[0].deletions),
            ("src/a.rs", 1, 1)
        );
        assert_eq!((d[1].kind, d[1].additions), (ChangeKind::Added, 2));
        assert_eq!(
            (d[2].kind, d[2].path.as_str(), d[2].old_path.as_str()),
            (ChangeKind::Removed, "gone.txt", "gone.txt")
        );
        assert_eq!(
            (d[3].kind, d[3].old_path.as_str(), d[3].path.as_str()),
            (ChangeKind::Renamed, "o.rs", "n.rs")
        );
        assert!(d[3].patch.is_none());
        assert_eq!((d[4].path.as_str(), d[4].patch.clone()), ("img.png", None));
        assert!(parse_unified_diff("").is_empty());
    }

    #[test]
    fn branch_pr_hooks() {
        let (t, p) = setup();
        t.push_json(200, &[], r#"{"name":"main","target":{"hash":"aaa"}}"#);
        t.push_json(201, &[], r#"{"name":"feat","target":{"hash":"aaa"}}"#);
        let b = p.create_branch("ws", "r", "feat", "main").unwrap();
        assert_eq!(
            b,
            BranchRef {
                name: "feat".into(),
                sha: "aaa".into()
            }
        );
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[1].body_text().unwrap()).unwrap();
        assert_eq!(sent["target"]["hash"], "aaa");

        t.push_json(
            201,
            &[],
            r#"{"id":7,"title":"T","state":"OPEN","links":{"html":{"href":"https://bitbucket.org/ws/r/pull-requests/7"}},
               "source":{"branch":{"name":"feat"}},"destination":{"branch":{"name":"main"}}}"#,
        );
        let pr = p
            .create_pull_request(
                "ws",
                "r",
                &NewPullRequest {
                    title: "T".into(),
                    body: "b".into(),
                    head: "feat".into(),
                    base: "main".into(),
                    draft: false,
                },
            )
            .unwrap();
        assert_eq!(
            (pr.number, pr.head.as_str(), pr.base.as_str()),
            (7, "feat", "main")
        );
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[2].body_text().unwrap()).unwrap();
        assert!(sent.get("draft").is_none());

        t.push_json(201, &[], r#"{"uuid":"{abc-123}"}"#);
        assert_eq!(
            p.create_webhook("ws", "r", "https://h", "s3").unwrap().id,
            "{abc-123}"
        );
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[3].body_text().unwrap()).unwrap();
        assert_eq!(sent["secret"], "s3");
        assert_eq!(sent["events"][0], "repo:push");

        t.push_json(204, &[], "");
        p.delete_webhook("ws", "r", "{abc-123}").unwrap();
        assert!(t.requests()[4].url.ends_with("/hooks/%7Babc-123%7D"));
    }

    #[test]
    fn create_repo_needs_workspace() {
        let (t, p) = setup();
        let mut new = NewRepo {
            name: "My Repo".into(),
            description: Some("d".into()),
            is_private: true,
            workspace: None,
        };
        assert!(matches!(p.create_repo(&new), Err(GitError::Invalid(_))));
        new.workspace = Some("ws".into());
        t.push_json(
            200,
            &[],
            r#"{"uuid":"{u}","name":"My Repo","full_name":"ws/my-repo","is_private":true,"links":{"html":{"href":"h"}}}"#,
        );
        assert_eq!(p.create_repo(&new).unwrap().full_name, "ws/my-repo");
        assert!(t.requests()[0].url.ends_with("/repositories/ws/my-repo"));
    }

    #[test]
    fn oauth_basic_auth_and_user() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"access_token":"at","token_type":"bearer","scopes":"repository issue","refresh_token":"rt"}"#,
        );
        let tok = p
            .exchange_code_for_token("id", &SecretString::from("sec".to_owned()), "c0de", None)
            .unwrap();
        assert_eq!(tok.scope, "repository issue");
        let req = &t.requests()[0];
        let expect = base64::engine::general_purpose::STANDARD.encode("id:sec");
        assert_eq!(
            req.headers.get("authorization"),
            Some(format!("Basic {expect}").as_str())
        );
        assert_eq!(
            req.body_text().unwrap(),
            "grant_type=authorization_code&code=c0de"
        );

        t.push_json(
            200,
            &[],
            r#"{"username":"ann","uuid":"{u}","display_name":"Ann","links":{"avatar":{"href":"https://av"}}}"#,
        );
        let u = p.get_authenticated_user().unwrap();
        assert_eq!(
            (u.login.as_str(), u.avatar_url.as_str()),
            ("ann", "https://av")
        );

        t.push_json(429, &[("Retry-After", "60")], "");
        assert!(matches!(
            p.get_authenticated_user(),
            Err(GitError::RateLimited {
                retry_after_secs: Some(60),
                ..
            })
        ));
        assert_eq!(p.last_rate_limit().unwrap().retry_after_secs, Some(60));
    }

    #[test]
    fn webhook_signature_and_parse() {
        let (_t, p) = setup();
        let body = br#"{"repository":{"full_name":"ws/r"},"push":{"changes":[]}}"#;
        let sig = format!(
            "sha256={}",
            hex::encode(crate::git_provider::util::hmac_sha256(b"k", body))
        );
        let h = Headers::from_pairs([
            ("X-Hub-Signature", sig.as_str()),
            ("X-Event-Key", "repo:push"),
        ]);
        assert!(p.verify_webhook(&h, body, "k"));
        assert!(!p.verify_webhook(&h, body, "z"));
        assert!(matches!(
            p.parse_webhook(&h, body).unwrap(),
            WebhookEvent::Push(_)
        ));
    }
}
