//! GitHub (REST v3). Port of `github.service.ts`.
//!
//! Request builders and response parsers are pure functions; [`GitHubProvider`]
//! wires them to a transport and the secret store.
//! Dropped from the TS service: Projects v2 GraphQL helpers and
//! `getGitHubTokenForTeam` (DB lookup; replaced by the `SecretStore`).

use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::json;

use super::client::{parse_oauth, Client};
use super::pagination::next_link;
use super::rate_limit::RateLimit;
use super::transport::{Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport};
use super::util::{encode_component, encode_path, query};
use super::webhook::{self, WebhookEvent};
use super::{
    BranchRef, ChangeKind, FileDiff, GitCommit, GitError, GitFileContent, GitIssue, GitProvider,
    GitRepo, GitResult, GitTreeEntry, GitUser, GitWebhook, IssueStateFilter, NewPullRequest,
    NewRepo, OAuthToken, ProviderKind, PullRequest, TreeEntryKind,
};
use crate::profile::SecretStore;

/// Default API root.
pub const API_BASE: &str = "https://api.github.com";
/// OAuth code-exchange endpoint.
pub const OAUTH_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";

// ── Raw response types ───────────────────────────────

#[derive(Debug, Deserialize)]
struct RawRepo {
    id: u64,
    name: String,
    full_name: String,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    default_branch: Option<String>,
}

impl From<RawRepo> for GitRepo {
    fn from(r: RawRepo) -> Self {
        Self {
            id: r.id.to_string(),
            name: r.name,
            full_name: r.full_name,
            is_private: r.private,
            html_url: r.html_url,
            default_branch: r.default_branch.unwrap_or_else(|| "main".into()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawTree {
    #[serde(default)]
    tree: Vec<RawTreeEntry>,
}

#[derive(Debug, Deserialize)]
struct RawTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    size: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    name: String,
    path: String,
    #[serde(default)]
    size: u64,
    content: String,
    #[serde(default)]
    encoding: String,
    #[serde(default)]
    html_url: String,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    id: u64,
    number: u64,
    title: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    pull_request: Option<serde_json::Value>,
}

impl From<RawIssue> for GitIssue {
    fn from(i: RawIssue) -> Self {
        Self {
            id: i.id.to_string(),
            number: Some(i.number),
            iid: None,
            title: i.title,
            html_url: i.html_url,
            state: i.state,
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawCommit {
    sha: String,
    #[serde(default)]
    html_url: Option<String>,
    commit: RawCommitInner,
}

#[derive(Debug, Deserialize)]
struct RawCommitInner {
    #[serde(default)]
    message: String,
    #[serde(default)]
    author: Option<RawCommitAuthor>,
}

#[derive(Debug, Deserialize)]
struct RawCommitAuthor {
    #[serde(default)]
    name: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    date: String,
}

#[derive(Debug, Deserialize)]
struct RawCommitDetail {
    #[serde(default)]
    files: Vec<RawDiffFile>,
}

#[derive(Debug, Deserialize)]
struct RawDiffFile {
    filename: String,
    #[serde(default)]
    previous_filename: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    additions: u64,
    #[serde(default)]
    deletions: u64,
    #[serde(default)]
    patch: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawRef {
    object: RawRefObject,
}

#[derive(Debug, Deserialize)]
struct RawRefObject {
    sha: String,
}

#[derive(Debug, Deserialize)]
struct RawPr {
    id: u64,
    number: u64,
    title: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    state: String,
    head: RawPrRef,
    base: RawPrRef,
}

#[derive(Debug, Deserialize)]
struct RawPrRef {
    #[serde(rename = "ref")]
    name: String,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    login: String,
    id: u64,
    #[serde(default)]
    avatar_url: String,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawHook {
    id: u64,
}

// ── Request builders ─────────────────────────────────

fn authed(method: HttpMethod, url: String, token: &str) -> HttpRequest {
    HttpRequest::new(method, url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "nyx")
}

fn repo_url(base: &str, owner: &str, repo: &str) -> String {
    format!(
        "{base}/repos/{}/{}",
        encode_component(owner),
        encode_component(repo)
    )
}

/// `GET /user/repos?per_page=100&sort=updated`
#[must_use]
pub fn list_repos_request(base: &str, token: &str) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!("{base}/user/repos?per_page=100&sort=updated"),
        token,
    )
}

/// `POST /user/repos` (private + auto-init by default, as in the TS).
#[must_use]
pub fn create_repo_request(base: &str, token: &str, new: &NewRepo) -> HttpRequest {
    authed(HttpMethod::Post, format!("{base}/user/repos"), token).json(&json!({
        "name": new.name,
        "description": new.description.clone().unwrap_or_default(),
        "private": new.is_private,
        "auto_init": true,
    }))
}

/// `GET /repos/{o}/{r}/git/trees/{ref}?recursive=1`
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
            "{}/git/trees/{}?recursive=1",
            repo_url(base, owner, repo),
            encode_component(git_ref.unwrap_or("HEAD"))
        ),
        token,
    )
}

/// `GET /repos/{o}/{r}/contents/{path}[?ref=]`
#[must_use]
pub fn file_content_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    path: &str,
    git_ref: Option<&str>,
) -> HttpRequest {
    let mut url = format!(
        "{}/contents/{}",
        repo_url(base, owner, repo),
        encode_path(path)
    );
    if let Some(r) = git_ref {
        url.push('?');
        url.push_str(&query(&[("ref", r)]));
    }
    authed(HttpMethod::Get, url, token)
}

/// `GET /repos/{o}/{r}/commits?sha=&per_page=`
#[must_use]
pub fn list_commits_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
    per_page: usize,
) -> HttpRequest {
    let mut url = format!(
        "{}/commits?per_page={}",
        repo_url(base, owner, repo),
        per_page.clamp(1, 100)
    );
    if let Some(r) = git_ref {
        url.push('&');
        url.push_str(&query(&[("sha", r)]));
    }
    authed(HttpMethod::Get, url, token)
}

/// `GET /repos/{o}/{r}/commits/{sha}` (includes per-file patches).
#[must_use]
pub fn commit_diff_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    sha: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/commits/{}",
            repo_url(base, owner, repo),
            encode_component(sha)
        ),
        token,
    )
}

