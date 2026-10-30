//! The one canonical HTTP seam of the core.
//!
//! Everything network-shaped (LLM providers, git hosts, Jira/Confluence/Slack, Linear, Tavily,
//! embeddings) builds an [`HttpRequest`] as plain data, hands it to an [`HttpTransport`] and parses
//! the [`HttpResponse`]. Builders and parsers stay pure; tests use [`FakeTransport`]; the real,
//! blocking, SSRF-guarded implementation lives in the `nyx-net` crate so `nyx-core` links no HTTP
//! or TLS stack.
//!
//! Historically `ai::transport` and `git_provider::transport` each had their own copy. Both paths
//! now re-export this module, so old imports keep working.
//!
//! # Error model
//!
//! Only "no usable response" is an `Err` ([`NetError`]): connection failure, timeout, a blocked
//! URL, an oversize body. A non-2xx status is a normal [`HttpResponse`]; callers classify it.
//! [`NetError`] converts into the module errors ([`crate::git_provider::GitError`],
//! [`crate::ai::LlmError`], [`crate::integrations::IntegrationError`], [`crate::Error`]) so `?`
//! keeps working.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;

use time::format_description::well_known::Rfc2822;
use time::OffsetDateTime;

/// HTTP verb.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HttpMethod {
    /// GET
    Get,
    /// POST
    Post,
    /// PUT
    Put,
    /// PATCH
    Patch,
    /// DELETE
    Delete,
}

impl HttpMethod {
    /// Upper-case verb, as sent on the wire.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }
}

impl fmt::Display for HttpMethod {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why no response was obtained.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NetError {
    /// Connection, TLS, DNS, or timeout failure.
    #[error("transport error: {0}")]
    Transport(String),
    /// The URL was refused by policy (SSRF guard, scheme, redirect to a forbidden target).
    #[error("request blocked: {0}")]
    Blocked(String),
    /// The response body exceeded the transport's size cap.
    #[error("response too large (limit {limit} bytes)")]
    TooLarge {
        /// The cap that was exceeded.
        limit: usize,
    },
    /// The body was not the expected JSON.
    #[error("unexpected response: {0}")]
    Parse(String),
    /// A scripted fake ran out of responses.
    #[error("fake transport: no response queued")]
    Exhausted,
}

/// Case-insensitive header collection.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Headers(Vec<(String, String)>);

impl Headers {
    /// Empty collection.
    #[must_use]
    pub fn new() -> Self {
        Self(Vec::new())
    }

    /// Build from name/value pairs.
    #[must_use]
    pub fn from_pairs<K: Into<String>, V: Into<String>>(
        pairs: impl IntoIterator<Item = (K, V)>,
    ) -> Self {
        Self(
            pairs
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        )
    }

    /// Append a header.
    pub fn push(&mut self, name: impl Into<String>, value: impl Into<String>) {
        self.0.push((name.into(), value.into()));
    }

    /// First value for `name` (ASCII case-insensitive).
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Remove every header called `name`.
    pub fn remove(&mut self, name: &str) {
        self.0.retain(|(k, _)| !k.eq_ignore_ascii_case(name));
    }

    /// Iterate all pairs.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    /// Number of headers.
    #[must_use]
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// True when there are no headers.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// `Retry-After` in seconds from now. Accepts delta-seconds and an HTTP-date (IMF-fixdate).
    #[must_use]
    pub fn retry_after_secs(&self) -> Option<u64> {
        self.retry_after_secs_at(OffsetDateTime::now_utc())
    }

    /// Like [`Self::retry_after_secs`] with an explicit clock (tests). A date in the past yields 0.
    #[must_use]
    pub fn retry_after_secs_at(&self, now: OffsetDateTime) -> Option<u64> {
        let raw = self.get("retry-after")?.trim();
        if let Ok(n) = raw.parse::<u64>() {
            return Some(n);
        }
        let when = OffsetDateTime::parse(raw, &Rfc2822).ok()?;
        let delta = (when - now).whole_seconds();
        Some(u64::try_from(delta).unwrap_or(0))
    }
}

/// Header names whose values must never be printed, and must never follow a redirect to another
/// origin (`authorization`, `x-api-key`, `proxy-authorization`, cookies, anything with `token`).
#[must_use]
pub fn is_sensitive_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "authorization"
        || n == "x-api-key"
        || n == "proxy-authorization"
        || n == "cookie"
        || n == "set-cookie"
        || n.contains("token")
}

