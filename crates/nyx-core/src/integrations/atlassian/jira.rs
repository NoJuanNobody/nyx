//! Jira Cloud REST API v3: projects, issue types, search, create/update issue, comments,
//! transitions, dynamic webhooks.
//!
//! Ports `jira.service.ts` (Basic auth with an API token against a site URL) and the Jira half of
//! `atlassian.service.ts` (OAuth bearer through the `api.atlassian.com/ex/jira/{cloudId}` gateway),
//! now behind one [`JiraAuth`] enum.
//!
//! # Public API for other modules (for example the AI-69 ticket tracker adapter)
//! - Pure builders returning an [`HttpRequest`]: [`create_issue_request`], [`search_request`],
//!   [`update_issue_request`], ... plus matching `parse_*` functions. Use these if you own the
//!   transport.
//! - [`JiraClient`] glues them to an [`Http`]: `create_issue(&NewIssue)`,
//!   `search_issues(&SearchQuery)`, `get_issue`, `update_issue`, `add_comment`,
//!   `transition_issue_by_name`.
//!
//! Deviations from the TS: search uses `POST /rest/api/3/search/jql` (Atlassian removed
//! `GET /search`), project listing is paginated, and `createIssue` returns the real response shape
//! ([`CreatedIssue`]: id, key, self) instead of pretending it is a full issue.

use std::sync::OnceLock;

use base64::Engine;
use regex::Regex;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::adf::{adf_to_text, text_to_adf};
use crate::git_provider::util::encode_component;
use crate::integrations::http::{classify, parse_json, Http};
use crate::integrations::{HttpMethod, HttpRequest, HttpResponse, IntegrationError, Result};
use crate::model::TicketStatus;
use crate::security::ssrf::UrlPolicy;

/// Display name used in errors.
pub const PROVIDER: &str = "Jira";
/// Summary length limit enforced by Jira (and by the TS service).
pub const MAX_SUMMARY_CHARS: usize = 255;
/// Fields requested by [`SearchQuery`] unless overridden.
pub const DEFAULT_SEARCH_FIELDS: &[&str] = &[
    "summary",
    "status",
    "issuetype",
    "labels",
    "priority",
    "assignee",
    "updated",
];

// ── Auth ────────────────────────────────────────────

/// How to authenticate to Jira. Secrets are held as [`SecretString`] (redacted `Debug`).
#[derive(Debug)]
pub enum JiraAuth {
    /// OAuth 3LO bearer token through the Atlassian gateway.
    OAuth {
        /// Access token.
        access_token: SecretString,
        /// Cloud id of the site.
        cloud_id: String,
    },
    /// Email + API token (Basic) against the site URL itself.
    Basic {
        /// Site URL without trailing slash, for example `https://acme.atlassian.net`.
        base_url: String,
        /// Account email.
        email: String,
        /// API token.
        api_token: SecretString,
    },
}

impl JiraAuth {
    /// OAuth auth. `cloud_id` must be a UUID-like id (URL-path safe).
    pub fn oauth(access_token: SecretString, cloud_id: &str) -> Result<Self> {
        if cloud_id.is_empty()
            || !cloud_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return Err(IntegrationError::Invalid(format!(
                "bad Atlassian cloud id: {cloud_id:?}"
            )));
        }
        Ok(Self::OAuth {
            access_token,
            cloud_id: cloud_id.to_owned(),
        })
    }

    /// Basic auth. `base_url` must pass the SSRF policy (https, public host).
    pub fn basic(base_url: &str, email: &str, api_token: SecretString) -> Result<Self> {
        let t = UrlPolicy::strict()
            .check_url(base_url)
            .map_err(|e| IntegrationError::Invalid(format!("Jira base URL rejected: {e}")))?;
        Ok(Self::Basic {
            base_url: t.url.as_str().trim_end_matches('/').to_owned(),
            email: email.to_owned(),
            api_token,
        })
    }

    /// Base URL all `/rest/api/3/...` paths hang off.
    #[must_use]
    pub fn api_base(&self) -> String {
        match self {
            Self::OAuth { cloud_id, .. } => {
                format!("https://api.atlassian.com/ex/jira/{cloud_id}")
            }
            Self::Basic { base_url, .. } => base_url.clone(),
        }
    }

    /// `Authorization` header value.
    #[must_use]
    pub fn authorization(&self) -> String {
        match self {
            Self::OAuth { access_token, .. } => {
                format!("Bearer {}", access_token.expose_secret())
            }
            Self::Basic {
                email, api_token, ..
            } => {
                let raw = format!("{email}:{}", api_token.expose_secret());
                format!(
                    "Basic {}",
                    base64::engine::general_purpose::STANDARD.encode(raw)
                )
            }
        }
    }
}

// ── Models ──────────────────────────────────────────

/// Jira project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JiraProject {
    /// Numeric id (string).
    pub id: String,
    /// Project key.
    pub key: String,
    /// Display name.
    pub name: String,
    /// API URL.
    #[serde(rename = "self", default)]
    pub self_url: String,
}

/// Issue type available in a project.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JiraIssueType {
    /// Id.
    pub id: String,
    /// Name, for example `Task`.
    pub name: String,
    /// Whether this is a sub-task type.
    #[serde(default)]
    pub subtask: bool,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
}

/// Status category (`new`, `indeterminate`, `done`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusCategory {
    /// Key, for example `indeterminate`.
    #[serde(default)]
    pub key: Option<String>,
    /// Name, for example `In Progress`.
    pub name: String,
}

/// Issue status.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraStatus {
    /// Status name (workflow specific).
    pub name: String,
    /// Workflow-independent category.
    #[serde(default)]
    pub status_category: Option<StatusCategory>,
}

/// `{ name }` reference (issue type, priority).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedRef {
    /// Name.
    pub name: String,
}

/// Jira user reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JiraUser {
    /// Account id.
    pub account_id: String,
    /// Display name.
    #[serde(default)]
    pub display_name: Option<String>,
}

