//! GitLab (cloud and self-hosted, API v4). Port of `gitlab.service.ts`.
//!
//! Projects are addressed by URL-encoded `owner/repo` path. For self-hosted
//! instances pass the base URL (`https://git.example.com`) to
//! [`GitLabProvider::new`].

use std::sync::Arc;

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::json;

use super::client::{parse_oauth, Client};
use super::pagination::next_link;
use super::rate_limit::RateLimit;
use super::transport::{Headers, HttpMethod, HttpRequest, HttpResponse, HttpTransport};
use super::util::{count_patch_lines, encode_component, query};
use super::webhook::{self, WebhookEvent};
use super::{
    BranchRef, ChangeKind, FileDiff, GitCommit, GitFileContent, GitIssue, GitProvider, GitRepo,
    GitResult, GitTreeEntry, GitUser, GitWebhook, IssueStateFilter, NewPullRequest, NewRepo,
    OAuthToken, ProviderKind, PullRequest, TreeEntryKind,
};
use crate::profile::SecretStore;

/// gitlab.com web root.
pub const DEFAULT_WEB_BASE: &str = "https://gitlab.com";

// ── Raw response types ───────────────────────────────

#[derive(Debug, Deserialize)]
struct RawProject {
    id: u64,
    name: String,
    path_with_namespace: String,
    #[serde(default)]
    visibility: String,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    default_branch: Option<String>,
}

impl From<RawProject> for GitRepo {
    fn from(p: RawProject) -> Self {
        Self {
            id: p.id.to_string(),
            name: p.name,
            full_name: p.path_with_namespace,
            is_private: p.visibility == "private",
            html_url: p.web_url,
            default_branch: p.default_branch.unwrap_or_else(|| "main".into()),
        }
    }
}

#[derive(Debug, Deserialize)]
struct RawTreeEntry {
    path: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Deserialize)]
struct RawFile {
    file_name: String,
    file_path: String,
    #[serde(default)]
    size: u64,
    content: String,
    #[serde(default)]
    encoding: String,
}

#[derive(Debug, Deserialize)]
struct RawIssue {
    id: u64,
    iid: u64,
    title: String,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    state: String,
}

#[derive(Debug, Deserialize)]
struct RawCommit {
    id: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    author_name: String,
    #[serde(default)]
    author_email: Option<String>,
    #[serde(default)]
    authored_date: String,
    #[serde(default)]
    web_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawDiff {
    old_path: String,
    new_path: String,
    #[serde(default)]
    new_file: bool,
    #[serde(default)]
    renamed_file: bool,
    #[serde(default)]
    deleted_file: bool,
    #[serde(default)]
    diff: String,
}

#[derive(Debug, Deserialize)]
struct RawBranch {
    name: String,
    commit: RawBranchCommit,
}

#[derive(Debug, Deserialize)]
struct RawBranchCommit {
    id: String,
}

#[derive(Debug, Deserialize)]
struct RawMr {
    id: u64,
    iid: u64,
    title: String,
    #[serde(default)]
    web_url: String,
    #[serde(default)]
    state: String,
    source_branch: String,
    target_branch: String,
}

#[derive(Debug, Deserialize)]
struct RawUser {
    username: String,
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

/// `{base}/api/v4`, or gitlab.com's when `base_url` is `None`.
#[must_use]
pub fn api_base(base_url: Option<&str>) -> String {
    format!("{}/api/v4", web_base(base_url))
}

/// Instance root without trailing slash.
#[must_use]
pub fn web_base(base_url: Option<&str>) -> String {
    base_url.map_or_else(
        || DEFAULT_WEB_BASE.to_owned(),
        |b| b.trim_end_matches('/').to_owned(),
    )
}

fn authed(method: HttpMethod, url: String, token: &str) -> HttpRequest {
    HttpRequest::new(method, url)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
}

fn project_url(api: &str, owner: &str, repo: &str) -> String {
    format!(
        "{api}/projects/{}",
        encode_component(&format!("{owner}/{repo}"))
    )
}

/// `GET /projects?membership=true&per_page=100&order_by=updated_at`
#[must_use]
pub fn list_repos_request(api: &str, token: &str) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!("{api}/projects?membership=true&per_page=100&order_by=updated_at"),
        token,
    )
}

