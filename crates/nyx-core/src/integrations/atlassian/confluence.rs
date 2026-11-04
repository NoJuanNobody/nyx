//! Confluence Cloud: spaces, pages (create, update with version bump, import), labels.
//!
//! Ports `listConfluenceSpaces`, `exportToConfluence` and `importFromConfluence` from
//! `atlassian.service.ts`. Pages are written in the storage representation produced by
//! [`super::storage::markdown_to_storage`] (the TS service wrote ADF); import still reads ADF
//! (`body-format=atlas_doc_format`) and flattens it with [`super::adf::adf_to_text`], like the TS.
//! Labels are new: they use the v1 endpoint because the v2 API has no add-label call.
//!
//! Authentication is shared with Jira ([`JiraAuth`]): one Atlassian OAuth connection covers both.

use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use super::adf::adf_to_text;
use super::jira::{check, JiraAuth};
use super::storage::markdown_to_storage;
use crate::git_provider::util::encode_component;
use crate::integrations::http::{parse_json, Http};
use crate::integrations::{HttpMethod, HttpRequest, HttpResponse, IntegrationError, Result};

/// Confluence authenticates exactly like Jira.
pub type ConfluenceAuth = JiraAuth;

const MAX_SPACE_PAGES: usize = 10;

fn base(auth: &ConfluenceAuth) -> String {
    match auth {
        JiraAuth::OAuth { cloud_id, .. } => {
            format!("https://api.atlassian.com/ex/confluence/{cloud_id}")
        }
        JiraAuth::Basic { base_url, .. } => base_url.clone(),
    }
}

fn req(auth: &ConfluenceAuth, method: HttpMethod, path: &str) -> HttpRequest {
    HttpRequest::new(method, format!("{}{path}", base(auth)))
        .header("Authorization", auth.authorization())
        .header("Accept", "application/json")
}

/// Confluence space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfluenceSpace {
    /// Numeric id (string).
    pub id: String,
    /// Space key.
    pub key: String,
    /// Name.
    pub name: String,
    /// `global`, `personal`, ...
    #[serde(rename = "type", default)]
    pub space_type: Option<String>,
    /// `current` or `archived`.
    #[serde(default)]
    pub status: Option<String>,
}

/// Page version info.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageVersion {
    /// Version number (starts at 1; each update needs previous + 1).
    pub number: u64,
}

/// Page links.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageLinks {
    /// Web UI path, relative to [`PageLinks::base`] or the site.
    #[serde(default)]
    pub webui: Option<String>,
    /// Site base URL.
    #[serde(default)]
    pub base: Option<String>,
}

/// A body in one representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageBodyValue {
    /// Raw body text (XHTML for storage, JSON text for ADF).
    pub value: String,
}

/// Bodies the response included.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageBody {
    /// Storage format.
    #[serde(default)]
    pub storage: Option<PageBodyValue>,
    /// Atlassian document format.
    #[serde(default)]
    pub atlas_doc_format: Option<PageBodyValue>,
}

/// Confluence page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfluencePage {
    /// Page id.
    pub id: String,
    /// Title.
    #[serde(default)]
    pub title: String,
    /// Owning space id.
    #[serde(default)]
    pub space_id: String,
    /// Status (`current`, `draft`, ...).
    #[serde(default)]
    pub status: Option<String>,
    /// Version.
    #[serde(default)]
    pub version: Option<PageVersion>,
    /// Body, when requested.
    #[serde(default)]
    pub body: Option<PageBody>,
    /// Links.
    #[serde(rename = "_links", default)]
    pub links: Option<PageLinks>,
}

impl ConfluencePage {
    /// Absolute web URL when the response carried link info.
    #[must_use]
    pub fn web_url(&self) -> Option<String> {
        let l = self.links.as_ref()?;
        Some(format!("{}{}", l.base.as_deref()?, l.webui.as_deref()?))
    }
}

/// Page content flattened for import into Nyx.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedPage {
    /// Title.
    pub title: String,
    /// Markdown-ish text.
    pub content: String,
    /// Page id.
    pub page_id: String,
    /// Space id.
    pub space_id: String,
}

/// Input for creating a page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NewPage {
    /// Numeric space id.
    pub space_id: String,
    /// Title.
    pub title: String,
    /// Markdown body.
    pub markdown: String,
    /// Optional parent page id.
    pub parent_page_id: Option<String>,
}