/// Issue fields we read.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct JiraIssueFields {
    /// Summary.
    #[serde(default)]
    pub summary: String,
    /// Status.
    #[serde(default)]
    pub status: Option<JiraStatus>,
    /// Issue type.
    #[serde(default)]
    pub issuetype: Option<NamedRef>,
    /// Labels.
    #[serde(default)]
    pub labels: Vec<String>,
    /// Priority.
    #[serde(default)]
    pub priority: Option<NamedRef>,
    /// Assignee.
    #[serde(default)]
    pub assignee: Option<JiraUser>,
    /// Description as raw ADF (use [`adf_to_text`] to flatten).
    #[serde(default)]
    pub description: Option<Value>,
    /// Last update timestamp (ISO 8601).
    #[serde(default)]
    pub updated: Option<String>,
}

/// An issue as returned by get/search.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JiraIssue {
    /// Numeric id (string).
    pub id: String,
    /// Key, for example `NYX-12`.
    pub key: String,
    /// API URL.
    #[serde(rename = "self", default)]
    pub self_url: String,
    /// Fields.
    #[serde(default)]
    pub fields: JiraIssueFields,
}

impl JiraIssue {
    /// Browse URL on `site_url` (for example `https://acme.atlassian.net/browse/NYX-12`).
    #[must_use]
    pub fn browse_url(&self, site_url: &str) -> String {
        format!("{}/browse/{}", site_url.trim_end_matches('/'), self.key)
    }

    /// Description flattened to Markdown-ish text.
    #[must_use]
    pub fn description_text(&self) -> String {
        self.fields
            .description
            .as_ref()
            .map(adf_to_text)
            .unwrap_or_default()
    }

    /// Nyx ticket status derived from the Jira status category (falling back to the status name).
    #[must_use]
    pub fn ticket_status(&self) -> TicketStatus {
        self.fields.status.as_ref().map_or(TicketStatus::Open, |s| {
            status_to_ticket_status(
                s.status_category
                    .as_ref()
                    .map_or(s.name.as_str(), |c| c.name.as_str()),
            )
        })
    }
}

/// Result of creating an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedIssue {
    /// Numeric id (string).
    pub id: String,
    /// Key.
    pub key: String,
    /// API URL.
    #[serde(rename = "self", default)]
    pub self_url: String,
}

/// One page of search results.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    /// Issues on this page.
    #[serde(default)]
    pub issues: Vec<JiraIssue>,
    /// Pass back as [`SearchQuery::next_page_token`] for the next page.
    #[serde(default)]
    pub next_page_token: Option<String>,
    /// Whether this was the last page.
    #[serde(default)]
    pub is_last: bool,
}

/// An issue transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JiraTransition {
    /// Transition id (pass to [`transition_request`]).
    pub id: String,
    /// Transition name, for example `Start progress`.
    pub name: String,
    /// Target status.
    #[serde(default)]
    pub to: Option<JiraStatus>,
}

/// An issue comment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JiraComment {
    /// Comment id.
    pub id: String,
    /// Body as raw ADF.
    #[serde(default)]
    pub body: Option<Value>,
    /// Author.
    #[serde(default)]
    pub author: Option<JiraUser>,
    /// Creation timestamp.
    #[serde(default)]
    pub created: Option<String>,
}

impl JiraComment {
    /// Body flattened to text.
    #[must_use]
    pub fn body_text(&self) -> String {
        self.body.as_ref().map(adf_to_text).unwrap_or_default()
    }
}

/// Map a Jira status (category) name to a Nyx ticket status. Port of `JIRA_STATUS_TO_NYX` plus the
/// route's `pending/in_progress/completed` to `open/in_progress/closed` mapping; unknown names map
/// to `Open`. Category keys (`new`, `indeterminate`, `done`) are accepted too.
#[must_use]
pub fn status_to_ticket_status(name: &str) -> TicketStatus {
    match name.trim().to_ascii_lowercase().as_str() {
        "in progress" | "indeterminate" => TicketStatus::InProgress,
        "done" => TicketStatus::Closed,
        _ => TicketStatus::Open,
    }
}

// ── Inputs ──────────────────────────────────────────

/// Input for creating an issue. `description` is Markdown; it is converted to ADF.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewIssue {
    /// Project key (validated).
    pub project_key: String,
    /// Summary (newlines collapsed, truncated to 255 chars).
    pub summary: String,
    /// Markdown description (may be empty).
    pub description: String,
    /// Issue type name; defaults to `Task`.
    pub issue_type: Option<String>,
    /// Labels (Jira forbids spaces; they are replaced with `_`).
    pub labels: Vec<String>,
    /// Priority name.
    pub priority: Option<String>,
    /// Assignee account id.
    pub assignee_account_id: Option<String>,
    /// Appended to the description as a "Source:" link (the Nyx spec URL).
    pub spec_url: Option<String>,
}

/// Partial issue update. Unset fields are left alone.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IssueUpdate {
    /// New summary.
    pub summary: Option<String>,
    /// New Markdown description.
    pub description: Option<String>,
    /// Replacement label set.
    pub labels: Option<Vec<String>>,
    /// New priority name.
    pub priority: Option<String>,
    /// New assignee account id.
    pub assignee_account_id: Option<String>,
}

/// A JQL search.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    /// JQL text.
    pub jql: String,
    /// Page size (1 to 100).
    pub max_results: u32,
    /// Fields to return.
    pub fields: Vec<String>,
    /// Continuation token from the previous page.
    pub next_page_token: Option<String>,
}

impl SearchQuery {
    /// Raw JQL with default fields and page size 50.
    #[must_use]
    pub fn new(jql: impl Into<String>) -> Self {
        Self {
            jql: jql.into(),
            max_results: 50,
            fields: DEFAULT_SEARCH_FIELDS
                .iter()
                .map(|s| (*s).to_owned())
                .collect(),
            next_page_token: None,
        }
    }