/// `POST /projects` (README-initialised; visibility from `is_private`).
#[must_use]
pub fn create_repo_request(api: &str, token: &str, new: &NewRepo) -> HttpRequest {
    authed(HttpMethod::Post, format!("{api}/projects"), token).json(&json!({
        "name": new.name,
        "description": new.description.clone().unwrap_or_default(),
        "visibility": if new.is_private { "private" } else { "public" },
        "initialize_with_readme": true,
    }))
}

/// `GET /projects/:id/repository/tree?recursive=true&per_page=100&ref=`
#[must_use]
pub fn file_tree_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/repository/tree?recursive=true&per_page=100&{}",
            project_url(api, owner, repo),
            query(&[("ref", git_ref.unwrap_or("HEAD"))])
        ),
        token,
    )
}

/// `GET /projects/:id/repository/files/:path?ref=` (ref defaults to `HEAD`).
#[must_use]
pub fn file_content_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    path: &str,
    git_ref: Option<&str>,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/repository/files/{}?{}",
            project_url(api, owner, repo),
            encode_component(path),
            query(&[("ref", git_ref.unwrap_or("HEAD"))])
        ),
        token,
    )
}

/// `GET /projects/:id/repository/commits?ref_name=&per_page=`
#[must_use]
pub fn list_commits_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
    per_page: usize,
) -> HttpRequest {
    let mut url = format!(
        "{}/repository/commits?per_page={}",
        project_url(api, owner, repo),
        per_page.clamp(1, 100)
    );
    if let Some(r) = git_ref {
        url.push('&');
        url.push_str(&query(&[("ref_name", r)]));
    }
    authed(HttpMethod::Get, url, token)
}

/// `GET /projects/:id/repository/commits/:sha/diff?per_page=100`
#[must_use]
pub fn commit_diff_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    sha: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Get,
        format!(
            "{}/repository/commits/{}/diff?per_page=100",
            project_url(api, owner, repo),
            encode_component(sha)
        ),
        token,
    )
}

/// `POST /projects/:id/repository/branches?branch=&ref=`
#[must_use]
pub fn create_branch_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    name: &str,
    from_ref: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!(
            "{}/repository/branches?{}",
            project_url(api, owner, repo),
            query(&[("branch", name), ("ref", from_ref)])
        ),
        token,
    )
}

/// `POST /projects/:id/merge_requests` (draft => `Draft: ` title prefix).
#[must_use]
pub fn create_mr_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    pr: &NewPullRequest,
) -> HttpRequest {
    let title = if pr.draft && !pr.title.starts_with("Draft:") {
        format!("Draft: {}", pr.title)
    } else {
        pr.title.clone()
    };
    authed(
        HttpMethod::Post,
        format!("{}/merge_requests", project_url(api, owner, repo)),
        token,
    )
    .json(&json!({
        "source_branch": pr.head,
        "target_branch": pr.base,
        "title": title,
        "description": pr.body,
    }))
}

/// `POST /projects/:id/issues` (`labels` comma-joined, omitted when empty).
#[must_use]
pub fn create_issue_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    title: &str,
    body: &str,
    labels: &[String],
) -> HttpRequest {
    let mut payload = json!({ "title": title, "description": body });
    if !labels.is_empty() {
        payload["labels"] = json!(labels.join(","));
    }
    authed(
        HttpMethod::Post,
        format!("{}/issues", project_url(api, owner, repo)),
        token,
    )
    .json(&payload)
}

/// `GET /projects/:id/issues?state=&per_page=100` (`open` is spelled `opened`).
#[must_use]
pub fn list_issues_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    state: IssueStateFilter,
) -> HttpRequest {
    let s = match state {
        IssueStateFilter::Open => "opened",
        IssueStateFilter::Closed => "closed",
        IssueStateFilter::All => "all",
    };
    authed(
        HttpMethod::Get,
        format!(
            "{}/issues?state={s}&per_page=100",
            project_url(api, owner, repo)
        ),
        token,
    )
}

/// `POST /projects/:id/hooks` (push + issue + note events, secret in `token`).
#[must_use]
pub fn create_webhook_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    url: &str,
    secret: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Post,
        format!("{}/hooks", project_url(api, owner, repo)),
        token,
    )
    .json(&json!({
        "url": url,
        "token": secret,
        "push_events": true,
        "issues_events": true,
        "note_events": true,
        "enable_ssl_verification": true,
    }))
}

