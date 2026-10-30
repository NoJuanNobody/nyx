//! Jira Cloud REST v3 ticket adapter: pure request builders and response parsers plus a thin
//! [`JiraTracker`] that runs them over an [`HttpTransport`].
//!
//! Scope note: the full Jira / Confluence client (projects, search UI, Confluence pages, Slack)
//! belongs to AI-71. This module only knows the three calls the ticket pipeline needs: create
//! issue, get issue status, find issue by summary. Descriptions are sent as Atlassian Document
//! Format (ADF); the TS service sent the whole markdown as one literal text node.
//!
//! The request shapes follow Atlassian's public REST v3 documentation and are covered by fixture
//! tests; they have not been exercised against a live Jira site.

use std::sync::Arc;

use base64::Engine as _;
use secrecy::{ExposeSecret, SecretString};
use serde_json::{json, Value};

use super::sprint::{
    normalize_jira_status, SprintItem, SprintOrigin, SprintSnapshot, SprintSource,
};
use super::tracker::{
    check_response, title_key, Destination, NewIssue, RemoteIssue, TicketTracker, TrackerError,
    TrackerKind,
};
use crate::git_provider::{HttpMethod, HttpRequest, HttpResponse, HttpTransport};
use crate::model::TicketStatus;

/// Jira site + API-token credentials (`integrations.config` for type `jira`).
#[derive(Clone)]
pub struct JiraCredentials {
    /// Site URL, e.g. `https://acme.atlassian.net`.
    pub base_url: String,
    /// Account e-mail.
    pub email: String,
    /// API token.
    pub api_token: SecretString,
}

impl std::fmt::Debug for JiraCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JiraCredentials")
            .field("base_url", &self.base_url)
            .field("email", &self.email)
            .field("api_token", &"[REDACTED]")
            .finish()
    }
}

impl JiraCredentials {
    fn base(&self) -> &str {
        self.base_url.trim_end_matches('/')
    }
}

fn authed(creds: &JiraCredentials, method: HttpMethod, url: String) -> HttpRequest {
    let basic = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}:{}",
        creds.email,
        creds.api_token.expose_secret()
    ));
    HttpRequest::new(method, url)
        .header("Authorization", format!("Basic {basic}"))
        .header("Accept", "application/json")
}

// ------------------------------------------------------------------ ADF

fn text_node(text: &str, marks: &[Value]) -> Value {
    let mut n = json!({"type": "text", "text": text});
    if !marks.is_empty() {
        n["marks"] = Value::Array(marks.to_vec());
    }
    n
}

/// Inline markdown (`code`, **bold**, [text](url)) to ADF text nodes. Unmatched markers stay
/// literal. Never emits an empty text node (Jira rejects them).
fn inline(src: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut buf = String::new();
    let flush = |buf: &mut String, out: &mut Vec<Value>| {
        if !buf.is_empty() {
            out.push(text_node(buf, &[]));
            buf.clear();
        }
    };
    let mut rest = src;
    while let Some(c) = rest.chars().next() {
        if c == '`' {
            if let Some(end) = rest[1..].find('`').filter(|e| *e > 0) {
                flush(&mut buf, &mut out);
                out.push(text_node(&rest[1..=end], &[json!({"type": "code"})]));
                rest = &rest[end + 2..];
                continue;
            }
        } else if rest.starts_with("**") {
            if let Some(end) = rest[2..].find("**").filter(|e| *e > 0) {
                flush(&mut buf, &mut out);
                out.push(text_node(&rest[2..2 + end], &[json!({"type": "strong"})]));
                rest = &rest[end + 4..];
                continue;
            }
        } else if c == '[' {
            if let Some(mid) = rest.find("](") {
                if let Some(close) = rest[mid + 2..].find(')') {
                    let label = &rest[1..mid];
                    let href = &rest[mid + 2..mid + 2 + close];
                    if !label.is_empty() && !label.contains('[') && href.starts_with("http") {
                        flush(&mut buf, &mut out);
                        out.push(text_node(
                            label,
                            &[json!({"type": "link", "attrs": {"href": href}})],
                        ));
                        rest = &rest[mid + 3 + close..];
                        continue;
                    }
                }
            }
        }
        buf.push(c);
        rest = &rest[c.len_utf8()..];
    }
    flush(&mut buf, &mut out);
    out
}