/// Export parameters (port of `exportToConfluence`): create, or update when `existing_page_id` is set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExportParams {
    /// Numeric space id (needed for create).
    pub space_id: String,
    /// Title.
    pub title: String,
    /// Markdown body.
    pub markdown: String,
    /// Parent for new pages.
    pub parent_page_id: Option<String>,
    /// Update this page instead of creating.
    pub existing_page_id: Option<String>,
    /// Labels to add after the write.
    pub labels: Vec<String>,
}

/// Which body representation to request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyFormat {
    /// Storage XHTML.
    Storage,
    /// Atlassian document format.
    AtlasDocFormat,
}

impl BodyFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "storage",
            Self::AtlasDocFormat => "atlas_doc_format",
        }
    }
}

// ── Validation ──────────────────────────────────────

fn numeric_id(what: &str, v: &str) -> Result<()> {
    if !v.is_empty() && v.len() <= 20 && v.chars().all(|c| c.is_ascii_digit()) {
        Ok(())
    } else {
        Err(IntegrationError::Invalid(format!("bad {what}: {v:?}")))
    }
}

fn label_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"^[a-z0-9_.\-]{1,255}$").unwrap_or_else(|_| unreachable!()))
}

/// Normalise labels: lowercase, spaces to `-`; rejects characters Confluence does not allow.
pub fn normalize_labels(labels: &[String]) -> Result<Vec<String>> {
    labels
        .iter()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let n = l.trim().to_lowercase().replace(char::is_whitespace, "-");
            if label_re().is_match(&n) {
                Ok(n)
            } else {
                Err(IntegrationError::Invalid(format!(
                    "bad Confluence label: {l:?}"
                )))
            }
        })
        .collect()
}

fn require_title(t: &str) -> Result<&str> {
    let t = t.trim();
    if t.is_empty() {
        Err(IntegrationError::Invalid("page title is empty".into()))
    } else {
        Ok(t)
    }
}

// ── Request builders ────────────────────────────────

/// `GET /wiki/api/v2/spaces`.
#[must_use]
pub fn list_spaces_request(auth: &ConfluenceAuth, cursor: Option<&str>, limit: u32) -> HttpRequest {
    let mut path = format!("/wiki/api/v2/spaces?limit={}", limit.clamp(1, 250));
    if let Some(c) = cursor {
        path.push_str("&cursor=");
        path.push_str(&encode_component(c));
    }
    req(auth, HttpMethod::Get, &path)
}

/// `GET /wiki/api/v2/pages/{id}?body-format=...`.
pub fn get_page_request(
    auth: &ConfluenceAuth,
    page_id: &str,
    format: BodyFormat,
) -> Result<HttpRequest> {
    numeric_id("page id", page_id)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!(
            "/wiki/api/v2/pages/{page_id}?body-format={}",
            format.as_str()
        ),
    ))
}

/// `GET /wiki/api/v2/pages?space-id=..&title=..` (exact title match within a space).
pub fn find_pages_request(
    auth: &ConfluenceAuth,
    space_id: &str,
    title: &str,
) -> Result<HttpRequest> {
    numeric_id("space id", space_id)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!(
            "/wiki/api/v2/pages?space-id={space_id}&title={}&status=current&limit=5",
            encode_component(require_title(title)?)
        ),
    ))
}

/// `POST /wiki/api/v2/pages` with a storage-format body.
pub fn create_page_request(auth: &ConfluenceAuth, page: &NewPage) -> Result<HttpRequest> {
    numeric_id("space id", &page.space_id)?;
    let mut body = json!({
        "spaceId": page.space_id,
        "status": "current",
        "title": require_title(&page.title)?,
        "body": {"representation": "storage", "value": markdown_to_storage(&page.markdown)},
    });
    if let Some(p) = &page.parent_page_id {
        numeric_id("parent page id", p)?;
        body["parentId"] = json!(p);
    }
    Ok(req(auth, HttpMethod::Post, "/wiki/api/v2/pages").json(&body))
}