/// `GET /repos/{o}/{r}/git/ref/heads/{branch}` — step 1 of branch creation.
#[must_use]
pub fn branch_ref_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    branch: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/git/ref/heads/{}",
            repo_url(base, owner, repo),
            encode_path(branch)
        ),
        token,
    )
}

/// `POST /repos/{o}/{r}/git/refs` — step 2 of branch creation.
#[must_use]
pub fn create_branch_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    name: &str,
    sha: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!("{}/git/refs", repo_url(base, owner, repo)),
        token,
    )
    .json(&json!({ "ref": format!("refs/heads/{name}"), "sha": sha }))
}

/// `POST /repos/{o}/{r}/pulls`
#[must_use]
pub fn create_pr_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    pr: &NewPullRequest,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!("{}/pulls", repo_url(base, owner, repo)),
        token,
    )
    .json(&json!({
        "title": pr.title,
        "body": pr.body,
        "head": pr.head,
        "base": pr.base,
        "draft": pr.draft,
    }))
}

/// `POST /repos/{o}/{r}/issues` (labels omitted when empty).
#[must_use]
pub fn create_issue_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    labels: &[String],
) -> HttpRequest {
    let mut payload = json!({ "title": title, "body": body });
    if !labels.is_empty() {
        payload["labels"] = json!(labels);
    }
    authed(
        HttpMethod::Post,
        format!("{}/issues", repo_url(base, owner, repo)),
        token,
    )
    .json(&payload)
}

/// `GET /repos/{o}/{r}/issues?state=&per_page=100`
#[must_use]
pub fn list_issues_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    state: IssueStateFilter,
) -> HttpRequest {
    let s = match state {
        IssueStateFilter::Open => "open",
        IssueStateFilter::Closed => "closed",
        IssueStateFilter::All => "all",
    };
    authed(
        HttpMethod::Get,
        format!(
            "{}/issues?state={s}&per_page=100",
            repo_url(base, owner, repo)
        ),
        token,
    )
}