    /// Issues of a project, newest first (port of `searchIssues(projectKey)`).
    pub fn for_project(project_key: &str, max_results: u32) -> Result<Self> {
        validate_project_key(project_key)?;
        let mut q = Self::new(format!("project = \"{project_key}\" ORDER BY updated DESC"));
        q.max_results = max_results;
        Ok(q)
    }
}

// ── Validation ──────────────────────────────────────

fn key_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[A-Za-z][A-Za-z0-9_]*$").unwrap_or_else(|_| unreachable!()))
}
fn issue_key_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"^[A-Za-z][A-Za-z0-9_]*-[0-9]+$").unwrap_or_else(|_| unreachable!())
    })
}

/// Reject project keys that could break out of a URL path or JQL string.
pub fn validate_project_key(key: &str) -> Result<()> {
    if key.len() <= 255 && key_re().is_match(key) {
        Ok(())
    } else {
        Err(IntegrationError::Invalid(format!(
            "bad Jira project key: {key:?}"
        )))
    }
}

/// Reject issue keys that are not `PROJ-123` shaped.
pub fn validate_issue_key(key: &str) -> Result<()> {
    if key.len() <= 300 && issue_key_re().is_match(key) {
        Ok(())
    } else {
        Err(IntegrationError::Invalid(format!(
            "bad Jira issue key: {key:?}"
        )))
    }
}

fn clean_summary(s: &str) -> Result<String> {
    let one_line = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() {
        return Err(IntegrationError::Invalid("issue summary is empty".into()));
    }
    Ok(one_line.chars().take(MAX_SUMMARY_CHARS).collect())
}

fn clean_labels(labels: &[String]) -> Vec<String> {
    labels
        .iter()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join("_"))
        .filter(|l| !l.is_empty())
        .collect()
}

// ── Request builders ────────────────────────────────

fn req(auth: &JiraAuth, method: HttpMethod, path: &str) -> HttpRequest {
    HttpRequest::new(method, format!("{}{path}", auth.api_base()))
        .header("Authorization", auth.authorization())
        .header("Accept", "application/json")
}

/// `GET /rest/api/3/project/search`.
#[must_use]
pub fn list_projects_request(auth: &JiraAuth, start_at: u32, max_results: u32) -> HttpRequest {
    req(
        auth,
        HttpMethod::Get,
        &format!("/rest/api/3/project/search?startAt={start_at}&maxResults={max_results}"),
    )
}

/// `GET /rest/api/3/issue/createmeta/{project}/issuetypes`.
pub fn list_issue_types_request(auth: &JiraAuth, project_key: &str) -> Result<HttpRequest> {
    validate_project_key(project_key)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!("/rest/api/3/issue/createmeta/{project_key}/issuetypes"),
    ))
}

/// `POST /rest/api/3/issue`.
pub fn create_issue_request(auth: &JiraAuth, issue: &NewIssue) -> Result<HttpRequest> {
    validate_project_key(&issue.project_key)?;
    let mut fields = Map::new();
    fields.insert("project".into(), json!({"key": issue.project_key}));
    fields.insert("summary".into(), json!(clean_summary(&issue.summary)?));
    if !issue.description.trim().is_empty() || issue.spec_url.is_some() {
        fields.insert(
            "description".into(),
            text_to_adf(&issue.description, issue.spec_url.as_deref()),
        );
    }
    fields.insert(
        "issuetype".into(),
        json!({"name": issue.issue_type.as_deref().unwrap_or("Task")}),
    );
    let labels = clean_labels(&issue.labels);
    if !labels.is_empty() {
        fields.insert("labels".into(), json!(labels));
    }
    if let Some(p) = &issue.priority {
        fields.insert("priority".into(), json!({"name": p}));
    }
    if let Some(a) = &issue.assignee_account_id {
        fields.insert("assignee".into(), json!({"accountId": a}));
    }
    Ok(req(auth, HttpMethod::Post, "/rest/api/3/issue").json(&json!({"fields": fields})))
}

/// `PUT /rest/api/3/issue/{key}`.
pub fn update_issue_request(
    auth: &JiraAuth,
    issue_key: &str,
    update: &IssueUpdate,
) -> Result<HttpRequest> {
    validate_issue_key(issue_key)?;
    let mut fields = Map::new();
    if let Some(s) = &update.summary {
        fields.insert("summary".into(), json!(clean_summary(s)?));
    }
    if let Some(d) = &update.description {
        fields.insert("description".into(), text_to_adf(d, None));
    }
    if let Some(l) = &update.labels {
        fields.insert("labels".into(), json!(clean_labels(l)));
    }
    if let Some(p) = &update.priority {
        fields.insert("priority".into(), json!({"name": p}));
    }
    if let Some(a) = &update.assignee_account_id {
        fields.insert("assignee".into(), json!({"accountId": a}));
    }
    if fields.is_empty() {
        return Err(IntegrationError::Invalid("no fields to update".into()));
    }
    Ok(req(
        auth,
        HttpMethod::Put,
        &format!("/rest/api/3/issue/{issue_key}"),
    )
    .json(&json!({"fields": fields})))
}

/// `GET /rest/api/3/issue/{key}`.
pub fn get_issue_request(auth: &JiraAuth, issue_key: &str) -> Result<HttpRequest> {
    validate_issue_key(issue_key)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!("/rest/api/3/issue/{issue_key}"),
    ))
}

/// `POST /rest/api/3/search/jql`.
#[must_use]
pub fn search_request(auth: &JiraAuth, q: &SearchQuery) -> HttpRequest {
    let mut body = json!({
        "jql": q.jql,
        "maxResults": q.max_results.clamp(1, 100),
        "fields": q.fields,
    });
    if let Some(t) = &q.next_page_token {
        body["nextPageToken"] = json!(t);
    }
    req(auth, HttpMethod::Post, "/rest/api/3/search/jql").json(&body)
}