/// `DELETE /projects/:id/hooks/:hook`
#[must_use]
pub fn delete_webhook_request(
    api: &str,
    token: &str,
    owner: &str,
    repo: &str,
    hook_id: &str,
) -> HttpRequest {
    authed(
        HttpMethod::Delete,
        format!(
            "{}/hooks/{}",
            project_url(api, owner, repo),
            encode_component(hook_id)
        ),
        token,
    )
}

/// `POST {base}/oauth/token` (`authorization_code` grant).
#[must_use]
pub fn oauth_exchange_request(
    web: &str,
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: Option<&str>,
) -> HttpRequest {
    let mut payload = json!({
        "client_id": client_id,
        "client_secret": client_secret,
        "code": code,
        "grant_type": "authorization_code",
    });
    if let Some(r) = redirect_uri {
        payload["redirect_uri"] = json!(r);
    }
    HttpRequest::new(HttpMethod::Post, format!("{web}/oauth/token"))
        .header("Accept", "application/json")
        .json(&payload)
}

/// `GET /user`
#[must_use]
pub fn user_request(api: &str, token: &str) -> HttpRequest {
    authed(HttpMethod::Get, format!("{api}/user"), token)
}

// ── Response parsers ─────────────────────────────────

/// Parse a projects page.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_repos(resp: &HttpResponse) -> GitResult<Vec<GitRepo>> {
    Ok(resp
        .json::<Vec<RawProject>>()?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// Parse one project.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_repo(resp: &HttpResponse) -> GitResult<GitRepo> {
    Ok(resp.json::<RawProject>()?.into())
}

/// Parse a tree page: `blob` -> file, everything else -> directory.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_tree(resp: &HttpResponse) -> GitResult<Vec<GitTreeEntry>> {
    Ok(resp
        .json::<Vec<RawTreeEntry>>()?
        .into_iter()
        .map(|e| GitTreeEntry {
            kind: if e.kind == "blob" {
                TreeEntryKind::Blob
            } else {
                TreeEntryKind::Tree
            },
            path: e.path,
            size: None,
        })
        .collect())
}

/// Parse the files API. `html_url` is synthesised from `web`, owner/repo and ref.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_file(
    resp: &HttpResponse,
    web: &str,
    owner: &str,
    repo: &str,
    git_ref: Option<&str>,
) -> GitResult<GitFileContent> {
    let f: RawFile = resp.json()?;
    Ok(GitFileContent {
        html_url: format!(
            "{web}/{owner}/{repo}/-/blob/{}/{}",
            git_ref.unwrap_or("HEAD"),
            f.file_path
        ),
        name: f.file_name,
        path: f.file_path,
        size: f.size,
        content: f.content,
        encoding: if f.encoding.is_empty() {
            "base64".into()
        } else {
            f.encoding
        },
    })
}

fn issue_from(i: RawIssue) -> GitIssue {
    GitIssue {
        id: i.id.to_string(),
        number: None,
        iid: Some(i.iid),
        title: i.title,
        html_url: i.web_url,
        state: i.state,
    }
}

/// Parse an issue list.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_issues(resp: &HttpResponse) -> GitResult<Vec<GitIssue>> {
    Ok(resp
        .json::<Vec<RawIssue>>()?
        .into_iter()
        .map(issue_from)
        .collect())
}

/// Parse one issue.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_issue(resp: &HttpResponse) -> GitResult<GitIssue> {
    Ok(issue_from(resp.json()?))
}

/// Parse a commits page.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_commits(resp: &HttpResponse) -> GitResult<Vec<GitCommit>> {
    Ok(resp
        .json::<Vec<RawCommit>>()?
        .into_iter()
        .map(|c| GitCommit {
            sha: c.id,
            message: c.message,
            author_name: c.author_name,
            author_email: c.author_email.filter(|e| !e.is_empty()),
            timestamp: c.authored_date,
            html_url: c.web_url,
        })
        .collect())
}

/// Parse a commit-diff page.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_diffs(resp: &HttpResponse) -> GitResult<Vec<FileDiff>> {
    Ok(resp
        .json::<Vec<RawDiff>>()?
        .into_iter()
        .map(|d| {
            let (additions, deletions) = count_patch_lines(&d.diff);
            let kind = if d.new_file {
                ChangeKind::Added
            } else if d.deleted_file {
                ChangeKind::Removed
            } else if d.renamed_file {
                ChangeKind::Renamed
            } else {
                ChangeKind::Modified
            };
            FileDiff {
                old_path: d.old_path,
                path: d.new_path,
                kind,
                patch: (!d.diff.is_empty()).then_some(d.diff),
                additions,
                deletions,
            }
        })
        .collect())
}