/// `POST /repos/{o}/{r}/hooks` (push, issues, `issue_comment`; JSON; SSL verified).
#[must_use]
pub fn create_webhook_request(
    base: &str,
    token: &str,
    owner: &str,
    repo: &str,
    url: &str,
    secret: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!("{}/hooks", repo_url(base, owner, repo)),
        token,
    )
    .json(&json!({
        "name": "web",
        "active": true,
        "events": ["push", "issues", "issue_comment"],
        "config": { "url": url, "content_type": "json", "secret": secret, "insecure_ssl": "0" },
    }))
}

/// `DELETE /repos/{o}/{r}/hooks/{id}`
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

/// OAuth code exchange (no bearer auth).
#[must_use]
pub fn oauth_exchange_request(client_id: &str, client_secret: &str, code: &str) -> HttpRequest {
    HttpRequest::new(HttpMethod::Post, OAUTH_TOKEN_URL)
        .header("Accept", "application/json")
        .header("User-Agent", "nyx")
        .json(&json!({ "client_id": client_id, "client_secret": client_secret, "code": code }))
}

/// `GET /user`
#[must_use]
pub fn user_request(base: &str, token: &str) -> HttpRequest {
    authed(HttpMethod::Get, format!("{base}/user"), token)
}

// ── Response parsers ─────────────────────────────────

/// Parse a `/user/repos` page.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_repos(resp: &HttpResponse) -> GitResult<Vec<GitRepo>> {
    Ok(resp
        .json::<Vec<RawRepo>>()?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// Parse a single repo (create response).
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_repo(resp: &HttpResponse) -> GitResult<GitRepo> {
    Ok(resp.json::<RawRepo>()?.into())
}

/// Parse a recursive tree. `blob` -> file; `tree` and `commit` (submodule) -> directory.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_tree(resp: &HttpResponse) -> GitResult<Vec<GitTreeEntry>> {
    Ok(resp
        .json::<RawTree>()?
        .tree
        .into_iter()
        .map(|e| GitTreeEntry {
            kind: if e.kind == "blob" {
                TreeEntryKind::Blob
            } else {
                TreeEntryKind::Tree
            },
            path: e.path,
            size: e.size,
        })
        .collect())
}

/// Parse the contents API. A directory listing (JSON array) is rejected.
///
/// # Errors
/// [`GitError::Invalid`] if the path is a directory; [`GitError::Parse`] otherwise.
pub fn parse_file(resp: &HttpResponse) -> GitResult<GitFileContent> {
    let v: serde_json::Value = resp.json()?;
    if v.is_array() {
        return Err(GitError::Invalid("path is a directory, not a file".into()));
    }
    let f: RawFile = serde_json::from_value(v).map_err(|e| GitError::Parse(e.to_string()))?;
    Ok(GitFileContent {
        name: f.name,
        path: f.path,
        size: f.size,
        content: f.content,
        encoding: if f.encoding.is_empty() {
            "base64".into()
        } else {
            f.encoding
        },
        html_url: f.html_url,
    })
}

/// Parse an issue list. Pull requests (which GitHub mixes into `/issues`) are dropped.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_issues(resp: &HttpResponse) -> GitResult<Vec<GitIssue>> {
    Ok(resp
        .json::<Vec<RawIssue>>()?
        .into_iter()
        .filter(|i| i.pull_request.is_none())
        .map(Into::into)
        .collect())
}

/// Parse a single issue.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_issue(resp: &HttpResponse) -> GitResult<GitIssue> {
    Ok(resp.json::<RawIssue>()?.into())
}

/// Parse a commit list.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_commits(resp: &HttpResponse) -> GitResult<Vec<GitCommit>> {
    Ok(resp
        .json::<Vec<RawCommit>>()?
        .into_iter()
        .map(|c| {
            let a = c.commit.author.unwrap_or(RawCommitAuthor {
                name: String::new(),
                email: String::new(),
                date: String::new(),
            });
            GitCommit {
                sha: c.sha,
                message: c.commit.message,
                author_name: a.name,
                author_email: (!a.email.is_empty()).then_some(a.email),
                timestamp: a.date,
                html_url: c.html_url,
            }
        })
        .collect())
}