/// An outgoing request. `Debug` redacts credential-bearing headers.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// Verb.
    pub method: HttpMethod,
    /// Absolute URL including query string.
    pub url: String,
    /// Request headers.
    pub headers: Headers,
    /// Raw body, if any.
    pub body: Option<Vec<u8>>,
    /// Overall timeout in seconds; `None` means the transport default.
    pub timeout_secs: Option<u64>,
}

impl HttpRequest {
    /// New request with no headers or body.
    #[must_use]
    pub fn new(method: HttpMethod, url: impl Into<String>) -> Self {
        Self {
            method,
            url: url.into(),
            headers: Headers::new(),
            body: None,
            timeout_secs: None,
        }
    }

    /// Add a header (builder style).
    #[must_use]
    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push(name, value);
        self
    }

    /// Set a JSON body and `Content-Type` (builder style).
    #[must_use]
    pub fn json(mut self, value: &serde_json::Value) -> Self {
        self.headers.push("Content-Type", "application/json");
        self.body = Some(value.to_string().into_bytes());
        self
    }

    /// Set a raw body (builder style).
    #[must_use]
    pub fn with_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = Some(body.into());
        self
    }

    /// Set the overall timeout (builder style).
    #[must_use]
    pub fn with_timeout(mut self, secs: u64) -> Self {
        self.timeout_secs = Some(secs);
        self
    }

    /// Value of a header, case-insensitive.
    #[must_use]
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers.get(name)
    }

    /// Body as UTF-8 text, for assertions.
    #[must_use]
    pub fn body_text(&self) -> Option<String> {
        self.body
            .as_ref()
            .map(|b| String::from_utf8_lossy(b).into_owned())
    }
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(k, v)| {
                if is_sensitive_header(k) {
                    (k, "[redacted]")
                } else {
                    (k, v)
                }
            })
            .collect();
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &headers)
            .field("body_len", &self.body.as_ref().map(Vec::len))
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

/// A received response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Response headers.
    pub headers: Headers,
    /// Raw body.
    pub body: Vec<u8>,
}

impl HttpResponse {
    /// Convenience constructor.
    #[must_use]
    pub fn new(status: u16, headers: Headers, body: impl Into<Vec<u8>>) -> Self {
        Self {
            status,
            headers,
            body: body.into(),
        }
    }

    /// Whether the status is 2xx.
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Body as lossy UTF-8.
    #[must_use]
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// `Retry-After` in seconds, if the server sent one.
    #[must_use]
    pub fn retry_after_secs(&self) -> Option<u64> {
        self.headers.retry_after_secs()
    }

    /// Deserialise the body as JSON.
    ///
    /// # Errors
    /// [`NetError::Parse`] if the body is not the expected JSON.
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T, NetError> {
        serde_json::from_slice(&self.body).map_err(|e| NetError::Parse(e.to_string()))
    }
}

/// Synchronous HTTP client abstraction.
pub trait HttpTransport: Send + Sync + fmt::Debug {
    /// Perform the request. Non-2xx statuses are NOT errors at this layer; only the absence of a
    /// response is. Implementations must not log request headers.
    ///
    /// # Errors
    /// [`NetError`] when no response was received.
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, NetError>;
}

/// Scripted in-memory transport: pops queued responses in order and records every request.
/// Returns [`NetError::Exhausted`] when the queue is empty.
#[derive(Debug, Default)]
pub struct FakeTransport {
    queue: Mutex<VecDeque<Result<HttpResponse, NetError>>>,
    log: Mutex<Vec<HttpRequest>>,
}

impl FakeTransport {
    /// Empty fake.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a response with the given status, extra headers and body.
    pub fn push_json(&self, status: u16, headers: &[(&str, &str)], body: &str) {
        self.push(HttpResponse::new(
            status,
            Headers::from_pairs(headers.iter().copied()),
            body.as_bytes(),
        ));
    }