fn paragraph(lines: &[&str]) -> Value {
    let mut content = Vec::new();
    for (i, l) in lines.iter().enumerate() {
        if i > 0 {
            content.push(json!({"type": "hardBreak"}));
        }
        content.extend(inline(l.trim()));
    }
    json!({"type": "paragraph", "content": content})
}

fn list_marker(line: &str) -> Option<(bool, &str)> {
    let t = line.trim_start();
    for m in ["- ", "* ", "+ "] {
        if let Some(r) = t.strip_prefix(m) {
            return Some((false, r));
        }
    }
    let digits = t.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 {
        if let Some(r) = t[digits..].strip_prefix(". ") {
            return Some((true, r));
        }
    }
    None
}

/// Convert the markdown subset tickets use (headings, paragraphs, bullet / ordered lists, fenced
/// code, rules, inline code / bold / links) to an ADF document.
#[must_use]
pub fn markdown_to_adf(md: &str) -> Value {
    let lines: Vec<&str> = md.lines().collect();
    let mut blocks: Vec<Value> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let t = line.trim();
        if t.is_empty() {
            i += 1;
        } else if let Some(lang) = t.strip_prefix("```") {
            let mut code = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim().starts_with("```") {
                code.push(lines[i]);
                i += 1;
            }
            i += 1; // closing fence (or EOF)
            let mut node = json!({"type": "codeBlock"});
            if !lang.trim().is_empty() {
                node["attrs"] = json!({"language": lang.trim()});
            }
            let body = code.join("\n");
            if !body.is_empty() {
                node["content"] = json!([{"type": "text", "text": body}]);
            }
            blocks.push(node);
        } else if t.len() >= 3 && t.chars().all(|c| c == '-') {
            blocks.push(json!({"type": "rule"}));
            i += 1;
        } else if t.starts_with('#') {
            let level = t.chars().take_while(|c| *c == '#').count();
            if (1..=6).contains(&level) && t[level..].starts_with(' ') {
                blocks.push(json!({
                    "type": "heading",
                    "attrs": {"level": level},
                    "content": inline(t[level..].trim()),
                }));
            } else {
                blocks.push(paragraph(&[t]));
            }
            i += 1;
        } else if let Some((ordered, _)) = list_marker(line) {
            let mut items = Vec::new();
            while i < lines.len() {
                match list_marker(lines[i]) {
                    Some((o, text)) if o == ordered => {
                        items.push(json!({
                            "type": "listItem",
                            "content": [paragraph(&[text])],
                        }));
                        i += 1;
                    }
                    _ => break,
                }
            }
            blocks.push(json!({
                "type": if ordered { "orderedList" } else { "bulletList" },
                "content": items,
            }));
        } else {
            let mut para = vec![t];
            i += 1;
            while i < lines.len() {
                let n = lines[i].trim();
                if n.is_empty()
                    || (n.len() >= 3 && n.chars().all(|c| c == '-'))
                    || n.starts_with('#')
                    || n.starts_with("```")
                    || list_marker(lines[i]).is_some()
                {
                    break;
                }
                para.push(n);
                i += 1;
            }
            blocks.push(paragraph(&para));
        }
    }
    json!({"type": "doc", "version": 1, "content": blocks})
}

// ------------------------------------------------------------ requests

/// Jira labels cannot contain whitespace.
#[must_use]
pub fn sanitize_label(label: &str) -> String {
    label.split_whitespace().collect::<Vec<_>>().join("-")
}

/// `POST /rest/api/3/issue`.
#[must_use]
pub fn create_issue_request(
    creds: &JiraCredentials,
    project_key: &str,
    issue: &NewIssue,
    issue_type: &str,
    include_labels: bool,
) -> HttpRequest {
    let mut fields = json!({
        "project": {"key": project_key},
        "summary": issue.title,
        "issuetype": {"name": issue_type},
    });
    if !issue.body.trim().is_empty() {
        fields["description"] = markdown_to_adf(&issue.body);
    }
    if include_labels && !issue.labels.is_empty() {
        fields["labels"] = json!(issue
            .labels
            .iter()
            .map(|l| sanitize_label(l))
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>());
    }
    authed(
        creds,
        HttpMethod::Post,
        format!("{}/rest/api/3/issue", creds.base()),
    )
    .json(&json!({ "fields": fields }))
}