/// `POST /rest/api/3/issue/{key}/comment` with a Markdown body converted to ADF.
pub fn add_comment_request(
    auth: &JiraAuth,
    issue_key: &str,
    markdown: &str,
) -> Result<HttpRequest> {
    validate_issue_key(issue_key)?;
    if markdown.trim().is_empty() {
        return Err(IntegrationError::Invalid("comment is empty".into()));
    }
    Ok(req(
        auth,
        HttpMethod::Post,
        &format!("/rest/api/3/issue/{issue_key}/comment"),
    )
    .json(&json!({"body": text_to_adf(markdown, None)})))
}

/// `GET /rest/api/3/issue/{key}/comment`.
pub fn list_comments_request(auth: &JiraAuth, issue_key: &str) -> Result<HttpRequest> {
    validate_issue_key(issue_key)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!("/rest/api/3/issue/{issue_key}/comment?orderBy=created"),
    ))
}

/// `GET /rest/api/3/issue/{key}/transitions`.
pub fn list_transitions_request(auth: &JiraAuth, issue_key: &str) -> Result<HttpRequest> {
    validate_issue_key(issue_key)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!("/rest/api/3/issue/{issue_key}/transitions"),
    ))
}

/// `POST /rest/api/3/issue/{key}/transitions`.
pub fn transition_request(
    auth: &JiraAuth,
    issue_key: &str,
    transition_id: &str,
) -> Result<HttpRequest> {
    validate_issue_key(issue_key)?;
    if transition_id.is_empty() || !transition_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(IntegrationError::Invalid(format!(
            "bad transition id: {transition_id:?}"
        )));
    }
    Ok(req(
        auth,
        HttpMethod::Post,
        &format!("/rest/api/3/issue/{issue_key}/transitions"),
    )
    .json(&json!({"transition": {"id": transition_id}})))
}

/// `POST /rest/api/3/webhook` for status-sync events. `jql_filter` must be non-empty (Jira rejects
/// an empty filter; the TS service sent `''`).
pub fn register_webhook_request(
    auth: &JiraAuth,
    callback_url: &str,
    jql_filter: &str,
) -> Result<HttpRequest> {
    if jql_filter.trim().is_empty() {
        return Err(IntegrationError::Invalid("jql filter is required".into()));
    }
    Ok(
        req(auth, HttpMethod::Post, "/rest/api/3/webhook").json(&json!({
            "url": callback_url,
            "webhooks": [{
                "events": ["jira:issue_updated", "jira:issue_deleted"],
                "jqlFilter": jql_filter,
            }],
        })),
    )
}

/// `DELETE /rest/api/3/webhook`.
#[must_use]
pub fn delete_webhook_request(auth: &JiraAuth, webhook_ids: &[u64]) -> HttpRequest {
    req(auth, HttpMethod::Delete, "/rest/api/3/webhook").json(&json!({"webhookIds": webhook_ids}))
}

// ── Parsers ─────────────────────────────────────────

/// Turn a Jira error body (`errorMessages` + `errors`) into one readable line.
#[must_use]
pub fn error_detail(resp: &HttpResponse) -> String {
    let Ok(v) = serde_json::from_slice::<Value>(&resp.body) else {
        return resp.text().chars().take(200).collect();
    };
    let mut parts: Vec<String> = v
        .get("errorMessages")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|m| m.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    if let Some(o) = v.get("errors").and_then(Value::as_object) {
        parts.extend(
            o.iter()
                .filter_map(|(k, m)| m.as_str().map(|m| format!("{k}: {m}"))),
        );
    }
    if parts.is_empty() {
        resp.text().chars().take(200).collect()
    } else {
        parts.join("; ")
    }
}

/// Check a response: 2xx passes; 400 becomes [`IntegrationError::Invalid`] with Jira's field
/// errors; other statuses are classified (401, 403, 404, 429, ...).
pub fn check(resp: &HttpResponse, op: &'static str) -> Result<()> {
    if resp.is_success() {
        Ok(())
    } else if resp.status == 400 {
        Err(IntegrationError::Invalid(format!(
            "Jira {op} rejected: {}",
            error_detail(resp)
        )))
    } else {
        Err(classify(PROVIDER, op, resp))
    }
}

/// Parse a project search page: `(projects, is_last)`.
pub fn parse_projects(resp: &HttpResponse) -> Result<(Vec<JiraProject>, bool)> {
    check(resp, "list projects")?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        #[serde(default)]
        values: Vec<JiraProject>,
        #[serde(default)]
        is_last: Option<bool>,
    }
    let p: Page = parse_json(resp, "projects")?;
    let last = p.is_last.unwrap_or(true);
    Ok((p.values, last))
}

/// Parse issue types for a project (accepts both `issueTypes` and `values` shapes).
pub fn parse_issue_types(resp: &HttpResponse) -> Result<Vec<JiraIssueType>> {
    check(resp, "list issue types")?;
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Page {
        #[serde(default)]
        issue_types: Option<Vec<JiraIssueType>>,
        #[serde(default)]
        values: Option<Vec<JiraIssueType>>,
    }
    let p: Page = parse_json(resp, "issue types")?;
    Ok(p.issue_types.or(p.values).unwrap_or_default())
}

/// Parse a create-issue response.
pub fn parse_created(resp: &HttpResponse) -> Result<CreatedIssue> {
    check(resp, "create issue")?;
    parse_json(resp, "created issue")
}

/// Parse a get-issue response.
pub fn parse_issue(resp: &HttpResponse) -> Result<JiraIssue> {
    check(resp, "get issue")?;
    parse_json(resp, "issue")
}

/// Check an update response (204 No Content on success).
pub fn parse_updated(resp: &HttpResponse) -> Result<()> {
    check(resp, "update issue")
}

/// Parse a search response.
pub fn parse_search(resp: &HttpResponse) -> Result<SearchPage> {
    check(resp, "search issues")?;
    parse_json(resp, "search results")
}