    /// Queue a header-less response with the given status and body.
    pub fn push_text(&self, status: u16, body: &str) {
        self.push_json(status, &[], body);
    }

    /// Queue a response.
    pub fn push(&self, resp: HttpResponse) {
        if let Ok(mut q) = self.queue.lock() {
            q.push_back(Ok(resp));
        }
    }

    /// Queue a connection-level failure.
    pub fn push_error(&self, message: &str) {
        if let Ok(mut q) = self.queue.lock() {
            q.push_back(Err(NetError::Transport(message.to_owned())));
        }
    }

    /// Snapshot of requests seen so far.
    #[must_use]
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.log.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

impl HttpTransport for FakeTransport {
    fn send(&self, req: &HttpRequest) -> Result<HttpResponse, NetError> {
        if let Ok(mut l) = self.log.lock() {
            l.push(req.clone());
        }
        self.queue
            .lock()
            .map_err(|_| NetError::Transport("fake transport poisoned".into()))?
            .pop_front()
            .unwrap_or(Err(NetError::Exhausted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_case_insensitive_and_remove() {
        let mut h = Headers::from_pairs([("X-RateLimit-Remaining", "3")]);
        assert_eq!(h.get("x-ratelimit-remaining"), Some("3"));
        assert_eq!(h.get("nope"), None);
        h.remove("X-RATELIMIT-REMAINING");
        assert!(h.is_empty());
    }

    #[test]
    fn debug_redacts_credentials() {
        let r = HttpRequest::new(HttpMethod::Post, "https://x")
            .header("Authorization", "Bearer sekrit")
            .header("x-api-key", "sk-ant-secret")
            .header("X-Auth-Token", "tok")
            .header("content-type", "application/json");
        let s = format!("{r:?}");
        assert!(!s.contains("sekrit") && !s.contains("secret") && !s.contains("tok\""));
        assert!(s.contains("[redacted]") && s.contains("application/json"));
        assert_eq!(r.header_value("X-API-KEY"), Some("sk-ant-secret"));
    }

    #[test]
    fn fake_pops_in_order_and_records() {
        let t = FakeTransport::new();
        t.push_text(200, "{}");
        t.push_error("boom");
        let r = HttpRequest::new(HttpMethod::Get, "https://a");
        assert_eq!(t.send(&r).unwrap().status, 200);
        assert_eq!(t.send(&r), Err(NetError::Transport("boom".into())));
        assert_eq!(t.send(&r), Err(NetError::Exhausted));
        assert_eq!(t.requests().len(), 3);
    }

    #[test]
    fn methods_render() {
        assert_eq!(HttpMethod::Patch.as_str(), "PATCH");
        assert_eq!(HttpMethod::Delete.to_string(), "DELETE");
    }

    #[test]
    fn retry_after_seconds_and_date() {
        let now = OffsetDateTime::parse("Sun, 06 Nov 1994 08:49:07 GMT", &Rfc2822).unwrap();
        let h = Headers::from_pairs([("Retry-After", " 120 ")]);
        assert_eq!(h.retry_after_secs_at(now), Some(120));
        let h = Headers::from_pairs([("retry-after", "Sun, 06 Nov 1994 08:49:37 GMT")]);
        assert_eq!(h.retry_after_secs_at(now), Some(30));
        let h = Headers::from_pairs([("retry-after", "Sun, 06 Nov 1994 08:00:00 GMT")]);
        assert_eq!(h.retry_after_secs_at(now), Some(0));
        let h = Headers::from_pairs([("retry-after", "soon")]);
        assert_eq!(h.retry_after_secs_at(now), None);
        assert_eq!(Headers::new().retry_after_secs_at(now), None);
    }

    #[test]
    fn json_parse_error_is_net_error() {
        let r = HttpResponse::new(200, Headers::new(), "nope");
        assert!(matches!(r.json::<Vec<u8>>(), Err(NetError::Parse(_))));
    }
}
