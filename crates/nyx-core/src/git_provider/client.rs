//! Shared plumbing for the three provider implementations: token lookup from the
//! `SecretStore`, sending, error classification, rate-limit capture, pagination.

use std::sync::{Arc, Mutex};

use secrecy::SecretString;

use super::pagination::{fetch_pages, DEFAULT_MAX_PAGES};
use super::rate_limit::{self, RateLimit};
use crate::net::{HttpRequest, HttpResponse, HttpTransport};
use super::util::truncate;
use super::{GitError, GitResult, OAuthToken, ProviderKind};
use crate::profile::{SecretKey, SecretStore};

#[derive(Debug)]
pub(crate) struct Client {
    pub kind: ProviderKind,
    transport: Arc<dyn HttpTransport>,
    secrets: Arc<dyn SecretStore>,
    last_rl: Mutex<Option<RateLimit>>,
}

impl Client {
    pub fn new(
        kind: ProviderKind,
        transport: Arc<dyn HttpTransport>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            kind,
            transport,
            secrets,
            last_rl: Mutex::new(None),
        }
    }

    /// Read the stored access token.
    pub fn token(&self) -> GitResult<SecretString> {
        self.secrets
            .get(&SecretKey::access_token(self.kind.secret_provider()))
            .map_err(|e| GitError::Secrets(e.to_string()))?
            .ok_or(GitError::MissingCredential(self.kind.display_name()))
    }

    /// Send and record rate-limit headers. Does not interpret the status.
    pub fn send(&self, req: &HttpRequest) -> GitResult<HttpResponse> {
        let resp = self.transport.send(req)?;
        if let Some(rl) = rate_limit::parse(self.kind, &resp.headers) {
            if let Ok(mut g) = self.last_rl.lock() {
                *g = Some(rl);
            }
        }
        Ok(resp)
    }

    /// Send and turn non-2xx into a classified error.
    pub fn send_ok(
        &self,
        req: &HttpRequest,
        op: &'static str,
        not_found: Option<&str>,
    ) -> GitResult<HttpResponse> {
        let resp = self.send(req)?;
        self.check(resp, op, not_found)
    }

    /// Classify a response.
    pub fn check(
        &self,
        resp: HttpResponse,
        op: &'static str,
        not_found: Option<&str>,
    ) -> GitResult<HttpResponse> {
        if resp.is_success() {
            Ok(resp)
        } else {
            Err(classify(self.kind, op, &resp, not_found))
        }
    }

    /// Follow pages with auth/error handling applied to every request.
    pub fn pages<T>(
        &self,
        first: HttpRequest,
        op: &'static str,
        next: impl Fn(&HttpResponse) -> Option<String>,
        parse: impl Fn(&HttpResponse) -> GitResult<Vec<T>>,
    ) -> GitResult<Vec<T>> {
        self.pages_capped(first, op, DEFAULT_MAX_PAGES, next, parse)
    }

    /// As [`Client::pages`] with an explicit page cap.
    pub fn pages_capped<T>(
        &self,
        first: HttpRequest,
        op: &'static str,
        max_pages: usize,
        next: impl Fn(&HttpResponse) -> Option<String>,
        parse: impl Fn(&HttpResponse) -> GitResult<Vec<T>>,
    ) -> GitResult<Vec<T>> {
        fetch_pages(first, max_pages, |r| self.send_ok(r, op, None), next, parse)
    }

    pub fn last_rate_limit(&self) -> Option<RateLimit> {
        self.last_rl.lock().ok().and_then(|g| *g)
    }
}