/// Parse a commit-detail response into per-file diffs.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_commit_diff(resp: &HttpResponse) -> GitResult<Vec<FileDiff>> {
    Ok(resp
        .json::<RawCommitDetail>()?
        .files
        .into_iter()
        .map(|f| FileDiff {
            old_path: f.previous_filename.unwrap_or_else(|| f.filename.clone()),
            kind: match f.status.as_str() {
                "added" => ChangeKind::Added,
                "removed" => ChangeKind::Removed,
                "renamed" => ChangeKind::Renamed,
                _ => ChangeKind::Modified,
            },
            path: f.filename,
            patch: f.patch,
            additions: f.additions,
            deletions: f.deletions,
        })
        .collect())
}

/// Parse a ref lookup into the head SHA.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_ref_sha(resp: &HttpResponse) -> GitResult<String> {
    Ok(resp.json::<RawRef>()?.object.sha)
}

/// Parse a PR.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_pr(resp: &HttpResponse) -> GitResult<PullRequest> {
    let p: RawPr = resp.json()?;
    Ok(PullRequest {
        id: p.id.to_string(),
        number: p.number,
        title: p.title,
        html_url: p.html_url,
        state: p.state,
        head: p.head.name,
        base: p.base.name,
    })
}

/// Parse `/user`.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_user(resp: &HttpResponse) -> GitResult<GitUser> {
    let u: RawUser = resp.json()?;
    Ok(GitUser {
        login: u.login,
        id: u.id.to_string(),
        avatar_url: u.avatar_url,
        name: u.name,
    })
}

/// Parse a created hook.
///
/// # Errors
/// [`GitError::Parse`] on unexpected JSON.
pub fn parse_hook(resp: &HttpResponse) -> GitResult<GitWebhook> {
    Ok(GitWebhook {
        id: resp.json::<RawHook>()?.id.to_string(),
    })
}