/// Parse a created branch.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_branch(resp: &HttpResponse) -> GitResult<BranchRef> {
    let b: RawBranch = resp.json()?;
    Ok(BranchRef {
        name: b.name,
        sha: b.commit.id,
    })
}

/// Parse a merge request.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_mr(resp: &HttpResponse) -> GitResult<PullRequest> {
    let m: RawMr = resp.json()?;
    Ok(PullRequest {
        id: m.id.to_string(),
        number: m.iid,
        title: m.title,
        html_url: m.web_url,
        state: m.state,
        head: m.source_branch,
        base: m.target_branch,
    })
}

/// Parse `/user`.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_user(resp: &HttpResponse) -> GitResult<GitUser> {
    let u: RawUser = resp.json()?;
    Ok(GitUser {
        login: u.username,
        id: u.id.to_string(),
        avatar_url: u.avatar_url,
        name: u.name,
    })
}

/// Parse a created hook.
///
/// # Errors
/// [`super::GitError::Parse`] on unexpected JSON.
pub fn parse_hook(resp: &HttpResponse) -> GitResult<GitWebhook> {
    Ok(GitWebhook {
        id: resp.json::<RawHook>()?.id.to_string(),
    })
}

// ── Provider ─────────────────────────────────────────

/// GitLab implementation of [`GitProvider`].
#[derive(Debug)]
pub struct GitLabProvider {
    c: Client,
    api: String,
    web: String,
}

impl GitLabProvider {
    /// `base_url`: self-hosted instance root, or `None` for gitlab.com.
    #[must_use]
    pub fn new(
        transport: Arc<dyn HttpTransport>,
        secrets: Arc<dyn SecretStore>,
        base_url: Option<&str>,
    ) -> Self {
        Self {
            c: Client::new(ProviderKind::GitLab, transport, secrets),
            api: api_base(base_url),
            web: web_base(base_url),
        }
    }
}