/// Map a non-success response to a [`GitError`] (port of the per-status branches in the TS services).
pub(crate) fn classify(
    kind: ProviderKind,
    op: &'static str,
    resp: &HttpResponse,
    not_found: Option<&str>,
) -> GitError {
    let name = kind.display_name();
    let rl = rate_limit::parse(kind, &resp.headers);
    let wait = rl.and_then(|r| r.wait_secs(now_epoch()));
    match resp.status {
        401 => GitError::Unauthorized(name),
        429 => GitError::RateLimited {
            provider: name,
            retry_after_secs: wait,
        },
        403 => {
            let body = resp.text();
            let limited = rl.is_some_and(|r| r.is_exhausted())
                || body.to_ascii_lowercase().contains("rate limit");
            if limited {
                GitError::RateLimited {
                    provider: name,
                    retry_after_secs: wait,
                }
            } else {
                GitError::Forbidden {
                    provider: name,
                    op,
                    body: truncate(&body, 200),
                }
            }
        }
        404 => GitError::NotFound(
            not_found.map_or_else(|| format!("{name} {op}: not found"), str::to_owned),
        ),
        status => GitError::Api {
            provider: name,
            op,
            status,
            body: truncate(&resp.text(), 200),
        },
    }
}

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Parse an OAuth token-exchange response (shared by all providers).
///
/// `scope_field` is `scope` (GitHub, GitLab) or `scopes` (Bitbucket).
pub(crate) fn parse_oauth(
    kind: ProviderKind,
    resp: &HttpResponse,
    scope_field: &str,
) -> GitResult<OAuthToken> {
    let name = kind.display_name();
    if !resp.is_success() {
        return Err(GitError::OAuth(format!(
            "{name} token exchange failed: {} {}",
            resp.status,
            truncate(&resp.text(), 200)
        )));
    }
    let v: serde_json::Value = resp.json()?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str());
    if let Some(err) = s("error") {
        let detail = s("error_description")
            .filter(|d| !d.is_empty())
            .unwrap_or(err);
        return Err(GitError::OAuth(format!("{name} OAuth error: {detail}")));
    }
    let access = s("access_token").filter(|t| !t.is_empty()).ok_or_else(|| {
        GitError::OAuth(format!("{name} token exchange returned no access_token"))
    })?;
    Ok(OAuthToken {
        access_token: SecretString::from(access.to_owned()),
        token_type: s("token_type").unwrap_or("bearer").to_owned(),
        scope: s(scope_field).unwrap_or("").to_owned(),
        refresh_token: s("refresh_token").map(|t| SecretString::from(t.to_owned())),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_provider::transport::Headers;

    fn r(status: u16, h: &[(&str, &str)], body: &str) -> HttpResponse {
        HttpResponse::new(status, Headers::from_pairs(h.iter().copied()), body)
    }

    #[test]
    fn classify_statuses() {
        let k = ProviderKind::GitHub;
        assert!(matches!(
            classify(k, "x", &r(401, &[], ""), None),
            GitError::Unauthorized("GitHub")
        ));
        assert!(matches!(
            classify(
                k,
                "x",
                &r(403, &[("x-ratelimit-remaining", "0")], "nope"),
                None
            ),
            GitError::RateLimited { .. }
        ));
        assert!(matches!(
            classify(
                k,
                "x",
                &r(403, &[], "API rate limit exceeded for user"),
                None
            ),
            GitError::RateLimited { .. }
        ));
        let long = "a".repeat(500);
        match classify(k, "getFileTree", &r(403, &[], &long), None) {
            GitError::Forbidden { body, .. } => assert_eq!(body.len(), 200),
            e => panic!("{e:?}"),
        }
        assert!(matches!(
            classify(k, "x", &r(429, &[("retry-after", "9")], ""), None),
            GitError::RateLimited {
                retry_after_secs: Some(9),
                ..
            }
        ));
        assert_eq!(
            classify(k, "x", &r(404, &[], ""), Some("custom")).to_string(),
            "custom"
        );
        assert!(matches!(
            classify(k, "x", &r(500, &[], "boom"), None),
            GitError::Api { status: 500, .. }
        ));
    }

    #[test]
    fn oauth_parse() {
        let k = ProviderKind::GitHub;
        let ok = parse_oauth(
            k,
            &r(200, &[], r#"{"access_token":"tok","scope":"repo"}"#),
            "scope",
        )
        .unwrap();
        assert_eq!(ok.token_type, "bearer");
        assert_eq!(ok.scope, "repo");
        assert!(!format!("{ok:?}").contains("tok\""));
        let e = parse_oauth(k, &r(200, &[], r#"{"error":"bad_verification_code","error_description":"The code passed is incorrect"}"#), "scope").unwrap_err();
        assert_eq!(
            e.to_string(),
            "GitHub OAuth error: The code passed is incorrect"
        );
        let e = parse_oauth(k, &r(200, &[], "{}"), "scope").unwrap_err();
        assert!(e.to_string().contains("no access_token"));
        assert!(parse_oauth(k, &r(500, &[], "x"), "scope").is_err());
    }
}
