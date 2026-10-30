//! HTTP transport abstraction. All provider logic talks to this trait so it
//! can be tested with [`FakeTransport`] and never touches the network in tests.
//!
//! TODO: a real `reqwest`-backed implementation is deliberately not included
//! yet (it pulls an HTTP/TLS stack into `nyx-core`). The wiring wave should
//! add one in the front-end crate behind this same trait.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;

use super::{GitError, GitResult};

/// HTTP verb used by the providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    /// GET
    Get,
    /// POST
    Post,
    /// PUT (added by AI-71 for Jira/Confluence updates)
    Put,
    /// DELETE
    Delete,
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

    /// Iterate all pairs.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

/// An outgoing request. `Debug` redacts credential headers.
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
                if k.eq_ignore_ascii_case("authorization") {
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

    /// Deserialise the body as JSON.
    ///
    /// # Errors
    /// [`GitError::Parse`] if the body is not the expected JSON.
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> GitResult<T> {
        serde_json::from_slice(&self.body).map_err(|e| GitError::Parse(e.to_string()))
    }
}

/// Synchronous HTTP client abstraction.
pub trait HttpTransport: Send + Sync + fmt::Debug {
    /// Perform the request. Non-2xx statuses are NOT errors at this layer;
    /// only connection-level failures return `Err` ([`GitError::Transport`]).
    ///
    /// # Errors
    /// Connection, TLS or timeout failure.
    fn send(&self, req: &HttpRequest) -> GitResult<HttpResponse>;
}

/// Scripted in-memory transport: pops queued responses in order and records
/// every request. Returns a transport error when the queue is empty.
#[derive(Debug, Default)]
pub struct FakeTransport {
    queue: Mutex<VecDeque<GitResult<HttpResponse>>>,
    log: Mutex<Vec<HttpRequest>>,
}

impl FakeTransport {
    /// Empty fake.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a JSON response with the given status and extra headers.
    pub fn push_json(&self, status: u16, headers: &[(&str, &str)], body: &str) {
        self.push(HttpResponse::new(
            status,
            Headers::from_pairs(headers.iter().copied()),
            body.as_bytes(),
        ));
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
            q.push_back(Err(GitError::Transport(message.to_owned())));
        }
    }

    /// Snapshot of requests seen so far.
    #[must_use]
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.log.lock().map(|l| l.clone()).unwrap_or_default()
    }
}

impl HttpTransport for FakeTransport {
    fn send(&self, req: &HttpRequest) -> GitResult<HttpResponse> {
        if let Ok(mut l) = self.log.lock() {
            l.push(req.clone());
        }
        self.queue
            .lock()
            .map_err(|_| GitError::Transport("fake transport poisoned".into()))?
            .pop_front()
            .unwrap_or_else(|| {
                Err(GitError::Transport(
                    "fake transport: no response queued".into(),
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headers_case_insensitive() {
        let h = Headers::from_pairs([("X-RateLimit-Remaining", "3")]);
        assert_eq!(h.get("x-ratelimit-remaining"), Some("3"));
        assert_eq!(h.get("nope"), None);
    }

    #[test]
    fn debug_redacts_authorization() {
        let r =
            HttpRequest::new(HttpMethod::Get, "https://x").header("Authorization", "Bearer sekrit");
        let s = format!("{r:?}");
        assert!(!s.contains("sekrit"));
        assert!(s.contains("[redacted]"));
    }

    #[test]
    fn fake_pops_in_order_and_records() {
        let t = FakeTransport::new();
        t.push_json(200, &[], "{}");
        t.push_error("boom");
        let r = HttpRequest::new(HttpMethod::Get, "https://a");
        assert_eq!(t.send(&r).unwrap().status, 200);
        assert!(matches!(t.send(&r), Err(GitError::Transport(_))));
        assert!(t.send(&r).is_err());
        assert_eq!(t.requests().len(), 3);
    }
}