/// Parse a created comment.
pub fn parse_comment(resp: &HttpResponse) -> Result<JiraComment> {
    check(resp, "add comment")?;
    parse_json(resp, "comment")
}

/// Parse the comment list.
pub fn parse_comments(resp: &HttpResponse) -> Result<Vec<JiraComment>> {
    check(resp, "list comments")?;
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        comments: Vec<JiraComment>,
    }
    Ok(parse_json::<Page>(resp, "comments")?.comments)
}

/// Parse the transition list.
pub fn parse_transitions(resp: &HttpResponse) -> Result<Vec<JiraTransition>> {
    check(resp, "list transitions")?;
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        transitions: Vec<JiraTransition>,
    }
    Ok(parse_json::<Page>(resp, "transitions")?.transitions)
}

/// Parse a webhook registration; returns the first created webhook id when present.
pub fn parse_webhook_registration(resp: &HttpResponse) -> Result<Option<u64>> {
    check(resp, "register webhook")?;
    let v: Value = parse_json(resp, "webhook registration")?;
    Ok(v.pointer("/webhookRegistrationResult/0/createdWebhookId")
        .and_then(Value::as_u64))
}

/// Pick the transition whose name or target status matches `wanted` (case-insensitive).
#[must_use]
pub fn find_transition<'a>(
    transitions: &'a [JiraTransition],
    wanted: &str,
) -> Option<&'a JiraTransition> {
    transitions.iter().find(|t| {
        t.name.eq_ignore_ascii_case(wanted)
            || t.to
                .as_ref()
                .is_some_and(|s| s.name.eq_ignore_ascii_case(wanted))
    })
}

// ── Client ──────────────────────────────────────────

const MAX_PROJECT_PAGES: u32 = 20;

/// Jira client: builders + parsers over an [`Http`] (with rate-limit retries).
#[derive(Debug)]
pub struct JiraClient {
    http: Http,
    auth: JiraAuth,
}

impl JiraClient {
    /// New client.
    #[must_use]
    pub fn new(http: Http, auth: JiraAuth) -> Self {
        Self { http, auth }
    }

    fn exec(&self, r: &HttpRequest, op: &'static str) -> Result<HttpResponse> {
        let resp = self.http.send(r)?;
        if resp.status == 400 {
            check(&resp, op)?;
        }
        Ok(resp)
    }

    /// All projects visible to the user (up to 20 pages of 50).
    pub fn list_projects(&self) -> Result<Vec<JiraProject>> {
        let mut out = Vec::new();
        for page in 0..MAX_PROJECT_PAGES {
            let start = page * 50;
            let resp = self.exec(
                &list_projects_request(&self.auth, start, 50),
                "list projects",
            )?;
            let (mut items, last) = parse_projects(&resp)?;
            let empty = items.is_empty();
            out.append(&mut items);
            if last || empty {
                break;
            }
        }
        Ok(out)
    }

    /// Issue types of a project.
    pub fn list_issue_types(&self, project_key: &str) -> Result<Vec<JiraIssueType>> {
        let r = list_issue_types_request(&self.auth, project_key)?;
        parse_issue_types(&self.exec(&r, "list issue types")?)
    }

    /// Create an issue.
    pub fn create_issue(&self, issue: &NewIssue) -> Result<CreatedIssue> {
        let r = create_issue_request(&self.auth, issue)?;
        parse_created(&self.exec(&r, "create issue")?)
    }

    /// Fetch an issue.
    pub fn get_issue(&self, key: &str) -> Result<JiraIssue> {
        let r = get_issue_request(&self.auth, key)?;
        parse_issue(&self.exec(&r, "get issue")?)
    }

    /// Update fields of an issue.
    pub fn update_issue(&self, key: &str, update: &IssueUpdate) -> Result<()> {
        let r = update_issue_request(&self.auth, key, update)?;
        parse_updated(&self.exec(&r, "update issue")?)
    }

    /// Run a JQL search (one page).
    pub fn search_issues(&self, q: &SearchQuery) -> Result<SearchPage> {
        parse_search(&self.exec(&search_request(&self.auth, q), "search issues")?)
    }

    /// Add a Markdown comment.
    pub fn add_comment(&self, key: &str, markdown: &str) -> Result<JiraComment> {
        let r = add_comment_request(&self.auth, key, markdown)?;
        parse_comment(&self.exec(&r, "add comment")?)
    }

    /// List comments.
    pub fn list_comments(&self, key: &str) -> Result<Vec<JiraComment>> {
        let r = list_comments_request(&self.auth, key)?;
        parse_comments(&self.exec(&r, "list comments")?)
    }

    /// Transitions currently available on an issue.
    pub fn list_transitions(&self, key: &str) -> Result<Vec<JiraTransition>> {
        let r = list_transitions_request(&self.auth, key)?;
        parse_transitions(&self.exec(&r, "list transitions")?)
    }

    /// Apply a transition by id.
    pub fn transition_issue(&self, key: &str, transition_id: &str) -> Result<()> {
        let r = transition_request(&self.auth, key, transition_id)?;
        check(&self.exec(&r, "transition issue")?, "transition issue")
    }

    /// Apply the transition whose name or target status equals `wanted` (for example `Done`).
    ///
    /// # Errors
    /// [`IntegrationError::NotFound`] if no available transition matches.
    pub fn transition_issue_by_name(&self, key: &str, wanted: &str) -> Result<()> {
        let all = self.list_transitions(key)?;
        let t = find_transition(&all, wanted).ok_or_else(|| {
            IntegrationError::NotFound(format!("no transition to `{wanted}` available on {key}"))
        })?;
        self.transition_issue(key, &t.id)
    }

