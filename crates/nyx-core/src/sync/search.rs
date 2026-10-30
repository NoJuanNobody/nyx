//! Web search. Port of `search.service.ts`: Tavily when a key is configured, otherwise the same
//! explanatory stub result. The HTTP call goes through [`HttpTransport`] so tests never touch the
//! network; the real transport is supplied by the wiring wave (see `ai::transport`).

use std::fmt;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::ai::transport::{HttpRequest, HttpTransport, Method};
use crate::error::{Error, Result};

/// Tavily endpoint.
pub const TAVILY_API_URL: &str = "https://api.tavily.com/search";

/// One search hit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchResult {
    /// Page title.
    pub title: String,
    /// Extract.
    pub snippet: String,
    /// Page URL.
    pub url: String,
}

/// A web search backend.
pub trait WebSearch: Send + Sync {
    /// Search the web.
    ///
    /// # Errors
    /// Transport or provider failure.
    fn search(&self, query: &str) -> Result<Vec<SearchResult>>;
}

/// Result list used when no key is configured.
#[must_use]
pub fn stub_results(query: &str) -> Vec<SearchResult> {
    vec![SearchResult {
        title: format!("Stub result for: {query}"),
        snippet: "Web search is not configured. Add a Tavily API key to enable live results."
            .into(),
        url: "https://tavily.com".into(),
    }]
}

/// Tavily-backed search; stubbed when `api_key` is `None` or empty.
pub struct TavilySearch {
    api_key: Option<String>,
    transport: Arc<dyn HttpTransport>,
}

impl fmt::Debug for TavilySearch {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("TavilySearch")
            .field("configured", &self.api_key.is_some())
            .finish_non_exhaustive()
    }
}

impl TavilySearch {
    /// New backend. The key is never printed.
    #[must_use]
    pub fn new(api_key: Option<String>, transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            api_key: api_key.filter(|k| !k.trim().is_empty()),
            transport,
        }
    }
}

/// Parse a Tavily response body into results (entries missing a field become empty strings).
pub fn parse_tavily(body: &str) -> Result<Vec<SearchResult>> {
    let v: Value = serde_json::from_str(body)?;
    let results = v
        .get("results")
        .and_then(Value::as_array)
        .ok_or_else(|| Error::Invalid("Tavily response has no `results` array".into()))?;
    let s = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    Ok(results
        .iter()
        .map(|r| SearchResult {
            title: s(r, "title"),
            snippet: s(r, "content"),
            url: s(r, "url"),
        })
        .collect())
}

impl WebSearch for TavilySearch {
    fn search(&self, query: &str) -> Result<Vec<SearchResult>> {
        let Some(key) = &self.api_key else {
            return Ok(stub_results(query));
        };
        let req = HttpRequest {
            method: Method::Post,
            url: TAVILY_API_URL.into(),
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: Some(
                json!({"api_key": key, "query": query, "search_depth": "basic", "max_results": 10})
                    .to_string(),
            ),
            timeout_secs: 30,
        };
        let resp = self.transport.send(&req)?;
        if !resp.is_success() {
            let msg: String = resp.body.chars().take(300).collect();
            return Err(Error::Invalid(format!(
                "Tavily API error ({}): {msg}",
                resp.status
            )));
        }
        parse_tavily(&resp.body)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::transport::FakeTransport;

    #[test]
    fn stub_without_key_makes_no_request() {
        let t = Arc::new(FakeTransport::new());
        for key in [None, Some("  ".to_string())] {
            let s = TavilySearch::new(key, t.clone());
            let r = s.search("rust").unwrap();
            assert_eq!(r.len(), 1);
            assert_eq!(r[0].title, "Stub result for: rust");
        }
        assert!(t.requests().is_empty());
    }

    #[test]
    fn maps_results_and_sends_documented_body() {
        let t = Arc::new(FakeTransport::new());
        t.push(
            200,
            r#"{"results":[{"title":"A","content":"snip","url":"https://a"},{"title":"B"}]}"#,
        );
        let r = TavilySearch::new(Some("k".into()), t.clone())
            .search("q")
            .unwrap();
        assert_eq!(
            r[0],
            SearchResult {
                title: "A".into(),
                snippet: "snip".into(),
                url: "https://a".into()
            }
        );
        assert_eq!(r[1].url, "");
        let req = &t.requests()[0];
        assert_eq!(req.url, TAVILY_API_URL);
        let body: Value = serde_json::from_str(req.body.as_deref().unwrap()).unwrap();
        assert_eq!(body["max_results"], 10);
        assert_eq!(body["search_depth"], "basic");
        assert_eq!(body["query"], "q");
    }

    #[test]
    fn errors_surface_status_and_never_the_key() {
        let t = Arc::new(FakeTransport::new());
        t.push(429, "slow down");
        let s = TavilySearch::new(Some("secret-key".into()), t.clone());
        let e = s.search("q").unwrap_err().to_string();
        assert!(e.contains("429") && e.contains("slow down") && !e.contains("secret-key"));
        assert!(!format!("{s:?}").contains("secret-key"));
        t.push(200, "{}");
        assert!(s.search("q").is_err());
        t.push(200, "not json");
        assert!(s.search("q").is_err());
    }
}
