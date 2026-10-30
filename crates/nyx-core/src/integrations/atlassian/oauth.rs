//! Atlassian OAuth 2.0 (3LO) with PKCE: authorise URL, token exchange, refresh, revoke,
//! accessible-resources lookup. Ports the OAuth half of `atlassian.service.ts`.
//!
//! All request builders are pure. [`begin_authorization`] and [`complete_authorization`] compose
//! them with [`PendingAuths`] and an [`Http`] for the desktop loopback flow. Atlassian still wants
//! the app's `client_secret` on the token endpoint even with PKCE; it is read from the
//! [`SecretStore`](crate::profile::SecretStore) by the caller and passed in [`OAuthClient`].

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::json;

use crate::integrations::http::{classify, parse_json, Http};
use crate::integrations::oauth::{
    code_challenge, generate_state, parse_callback, peek_state, url_with_params, PendingAuth,
    PendingAuths, Pkce,
};
use crate::integrations::{HttpMethod, HttpRequest, HttpResponse, IntegrationError, Result};

/// Authorise endpoint.
pub const AUTH_URL: &str = "https://auth.atlassian.com/authorize";
/// Token endpoint (exchange and refresh).
pub const TOKEN_URL: &str = "https://auth.atlassian.com/oauth/token";
/// Revoke endpoint.
pub const REVOKE_URL: &str = "https://auth.atlassian.com/oauth/revoke";
/// Accessible-resources endpoint (lists the Cloud sites a token can reach).
pub const RESOURCES_URL: &str = "https://api.atlassian.com/oauth/token/accessible-resources";
/// Display name used in errors.
pub const PROVIDER: &str = "Atlassian";

/// Scopes requested (same set as the TS service).
pub const SCOPES: &[&str] = &[
    "read:jira-work",
    "write:jira-work",
    "read:confluence-content.all",
    "write:confluence-content.all",
    "offline_access",
];

/// The OAuth app's credentials. The secret is optional so that a public client could be used.
#[derive(Debug)]
pub struct OAuthClient {
    /// Client id from the Atlassian developer console (not secret).
    pub client_id: String,
    /// Client secret; keep it in the secret store and load it per flow.
    pub client_secret: Option<SecretString>,
}

/// Tokens returned by the token endpoint.
#[derive(Debug)]
pub struct TokenSet {
    /// Bearer access token.
    pub access_token: SecretString,
    /// Refresh token (Atlassian rotates it on every refresh).
    pub refresh_token: Option<SecretString>,
    /// Lifetime of the access token in seconds.
    pub expires_in_secs: u64,
    /// Granted scopes.
    pub scopes: Vec<String>,
}

impl TokenSet {
    /// Absolute expiry given the time of issue.
    #[must_use]
    pub fn expires_at_ms(&self, now_ms: i64) -> i64 {
        let secs = i64::try_from(self.expires_in_secs).unwrap_or(i64::MAX);
        now_ms.saturating_add(secs.saturating_mul(1000))
    }
}