    /// Register the status-sync webhook; returns the webhook id when Jira reports one. Failures are
    /// returned, not swallowed (the TS version returned `null`); callers that want best-effort
    /// behaviour can `.ok().flatten()`. Jira dynamic webhooks expire after 30 days unless refreshed.
    pub fn register_webhook(&self, callback_url: &str, jql_filter: &str) -> Result<Option<u64>> {
        let r = register_webhook_request(&self.auth, callback_url, jql_filter)?;
        parse_webhook_registration(&self.exec(&r, "register webhook")?)
    }

    /// Delete a registered webhook.
    pub fn delete_webhook(&self, webhook_id: u64) -> Result<()> {
        let r = delete_webhook_request(&self.auth, &[webhook_id]);
        check(&self.exec(&r, "delete webhook")?, "delete webhook")
    }
}

/// Percent-encode a JQL string for use in a query string (helper for callers that build GET URLs).
#[must_use]
pub fn encode_jql(jql: &str) -> String {
    encode_component(jql)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::git_provider::FakeTransport;
    use crate::integrations::http::{RecordingSleeper, RetryPolicy};

    const PROJECTS: &str = r#"{"self":"x","maxResults":50,"startAt":0,"total":2,"isLast":true,
      "values":[{"self":"https://api.atlassian.com/ex/jira/c/rest/api/3/project/10000","id":"10000","key":"NYX","name":"Nyx","projectTypeKey":"software"},
                {"id":"10001","key":"OPS","name":"Ops"}]}"#;
    const ISSUE_TYPES: &str = r#"{"maxResults":50,"startAt":0,"total":2,"issueTypes":[
      {"id":"10001","name":"Task","subtask":false,"description":"A task"},
      {"id":"10002","name":"Sub-task","subtask":true}]}"#;
    const CREATED: &str = r#"{"id":"10042","key":"NYX-42","self":"https://api.atlassian.com/ex/jira/c/rest/api/3/issue/10042"}"#;
    const ISSUE: &str = r#"{"id":"10042","key":"NYX-42","self":"https://x/10042","expand":"x",
      "fields":{"summary":"Fix login","status":{"name":"In Review","statusCategory":{"key":"indeterminate","name":"In Progress"}},
      "issuetype":{"name":"Bug"},"labels":["a","b"],"priority":{"name":"High"},
      "assignee":{"accountId":"acc-1","displayName":"Ada"},"updated":"2026-01-02T03:04:05.000+0000",
      "description":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Steps"}]}]}}}"#;
    const SEARCH: &str = r#"{"issues":[
      {"id":"1","key":"NYX-1","self":"s","fields":{"summary":"One","status":{"name":"To Do","statusCategory":{"key":"new","name":"To Do"}},"issuetype":{"name":"Task"}}},
      {"id":"2","key":"NYX-2","self":"s","fields":{"summary":"Two","status":{"name":"Done","statusCategory":{"key":"done","name":"Done"}},"issuetype":{"name":"Task"}}}],
      "nextPageToken":"tok-2","isLast":false}"#;
    const TRANSITIONS: &str = r#"{"expand":"transitions","transitions":[
      {"id":"11","name":"Start progress","to":{"name":"In Progress","statusCategory":{"key":"indeterminate","name":"In Progress"}}},
      {"id":"31","name":"Finish","to":{"name":"Done","statusCategory":{"key":"done","name":"Done"}}}]}"#;
    const COMMENT: &str = r#"{"id":"900","author":{"accountId":"acc-1","displayName":"Ada"},"created":"2026-01-01T00:00:00.000+0000",
      "body":{"type":"doc","version":1,"content":[{"type":"paragraph","content":[{"type":"text","text":"Looks good"}]}]}}"#;
    const ERR_400: &str = r#"{"errorMessages":["Issue type is required"],"errors":{"summary":"You must specify a summary of the issue."}}"#;

    fn oauth() -> JiraAuth {
        JiraAuth::oauth(SecretString::from("tok".to_owned()), "cloud-1").unwrap()
    }

    fn client(t: &Arc<FakeTransport>) -> JiraClient {
        let http = Http::new(t.clone())
            .with_sleeper(Arc::new(RecordingSleeper::new()))
            .with_policy(RetryPolicy::none());
        JiraClient::new(http, oauth())
    }

    fn body(r: &HttpRequest) -> Value {
        serde_json::from_str(&r.body_text().unwrap()).unwrap()
    }

    #[test]
    fn auth_urls_and_headers() {
        let a = oauth();
        assert_eq!(a.api_base(), "https://api.atlassian.com/ex/jira/cloud-1");
        assert_eq!(a.authorization(), "Bearer tok");
        let b = JiraAuth::basic(
            "https://acme.atlassian.net/",
            "me@acme.com",
            SecretString::from("tkn".to_owned()),
        )
        .unwrap();
        assert_eq!(b.api_base(), "https://acme.atlassian.net");
        // base64("me@acme.com:tkn")
        assert_eq!(b.authorization(), "Basic bWVAYWNtZS5jb206dGtu");
        assert!(!format!("{b:?}").contains("tkn"));
        assert!(!format!("{a:?}").contains("tok\""));
    }

    #[test]
    fn auth_rejects_unsafe_inputs() {
        assert!(JiraAuth::oauth(SecretString::from("t".to_owned()), "a/../b").is_err());
        assert!(JiraAuth::oauth(SecretString::from("t".to_owned()), "").is_err());
        for url in [
            "http://acme.atlassian.net",
            "https://127.0.0.1",
            "https://10.0.0.5/x",
            "ftp://x",
        ] {
            assert!(
                JiraAuth::basic(url, "e", SecretString::from("t".to_owned())).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn create_issue_request_shape() {
        let r = create_issue_request(
            &oauth(),
            &NewIssue {
                project_key: "NYX".into(),
                summary: "  Fix\nlogin  ".into(),
                description: "# Steps\n- one".into(),
                labels: vec!["needs review".into(), String::new()],
                priority: Some("High".into()),
                assignee_account_id: Some("acc-1".into()),
                spec_url: Some("https://nyx.io/spec/1".into()),
                ..NewIssue::default()
            },
        )
        .unwrap();
        assert_eq!(r.method, HttpMethod::Post);
        assert_eq!(
            r.url,
            "https://api.atlassian.com/ex/jira/cloud-1/rest/api/3/issue"
        );
        assert_eq!(r.headers.get("authorization"), Some("Bearer tok"));
        let b = body(&r);
        let f = &b["fields"];
        assert_eq!(f["project"]["key"], "NYX");
        assert_eq!(f["summary"], "Fix login");
        assert_eq!(f["issuetype"]["name"], "Task");
        assert_eq!(f["labels"], json!(["needs_review"]));
        assert_eq!(f["priority"]["name"], "High");
        assert_eq!(f["assignee"]["accountId"], "acc-1");
        assert_eq!(f["description"]["type"], "doc");
        assert_eq!(f["description"]["content"][0]["type"], "heading");
        let last = f["description"]["content"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()
            .clone();
        assert_eq!(last["content"][1]["text"], "https://nyx.io/spec/1");
    }

    #[test]
    fn create_issue_truncates_summary_and_omits_empty_description() {
        let r = create_issue_request(
            &oauth(),
            &NewIssue {
                project_key: "NYX".into(),
                summary: "é".repeat(300),
                issue_type: Some("Bug".into()),
                ..NewIssue::default()
            },
        )
        .unwrap();
        let b = body(&r);
        assert_eq!(
            b["fields"]["summary"].as_str().unwrap().chars().count(),
            255
        );
        assert!(b["fields"].get("description").is_none());
        assert_eq!(b["fields"]["issuetype"]["name"], "Bug");
    }

    #[test]
    fn validation_blocks_injection() {
        for k in ["", "NYX\" OR 1=1", "../x", "1ABC", "A B"] {
            assert!(validate_project_key(k).is_err(), "{k}");
            assert!(SearchQuery::for_project(k, 10).is_err());
        }
        for k in ["NYX", "nyx_2"] {
            assert!(validate_project_key(k).is_ok());
        }
        for k in ["NYX", "NYX-", "NYX-1/../x", "-1", "NYX-1 ", "NYX-1a"] {
            assert!(validate_issue_key(k).is_err(), "{k}");
        }
        assert!(validate_issue_key("NYX-12").is_ok());
        assert!(create_issue_request(&oauth(), &NewIssue::default()).is_err());
        assert!(create_issue_request(
            &oauth(),
            &NewIssue {
                project_key: "NYX".into(),
                summary: "   ".into(),
                ..NewIssue::default()
            }
        )
        .is_err());
        assert!(transition_request(&oauth(), "NYX-1", "1; drop").is_err());
    }

    #[test]
    fn update_request_is_put_with_only_set_fields() {
        let r = update_issue_request(
            &oauth(),
            "NYX-7",
            &IssueUpdate {
                summary: Some("New".into()),
                labels: Some(vec!["x".into()]),
                ..IssueUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(r.method, HttpMethod::Put);
        assert!(r.url.ends_with("/rest/api/3/issue/NYX-7"));
        let b = body(&r);
        assert_eq!(b["fields"]["summary"], "New");
        assert!(b["fields"].get("priority").is_none());
        assert!(update_issue_request(&oauth(), "NYX-7", &IssueUpdate::default()).is_err());
    }

    #[test]
    fn search_request_shape() {
        let mut q = SearchQuery::for_project("NYX", 500).unwrap();
        q.next_page_token = Some("tok".into());
        let r = search_request(&oauth(), &q);
        assert_eq!(r.method, HttpMethod::Post);
        assert!(r.url.ends_with("/rest/api/3/search/jql"));
        let b = body(&r);
        assert_eq!(b["jql"], "project = \"NYX\" ORDER BY updated DESC");
        assert_eq!(b["maxResults"], 100);
        assert_eq!(b["nextPageToken"], "tok");
        assert!(b["fields"].as_array().unwrap().contains(&json!("summary")));
    }

    #[test]
    fn parsers_on_fixtures() {
        let ok = |s: &str| HttpResponse::new(200, Default::default(), s);
        let (projects, last) = parse_projects(&ok(PROJECTS)).unwrap();
        assert!(last);
        assert_eq!(projects[0].key, "NYX");
        assert!(projects[0].self_url.ends_with("10000"));
        assert_eq!(projects[1].self_url, "");
        let types = parse_issue_types(&ok(ISSUE_TYPES)).unwrap();
        assert_eq!(types.len(), 2);
        assert!(types[1].subtask);
        let c = parse_created(&ok(CREATED)).unwrap();
        assert_eq!(c.key, "NYX-42");
        let i = parse_issue(&ok(ISSUE)).unwrap();
        assert_eq!(i.fields.summary, "Fix login");
        assert_eq!(i.fields.assignee.as_ref().unwrap().account_id, "acc-1");
        assert_eq!(i.description_text(), "Steps");
        assert_eq!(i.ticket_status(), TicketStatus::InProgress);
        assert_eq!(
            i.browse_url("https://acme.atlassian.net/"),
            "https://acme.atlassian.net/browse/NYX-42"
        );
        let s = parse_search(&ok(SEARCH)).unwrap();
        assert_eq!(s.issues.len(), 2);
        assert_eq!(s.next_page_token.as_deref(), Some("tok-2"));
        assert!(!s.is_last);
        assert_eq!(s.issues[0].ticket_status(), TicketStatus::Open);
        assert_eq!(s.issues[1].ticket_status(), TicketStatus::Closed);
        let t = parse_transitions(&ok(TRANSITIONS)).unwrap();
        assert_eq!(find_transition(&t, "done").unwrap().id, "31");
        assert_eq!(find_transition(&t, "start PROGRESS").unwrap().id, "11");
        assert!(find_transition(&t, "nope").is_none());
        let cm = parse_comment(&ok(COMMENT)).unwrap();
        assert_eq!(cm.body_text(), "Looks good");
        assert_eq!(
            parse_comments(&ok(&format!(r#"{{"comments":[{COMMENT}]}}"#)))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            parse_webhook_registration(&ok(
                r#"{"webhookRegistrationResult":[{"createdWebhookId":1000}]}"#
            ))
            .unwrap(),
            Some(1000)
        );
        assert_eq!(
            parse_webhook_registration(&ok(
                r#"{"webhookRegistrationResult":[{"errors":["bad"]}]}"#
            ))
            .unwrap(),
            None
        );
    }

    #[test]
    fn status_mapping_matches_ts() {
        assert_eq!(status_to_ticket_status("To Do"), TicketStatus::Open);
        assert_eq!(
            status_to_ticket_status("In Progress"),
            TicketStatus::InProgress
        );
        assert_eq!(status_to_ticket_status("Done"), TicketStatus::Closed);
        assert_eq!(status_to_ticket_status("Unknown"), TicketStatus::Open);
        assert_eq!(status_to_ticket_status(""), TicketStatus::Open);
        assert_eq!(
            status_to_ticket_status("indeterminate"),
            TicketStatus::InProgress
        );
    }

    #[test]
    fn error_mapping() {
        let r = |s, b: &str| HttpResponse::new(s, Default::default(), b);
        let e = parse_created(&r(400, ERR_400)).unwrap_err();
        assert!(matches!(&e, IntegrationError::Invalid(m)
            if m.contains("Issue type is required") && m.contains("summary: You must")));
        assert!(matches!(
            parse_issue(&r(401, "")),
            Err(IntegrationError::Unauthorized("Jira"))
        ));
        assert!(matches!(
            parse_issue(&r(404, "")),
            Err(IntegrationError::NotFound(_))
        ));
        assert!(matches!(
            parse_issue(&r(403, "no")),
            Err(IntegrationError::Forbidden { .. })
        ));
        assert!(matches!(
            parse_search(&r(429, "")),
            Err(IntegrationError::RateLimited { .. })
        ));
        assert!(matches!(
            parse_issue(&r(200, "[]")),
            Err(IntegrationError::Parse(_))
        ));
    }

    #[test]
    fn client_create_then_search_flow() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(201, &[], CREATED);
        t.push_json(200, &[], SEARCH);
        let c = client(&t);
        let created = c
            .create_issue(&NewIssue {
                project_key: "NYX".into(),
                summary: "Hello".into(),
                ..NewIssue::default()
            })
            .unwrap();
        assert_eq!(created.key, "NYX-42");
        let page = c
            .search_issues(&SearchQuery::for_project("NYX", 50).unwrap())
            .unwrap();
        assert_eq!(page.issues.len(), 2);
        assert_eq!(t.requests().len(), 2);
    }

    #[test]
    fn client_surfaces_jira_validation_errors() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(400, &[], ERR_400);
        let e = client(&t)
            .create_issue(&NewIssue {
                project_key: "NYX".into(),
                summary: "x".into(),
                ..NewIssue::default()
            })
            .unwrap_err();
        assert!(e.to_string().contains("Issue type is required"));
    }

    #[test]
    fn client_paginates_projects() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(
            200,
            &[],
            r#"{"isLast":false,"values":[{"id":"1","key":"A","name":"A"}]}"#,
        );
        t.push_json(
            200,
            &[],
            r#"{"isLast":true,"values":[{"id":"2","key":"B","name":"B"}]}"#,
        );
        let ps = client(&t).list_projects().unwrap();
        assert_eq!(ps.len(), 2);
        assert!(t.requests()[1].url.contains("startAt=50"));
    }

    #[test]
    fn client_transition_by_name() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], TRANSITIONS);
        t.push_json(204, &[], "");
        client(&t)
            .transition_issue_by_name("NYX-1", "Done")
            .unwrap();
        let reqs = t.requests();
        assert_eq!(body(&reqs[1])["transition"]["id"], "31");
        t.push_json(200, &[], TRANSITIONS);
        let e = client(&t)
            .transition_issue_by_name("NYX-1", "Archived")
            .unwrap_err();
        assert!(matches!(e, IntegrationError::NotFound(_)));
    }

    #[test]
    fn client_update_comment_and_webhook() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(204, &[], "");
        t.push_json(201, &[], COMMENT);
        t.push_json(
            200,
            &[],
            r#"{"webhookRegistrationResult":[{"createdWebhookId":7}]}"#,
        );
        t.push_json(202, &[], "");
        let c = client(&t);
        c.update_issue(
            "NYX-1",
            &IssueUpdate {
                description: Some("new".into()),
                ..IssueUpdate::default()
            },
        )
        .unwrap();
        assert_eq!(c.add_comment("NYX-1", "**hi**").unwrap().id, "900");
        let id = c
            .register_webhook("https://hook.example/jira", "project = NYX")
            .unwrap();
        assert_eq!(id, Some(7));
        c.delete_webhook(7).unwrap();
        let reqs = t.requests();
        assert_eq!(reqs[0].method, HttpMethod::Put);
        assert_eq!(reqs[3].method, HttpMethod::Delete);
        assert_eq!(body(&reqs[3])["webhookIds"], json!([7]));
        assert_eq!(
            body(&reqs[2])["webhooks"][0]["events"][0],
            "jira:issue_updated"
        );
        assert!(c.register_webhook("u", " ").is_err());
    }

    #[test]
    fn rate_limit_retry_applies_to_client_calls() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(429, &[("Retry-After", "3")], "");
        t.push_json(200, &[], PROJECTS);
        let sleeper = Arc::new(RecordingSleeper::new());
        let http = Http::new(t.clone()).with_sleeper(sleeper.clone());
        let ps = JiraClient::new(http, oauth()).list_projects().unwrap();
        assert_eq!(ps.len(), 2);
        assert_eq!(sleeper.waits(), vec![3]);
    }
}