/// Parse the create response (`{"id","key","self"}`) into a [`RemoteIssue`].
///
/// # Errors
/// [`TrackerError::Parse`] when `key` is missing; HTTP errors per [`check_response`].
pub fn parse_create_response(
    creds: &JiraCredentials,
    resp: HttpResponse,
    title: &str,
) -> Result<RemoteIssue, TrackerError> {
    let resp = check_response(resp)?;
    let v: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| TrackerError::Parse(format!("jira create: {e}")))?;
    let key = v
        .get("key")
        .and_then(Value::as_str)
        .filter(|k| !k.is_empty())
        .ok_or_else(|| TrackerError::Parse("jira create: no issue key in response".into()))?;
    Ok(RemoteIssue {
        kind: TrackerKind::Jira,
        external_id: key.to_owned(),
        external_url: format!("{}/browse/{key}", creds.base()),
        title: title.to_owned(),
    })
}

/// `GET /rest/api/3/issue/{key}?fields=status`.
#[must_use]
pub fn get_status_request(creds: &JiraCredentials, key: &str) -> HttpRequest {
    authed(
        creds,
        HttpMethod::Get,
        format!(
            "{}/rest/api/3/issue/{}?fields=status",
            creds.base(),
            url::form_urlencoded::byte_serialize(key.as_bytes()).collect::<String>()
        ),
    )
}

/// Map a Jira status to Nyx's states. Names first (TS: `done`/`closed`/`resolved` -> closed,
/// `in progress` -> `in_progress`, else open), then the status category (`done` -> closed,
/// `indeterminate` -> `in_progress`) so custom workflow names ("QA", "Shipped") still classify.
#[must_use]
pub fn map_status(name: &str, category_key: Option<&str>) -> TicketStatus {
    match name.trim().to_lowercase().as_str() {
        "done" | "closed" | "resolved" => return TicketStatus::Closed,
        "in progress" => return TicketStatus::InProgress,
        "to do" | "open" | "backlog" => return TicketStatus::Open,
        _ => {}
    }
    match category_key {
        Some("done") => TicketStatus::Closed,
        Some("indeterminate") => TicketStatus::InProgress,
        _ => TicketStatus::Open,
    }
}

/// Parse an issue response into a status.
///
/// # Errors
/// [`TrackerError::Parse`] when `fields.status.name` is missing; HTTP errors per
/// [`check_response`].
pub fn parse_status_response(resp: HttpResponse) -> Result<TicketStatus, TrackerError> {
    let resp = check_response(resp)?;
    let v: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| TrackerError::Parse(format!("jira issue: {e}")))?;
    let status = v
        .pointer("/fields/status")
        .ok_or_else(|| TrackerError::Parse("jira issue: no fields.status".into()))?;
    let name = status
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| TrackerError::Parse("jira issue: no status name".into()))?;
    Ok(map_status(
        name,
        status
            .pointer("/statusCategory/key")
            .and_then(Value::as_str),
    ))
}

fn jql_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `GET /rest/api/3/search/jql?jql=project = KEY AND summary ~ "title"`. The `~` operator is a
/// fuzzy text match, so [`parse_search_response`] re-checks the summary exactly.
#[must_use]
pub fn search_by_summary_request(
    creds: &JiraCredentials,
    project_key: &str,
    title: &str,
) -> HttpRequest {
    let jql = format!(
        "project = {} AND summary ~ {} ORDER BY created DESC",
        jql_string(project_key),
        jql_string(&title.replace(['"', '\\'], " "))
    );
    let q: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("jql", &jql)
        .append_pair("fields", "summary")
        .append_pair("maxResults", "50")
        .finish();
    authed(
        creds,
        HttpMethod::Get,
        format!("{}/rest/api/3/search/jql?{q}", creds.base()),
    )
}