/// `PUT /wiki/api/v2/pages/{id}`; `new_version` must be the current version plus one.
pub fn update_page_request(
    auth: &ConfluenceAuth,
    page_id: &str,
    title: &str,
    markdown: &str,
    new_version: u64,
) -> Result<HttpRequest> {
    numeric_id("page id", page_id)?;
    Ok(req(
        auth,
        HttpMethod::Put,
        &format!("/wiki/api/v2/pages/{page_id}"),
    )
    .json(&json!({
        "id": page_id,
        "status": "current",
        "title": require_title(title)?,
        "body": {"representation": "storage", "value": markdown_to_storage(markdown)},
        "version": {"number": new_version},
    })))
}

/// `POST /wiki/rest/api/content/{id}/label` (v1; the v2 API cannot add labels).
pub fn add_labels_request(
    auth: &ConfluenceAuth,
    page_id: &str,
    labels: &[String],
) -> Result<HttpRequest> {
    numeric_id("page id", page_id)?;
    let labels = normalize_labels(labels)?;
    if labels.is_empty() {
        return Err(IntegrationError::Invalid("no labels given".into()));
    }
    let body: Vec<Value> = labels
        .iter()
        .map(|l| json!({"prefix": "global", "name": l}))
        .collect();
    Ok(req(
        auth,
        HttpMethod::Post,
        &format!("/wiki/rest/api/content/{page_id}/label"),
    )
    .json(&Value::Array(body)))
}

/// `GET /wiki/api/v2/pages/{id}/labels`.
pub fn list_labels_request(auth: &ConfluenceAuth, page_id: &str) -> Result<HttpRequest> {
    numeric_id("page id", page_id)?;
    Ok(req(
        auth,
        HttpMethod::Get,
        &format!("/wiki/api/v2/pages/{page_id}/labels"),
    ))
}

// ── Parsers ─────────────────────────────────────────

#[derive(Deserialize)]
struct Links {
    #[serde(default)]
    next: Option<String>,
}

fn next_cursor(links: Option<&Links>) -> Option<String> {
    let next = links?.next.as_deref()?;
    let u = Url::parse("https://x.invalid").ok()?.join(next).ok()?;
    u.query_pairs()
        .find(|(k, _)| k == "cursor")
        .map(|(_, v)| v.into_owned())
}

/// Parse a space list: `(spaces, next_cursor)`.
pub fn parse_spaces(resp: &HttpResponse) -> Result<(Vec<ConfluenceSpace>, Option<String>)> {
    check(resp, "list spaces")?;
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        results: Vec<ConfluenceSpace>,
        #[serde(rename = "_links")]
        links: Option<Links>,
    }
    let p: Page = parse_json(resp, "spaces")?;
    let cur = next_cursor(p.links.as_ref());
    Ok((p.results, cur))
}

/// Parse a single page (get, create or update response).
pub fn parse_page(resp: &HttpResponse, op: &'static str) -> Result<ConfluencePage> {
    check(resp, op)?;
    parse_json(resp, "page")
}

/// Parse a page search; returns the matches.
pub fn parse_pages(resp: &HttpResponse) -> Result<Vec<ConfluencePage>> {
    check(resp, "find pages")?;
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        results: Vec<ConfluencePage>,
    }
    Ok(parse_json::<Page>(resp, "pages")?.results)
}

/// Parse a label list into names.
pub fn parse_labels(resp: &HttpResponse) -> Result<Vec<String>> {
    check(resp, "list labels")?;
    #[derive(Deserialize)]
    struct L {
        name: String,
    }
    #[derive(Deserialize)]
    struct Page {
        #[serde(default)]
        results: Vec<L>,
    }
    Ok(parse_json::<Page>(resp, "labels")?
        .results
        .into_iter()
        .map(|l| l.name)
        .collect())
}

/// Flatten an ADF-bodied page for import. Port of `importFromConfluence`'s tail.
pub fn page_to_import(page: &ConfluencePage) -> Result<ImportedPage> {
    let raw = page
        .body
        .as_ref()
        .and_then(|b| b.atlas_doc_format.as_ref())
        .ok_or_else(|| IntegrationError::Parse("page has no atlas_doc_format body".into()))?;
    let adf: Value = serde_json::from_str(&raw.value)
        .map_err(|e| IntegrationError::Parse(format!("page body is not ADF JSON: {e}")))?;
    Ok(ImportedPage {
        title: page.title.clone(),
        content: adf_to_text(&adf),
        page_id: page.id.clone(),
        space_id: page.space_id.clone(),
    })
}

