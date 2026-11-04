//! Retrying HTTP wrapper and status classification shared by Atlassian and Slack.
//!
//! Rate limits: on `429` (and `503` that carries `Retry-After`) the request is retried after the
//! server-provided delay (default exponential back-off 1s, 2s, 4s), up to
//! [`RetryPolicy::max_attempts`]. If the server asks for more than
//! [`RetryPolicy::max_wait_secs`], the call fails immediately with
//! [`IntegrationError::RateLimited`] carrying the delay, so the UI can show it instead of blocking.
//! Sleeping goes through [`Sleeper`] so tests never wait.

use std::fmt;
use std::sync::{Arc, Mutex};

use super::{Headers, HttpRequest, HttpResponse, HttpTransport, IntegrationError, Result};
use crate::git_provider::util::truncate;

/// Retry behaviour for rate-limited responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Total attempts including the first (1 disables retries).
    pub max_attempts: u32,
    /// Longest single wait honoured; longer `Retry-After` values fail fast.
    pub max_wait_secs: u64,
    /// First back-off step when no `Retry-After` is sent (doubles each retry).
    pub base_backoff_secs: u64,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            max_wait_secs: 30,
            base_backoff_secs: 1,
        }
    }
}

impl RetryPolicy {
    /// No retries at all.
    #[must_use]
    pub fn none() -> Self {
        Self {
            max_attempts: 1,
            ..Self::default()
        }
    }
}

/// Blocking sleep seam.
pub trait Sleeper: Send + Sync + fmt::Debug {
    /// Block for `secs` seconds.
    fn sleep(&self, secs: u64);
}

/// Real sleeper using [`std::thread::sleep`].
#[derive(Debug, Default, Clone, Copy)]
pub struct ThreadSleeper;

impl Sleeper for ThreadSleeper {
    fn sleep(&self, secs: u64) {
        std::thread::sleep(std::time::Duration::from_secs(secs));
    }
}

/// Test sleeper: records requested waits and returns immediately.
#[derive(Debug, Default)]
pub struct RecordingSleeper {
    waits: Mutex<Vec<u64>>,
}

impl RecordingSleeper {
    /// Empty recorder.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Waits requested so far.
    #[must_use]
    pub fn waits(&self) -> Vec<u64> {
        self.waits.lock().map(|w| w.clone()).unwrap_or_default()
    }
}

impl Sleeper for RecordingSleeper {
    fn sleep(&self, secs: u64) {
        if let Ok(mut w) = self.waits.lock() {
            w.push(secs);
        }
    }
}

/// Seconds from a numeric `Retry-After` header. HTTP-date values are not supported (both
/// Atlassian and Slack send seconds); they yield `None`.
#[must_use]
pub fn retry_after_secs(headers: &Headers) -> Option<u64> {
    headers
        .get("retry-after")
        .and_then(|v| v.trim().parse::<u64>().ok())
}

/// Transport + retry policy + sleeper.
#[derive(Debug, Clone)]
pub struct Http {
    transport: Arc<dyn HttpTransport>,
    sleeper: Arc<dyn Sleeper>,
    policy: RetryPolicy,
}

impl Http {
    /// Wrap a transport with the default policy and a real sleeper.
    #[must_use]
    pub fn new(transport: Arc<dyn HttpTransport>) -> Self {
        Self {
            transport,
            sleeper: Arc::new(ThreadSleeper),
            policy: RetryPolicy::default(),
        }
    }

    /// Replace the sleeper (tests).
    #[must_use]
    pub fn with_sleeper(mut self, sleeper: Arc<dyn Sleeper>) -> Self {
        self.sleeper = sleeper;
        self
    }

    /// Replace the retry policy.
    #[must_use]
    pub fn with_policy(mut self, policy: RetryPolicy) -> Self {
        self.policy = policy;
        self
    }

    /// Send with rate-limit retries. Returns the last response whatever its status; only
    /// connection failures are errors.
    pub fn send(&self, req: &HttpRequest) -> Result<HttpResponse> {
        let mut attempt = 1u32;
        loop {
            let resp = self.transport.send(req)?;
            let retryable = resp.status == 429
                || (resp.status == 503 && retry_after_secs(&resp.headers).is_some());
            if !retryable || attempt >= self.policy.max_attempts {
                return Ok(resp);
            }
            let wait = retry_after_secs(&resp.headers).unwrap_or_else(|| {
                self.policy
                    .base_backoff_secs
                    .saturating_mul(1u64 << (attempt - 1).min(16))
            });
            if wait > self.policy.max_wait_secs {
                return Ok(resp);
            }
            self.sleeper.sleep(wait);
            attempt += 1;
        }
    }

