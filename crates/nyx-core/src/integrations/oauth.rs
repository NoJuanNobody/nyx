//! Provider-neutral OAuth helpers for the desktop loopback flow.
//!
//! Desktop flow (RFC 8252): the app picks a free port, builds an authorise URL whose
//! `redirect_uri` is `http://127.0.0.1:<port>/callback`, opens the system browser and listens on
//! that port for one request. [`parse_callback`] validates that request (CSRF `state`, provider
//! errors) and returns the authorisation `code`; the PKCE verifier is retrieved from
//! [`PendingAuths`] by `state`. The listener itself is part of the wiring wave.
//!
//! Ports `generateCodeVerifier` / `generateCodeChallenge` / `generateStateToken` and the DB-backed
//! `pkce_challenges` store (10 minute TTL, one-time use) from `atlassian.service.ts`; on desktop
//! the store is in memory because the flow completes inside one process.

use std::collections::HashMap;
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};
use url::Url;

use super::{IntegrationError, Result};
use crate::git_provider::util::ct_eq;

/// How long a pending authorisation stays valid (matches the TS `PKCE_TTL_MS`).
pub const PENDING_TTL_MS: i64 = 10 * 60 * 1000;
/// Refresh when the access token expires within this window (matches `TOKEN_REFRESH_BUFFER_MS`).
pub const REFRESH_BUFFER_MS: i64 = 5 * 60 * 1000;

fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut buf = [0u8; N];
    getrandom::getrandom(&mut buf)
        .map_err(|e| IntegrationError::Invalid(format!("no OS randomness: {e}")))?;
    Ok(buf)
}

/// 32 random bytes, base64url without padding (43 chars; RFC 7636 allows 43 to 128).
pub fn generate_code_verifier() -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(random_bytes::<32>()?))
}

/// `BASE64URL(SHA256(verifier))` (the `S256` method).
#[must_use]
pub fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// 32 random bytes as 64 lowercase hex characters (CSRF `state`).
pub fn generate_state() -> Result<String> {
    Ok(hex::encode(random_bytes::<32>()?))
}

/// A verifier/challenge pair.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pkce {
    /// Secret kept by the app until the token exchange.
    pub verifier: String,
    /// Sent in the authorise URL.
    pub challenge: String,
}

impl Pkce {
    /// Fresh random pair.
    pub fn generate() -> Result<Self> {
        let verifier = generate_code_verifier()?;
        let challenge = code_challenge(&verifier);
        Ok(Self {
            verifier,
            challenge,
        })
    }
}

/// `http://127.0.0.1:<port>/callback`. Use the literal IP, not `localhost` (RFC 8252 section 8.3).
#[must_use]
pub fn loopback_redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

/// Whether `uri` is an `http` loopback redirect on `127.0.0.1`, `[::1]` or `localhost`.
#[must_use]
pub fn is_loopback_redirect(uri: &str) -> bool {
    Url::parse(uri).is_ok_and(|u| {
        u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
    })
}

/// Extract and validate the authorisation `code` from the redirect request.
///
/// `target` is either a full URL, a request target (`/callback?code=..&state=..`) or a whole
/// request line (`GET /callback?code=.. HTTP/1.1`).
///
/// # Errors
/// - [`IntegrationError::OAuth`] if the provider returned `error=...` (for example
///   `access_denied`) or the `state` does not match (possible CSRF).
/// - [`IntegrationError::Invalid`] if `code` or `state` is missing.
pub fn parse_callback(target: &str, expected_state: &str) -> Result<String> {
    let target = target.trim();
    let target = if let Some(rest) = target.strip_prefix("GET ") {
        rest.split_whitespace().next().unwrap_or("")
    } else {
        target
    };
    let url = if target.starts_with('/') {
        Url::parse(&format!("http://127.0.0.1{target}"))
    } else {
        Url::parse(target)
    }
    .map_err(|e| IntegrationError::Invalid(format!("unparsable redirect: {e}")))?;
    let (mut code, mut state, mut error, mut desc) = (None, None, None, None);
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            "error_description" => desc = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(IntegrationError::OAuth(match desc {
            Some(d) => format!("authorization failed: {e} ({d})"),
            None => format!("authorization failed: {e}"),
        }));
    }
    let (Some(code), Some(state)) = (code, state) else {
        return Err(IntegrationError::Invalid(
            "missing code or state parameter".into(),
        ));
    };
    if !ct_eq(state.as_bytes(), expected_state.as_bytes()) {
        return Err(IntegrationError::OAuth(
            "invalid or expired state parameter (possible CSRF)".into(),
        ));
    }
    Ok(code)
}

/// The `state` query parameter of a redirect target, used to look up the [`PendingAuth`] before
/// validating it with [`parse_callback`]. Unverified: never trust anything else from it.
#[must_use]
pub fn peek_state(target: &str) -> Option<String> {
    let t = target.trim();
    let t = t
        .strip_prefix("GET ")
        .map_or(t, |r| r.split_whitespace().next().unwrap_or(""));
    let url = if t.starts_with('/') {
        Url::parse(&format!("http://127.0.0.1{t}")).ok()?
    } else {
        Url::parse(t).ok()?
    };
    url.query_pairs()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.into_owned())
}

/// True when an access token expiring at `expires_at_ms` should be refreshed at `now_ms`.
#[must_use]
pub fn needs_refresh(expires_at_ms: i64, now_ms: i64) -> bool {
    expires_at_ms - now_ms < REFRESH_BUFFER_MS
}

/// Everything remembered between building the authorise URL and the redirect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAuth {
    /// CSRF state (also the lookup key).
    pub state: String,
    /// PKCE verifier.
    pub verifier: String,
    /// Redirect URI used in the authorise request (must be repeated in the token exchange).
    pub redirect_uri: String,
    /// Nyx team the connection belongs to.
    pub team_id: String,
    /// Creation time (unix ms).
    pub created_ms: i64,
}