// ── Client ──────────────────────────────────────────

/// Confluence client over an [`Http`].
#[derive(Debug)]
pub struct ConfluenceClient {
    http: Http,
    auth: ConfluenceAuth,
}

impl ConfluenceClient {
    /// New client.
    #[must_use]
    pub fn new(http: Http, auth: ConfluenceAuth) -> Self {
        Self { http, auth }
    }

    /// All spaces (up to 10 pages).
    pub fn list_spaces(&self) -> Result<Vec<ConfluenceSpace>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_SPACE_PAGES {
            let r = list_spaces_request(&self.auth, cursor.as_deref(), 100);
            let (mut items, next) = parse_spaces(&self.http.send(&r)?)?;
            out.append(&mut items);
            if next.is_none() {
                break;
            }
            cursor = next;
        }
        Ok(out)
    }

    /// Fetch a page with the requested body format.
    pub fn get_page(&self, page_id: &str, format: BodyFormat) -> Result<ConfluencePage> {
        let r = get_page_request(&self.auth, page_id, format)?;
        parse_page(&self.http.send(&r)?, "get page")
    }

    /// Find pages by exact title in a space.
    pub fn find_pages(&self, space_id: &str, title: &str) -> Result<Vec<ConfluencePage>> {
        let r = find_pages_request(&self.auth, space_id, title)?;
        parse_pages(&self.http.send(&r)?)
    }

    /// Create a page.
    pub fn create_page(&self, page: &NewPage) -> Result<ConfluencePage> {
        let r = create_page_request(&self.auth, page)?;
        parse_page(&self.http.send(&r)?, "create page")
    }

    /// Update a page: reads the current version, writes version + 1. A concurrent edit yields
    /// [`IntegrationError::Conflict`] (HTTP 409); the caller can retry after re-reading.
    pub fn update_page(
        &self,
        page_id: &str,
        title: &str,
        markdown: &str,
    ) -> Result<ConfluencePage> {
        let current = self.get_page(page_id, BodyFormat::Storage)?;
        let version = current.version.map_or(1, |v| v.number);
        let r = update_page_request(&self.auth, page_id, title, markdown, version + 1)?;
        parse_page(&self.http.send(&r)?, "update page")
    }

    /// Add labels to a page.
    pub fn add_labels(&self, page_id: &str, labels: &[String]) -> Result<()> {
        let r = add_labels_request(&self.auth, page_id, labels)?;
        check(&self.http.send(&r)?, "add labels")
    }

    /// Labels on a page.
    pub fn list_labels(&self, page_id: &str) -> Result<Vec<String>> {
        let r = list_labels_request(&self.auth, page_id)?;
        parse_labels(&self.http.send(&r)?)
    }

    /// Create or update a page and add labels (port of `exportToConfluence`).
    pub fn export_page(&self, p: &ExportParams) -> Result<ConfluencePage> {
        let page = if let Some(id) = &p.existing_page_id {
            self.update_page(id, &p.title, &p.markdown)?
        } else {
            self.create_page(&NewPage {
                space_id: p.space_id.clone(),
                title: p.title.clone(),
                markdown: p.markdown.clone(),
                parent_page_id: p.parent_page_id.clone(),
            })?
        };
        if !p.labels.is_empty() {
            self.add_labels(&page.id, &p.labels)?;
        }
        Ok(page)
    }

    /// Fetch a page as ADF and flatten it (port of `importFromConfluence`).
    pub fn import_page(&self, page_id: &str) -> Result<ImportedPage> {
        page_to_import(&self.get_page(page_id, BodyFormat::AtlasDocFormat)?)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use secrecy::SecretString;

    use super::*;
    use crate::git_provider::FakeTransport;
    use crate::integrations::http::{RecordingSleeper, RetryPolicy};

    const SPACES_P1: &str = r#"{"results":[{"id":"1001","key":"ENG","name":"Engineering","type":"global","status":"current"}],
      "_links":{"next":"/wiki/api/v2/spaces?cursor=abc%3D%3D&limit=100"}}"#;
    const SPACES_P2: &str = r#"{"results":[{"id":"1002","key":"OPS","name":"Ops","type":"global","status":"current"}],"_links":{}}"#;
    const PAGE: &str = r#"{"id":"555","status":"current","title":"Spec","spaceId":"1001","version":{"number":3,"createdAt":"x"},
      "body":{"storage":{"representation":"storage","value":"<p>hi</p>"}},
      "_links":{"webui":"/spaces/ENG/pages/555/Spec","base":"https://acme.atlassian.net/wiki"}}"#;
    const PAGE_ADF: &str = r#"{"id":"555","title":"Spec","spaceId":"1001","version":{"number":3},
      "body":{"atlas_doc_format":{"representation":"atlas_doc_format","value":"{\"type\":\"doc\",\"version\":1,\"content\":[{\"type\":\"heading\",\"attrs\":{\"level\":1},\"content\":[{\"type\":\"text\",\"text\":\"Hi\"}]},{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Body\"}]}]}"}}}"#;

    fn auth() -> ConfluenceAuth {
        JiraAuth::oauth(SecretString::from("tok".to_owned()), "cloud-1").unwrap()
    }
    fn client(t: &Arc<FakeTransport>) -> ConfluenceClient {
        ConfluenceClient::new(
            Http::new(t.clone())
                .with_sleeper(Arc::new(RecordingSleeper::new()))
                .with_policy(RetryPolicy::none()),
            auth(),
        )
    }
    fn body(r: &HttpRequest) -> Value {
        serde_json::from_str(&r.body_text().unwrap()).unwrap()
    }

    #[test]
    fn create_request_shape() {
        let r = create_page_request(
            &auth(),
            &NewPage {
                space_id: "1001".into(),
                title: " Spec ".into(),
                markdown: "# Hi\n\n```js\nx\n```".into(),
                parent_page_id: Some("77".into()),
            },
        )
        .unwrap();
        assert_eq!(r.method, HttpMethod::Post);
        assert_eq!(
            r.url,
            "https://api.atlassian.com/ex/confluence/cloud-1/wiki/api/v2/pages"
        );
        let b = body(&r);
        assert_eq!(b["spaceId"], "1001");
        assert_eq!(b["title"], "Spec");
        assert_eq!(b["parentId"], "77");
        assert_eq!(b["body"]["representation"], "storage");
        let v = b["body"]["value"].as_str().unwrap();
        assert!(v.starts_with("<h1>Hi</h1>"));
        assert!(v.contains("ac:structured-macro"));
    }

    #[test]
    fn update_request_bumps_version() {
        let r = update_page_request(&auth(), "555", "T", "text", 4).unwrap();
        assert_eq!(r.method, HttpMethod::Put);
        assert!(r.url.ends_with("/wiki/api/v2/pages/555"));
        let b = body(&r);
        assert_eq!(b["version"]["number"], 4);
        assert_eq!(b["id"], "555");
        assert_eq!(b["body"]["value"], "<p>text</p>");
    }

    #[test]
    fn id_and_label_validation() {
        assert!(get_page_request(&auth(), "5/../6", BodyFormat::Storage).is_err());
        assert!(create_page_request(
            &auth(),
            &NewPage {
                space_id: "ENG".into(),
                title: "t".into(),
                ..NewPage::default()
            }
        )
        .is_err());
        assert!(create_page_request(
            &auth(),
            &NewPage {
                space_id: "1".into(),
                title: " ".into(),
                ..NewPage::default()
            }
        )
        .is_err());
        assert_eq!(
            normalize_labels(&["Needs Review".into(), " ".into(), "v1.0".into()]).unwrap(),
            vec!["needs-review", "v1.0"]
        );
        assert!(normalize_labels(&["bad#label".into()]).is_err());
        assert!(add_labels_request(&auth(), "5", &[]).is_err());
        let r = add_labels_request(&auth(), "5", &["Spec".into()]).unwrap();
        assert!(r.url.ends_with("/wiki/rest/api/content/5/label"));
        assert_eq!(body(&r), json!([{"prefix": "global", "name": "spec"}]));
    }

    #[test]
    fn get_and_find_request_urls() {
        let r = get_page_request(&auth(), "555", BodyFormat::AtlasDocFormat).unwrap();
        assert!(r.url.ends_with("/pages/555?body-format=atlas_doc_format"));
        let r = find_pages_request(&auth(), "1001", "A & B").unwrap();
        assert!(r.url.contains("title=A%20%26%20B"));
        let basic = JiraAuth::basic(
            "https://acme.atlassian.net",
            "e",
            SecretString::from("t".to_owned()),
        )
        .unwrap();
        assert_eq!(
            list_spaces_request(&basic, Some("a b"), 1000).url,
            "https://acme.atlassian.net/wiki/api/v2/spaces?limit=250&cursor=a%20b"
        );
    }

    #[test]
    fn parses_pages_spaces_and_cursor() {
        let ok = |s: &str| HttpResponse::new(200, Default::default(), s);
        let (spaces, cur) = parse_spaces(&ok(SPACES_P1)).unwrap();
        assert_eq!(spaces[0].key, "ENG");
        assert_eq!(cur.as_deref(), Some("abc=="));
        let (_, cur) = parse_spaces(&ok(SPACES_P2)).unwrap();
        assert_eq!(cur, None);
        let p = parse_page(&ok(PAGE), "get page").unwrap();
        assert_eq!(p.version.unwrap().number, 3);
        assert_eq!(
            p.web_url().unwrap(),
            "https://acme.atlassian.net/wiki/spaces/ENG/pages/555/Spec"
        );
        assert_eq!(
            parse_labels(&ok(
                r#"{"results":[{"id":"1","name":"a","prefix":"global"}]}"#
            ))
            .unwrap(),
            vec!["a"]
        );
        assert_eq!(
            parse_pages(&ok(&format!(r#"{{"results":[{PAGE}]}}"#)))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn client_lists_spaces_across_pages() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], SPACES_P1);
        t.push_json(200, &[], SPACES_P2);
        let s = client(&t).list_spaces().unwrap();
        assert_eq!(s.len(), 2);
        assert!(t.requests()[1].url.contains("cursor=abc%3D%3D"));
    }

    #[test]
    fn export_creates_page_and_labels() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], PAGE);
        t.push_json(200, &[], r#"{"results":[{"name":"spec"}]}"#);
        let page = client(&t)
            .export_page(&ExportParams {
                space_id: "1001".into(),
                title: "Spec".into(),
                markdown: "hello".into(),
                labels: vec!["Spec".into()],
                ..ExportParams::default()
            })
            .unwrap();
        assert_eq!(page.id, "555");
        let reqs = t.requests();
        assert_eq!(reqs.len(), 2);
        assert_eq!(reqs[0].method, HttpMethod::Post);
        assert!(reqs[1].url.ends_with("/content/555/label"));
    }

    #[test]
    fn export_update_reads_version_then_puts_next() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], PAGE);
        t.push_json(200, &[], PAGE);
        client(&t)
            .export_page(&ExportParams {
                title: "Spec".into(),
                markdown: "x".into(),
                existing_page_id: Some("555".into()),
                ..ExportParams::default()
            })
            .unwrap();
        let reqs = t.requests();
        assert_eq!(reqs[0].method, HttpMethod::Get);
        assert_eq!(reqs[1].method, HttpMethod::Put);
        assert_eq!(body(&reqs[1])["version"]["number"], 4);
    }

    #[test]
    fn update_conflict_and_errors_map() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], PAGE);
        t.push_json(409, &[], r#"{"message":"version"}"#);
        let e = client(&t).update_page("555", "T", "x").unwrap_err();
        assert!(matches!(e, IntegrationError::Conflict(_)));
        let core: crate::Error = e.into();
        assert!(matches!(core, crate::Error::Conflict(_)));
        t.push_json(404, &[], "");
        assert!(matches!(
            client(&t).get_page("9", BodyFormat::Storage),
            Err(IntegrationError::NotFound(_))
        ));
        t.push_json(401, &[], "");
        assert!(matches!(
            client(&t).list_spaces(),
            Err(IntegrationError::Unauthorized(_))
        ));
    }

    #[test]
    fn import_flattens_adf() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], PAGE_ADF);
        let p = client(&t).import_page("555").unwrap();
        assert_eq!(p.title, "Spec");
        assert_eq!(p.content, "# Hi\n\nBody");
        assert_eq!(p.space_id, "1001");
        assert!(t.requests()[0].url.contains("body-format=atlas_doc_format"));
        let storage_only =
            parse_page(&HttpResponse::new(200, Default::default(), PAGE), "x").unwrap();
        assert!(page_to_import(&storage_only).is_err());
    }
}