/// A Cloud site the user granted access to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AccessibleResource {
    /// Cloud id (used in the `api.atlassian.com/ex/...` gateway URLs).
    pub id: String,
    /// Site URL, for example `https://acme.atlassian.net`.
    pub url: String,
    /// Site name.
    pub name: String,
    /// Scopes granted on the site.
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// Build the authorise URL (PKCE `S256`, `prompt=consent`).
pub fn authorize_url(
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<String> {
    let scope = SCOPES.join(" ");
    url_with_params(
        AUTH_URL,
        &[
            ("audience", "api.atlassian.com"),
            ("client_id", client_id),
            ("scope", &scope),
            ("redirect_uri", redirect_uri),
            ("state", state),
            ("response_type", "code"),
            ("prompt", "consent"),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
        ],
    )
}

fn token_post(body: &serde_json::Value) -> HttpRequest {
    HttpRequest::new(HttpMethod::Post, TOKEN_URL)
        .header("Accept", "application/json")
        .json(body)
}

/// `authorization_code` exchange request.
#[must_use]
pub fn exchange_request(
    client: &OAuthClient,
    code: &str,
    redirect_uri: &str,
    verifier: &str,
) -> HttpRequest {
    token_post(&json!({
        "grant_type": "authorization_code",
        "client_id": client.client_id,
        "client_secret": client.client_secret.as_ref().map(ExposeSecret::expose_secret),
        "code": code,
        "redirect_uri": redirect_uri,
        "code_verifier": verifier,
    }))
}

/// `refresh_token` request.
#[must_use]
pub fn refresh_request(client: &OAuthClient, refresh_token: &str) -> HttpRequest {
    token_post(&json!({
        "grant_type": "refresh_token",
        "client_id": client.client_id,
        "client_secret": client.client_secret.as_ref().map(ExposeSecret::expose_secret),
        "refresh_token": refresh_token,
    }))
}

/// Token revocation request (best-effort in callers).
#[must_use]
pub fn revoke_request(client_id: &str, token: &str) -> HttpRequest {
    HttpRequest::new(HttpMethod::Post, REVOKE_URL).json(&json!({
        "client_id": client_id,
        "token": token,
    }))
}

/// Accessible-resources request.
#[must_use]
pub fn resources_request(access_token: &str) -> HttpRequest {
    HttpRequest::new(HttpMethod::Get, RESOURCES_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Accept", "application/json")
}

#[derive(Deserialize)]
struct RawToken {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: u64,
    #[serde(default)]
    scope: String,
}

/// Parse a token endpoint response.
///
/// For a refresh (`is_refresh`), 400 and 401 mean the refresh token is dead and map to
/// [`IntegrationError::TokenExpired`] (port of `AtlassianTokenExpiredError`).
pub fn parse_token_response(resp: &HttpResponse, is_refresh: bool) -> Result<TokenSet> {
    if !resp.is_success() {
        if is_refresh && matches!(resp.status, 400 | 401) {
            return Err(IntegrationError::TokenExpired(PROVIDER));
        }
        let op = if is_refresh {
            "token refresh"
        } else {
            "token exchange"
        };
        return Err(match classify(PROVIDER, op, resp) {
            IntegrationError::Api { status, body, .. } => {
                IntegrationError::OAuth(format!("Token exchange failed: {status} {body}"))
            }
            other => other,
        });
    }
    let raw: RawToken = parse_json(resp, "token response")?;
    Ok(TokenSet {
        access_token: SecretString::from(raw.access_token),
        refresh_token: raw.refresh_token.map(SecretString::from),
        expires_in_secs: raw.expires_in,
        scopes: raw.scope.split_whitespace().map(str::to_owned).collect(),
    })
}

/// Parse the accessible-resources list.
pub fn parse_resources(resp: &HttpResponse) -> Result<Vec<AccessibleResource>> {
    if !resp.is_success() {
        return Err(classify(PROVIDER, "accessible resources", resp));
    }
    parse_json(resp, "accessible resources")
}

/// Start the loopback flow: remember PKCE + state and return the URL to open in the browser.
pub fn begin_authorization(
    client_id: &str,
    redirect_uri: &str,
    team_id: &str,
    pending: &PendingAuths,
    now_ms: i64,
) -> Result<String> {
    let pkce = Pkce::generate()?;
    let state = generate_state()?;
    let url = authorize_url(client_id, redirect_uri, &state, &pkce.challenge)?;
    debug_assert_eq!(pkce.challenge, code_challenge(&pkce.verifier));
    pending.insert(
        PendingAuth {
            state,
            verifier: pkce.verifier,
            redirect_uri: redirect_uri.to_owned(),
            team_id: team_id.to_owned(),
            created_ms: now_ms,
        },
        now_ms,
    );
    Ok(url)
}

/// Finish the flow from the loopback request: validate state, exchange the code, and pick the
/// first accessible site (the TS service did the same).
///
/// Returns the tokens, the site and the Nyx team id remembered at [`begin_authorization`].
///
/// # Errors
/// OAuth/CSRF failures, expired pending state, token endpoint errors, or no accessible site.
pub fn complete_authorization(
    http: &Http,
    client: &OAuthClient,
    pending: &PendingAuths,
    callback_target: &str,
    now_ms: i64,
) -> Result<(TokenSet, AccessibleResource, String)> {
    let state = peek_state(callback_target)
        .ok_or_else(|| IntegrationError::Invalid("redirect carried no state parameter".into()))?;
    let p = pending.take(&state, now_ms).ok_or_else(|| {
        IntegrationError::OAuth("invalid or expired state parameter (possible CSRF)".into())
    })?;
    let code = parse_callback(callback_target, &p.state)?;
    let resp = http.send(&exchange_request(
        client,
        &code,
        &p.redirect_uri,
        &p.verifier,
    ))?;
    let tokens = parse_token_response(&resp, false)?;
    let resp = http.send(&resources_request(tokens.access_token.expose_secret()))?;
    let site = parse_resources(&resp)?
        .into_iter()
        .next()
        .ok_or_else(|| IntegrationError::OAuth("No accessible Atlassian sites found".into()))?;
    Ok((tokens, site, p.team_id))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::git_provider::FakeTransport;
    use crate::integrations::http::{RecordingSleeper, RetryPolicy};
    use crate::integrations::oauth::{loopback_redirect_uri, PENDING_TTL_MS};

    const TOKEN_JSON: &str = r#"{"access_token":"at-1","refresh_token":"rt-1","expires_in":3600,
        "scope":"read:jira-work write:jira-work offline_access","token_type":"Bearer"}"#;
    const RESOURCES_JSON: &str = r#"[
        {"id":"cloud-1","url":"https://acme.atlassian.net","name":"acme","scopes":["read:jira-work"],"avatarUrl":"x"},
        {"id":"cloud-2","url":"https://other.atlassian.net","name":"other","scopes":[]}]"#;

    fn client() -> OAuthClient {
        OAuthClient {
            client_id: "cid".into(),
            client_secret: Some(SecretString::from("csecret".to_owned())),
        }
    }

    fn http(t: &Arc<FakeTransport>) -> Http {
        Http::new(t.clone())
            .with_sleeper(Arc::new(RecordingSleeper::new()))
            .with_policy(RetryPolicy::none())
    }

    #[test]
    fn authorize_url_has_pkce_and_scopes() {
        let u = authorize_url("cid", "http://127.0.0.1:9/callback", "st", "ch").unwrap();
        let url = url::Url::parse(&u).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("auth.atlassian.com"));
        assert_eq!(q["audience"], "api.atlassian.com");
        assert_eq!(q["client_id"], "cid");
        assert_eq!(q["code_challenge"], "ch");
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["prompt"], "consent");
        assert_eq!(q["response_type"], "code");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:9/callback");
        assert!(q["scope"].contains("offline_access"));
        assert!(q["scope"].contains("write:confluence-content.all"));
    }

    #[test]
    fn exchange_and_refresh_bodies() {
        let r = exchange_request(&client(), "code1", "http://127.0.0.1:9/callback", "ver");
        let b: serde_json::Value = serde_json::from_str(&r.body_text().unwrap()).unwrap();
        assert_eq!(b["grant_type"], "authorization_code");
        assert_eq!(b["code_verifier"], "ver");
        assert_eq!(b["client_secret"], "csecret");
        assert_eq!(r.url, TOKEN_URL);
        let r = refresh_request(&client(), "rt");
        let b: serde_json::Value = serde_json::from_str(&r.body_text().unwrap()).unwrap();
        assert_eq!(b["grant_type"], "refresh_token");
        assert_eq!(b["refresh_token"], "rt");
        assert!(!format!("{r:?}").contains("csecret"));
        assert!(!format!("{:?}", client()).contains("csecret"));
    }

    #[test]
    fn parses_token_response() {
        let ok = HttpResponse::new(200, Default::default(), TOKEN_JSON);
        let t = parse_token_response(&ok, false).unwrap();
        assert_eq!(t.access_token.expose_secret(), "at-1");
        assert_eq!(t.refresh_token.as_ref().unwrap().expose_secret(), "rt-1");
        assert_eq!(t.expires_in_secs, 3600);
        assert_eq!(t.scopes.len(), 3);
        assert_eq!(t.expires_at_ms(1_000), 1_000 + 3_600_000);
        assert!(!format!("{t:?}").contains("at-1"));
    }

    #[test]
    fn token_errors() {
        let r = |s| HttpResponse::new(s, Default::default(), "{\"error\":\"invalid_grant\"}");
        assert!(matches!(
            parse_token_response(&r(400), true),
            Err(IntegrationError::TokenExpired(_))
        ));
        assert!(matches!(
            parse_token_response(&r(401), true),
            Err(IntegrationError::TokenExpired(_))
        ));
        assert!(matches!(
            parse_token_response(&r(400), false),
            Err(IntegrationError::OAuth(m)) if m.contains("400")
        ));
        assert!(matches!(
            parse_token_response(&r(500), true),
            Err(IntegrationError::OAuth(m)) if m.contains("500")
        ));
        assert!(matches!(
            parse_token_response(&HttpResponse::new(200, Default::default(), "nope"), false),
            Err(IntegrationError::Parse(_))
        ));
    }

    #[test]
    fn full_flow_with_fake_transport() {
        let pending = PendingAuths::new();
        let redirect = loopback_redirect_uri(4321);
        let url = begin_authorization("cid", &redirect, "team-1", &pending, 1_000).unwrap();
        let state = peek_state(&url.replace("https://auth.atlassian.com/authorize", "/x")).unwrap();
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], TOKEN_JSON);
        t.push_json(200, &[], RESOURCES_JSON);
        let cb = format!("GET /callback?code=abc&state={state} HTTP/1.1");
        let (tokens, site, team) =
            complete_authorization(&http(&t), &client(), &pending, &cb, 2_000).unwrap();
        assert_eq!(team, "team-1");
        assert_eq!(site.id, "cloud-1");
        assert_eq!(tokens.access_token.expose_secret(), "at-1");
        let reqs = t.requests();
        assert_eq!(reqs.len(), 2);
        let body: serde_json::Value = serde_json::from_str(&reqs[0].body_text().unwrap()).unwrap();
        assert_eq!(body["code"], "abc");
        assert_eq!(body["redirect_uri"], redirect);
        assert_eq!(
            body["code_challenge"],
            serde_json::Value::Null,
            "challenge is sent on authorize, verifier on exchange"
        );
        let verifier = body["code_verifier"].as_str().unwrap();
        assert!(url.contains(&code_challenge(verifier)));
        assert_eq!(reqs[1].headers.get("authorization"), Some("Bearer at-1"));
        // One-time use: replaying the same redirect fails.
        assert!(complete_authorization(&http(&t), &client(), &pending, &cb, 2_000).is_err());
    }

    #[test]
    fn flow_rejects_unknown_expired_and_site_less() {
        let pending = PendingAuths::new();
        let t = Arc::new(FakeTransport::new());
        let h = http(&t);
        assert!(
            complete_authorization(&h, &client(), &pending, "/callback?code=a&state=nope", 0)
                .is_err()
        );
        assert!(complete_authorization(&h, &client(), &pending, "/callback?code=a", 0).is_err());
        let url =
            begin_authorization("cid", "http://127.0.0.1:1/callback", "t", &pending, 0).unwrap();
        let state = peek_state(&url.replace("https://auth.atlassian.com/authorize", "/x")).unwrap();
        let late = format!("/callback?code=a&state={state}");
        assert!(
            complete_authorization(&h, &client(), &pending, &late, PENDING_TTL_MS + 1).is_err()
        );
        assert!(t.requests().is_empty(), "no network on rejected callbacks");

        let url =
            begin_authorization("cid", "http://127.0.0.1:1/callback", "t", &pending, 0).unwrap();
        let state = peek_state(&url.replace("https://auth.atlassian.com/authorize", "/x")).unwrap();
        t.push_json(200, &[], TOKEN_JSON);
        t.push_json(200, &[], "[]");
        let ok = format!("/callback?code=a&state={state}");
        let e = complete_authorization(&h, &client(), &pending, &ok, 5).unwrap_err();
        assert!(e.to_string().contains("No accessible"));
    }

    #[test]
    fn denied_authorization_surfaces_provider_error() {
        let pending = PendingAuths::new();
        let url =
            begin_authorization("cid", "http://127.0.0.1:1/callback", "t", &pending, 0).unwrap();
        let state = peek_state(&url.replace("https://auth.atlassian.com/authorize", "/x")).unwrap();
        let t = Arc::new(FakeTransport::new());
        let cb = format!("/callback?error=access_denied&state={state}");
        let e = complete_authorization(&http(&t), &client(), &pending, &cb, 1).unwrap_err();
        assert!(e.to_string().contains("access_denied"));
    }

    #[test]
    fn revoke_and_resources_requests() {
        let r = revoke_request("cid", "tok");
        assert_eq!(r.url, REVOKE_URL);
        assert!(r.body_text().unwrap().contains("\"token\":\"tok\""));
        let r = resources_request("tok");
        assert_eq!(r.headers.get("authorization"), Some("Bearer tok"));
    }
}