/// Parse a search response, keeping the first issue whose summary equals `title`
/// (whitespace / case-insensitive).
///
/// # Errors
/// [`TrackerError::Parse`] on a body without `issues`; HTTP errors per [`check_response`].
pub fn parse_search_response(
    creds: &JiraCredentials,
    resp: HttpResponse,
    title: &str,
) -> Result<Option<RemoteIssue>, TrackerError> {
    let resp = check_response(resp)?;
    let v: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| TrackerError::Parse(format!("jira search: {e}")))?;
    let issues = v
        .get("issues")
        .and_then(Value::as_array)
        .ok_or_else(|| TrackerError::Parse("jira search: no issues array".into()))?;
    let want = title_key(title);
    Ok(issues.iter().find_map(|i| {
        let key = i.get("key")?.as_str()?;
        let summary = i.pointer("/fields/summary")?.as_str()?;
        (title_key(summary) == want).then(|| RemoteIssue {
            kind: TrackerKind::Jira,
            external_id: key.to_owned(),
            external_url: format!("{}/browse/{key}", creds.base()),
            title: summary.to_owned(),
        })
    }))
}

/// [`TicketTracker`] for Jira Cloud.
#[derive(Debug, Clone)]
pub struct JiraTracker {
    creds: JiraCredentials,
    transport: Arc<dyn HttpTransport>,
    issue_type: String,
    include_labels: bool,
}

impl JiraTracker {
    /// New tracker; issue type `Task`, labels not sent (the field must be on the project's create
    /// screen or Jira answers 400; opt in with [`Self::with_labels`]).
    #[must_use]
    pub fn new(creds: JiraCredentials, transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            creds,
            transport,
            issue_type: "Task".into(),
            include_labels: false,
        }
    }

    /// Send labels with created issues.
    #[must_use]
    pub fn with_labels(mut self, on: bool) -> Self {
        self.include_labels = on;
        self
    }

    /// Issue type name (default `Task`).
    #[must_use]
    pub fn with_issue_type(mut self, name: impl Into<String>) -> Self {
        self.issue_type = name.into();
        self
    }

    fn project(dest: &Destination) -> Result<&str, TrackerError> {
        match dest {
            Destination::Jira { project_key } => Ok(project_key),
            other => Err(TrackerError::Invalid(format!(
                "jira tracker cannot post to {}",
                other.key()
            ))),
        }
    }

    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, TrackerError> {
        self.transport
            .send(req)
            .map_err(|e| TrackerError::Transport(e.to_string()))
    }
}

impl TicketTracker for JiraTracker {
    fn kind(&self) -> TrackerKind {
        TrackerKind::Jira
    }

    fn create_issue(
        &self,
        dest: &Destination,
        issue: &NewIssue,
    ) -> Result<RemoteIssue, TrackerError> {
        let project = Self::project(dest)?;
        let req = create_issue_request(
            &self.creds,
            project,
            issue,
            &self.issue_type,
            self.include_labels,
        );
        parse_create_response(&self.creds, self.send(&req)?, &issue.title)
    }

    fn find_by_title(
        &self,
        dest: &Destination,
        title: &str,
    ) -> Result<Option<RemoteIssue>, TrackerError> {
        let project = Self::project(dest)?;
        let req = search_by_summary_request(&self.creds, project, title);
        parse_search_response(&self.creds, self.send(&req)?, title)
    }

    fn fetch_status(
        &self,
        _dest: &Destination,
        external_id: &str,
    ) -> Result<TicketStatus, TrackerError> {
        parse_status_response(self.send(&get_status_request(&self.creds, external_id))?)
    }
}

/// `GET /rest/api/3/search/jql` for a project (or everything visible), newest-updated first,
/// capped at 100 (the TS `searchIssues`).
#[must_use]
pub fn search_project_request(creds: &JiraCredentials, project_key: Option<&str>) -> HttpRequest {
    let jql = project_key.map_or_else(
        || "ORDER BY updated DESC".to_owned(),
        |k| format!("project = {} ORDER BY updated DESC", jql_string(k)),
    );
    let q: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("jql", &jql)
        .append_pair("fields", "summary,status,labels")
        .append_pair("maxResults", "100")
        .finish();
    authed(
        creds,
        HttpMethod::Get,
        format!("{}/rest/api/3/search/jql?{q}", creds.base()),
    )
}