    /// Send and turn non-2xx into a classified error.
    pub fn send_ok(
        &self,
        req: &HttpRequest,
        provider: &'static str,
        op: &'static str,
    ) -> Result<HttpResponse> {
        let resp = self.send(req)?;
        if resp.is_success() {
            Ok(resp)
        } else {
            Err(classify(provider, op, &resp))
        }
    }
}

/// Map a non-success response to an [`IntegrationError`].
#[must_use]
pub fn classify(provider: &'static str, op: &'static str, resp: &HttpResponse) -> IntegrationError {
    let body = truncate(&resp.text(), 200);
    match resp.status {
        401 => IntegrationError::Unauthorized(provider),
        403 => IntegrationError::Forbidden { provider, op, body },
        404 => IntegrationError::NotFound(format!("{provider} {op}: not found")),
        409 => IntegrationError::Conflict(format!("{provider} {op}: conflict {body}")),
        429 => IntegrationError::RateLimited {
            provider,
            retry_after_secs: retry_after_secs(&resp.headers),
        },
        status => IntegrationError::Api {
            provider,
            op,
            status,
            body,
        },
    }
}

/// Parse a JSON response body.
pub fn parse_json<T: serde::de::DeserializeOwned>(resp: &HttpResponse, what: &str) -> Result<T> {
    serde_json::from_slice(&resp.body).map_err(|e| IntegrationError::Parse(format!("{what}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_provider::{FakeTransport, HttpMethod};

    fn http(t: &Arc<FakeTransport>, s: &Arc<RecordingSleeper>) -> Http {
        Http::new(t.clone()).with_sleeper(s.clone())
    }
    fn req() -> HttpRequest {
        HttpRequest::new(HttpMethod::Get, "https://x")
    }

    #[test]
    fn retries_429_with_retry_after_then_succeeds() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(429, &[("Retry-After", "2")], "");
        t.push_json(200, &[], "{}");
        let s = Arc::new(RecordingSleeper::new());
        let r = http(&t, &s).send(&req()).unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(s.waits(), vec![2]);
        assert_eq!(t.requests().len(), 2);
    }

    #[test]
    fn backs_off_exponentially_without_header_and_gives_up() {
        let t = Arc::new(FakeTransport::new());
        for _ in 0..3 {
            t.push_json(429, &[], "");
        }
        let s = Arc::new(RecordingSleeper::new());
        let err = http(&t, &s).send_ok(&req(), "Jira", "x").unwrap_err();
        assert!(matches!(
            err,
            IntegrationError::RateLimited {
                retry_after_secs: None,
                ..
            }
        ));
        assert_eq!(s.waits(), vec![1, 2]);
    }

    #[test]
    fn long_retry_after_fails_fast() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(429, &[("retry-after", "120")], "");
        let s = Arc::new(RecordingSleeper::new());
        let err = http(&t, &s).send_ok(&req(), "Slack", "x").unwrap_err();
        assert!(matches!(
            err,
            IntegrationError::RateLimited {
                retry_after_secs: Some(120),
                ..
            }
        ));
        assert!(s.waits().is_empty());
        assert_eq!(t.requests().len(), 1);
    }

    #[test]
    fn retries_503_only_with_retry_after() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(503, &[], "down");
        let s = Arc::new(RecordingSleeper::new());
        assert_eq!(http(&t, &s).send(&req()).unwrap().status, 503);
        assert!(s.waits().is_empty());
        t.push_json(503, &[("Retry-After", "1")], "");
        t.push_json(200, &[], "");
        assert_eq!(http(&t, &s).send(&req()).unwrap().status, 200);
        assert_eq!(s.waits(), vec![1]);
    }

    #[test]
    fn classification_maps_statuses() {
        let r = |status| HttpResponse::new(status, Headers::new(), "boom");
        assert!(matches!(
            classify("Jira", "op", &r(401)),
            IntegrationError::Unauthorized("Jira")
        ));
        assert!(matches!(
            classify("Jira", "op", &r(403)),
            IntegrationError::Forbidden { .. }
        ));
        assert!(matches!(
            classify("Jira", "op", &r(404)),
            IntegrationError::NotFound(_)
        ));
        assert!(matches!(
            classify("Jira", "op", &r(409)),
            IntegrationError::Conflict(_)
        ));
        let e = classify("Jira", "op", &r(500));
        assert!(matches!(e, IntegrationError::Api { status: 500, .. }));
        let core: crate::Error = e.into();
        assert!(core.to_string().contains("500"));
    }

    #[test]
    fn transport_error_propagates() {
        let t = Arc::new(FakeTransport::new());
        t.push_error("dns");
        let s = Arc::new(RecordingSleeper::new());
        assert!(matches!(
            http(&t, &s).send(&req()),
            Err(IntegrationError::Transport(_))
        ));
    }
}
