//! Thin HTTP seam. Everything network-shaped in this module goes through [`HttpTransport`], so
//! request builders and response parsers stay pure and tests use [`FakeTransport`].
//!
//! TODO(AI-74 wiring): the real transport is not shipped in this crate. `reqwest` was left out
//! on purpose: pulling it in (even optionally) rewrites `Cargo.lock` with the full TLS stack
//! (rustls + aws-lc-rs) for every sibling branch. The wiring wave should implement
//! [`HttpTransport`] once in the front-end crate that already links an HTTP client (Tauri's
//! `tauri-plugin-http` / `reqwest`, or `ureq` for the CLI); it is ~15 lines because
//! [`HttpRequest`] and [`HttpResponse`] are plain data.

use std::collections::VecDeque;
use std::fmt;
use std::sync::Mutex;

use super::provider::LlmError;

/// HTTP verb (only what the model APIs need).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// GET.
    Get,
    /// POST.
    Post,
}

/// An outgoing request. `Debug` redacts credential-bearing headers.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// Verb.
    pub method: Method,
    /// Absolute URL.
    pub url: String,
    /// Header name/value pairs.
    pub headers: Vec<(String, String)>,
    /// Body (JSON text for POST).
    pub body: Option<String>,
    /// Overall timeout in seconds.
    pub timeout_secs: u64,
}

/// Headers whose values must never be printed.
fn is_sensitive_header(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n == "authorization" || n == "x-api-key" || n == "proxy-authorization" || n.contains("token")
}

impl HttpRequest {
    /// Value of a header, case-insensitive.
    #[must_use]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

impl fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let headers: Vec<(&str, &str)> = self
            .headers
            .iter()
            .map(|(k, v)| {
                (
                    k.as_str(),
                    if is_sensitive_header(k) {
                        "[REDACTED]"
                    } else {
                        v.as_str()
                    },
                )
            })
            .collect();
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("url", &self.url)
            .field("headers", &headers)
            .field("body_len", &self.body.as_ref().map(String::len))
            .field("timeout_secs", &self.timeout_secs)
            .finish()
    }
}

/// A completed HTTP exchange.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Response body text.
    pub body: String,
}

impl HttpResponse {
    /// 2xx?
    #[must_use]
    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Sends one HTTP request. Implementations must not log request headers.
pub trait HttpTransport: Send + Sync + fmt::Debug {
    /// Perform the request.
    ///
    /// # Errors
    /// [`LlmError::Transport`] if no response was received.
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, LlmError>;
}

/// Scripted transport for tests; records requests.
#[derive(Default)]
pub struct FakeTransport {
    script: Mutex<VecDeque<Result<HttpResponse, LlmError>>>,
    seen: Mutex<Vec<HttpRequest>>,
}

impl fmt::Debug for FakeTransport {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FakeTransport")
    }
}

impl FakeTransport {
    /// Empty script.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue a response with the given status and body.
    pub fn push(&self, status: u16, body: &str) {
        if let Ok(mut s) = self.script.lock() {
            s.push_back(Ok(HttpResponse {
                status,
                body: body.to_owned(),
            }));
        }
    }

    /// Queue a transport failure.
    pub fn push_error(&self, message: &str) {
        if let Ok(mut s) = self.script.lock() {
            s.push_back(Err(LlmError::Transport(message.to_owned())));
        }
    }

    /// Requests seen so far.
    #[must_use]
    pub fn requests(&self) -> Vec<HttpRequest> {
        self.seen.lock().map(|s| s.clone()).unwrap_or_default()
    }
}

impl HttpTransport for FakeTransport {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, LlmError> {
        if let Ok(mut s) = self.seen.lock() {
            s.push(request.clone());
        }
        self.script
            .lock()
            .map_err(|_| LlmError::Exhausted)?
            .pop_front()
            .unwrap_or(Err(LlmError::Exhausted))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_redacts_credentials() {
        let r = HttpRequest {
            method: Method::Post,
            url: "https://x".into(),
            headers: vec![
                ("x-api-key".into(), "sk-ant-secret".into()),
                ("Authorization".into(), "Bearer sk-secret".into()),
                ("content-type".into(), "application/json".into()),
            ],
            body: Some("{}".into()),
            timeout_secs: 5,
        };
        let d = format!("{r:?}");
        assert!(!d.contains("secret"));
        assert!(d.contains("application/json"));
        assert_eq!(r.header("X-API-KEY"), Some("sk-ant-secret"));
    }

    #[test]
    fn fake_transport_scripts_and_records() {
        let t = FakeTransport::new();
        t.push(200, "ok");
        t.push_error("boom");
        let req = HttpRequest {
            method: Method::Get,
            url: "u".into(),
            headers: vec![],
            body: None,
            timeout_secs: 1,
        };
        assert!(t.send(&req).unwrap().is_success());
        assert_eq!(t.send(&req), Err(LlmError::Transport("boom".into())));
        assert_eq!(t.send(&req), Err(LlmError::Exhausted));
        assert_eq!(t.requests().len(), 3);
    }
}