/// Parse a project search into sprint items (status names normalised with
/// [`normalize_jira_status`]). The TS service did not read Jira labels for the weight heuristic;
/// they are read here when the response carries them.
///
/// # Errors
/// [`TrackerError::Parse`] on a body without `issues`; HTTP errors per [`check_response`].
pub fn parse_sprint_items(resp: HttpResponse) -> Result<Vec<SprintItem>, TrackerError> {
    let resp = check_response(resp)?;
    let v: Value = serde_json::from_slice(&resp.body)
        .map_err(|e| TrackerError::Parse(format!("jira search: {e}")))?;
    let issues = v
        .get("issues")
        .and_then(Value::as_array)
        .ok_or_else(|| TrackerError::Parse("jira search: no issues array".into()))?;
    Ok(issues
        .iter()
        .filter_map(|i| {
            Some(SprintItem {
                key: i.get("key")?.as_str()?.to_owned(),
                title: i.pointer("/fields/summary")?.as_str()?.to_owned(),
                labels: i
                    .pointer("/fields/labels")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|l| l.as_str().map(str::to_owned))
                            .collect()
                    })
                    .unwrap_or_default(),
                status: normalize_jira_status(
                    i.pointer("/fields/status/name")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                ),
            })
        })
        .collect())
}

/// [`SprintSource`] over a Jira project.
#[derive(Debug, Clone)]
pub struct JiraSprintSource {
    creds: JiraCredentials,
    transport: Arc<dyn HttpTransport>,
    project_key: Option<String>,
}

impl JiraSprintSource {
    /// New source; `project_key` `None` lists every visible issue (as the TS service did).
    #[must_use]
    pub fn new(
        creds: JiraCredentials,
        transport: Arc<dyn HttpTransport>,
        project_key: Option<String>,
    ) -> Self {
        Self {
            creds,
            transport,
            project_key,
        }
    }
}

impl SprintSource for JiraSprintSource {
    fn origin(&self) -> SprintOrigin {
        SprintOrigin::Jira
    }

    fn fetch(&self) -> Result<Option<SprintSnapshot>, TrackerError> {
        let req = search_project_request(&self.creds, self.project_key.as_deref());
        let resp = self
            .transport
            .send(&req)
            .map_err(|e| TrackerError::Transport(e.to_string()))?;
        Ok(Some(SprintSnapshot {
            name: self
                .project_key
                .as_ref()
                .map_or_else(|| "Jira Sprint".to_owned(), |k| format!("{k} Sprint")),
            items: parse_sprint_items(resp)?,
            origin: SprintOrigin::Jira,
        }))
    }
}

#[cfg(test)]
#[allow(clippy::assert_is_empty, clippy::items_after_statements)]
mod tests {
    use super::*;
    use crate::git_provider::{FakeTransport, Headers};

    fn creds() -> JiraCredentials {
        JiraCredentials {
            base_url: "https://acme.atlassian.net/".into(),
            email: "me@acme.test".into(),
            api_token: SecretString::from("tok-123"),
        }
    }

    fn issue() -> NewIssue {
        NewIssue {
            title: "Add login".into(),
            body: "## Goal\nUsers can **log in**.\n\n- a\n- b\n\n```rust\nfn x() {}\n```".into(),
            labels: vec!["spec change".into(), "backend".into()],
        }
    }