impl GitProvider for GitLabProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::GitLab
    }

    fn list_repos(&self) -> GitResult<Vec<GitRepo>> {
        let t = self.c.token()?;
        let req = list_repos_request(&self.api, t.expose_secret());
        self.c.pages(req, "listRepos", next_link, parse_repos)
    }

    fn create_repo(&self, new: &NewRepo) -> GitResult<GitRepo> {
        let t = self.c.token()?;
        let req = create_repo_request(&self.api, t.expose_secret(), new);
        parse_repo(&self.c.send_ok(&req, "createRepo", None)?)
    }

    fn get_file_tree(
        &self,
        owner: &str,
        repo: &str,
        git_ref: Option<&str>,
    ) -> GitResult<Vec<GitTreeEntry>> {
        let t = self.c.token()?;
        let req = file_tree_request(&self.api, t.expose_secret(), owner, repo, git_ref);
        self.c.pages(req, "getFileTree", next_link, parse_tree)
    }

    fn get_file_content(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        git_ref: Option<&str>,
    ) -> GitResult<GitFileContent> {
        let t = self.c.token()?;
        let req = file_content_request(&self.api, t.expose_secret(), owner, repo, path, git_ref);
        let nf = format!("File not found: \"{path}\". Check the path and try again.");
        let resp = self.c.send_ok(&req, "getFileContent", Some(&nf))?;
        parse_file(&resp, &self.web, owner, repo, git_ref)
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
        let req = list_commits_request(&self.api, t.expose_secret(), owner, repo, git_ref, limit);
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
        let req = commit_diff_request(&self.api, t.expose_secret(), owner, repo, sha);
        self.c.pages(req, "getCommitDiff", next_link, parse_diffs)
    }

    fn create_branch(
        &self,
        owner: &str,
        repo: &str,
        name: &str,
        from_ref: &str,
    ) -> GitResult<BranchRef> {
        let t = self.c.token()?;
        let req = create_branch_request(&self.api, t.expose_secret(), owner, repo, name, from_ref);
        parse_branch(
            &self
                .c
                .send_ok(&req, "createBranch", Some("Base ref not found."))?,
        )
    }

    fn create_pull_request(
        &self,
        owner: &str,
        repo: &str,
        pr: &NewPullRequest,
    ) -> GitResult<PullRequest> {
        let t = self.c.token()?;
        let req = create_mr_request(&self.api, t.expose_secret(), owner, repo, pr);
        parse_mr(&self.c.send_ok(&req, "createPullRequest", None)?)
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
            &self.api,
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
        let req = list_issues_request(&self.api, t.expose_secret(), owner, repo, state);
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
        let req = create_webhook_request(&self.api, t.expose_secret(), owner, repo, url, secret);
        parse_hook(&self.c.send_ok(&req, "createWebhook", None)?)
    }

    fn delete_webhook(&self, owner: &str, repo: &str, hook_id: &str) -> GitResult<()> {
        let t = self.c.token()?;
        let req = delete_webhook_request(&self.api, t.expose_secret(), owner, repo, hook_id);
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
        redirect_uri: Option<&str>,
    ) -> GitResult<OAuthToken> {
        let req = oauth_exchange_request(
            &self.web,
            client_id,
            client_secret.expose_secret(),
            code,
            redirect_uri,
        );
        let resp = self.c.send(&req)?;
        parse_oauth(ProviderKind::GitLab, &resp, "scope")
    }

    fn get_authenticated_user(&self) -> GitResult<GitUser> {
        let t = self.c.token()?;
        let req = user_request(&self.api, t.expose_secret());
        parse_user(&self.c.send_ok(&req, "getUser", None)?)
    }

    fn verify_webhook(&self, headers: &Headers, body: &[u8], secret: &str) -> bool {
        webhook::verify(ProviderKind::GitLab, headers, body, secret)
    }

    fn parse_webhook(&self, headers: &Headers, body: &[u8]) -> GitResult<WebhookEvent> {
        webhook::parse_gitlab(headers, body)
    }

    fn last_rate_limit(&self) -> Option<RateLimit> {
        self.c.last_rate_limit()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_provider::transport::FakeTransport;
    use crate::git_provider::GitError;
    use crate::profile::{MemorySecretStore, Provider, SecretKey};

    fn setup(base: Option<&str>) -> (Arc<FakeTransport>, GitLabProvider) {
        let t = Arc::new(FakeTransport::new());
        let s = Arc::new(MemorySecretStore::default());
        s.set(
            &SecretKey::access_token(Provider::Other("gitlab".into())),
            SecretString::from("glpat-test".to_owned()),
        )
        .unwrap();
        (t.clone(), GitLabProvider::new(t, s, base))
    }

    #[test]
    fn base_urls() {
        assert_eq!(api_base(None), "https://gitlab.com/api/v4");
        assert_eq!(
            api_base(Some("https://git.corp.io/")),
            "https://git.corp.io/api/v4"
        );
    }

    #[test]
    fn list_repos_maps_visibility_and_default_branch() {
        let (t, p) = setup(None);
        t.push_json(
            200,
            &[("RateLimit-Remaining", "590"), ("RateLimit-Limit", "600")],
            r#"[{"id":10,"name":"Proj","path_with_namespace":"grp/proj","visibility":"private",
                 "web_url":"https://gitlab.com/grp/proj","default_branch":null},
                {"id":11,"name":"Pub","path_with_namespace":"grp/pub","visibility":"public",
                 "web_url":"https://gitlab.com/grp/pub","default_branch":"develop"}]"#,
        );
        let r = p.list_repos().unwrap();
        assert!(r[0].is_private && r[0].default_branch == "main");
        assert!(!r[1].is_private && r[1].default_branch == "develop");
        let req = &t.requests()[0];
        assert_eq!(req.headers.get("authorization"), Some("Bearer glpat-test"));
        assert!(req
            .url
            .starts_with("https://gitlab.com/api/v4/projects?membership=true"));
        assert_eq!(p.last_rate_limit().unwrap().remaining, Some(590));
    }

    #[test]
    fn self_hosted_and_encoded_project_id() {
        let (t, p) = setup(Some("https://git.corp.io"));
        t.push_json(200, &[], "[]");
        assert!(p
            .get_file_tree("grp/sub", "proj", Some("feat/x"))
            .unwrap()
            .is_empty());
        assert_eq!(
            t.requests()[0].url,
            "https://git.corp.io/api/v4/projects/grp%2Fsub%2Fproj/repository/tree?recursive=true&per_page=100&ref=feat%2Fx"
        );
    }

    #[test]
    fn tree_paginates_and_maps() {
        let (t, p) = setup(None);
        t.push_json(
            200,
            &[(
                "Link",
                "<https://gitlab.com/api/v4/projects/g%2Fp/repository/tree?page=2>; rel=\"next\"",
            )],
            r#"[{"id":"1","name":"src","type":"tree","path":"src","mode":"040000"}]"#,
        );
        t.push_json(
            200,
            &[],
            r#"[{"id":"2","name":"a.rs","type":"blob","path":"src/a.rs","mode":"100644"}]"#,
        );
        let tree = p.get_file_tree("g", "p", None).unwrap();
        assert_eq!(tree.len(), 2);
        assert_eq!(
            (tree[0].kind, tree[1].kind),
            (TreeEntryKind::Tree, TreeEntryKind::Blob)
        );
        assert!(t.requests()[0].url.ends_with("ref=HEAD"));
    }

    #[test]
    fn file_content_url_and_html_url() {
        let (t, p) = setup(None);
        t.push_json(
            200,
            &[],
            r#"{"file_name":"a.rs","file_path":"src/a.rs","size":5,"encoding":"base64","content":"aGVsbG8=","ref":"main"}"#,
        );
        let f = p
            .get_file_content("grp", "proj", "src/a.rs", Some("main"))
            .unwrap();
        assert_eq!(f.decode().unwrap(), b"hello");
        assert_eq!(
            f.html_url,
            "https://gitlab.com/grp/proj/-/blob/main/src/a.rs"
        );
        assert_eq!(
            t.requests()[0].url,
            "https://gitlab.com/api/v4/projects/grp%2Fproj/repository/files/src%2Fa.rs?ref=main"
        );
        t.push_json(404, &[], "{}");
        assert!(matches!(
            p.get_file_content("g", "p", "x", None),
            Err(GitError::NotFound(_))
        ));
    }

    #[test]
    fn issues_create_list() {
        let (t, p) = setup(None);
        t.push_json(201, &[], r#"{"id":900,"iid":4,"title":"T","web_url":"https://gitlab.com/g/p/-/issues/4","state":"opened"}"#);
        let i = p
            .create_issue("g", "p", "T", "desc", &["a".into(), "b".into()])
            .unwrap();
        assert_eq!((i.iid, i.number), (Some(4), None));
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[0].body_text().unwrap()).unwrap();
        assert_eq!(sent["labels"], "a,b");
        assert_eq!(sent["description"], "desc");

        t.push_json(200, &[], "[]");
        p.list_issues("g", "p", IssueStateFilter::Open).unwrap();
        assert!(t.requests()[1].url.contains("state=opened&per_page=100"));
        t.push_json(200, &[], "[]");
        p.list_issues("g", "p", IssueStateFilter::All).unwrap();
        assert!(t.requests()[2].url.contains("state=all"));
    }

    #[test]
    fn commits_and_diffs() {
        let (t, p) = setup(None);
        t.push_json(
            200,
            &[],
            r#"[{"id":"abc123","message":"feat","author_name":"Zed","author_email":"z@x","authored_date":"2024-05-01T00:00:00Z","web_url":"https://gitlab.com/g/p/-/commit/abc123"}]"#,
        );
        let c = p.list_commits("g", "p", Some("main"), 5).unwrap();
        assert_eq!(c[0].sha, "abc123");
        assert!(t.requests()[0].url.contains("ref_name=main"));

        t.push_json(
            200,
            &[],
            r#"[{"old_path":"a","new_path":"a","new_file":false,"renamed_file":false,"deleted_file":false,"diff":"@@ -1 +1,2 @@\n-x\n+y\n+z\n"},
                {"old_path":"b","new_path":"b","new_file":true,"renamed_file":false,"deleted_file":false,"diff":"@@ -0,0 +1 @@\n+n\n"},
                {"old_path":"c","new_path":"c","new_file":false,"renamed_file":false,"deleted_file":true,"diff":""},
                {"old_path":"d","new_path":"e","new_file":false,"renamed_file":true,"deleted_file":false,"diff":""}]"#,
        );
        let d = p.get_commit_diff("g", "p", "abc123").unwrap();
        assert_eq!((d[0].additions, d[0].deletions), (2, 1));
        assert_eq!(d[1].kind, ChangeKind::Added);
        assert_eq!((d[2].kind, d[2].patch.clone()), (ChangeKind::Removed, None));
        assert_eq!(
            (d[3].kind, d[3].old_path.as_str(), d[3].path.as_str()),
            (ChangeKind::Renamed, "d", "e")
        );
    }

    #[test]
    fn branch_mr_webhook() {
        let (t, p) = setup(None);
        t.push_json(201, &[], r#"{"name":"feat","commit":{"id":"c0ffee"}}"#);
        let b = p.create_branch("g", "p", "feat", "main").unwrap();
        assert_eq!(b.sha, "c0ffee");
        assert!(t.requests()[0]
            .url
            .ends_with("/repository/branches?branch=feat&ref=main"));
        assert!(t.requests()[0].body.is_none());

        t.push_json(
            201,
            &[],
            r#"{"id":50,"iid":2,"title":"Draft: Add","web_url":"https://gitlab.com/g/p/-/merge_requests/2","state":"opened","source_branch":"feat","target_branch":"main"}"#,
        );
        let pr = p
            .create_pull_request(
                "g",
                "p",
                &NewPullRequest {
                    title: "Add".into(),
                    body: "d".into(),
                    head: "feat".into(),
                    base: "main".into(),
                    draft: true,
                },
            )
            .unwrap();
        assert_eq!((pr.number, pr.id.as_str()), (2, "50"));
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[1].body_text().unwrap()).unwrap();
        assert_eq!(sent["title"], "Draft: Add");
        assert_eq!(sent["source_branch"], "feat");

        t.push_json(201, &[], r#"{"id":5}"#);
        assert_eq!(
            p.create_webhook("g", "p", "https://h", "tok").unwrap().id,
            "5"
        );
        let sent: serde_json::Value =
            serde_json::from_str(&t.requests()[2].body_text().unwrap()).unwrap();
        assert_eq!(sent["token"], "tok");
        assert_eq!(sent["push_events"], true);
        assert_eq!(sent["enable_ssl_verification"], true);

        t.push_json(404, &[], "{}");
        p.delete_webhook("g", "p", "5").unwrap();
        t.push_json(403, &[], "{\"message\":\"nope\"}");
        assert!(matches!(
            p.delete_webhook("g", "p", "5"),
            Err(GitError::Forbidden { .. })
        ));
    }

    #[test]
    fn oauth_user_and_errors() {
        let (t, p) = setup(Some("https://git.corp.io"));
        t.push_json(
            200,
            &[],
            r#"{"access_token":"at","token_type":"Bearer","scope":"api","refresh_token":"rt"}"#,
        );
        let tok = p
            .exchange_code_for_token(
                "cid",
                &SecretString::from("cs".to_owned()),
                "code",
                Some("http://127.0.0.1:1/cb"),
            )
            .unwrap();
        assert_eq!(tok.refresh_token.as_ref().unwrap().expose_secret(), "rt");
        let req = &t.requests()[0];
        assert_eq!(req.url, "https://git.corp.io/oauth/token");
        let sent: serde_json::Value = serde_json::from_str(&req.body_text().unwrap()).unwrap();
        assert_eq!(sent["grant_type"], "authorization_code");
        assert_eq!(sent["redirect_uri"], "http://127.0.0.1:1/cb");

        t.push_json(400, &[], r#"{"error":"invalid_grant"}"#);
        assert!(matches!(
            p.exchange_code_for_token("c", &SecretString::from("s".to_owned()), "x", None),
            Err(GitError::OAuth(_))
        ));

        t.push_json(
            200,
            &[],
            r#"{"username":"zed","id":3,"avatar_url":"https://a","name":"Zed Z"}"#,
        );
        let u = p.get_authenticated_user().unwrap();
        assert_eq!(
            (u.login.as_str(), u.name.as_deref()),
            ("zed", Some("Zed Z"))
        );

        t.push_json(429, &[("Retry-After", "42")], "");
        assert!(matches!(
            p.get_authenticated_user(),
            Err(GitError::RateLimited {
                retry_after_secs: Some(42),
                ..
            })
        ));
        t.push_json(401, &[], "");
        assert!(matches!(
            p.list_repos(),
            Err(GitError::Unauthorized("GitLab"))
        ));
    }

    #[test]
    fn webhook_token_flow() {
        let (_t, p) = setup(None);
        let h = Headers::from_pairs([("X-Gitlab-Token", "sek"), ("X-Gitlab-Event", "Push Hook")]);
        assert!(p.verify_webhook(&h, b"{}", "sek"));
        assert!(!p.verify_webhook(&h, b"{}", "other"));
        assert!(matches!(
            p.parse_webhook(&h, b"{}").unwrap(),
            WebhookEvent::Push(_)
        ));
    }
}