/// In-memory one-time-use store of [`PendingAuth`] keyed by state.
#[derive(Debug, Default)]
pub struct PendingAuths {
    inner: Mutex<HashMap<String, PendingAuth>>,
}

impl PendingAuths {
    /// Empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Remember a pending authorisation; also drops expired ones (opportunistic cleanup as in TS).
    pub fn insert(&self, p: PendingAuth, now_ms: i64) {
        if let Ok(mut m) = self.inner.lock() {
            m.retain(|_, v| now_ms - v.created_ms <= PENDING_TTL_MS);
            m.insert(p.state.clone(), p);
        }
    }

    /// Remove and return the entry for `state` if present and not expired (one-time use: an
    /// expired entry is removed too, like the TS `getPkceData`).
    pub fn take(&self, state: &str, now_ms: i64) -> Option<PendingAuth> {
        let p = self.inner.lock().ok()?.remove(state)?;
        (now_ms - p.created_ms <= PENDING_TTL_MS).then_some(p)
    }
}

/// Receives the browser redirect of the desktop loopback flow. Implemented by `nyx-net`'s
/// `LoopbackListener`; kept as a trait here so this crate stays free of sockets and tests can
/// script the callback.
pub trait CallbackReceiver {
    /// The `redirect_uri` to put in the authorise URL (see [`loopback_redirect_uri`]).
    fn redirect_uri(&self) -> String;
    /// Block until the redirect arrives (or `timeout` passes) and return the authorisation
    /// `code` after validating `expected_state` (see [`parse_callback`]). One-shot.
    ///
    /// # Errors
    /// [`IntegrationError::OAuth`] for a provider error or state mismatch,
    /// [`IntegrationError::Transport`] on timeout or socket failure.
    fn wait_for_code(&self, expected_state: &str, timeout: std::time::Duration) -> Result<String>;
}

/// Build `https://host/path?k=v` with proper encoding.
pub(crate) fn url_with_params(base: &str, params: &[(&str, &str)]) -> Result<String> {
    Url::parse_with_params(base, params)
        .map(String::from)
        .map_err(|e| IntegrationError::Invalid(format!("bad url {base}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verifier_is_urlsafe_and_long_enough() {
        let v = generate_code_verifier().unwrap();
        assert!(v.len() >= 43);
        assert!(v
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        assert_ne!(v, generate_code_verifier().unwrap());
    }

    #[test]
    fn challenge_matches_rfc7636_vector() {
        // RFC 7636 appendix B.
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        assert_eq!(code_challenge("a"), code_challenge("a"));
        assert_ne!(code_challenge("a"), code_challenge("b"));
    }

    #[test]
    fn state_is_64_hex() {
        let s = generate_state().unwrap();
        assert_eq!(s.len(), 64);
        assert!(s.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(s, generate_state().unwrap());
    }

    #[test]
    fn loopback_uri_and_detection() {
        assert_eq!(
            loopback_redirect_uri(8123),
            "http://127.0.0.1:8123/callback"
        );
        assert!(is_loopback_redirect("http://127.0.0.1:1/callback"));
        assert!(is_loopback_redirect("http://localhost:9/cb"));
        assert!(!is_loopback_redirect("https://127.0.0.1/cb"));
        assert!(!is_loopback_redirect("http://evil.example/cb"));
    }

    #[test]
    fn callback_accepts_request_line_target_and_url() {
        let want = "abc123";
        for t in [
            "GET /callback?code=C0DE&state=abc123 HTTP/1.1",
            "/callback?state=abc123&code=C0DE",
            "http://127.0.0.1:8123/callback?code=C0DE&state=abc123",
        ] {
            assert_eq!(parse_callback(t, want).unwrap(), "C0DE", "{t}");
        }
    }

    #[test]
    fn callback_rejects_bad_state_missing_params_and_denial() {
        assert!(matches!(
            parse_callback("/callback?code=x&state=zzz", "abc"),
            Err(IntegrationError::OAuth(m)) if m.contains("CSRF")
        ));
        assert!(matches!(
            parse_callback("/callback?code=x", "abc"),
            Err(IntegrationError::Invalid(_))
        ));
        let e = parse_callback(
            "/callback?error=access_denied&error_description=User+said+no&state=abc",
            "abc",
        )
        .unwrap_err();
        assert!(e.to_string().contains("access_denied"));
        assert!(e.to_string().contains("User said no"));
    }

    #[test]
    fn refresh_window() {
        assert!(needs_refresh(1_000_000, 1_000_000 - 60_000));
        assert!(!needs_refresh(1_000_000, 1_000_000 - REFRESH_BUFFER_MS - 1));
        assert!(needs_refresh(1_000, 5_000));
    }

    #[test]
    fn pending_is_one_time_and_expires() {
        let store = PendingAuths::new();
        let mk = |state: &str, created| PendingAuth {
            state: state.into(),
            verifier: "v".into(),
            redirect_uri: "r".into(),
            team_id: "t".into(),
            created_ms: created,
        };
        store.insert(mk("s1", 0), 0);
        assert!(store.take("s1", 1000).is_some());
        assert!(store.take("s1", 1000).is_none());
        store.insert(mk("s2", 0), 0);
        assert!(store.take("s2", PENDING_TTL_MS + 1).is_none());
        store.insert(mk("old", 0), 0);
        store.insert(mk("new", PENDING_TTL_MS + 10), PENDING_TTL_MS + 10);
        assert!(store.take("old", PENDING_TTL_MS + 10).is_none());
        assert!(store.take("new", PENDING_TTL_MS + 10).is_some());
    }
}