    #[test]
    fn create_request_fixture() {
        let req = create_issue_request(&creds(), "PROJ", &issue(), "Task", true);
        assert_eq!(req.method, HttpMethod::Post);
        assert_eq!(req.url, "https://acme.atlassian.net/rest/api/3/issue");
        let auth = req.headers.get("authorization").unwrap();
        assert_eq!(
            auth,
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode("me@acme.test:tok-123")
            )
        );
        let body: Value = serde_json::from_str(&req.body_text().unwrap()).unwrap();
        assert_eq!(body["fields"]["project"]["key"], "PROJ");
        assert_eq!(body["fields"]["summary"], "Add login");
        assert_eq!(body["fields"]["issuetype"]["name"], "Task");
        assert_eq!(body["fields"]["labels"], json!(["spec-change", "backend"]));
        let d = &body["fields"]["description"];
        assert_eq!(d["type"], "doc");
        assert_eq!(d["version"], 1);
        assert_eq!(d["content"][0]["type"], "heading");
        assert_eq!(d["content"][0]["attrs"]["level"], 2);
        assert_eq!(d["content"][1]["content"][1]["marks"][0]["type"], "strong");
        assert_eq!(d["content"][2]["type"], "bulletList");
        assert_eq!(d["content"][2]["content"].as_array().unwrap().len(), 2);
        assert_eq!(d["content"][3]["type"], "codeBlock");
        assert_eq!(d["content"][3]["attrs"]["language"], "rust");
    }

    #[test]
    fn labels_off_by_default_and_empty_body_omits_description() {
        let mut i = issue();
        i.body = "  ".into();
        let req = create_issue_request(&creds(), "P", &i, "Bug", false);
        let body: Value = serde_json::from_str(&req.body_text().unwrap()).unwrap();
        assert!(body["fields"].get("labels").is_none());
        assert!(body["fields"].get("description").is_none());
        assert_eq!(body["fields"]["issuetype"]["name"], "Bug");
    }

    #[test]
    fn adf_edge_cases() {
        // Unclosed markers stay literal; no empty text nodes.
        let d = markdown_to_adf("a `b and **c");
        let text = &d["content"][0]["content"];
        assert_eq!(text[0]["text"], "a `b and **c");
        // Ordered list, link, hard break, rule, unclosed fence.
        let d = markdown_to_adf(
            "1. one\n2. two\n\nsee [docs](https://x.test/a)\nnext line\n---\n```\nopen",
        );
        let c = d["content"].as_array().unwrap();
        assert_eq!(c[0]["type"], "orderedList");
        assert_eq!(
            c[1]["content"][1]["marks"][0]["attrs"]["href"],
            "https://x.test/a"
        );
        assert_eq!(c[1]["content"][2]["type"], "hardBreak");
        assert_eq!(c[2]["type"], "rule");
        assert_eq!(c[3]["type"], "codeBlock");
        assert_eq!(c[3]["content"][0]["text"], "open");
        // `#hashtag` is a paragraph, not a heading.
        assert_eq!(markdown_to_adf("#nope")["content"][0]["type"], "paragraph");
        // Empty markdown is an empty doc.
        assert_eq!(markdown_to_adf("")["content"], json!([]));
        // Multibyte text survives.
        let d = markdown_to_adf("héllo **wörld** ✓");
        assert_eq!(d["content"][0]["content"][2]["text"], " ✓");
    }

    #[test]
    fn create_response_fixture_and_errors() {
        let ok = HttpResponse::new(
            201,
            Headers::new(),
            r#"{"id":"10001","key":"PROJ-7","self":"https://acme.atlassian.net/rest/api/3/issue/10001"}"#,
        );
        let r = parse_create_response(&creds(), ok, "Add login").unwrap();
        assert_eq!(r.external_id, "PROJ-7");
        assert_eq!(r.external_url, "https://acme.atlassian.net/browse/PROJ-7");
        let bad = HttpResponse::new(201, Headers::new(), r#"{"id":"1"}"#);
        assert!(matches!(
            parse_create_response(&creds(), bad, "t"),
            Err(TrackerError::Parse(_))
        ));
        let junk = HttpResponse::new(200, Headers::new(), "<html>");
        assert!(parse_create_response(&creds(), junk, "t").is_err());
        let e = HttpResponse::new(400, Headers::new(), r#"{"errors":{"project":"bad"}}"#);
        assert!(matches!(
            parse_create_response(&creds(), e, "t"),
            Err(TrackerError::Rejected { status: 400, .. })
        ));
        let e = HttpResponse::new(401, Headers::new(), "");
        assert!(matches!(
            parse_create_response(&creds(), e, "t"),
            Err(TrackerError::Auth(_))
        ));
    }

    #[test]
    fn status_mapping_matches_ts_and_falls_back_to_category() {
        assert_eq!(map_status("Done", None), TicketStatus::Closed);
        assert_eq!(map_status("RESOLVED", None), TicketStatus::Closed);
        assert_eq!(map_status("Closed", Some("new")), TicketStatus::Closed);
        assert_eq!(map_status("In Progress", None), TicketStatus::InProgress);
        assert_eq!(
            map_status("To Do", Some("indeterminate")),
            TicketStatus::Open
        );
        assert_eq!(map_status("Backlog", None), TicketStatus::Open);
        assert_eq!(
            map_status("QA", Some("indeterminate")),
            TicketStatus::InProgress
        );
        assert_eq!(map_status("Shipped", Some("done")), TicketStatus::Closed);
        assert_eq!(map_status("Weird", None), TicketStatus::Open);
        let resp = HttpResponse::new(
            200,
            Headers::new(),
            r#"{"key":"PROJ-7","fields":{"status":{"name":"In Progress","statusCategory":{"key":"indeterminate"}}}}"#,
        );
        assert_eq!(
            parse_status_response(resp).unwrap(),
            TicketStatus::InProgress
        );
        let resp = HttpResponse::new(200, Headers::new(), r#"{"fields":{}}"#);
        assert!(parse_status_response(resp).is_err());
    }

    #[test]
    fn search_request_escapes_and_response_matches_exactly() {
        let req = search_by_summary_request(&creds(), "PROJ", r#"Fix "quoted" \ title"#);
        assert!(req
            .url
            .starts_with("https://acme.atlassian.net/rest/api/3/search/jql?jql="));
        assert!(req.url.contains("summary+%7E+%22Fix"));
        assert!(!req.url.contains("%5C%22")); // no backslash-escaped quote left over
        let resp = HttpResponse::new(
            200,
            Headers::new(),
            r#"{"issues":[{"key":"PROJ-1","fields":{"summary":"Fix other"}},{"key":"PROJ-2","fields":{"summary":"fix  Login"}}]}"#,
        );
        let hit = parse_search_response(&creds(), resp, "Fix login")
            .unwrap()
            .unwrap();
        assert_eq!(hit.external_id, "PROJ-2");
        let none = HttpResponse::new(200, Headers::new(), r#"{"issues":[]}"#);
        assert!(parse_search_response(&creds(), none, "x")
            .unwrap()
            .is_none());
    }

    #[test]
    fn tracker_over_fake_transport() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(201, &[], r#"{"id":"1","key":"PROJ-1"}"#);
        let tracker = JiraTracker::new(creds(), t.clone());
        let dest = Destination::Jira {
            project_key: "PROJ".into(),
        };
        let r = tracker.create_issue(&dest, &issue()).unwrap();
        assert_eq!(r.external_id, "PROJ-1");
        assert_eq!(t.requests().len(), 1);
        // Wrong destination is rejected before any request.
        let wrong = Destination::Linear {
            team_id: "x".into(),
        };
        assert!(matches!(
            tracker.create_issue(&wrong, &issue()),
            Err(TrackerError::Invalid(_))
        ));
        assert_eq!(t.requests().len(), 1);
        // Connection failure surfaces as Transport (outcome unknown).
        t.push_error("reset");
        let e = tracker.create_issue(&dest, &issue()).unwrap_err();
        assert!(e.outcome_unknown());
    }

    #[test]
    fn sprint_source_parses_project_search() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(
            200,
            &[],
            r#"{"issues":[{"key":"PROJ-1","fields":{"summary":"Add API","status":{"name":"In Progress"},"labels":["bug"]}},
                          {"key":"PROJ-2","fields":{"summary":"Docs","status":{"name":"Done"}}},
                          {"fields":{"summary":"no key"}}]}"#,
        );
        let src = JiraSprintSource::new(creds(), t.clone(), Some("PROJ".into()));
        let snap = src.fetch().unwrap().unwrap();
        assert_eq!(snap.name, "PROJ Sprint");
        assert_eq!(snap.items.len(), 2); // keyless row skipped
        assert_eq!(
            snap.items[0].status,
            crate::tickets::sprint::SprintStatus::InProgress
        );
        assert_eq!(snap.items[0].labels, ["bug"]);
        assert!(t.requests()[0].url.contains("maxResults=100"));
        assert!(t.requests()[0].url.contains("PROJ"));
        // No project: unfiltered query and generic name.
        assert!(search_project_request(&creds(), None)
            .url
            .contains("ORDER+BY+updated+DESC"));
        // Auth failure surfaces as an error (BOARD logs and falls through).
        t.push_json(401, &[], "");
        assert!(matches!(src.fetch(), Err(TrackerError::Auth(_))));
    }

    #[test]
    fn credentials_debug_hides_token() {
        let s = format!("{:?}", creds());
        assert!(!s.contains("tok-123"));
    }
}