fn looks_like_sha(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

// ── Provider ─────────────────────────────────────────

/// GitHub implementation of [`GitProvider`].
#[derive(Debug)]
pub struct GitHubProvider {
    c: Client,
    api_base: String,
}

impl GitHubProvider {
    /// Provider for github.com.
    #[must_use]
    pub fn new(transport: Arc<dyn HttpTransport>, secrets: Arc<dyn SecretStore>) -> Self {
        Self {
            c: Client::new(ProviderKind::GitHub, transport, secrets),
            api_base: API_BASE.to_owned(),
        }
    }

    /// Override the API root (GitHub Enterprise Server: `https://host/api/v3`).
    #[must_use]
    pub fn with_api_base(mut self, base: &str) -> Self {
        base.trim_end_matches('/').clone_into(&mut self.api_base);
        self
    }
}

impl GitProvider for GitHubProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::GitHub
    }

    fn list_repos(&self) -> GitResult<Vec<GitRepo>> {
        let t = self.c.token()?;
        let req = list_repos_request(&self.api_base, t.expose_secret());
        self.c.pages(req, "listRepos", next_link, parse_repos)
    }

    fn create_repo(&self, new: &NewRepo) -> GitResult<GitRepo> {
        let t = self.c.token()?;
        let req = create_repo_request(&self.api_base, t.expose_secret(), new);
        let resp = self.c.send(&req)?;
        if resp.status == 422 {
            // Port of the TS validation-error branch.
            let v: serde_json::Value = resp.json().unwrap_or_default();
            let detail = v
                .pointer("/errors/0/message")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Validation failed");
            return Err(GitError::Api {
                provider: "GitHub",
                op: "createRepo",
                status: 422,
                body: detail.to_owned(),
            });
        }
        parse_repo(&self.c.check(resp, "createRepo", None)?)
    }

    fn get_file_tree(
        &self,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
    ) -> GitResult<Vec<GitTreeEntry>> {
        let t = self.c.token()?;
        let req = file_tree_request(&self.api_base, t.expose_secret(), owner, repo, git_ref);
        let resp = self.c.send_ok(
            &req,
            "getFileTree",
            Some("Repository not found or not accessible. Check that the repository exists and your GitHub token has access."),
        )?;
        parse_tree(&resp)
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
        parse_file(&self.c.send_ok(&req, "getFileContent", Some(&nf))?)
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
            next_link,
            parse_commits,
        )?;
        out.truncate(limit);
        Ok(out)
    }

    fn get_commit_diff(&self, owner: &str, repo: &str, sha: &str) -> GitResult<Vec<FileDiff>> {
        let t = self.c.token()?;
        let req = commit_diff_request(&self.api_base, t.expose_secret(), owner, repo, sha);
        parse_commit_diff(
            &self
                .c
                .send_ok(&req, "getCommitDiff", Some("Commit not found."))?,
        )
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
        let sha = if looks_like_sha(from_ref) {
            from_ref.to_owned()
        } else {
            let req = branch_ref_request(&self.api_base, tok, owner, repo, from_ref);
            parse_ref_sha(
                &self
                    .c
                    .send_ok(&req, "createBranch", Some("Base branch not found."))?,
            )?
        };
        let req = create_branch_request(&self.api_base, tok, owner, repo, name, &sha);
        self.c.send_ok(&req, "createBranch", None)?;
        Ok(BranchRef {
            name: name.to_owned(),
            sha,
        })
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
        labels: &[String],
    ) -> GitResult<GitIssue> {
        let t = self.c.token()?;
        let req = create_issue_request(
            &self.api_base,
            t.expose_secret(),
            owner,
            repo,
            title,
            body,
            labels,
        );
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
        self.c.pages(req, "listIssues", next_link, parse_issues)
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
        parse_oauth(ProviderKind::GitHub, &resp, "scope")
    }

    fn get_authenticated_user(&self) -> GitResult<GitUser> {
        let t = self.c.token()?;
        let req = user_request(&self.api_base, t.expose_secret());
        parse_user(&self.c.send_ok(&req, "getUser", None)?)
    }

    fn verify_webhook(&self, headers: &Headers, body: &[u8], secret: &str) -> bool {
        webhook::verify(ProviderKind::GitHub, headers, body, secret)
    }

    fn parse_webhook(&self, headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
        webhook::parse_github(headers, body)
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

    fn setup() -> (Arc<FakeTransport>, GitHubProvider) {
        let t = Arc::new(FakeTransport::new());
        let s = Arc::new(MemorySecretStore::default());
        s.set(
            &SecretKey::access_token(Provider::GitHub),
            SecretString::from("ghp_test".to_owned()),
        )
        .unwrap();
        (t.clone(), GitHubProvider::new(t, s))
    }

    const REPOS_P1: &str = r#"[{"id":1,"name":"app","full_name":"acme/app","private":true,
      "html_url":"https://github.com/acme/app","default_branch":"trunk","owner":{"login":"acme"}}]"#;
    const REPOS_P2: &str = r#"[{"id":2,"name":"lib","full_name":"acme/lib","private":false,
      "html_url":"https://github.com/acme/lib","default_branch":null}]"#;

    #[test]
    fn list_repos_follows_link_header_and_sends_auth() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[
                ("Link", "<https://api.github.com/user/repos?per_page=100&sort=updated&page=2>; rel=\"next\""),
                ("X-RateLimit-Remaining", "4999"),
                ("X-RateLimit-Limit", "5000"),
            ],
            REPOS_P1,
        );
        t.push_json(200, &[], REPOS_P2);
        let repos = p.list_repos().unwrap();
        assert_eq!(repos.len(), 2);
        assert_eq!(repos[0].default_branch, "trunk");
        assert!(repos[0].is_private);
        assert_eq!(repos[1].default_branch, "main");
        let reqs = t.requests();
        assert_eq!(reqs.len(), 2);
        assert_eq!(
            reqs[0].headers.get("authorization"),
            Some("Bearer ghp_test")
        );
        assert_eq!(
            reqs[0].headers.get("x-github-api-version"),
            Some("2022-11-28")
        );
        assert!(reqs[0]
            .url
            .ends_with("/user/repos?per_page=100&sort=updated"));
        assert!(reqs[1].url.ends_with("page=2"));
        assert_eq!(p.last_rate_limit().unwrap().limit, Some(5000));
    }

    #[test]
    fn missing_token_is_reported() {
        let t = Arc::new(FakeTransport::new());
        let p = GitHubProvider::new(t.clone(), Arc::new(MemorySecretStore::default()));
        assert!(matches!(
            p.list_repos(),
            Err(GitError::MissingCredential("GitHub"))
        ));
        assert!(t.requests().is_empty());
    }

    #[test]
    fn tree_maps_types_and_error_messages() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"sha":"x","truncated":false,"tree":[
              {"path":"src","mode":"040000","type":"tree","sha":"a","url":"u"},
              {"path":"src/main.rs","mode":"100644","type":"blob","sha":"b","size":120,"url":"u"},
              {"path":"vendor/sub","mode":"160000","type":"commit","sha":"c","url":"u"}]}"#,
        );
        let tree = p.get_file_tree("acme", "app", None).unwrap();
        assert_eq!(tree.len(), 3);
        assert_eq!(tree[1].kind, TreeEntryKind::Blob);
        assert_eq!(tree[1].size, Some(120));
        assert_eq!(tree[2].kind, TreeEntryKind::Tree);
        assert!(t.requests()[0]
            .url
            .ends_with("/repos/acme/app/git/trees/HEAD?recursive=1"));

        t.push_json(404, &[], r#"{"message":"Not Found"}"#);
        let e = p.get_file_tree("acme", "nope", Some("main")).unwrap_err();
        assert!(e
            .to_string()
            .starts_with("Repository not found or not accessible."));

        t.push_json(
            403,
            &[
                ("X-RateLimit-Remaining", "0"),
                ("X-RateLimit-Reset", "1700000000"),
            ],
            "{}",
        );
        assert!(matches!(
            p.get_file_tree("a", "b", None),
            Err(GitError::RateLimited { .. })
        ));
        assert_eq!(p.last_rate_limit().unwrap().remaining, Some(0));

        t.push_json(401, &[], "{}");
        assert!(matches!(
            p.get_file_tree("a", "b", None),
            Err(GitError::Unauthorized("GitHub"))
        ));
    }

    #[test]
    fn file_content_builds_url_and_decodes() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"name":"a b.md","path":"docs/a b.md","sha":"s","size":5,"content":"aGVs\nbG8=\n","encoding":"base64","html_url":"https://github.com/acme/app/blob/main/docs/a%20b.md"}"#,
        );
        let f = p
            .get_file_content("acme", "app", "docs/a b.md", Some("feat/x"))
            .unwrap();
        assert_eq!(f.decode().unwrap(), b"hello");
        assert!(t.requests()[0]
            .url
            .ends_with("/repos/acme/app/contents/docs/a%20b.md?ref=feat%2Fx"));

        t.push_json(404, &[], "{}");
        let e = p
            .get_file_content("acme", "app", "missing.txt", None)
            .unwrap_err();
        assert_eq!(
            e.to_string(),
            "File not found: \"missing.txt\". Check the path and try again."
        );

        t.push_json(200, &[], "[{\"name\":\"x\"}]");
        assert!(matches!(
            p.get_file_content("a", "b", "dir", None),
            Err(GitError::Invalid(_))
        ));
    }

    #[test]
    fn issues_create_list_and_pr_filtering() {
        let (t, p) = setup();
        t.push_json(201, &[], r#"{"id":11,"number":5,"title":"Bug","html_url":"https://github.com/acme/app/issues/5","state":"open"}"#);
        let i = p
            .create_issue("acme", "app", "Bug", "details", &["bug".to_owned()])
            .unwrap();
        assert_eq!((i.number, i.id.as_str()), (Some(5), "11"));
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[0].body_text().unwrap()).unwrap();
        assert_eq!(sent["labels"][0], "bug");
        assert_eq!(sent["title"], "Bug");

        t.push_json(
            201,
            &[],
            r#"{"id":12,"number":6,"title":"T","html_url":"u","state":"open"}"#,
        );
        p.create_issue("acme", "app", "T", "b", &[]).unwrap();
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[1].body_text().unwrap()).unwrap();
        assert!(sent.get("labels").is_none());

        t.push_json(
            200,
            &[],
            r#"[{"id":1,"number":1,"title":"i","html_url":"u","state":"open"},
                {"id":2,"number":2,"title":"pr","html_url":"u","state":"open","pull_request":{"url":"x"}}]"#,
        );
        let list = p
            .list_issues("acme", "app", IssueStateFilter::Closed)
            .unwrap();
        assert_eq!(list.len(), 1);
        assert!(t.requests()[2].url.contains("state=closed&per_page=100"));
    }

    #[test]
    fn commits_and_diff() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"[{"sha":"abc","html_url":"https://github.com/acme/app/commit/abc",
                 "commit":{"message":"fix","author":{"name":"Ann","email":"a@x","date":"2024-01-01T00:00:00Z"}}}]"#,
        );
        let c = p.list_commits("acme", "app", Some("main"), 30).unwrap();
        assert_eq!(c[0].author_name, "Ann");
        assert!(t.requests()[0].url.contains("per_page=30&sha=main"));
        assert!(p.list_commits("a", "b", None, 0).unwrap().is_empty());

        t.push_json(
            200,
            &[],
            r#"{"sha":"abc","files":[
              {"filename":"a.rs","status":"added","additions":3,"deletions":0,"patch":"@@ -0,0 +1,3 @@\n+a"},
              {"filename":"b.rs","previous_filename":"old.rs","status":"renamed","additions":0,"deletions":0},
              {"filename":"c.rs","status":"removed","additions":0,"deletions":4,"patch":"@@"},
              {"filename":"d.rs","status":"changed","additions":1,"deletions":1}]}"#,
        );
        let d = p.get_commit_diff("acme", "app", "abc").unwrap();
        assert_eq!(d[0].kind, ChangeKind::Added);
        assert_eq!(
            (d[1].kind, d[1].old_path.as_str()),
            (ChangeKind::Renamed, "old.rs")
        );
        assert_eq!(d[2].kind, ChangeKind::Removed);
        assert_eq!(d[3].kind, ChangeKind::Modified);
        assert!(d[1].patch.is_none());
    }

    #[test]
    fn create_branch_two_step_and_sha_shortcut() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"ref":"refs/heads/main","object":{"sha":"deadbeef","type":"commit"}}"#,
        );
        t.push_json(
            201,
            &[],
            r#"{"ref":"refs/heads/feat/x","object":{"sha":"deadbeef"}}"#,
        );
        let b = p.create_branch("acme", "app", "feat/x", "main").unwrap();
        assert_eq!(
            b,
            BranchRef {
                name: "feat/x".into(),
                sha: "deadbeef".into()
            }
        );
        let reqs = t.requests();
        assert!(reqs[0].url.ends_with("/git/ref/heads/main"));
        let body: serde_json::Value = serde_json::from_str(&reqs[1].body_text().unwrap()).unwrap();
        assert_eq!(body["ref"], "refs/heads/feat/x");
        assert_eq!(body["sha"], "deadbeef");

        let sha = "0123456789abcdef0123456789abcdef01234567";
        t.push_json(201, &[], "{}");
        p.create_branch("acme", "app", "b", sha).unwrap();
        assert_eq!(t.requests().len(), 3, "sha base needs no lookup");

        t.push_json(404, &[], "{}");
        assert!(matches!(
            p.create_branch("a", "b", "n", "nope"),
            Err(GitError::NotFound(_))
        ));
    }

    #[test]
    fn pull_request_and_webhook_lifecycle() {
        let (t, p) = setup();
        t.push_json(
            201,
            &[],
            r#"{"id":9,"number":3,"title":"Add x","html_url":"https://github.com/acme/app/pull/3","state":"open","head":{"ref":"feat"},"base":{"ref":"main"}}"#,
        );
        let pr = p
            .create_pull_request(
                "acme",
                "app",
                &NewPullRequest {
                    title: "Add x".into(),
                    body: "b".into(),
                    head: "feat".into(),
                    base: "main".into(),
                    draft: true,
                },
            )
            .unwrap();
        assert_eq!(
            (pr.number, pr.head.as_str(), pr.base.as_str()),
            (3, "feat", "main")
        );
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[0].body_text().unwrap()).unwrap();
        assert_eq!(sent["draft"], true);

        t.push_json(201, &[], r#"{"id":777,"active":true}"#);
        let h = p
            .create_webhook("acme", "app", "https://nyx.example/hook", "shh")
            .unwrap();
        assert_eq!(h.id, "777");
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[1].body_text().unwrap()).unwrap();
        assert_eq!(sent["config"]["secret"], "shh");
        assert_eq!(sent["config"]["content_type"], "json");
        assert_eq!(sent["events"][0], "push");

        t.push_json(204, &[], "");
        p.delete_webhook("acme", "app", "777").unwrap();
        t.push_json(404, &[], "{}");
        p.delete_webhook("acme", "app", "777").unwrap();
        t.push_json(500, &[], "boom");
        assert!(p.delete_webhook("acme", "app", "777").is_err());
        assert_eq!(t.requests()[2].method, HttpMethod::Delete);
    }

    #[test]
    fn oauth_and_user() {
        let (t, p) = setup();
        t.push_json(
            200,
            &[],
            r#"{"access_token":"gho_new","token_type":"bearer","scope":"repo,read:user"}"#,
        );
        let tok = p
            .exchange_code_for_token(
                "cid",
                &SecretString::from("csec".to_owned()),
                "code123",
                None,
            )
            .unwrap();
        assert_eq!(tok.access_token.expose_secret(), "gho_new");
        assert_eq!(tok.scope, "repo,read:user");
        let req = &t.requests()[0];
        assert_eq!(req.url, OAUTH_TOKEN_URL);
        assert!(req.headers.get("authorization").is_none());
        assert!(req.body_text().unwrap().contains("code123"));

        t.push_json(200, &[], r#"{"error":"bad_verification_code","error_description":"The code passed is incorrect or expired."}"#);
        let e = p
            .exchange_code_for_token("cid", &SecretString::from("csec".to_owned()), "x", None)
            .unwrap_err();
        assert_eq!(
            e.to_string(),
            "GitHub OAuth error: The code passed is incorrect or expired."
        );

        t.push_json(
            200,
            &[],
            r#"{"login":"ann","id":42,"avatar_url":"https://a/42","name":null}"#,
        );
        let u = p.get_authenticated_user().unwrap();
        assert_eq!(
            (u.login.as_str(), u.id.as_str(), u.name),
            ("ann", "42", None)
        );
    }

    #[test]
    fn create_repo_422_detail() {
        let (t, p) = setup();
        let new = NewRepo {
            name: "x".into(),
            description: None,
            is_private: true,
            workspace: None,
        };
        t.push_json(422, &[], r#"{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}"#);
        let e = p.create_repo(&new).unwrap_err();
        assert!(e
            .to_string()
            .contains("name already exists on this account"));
        t.push_json(
            201,
            &[],
            REPOS_P1.trim_start_matches('[').trim_end_matches(']'),
        );
        assert_eq!(p.create_repo(&new).unwrap().name, "app");
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[1].body_text().unwrap()).unwrap();
        assert_eq!(sent["auto_init"], true);
        assert_eq!(sent["private"], true);
    }

    #[test]
    fn transport_failure_surfaces() {
        let (t, p) = setup();
        t.push_error("connection reset");
        assert!(matches!(
            p.get_authenticated_user(),
            Err(GitError::Transport(_))
        ));
    }

    #[test]
    fn webhook_roundtrip_through_provider() {
        let (_t, p) = setup();
        let body =
            br#"{"ref":"refs/heads/main","commits":[],"repository":{"full_name":"acme/app"}}"#;
        let sig = format!(
            "sha256={}",
            hex::encode(crate::git_provider::util::hmac_sha256(b"shh", body))
        );
        let h = Headers::from_pairs([
            ("X-Hub-Signature-256", sig.as_str()),
            ("X-GitHub-Event", "push"),
        ]);
        assert!(p.verify_webhook(&h, body, "shh"));
        assert!(!p.verify_webhook(&h, body, "wrong"));
        assert!(matches!(
            p.parse_webhook(&h, body).unwrap(),
            WebhookEvent::Push(_)
        ));
    }
}
