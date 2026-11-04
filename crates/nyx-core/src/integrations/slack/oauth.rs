//! Slack OAuth v2 install: authorise URL and `oauth.v2.access` exchange.
//!
//! Port of `GET /slack/install` and `GET /slack/callback`. Differences: the TS passed the Nyx team
//! id as `state` (guessable, no CSRF protection); here `state` is a random token from
//! [`crate::integrations::oauth::generate_state`] validated with
//! [`crate::integrations::oauth::parse_callback`]. Slack does not support PKCE for this flow, and
//! it only accepts `https` redirect URLs, so a pure loopback redirect (`http://127.0.0.1`) is not
//! possible: the desktop app needs an https relay page that forwards `code` and `state` to the
//! loopback listener, or manual bot-token entry (`xoxb-...`) via [`super::store::connect_with_token`].

use secrecy::SecretString;
use serde_json::Value;

use super::api::parse_envelope;
use crate::git_provider::util::query;
use crate::integrations::oauth::url_with_params;
use crate::integrations::{HttpMethod, HttpRequest, HttpResponse, IntegrationError, Result};

/// Authorise endpoint.
pub const AUTH_URL: &str = "https://slack.com/oauth/v2/authorize";
/// Token endpoint (a Web API method).
pub const TOKEN_URL: &str = "https://slack.com/api/oauth.v2.access";

/// Bot scopes (same set as the TS install route).
pub const BOT_SCOPES: &[&str] = &[
    "channels:history",
    "channels:read",
    "chat:write",
    "commands",
    "reactions:read",
];

/// Install URL.
pub fn install_url(client_id: &str, redirect_uri: &str, state: &str) -> Result<String> {
    let scope = BOT_SCOPES.join(",");
    url_with_params(
        AUTH_URL,
        &[
            ("client_id", client_id),
            ("scope", &scope),
            ("redirect_uri", redirect_uri),
            ("state", state),
        ],
    )
}

/// `oauth.v2.access` request (form-encoded, as Slack requires).
#[must_use]
pub fn exchange_request(
    client_id: &str,
    client_secret: &str,
    code: &str,
    redirect_uri: &str,
) -> HttpRequest {
    let mut r = HttpRequest::new(HttpMethod::Post, TOKEN_URL).header("Accept", "application/json");
    r.headers
        .push("Content-Type", "application/x-www-form-urlencoded");
    r.body = Some(
        query(&[
            ("client_id", client_id),
            ("client_secret", client_secret),
            ("code", code),
            ("redirect_uri", redirect_uri),
        ])
        .into_bytes(),
    );
    r
}

/// A completed Slack install.
#[derive(Debug)]
pub struct SlackInstall {
    /// Bot token (`xoxb-...`).
    pub bot_token: SecretString,
    /// Workspace id.
    pub slack_team_id: String,
    /// Workspace name.
    pub team_name: String,
    /// Bot user id.
    pub bot_user_id: Option<String>,
    /// Granted scopes.
    pub scopes: Vec<String>,
}

/// Parse an `oauth.v2.access` response. Requires `access_token` and `team.id` (the TS check).
pub fn parse_install(resp: &HttpResponse) -> Result<SlackInstall> {
    let v = parse_envelope(resp, "oauth.v2.access")?;
    let token = v.get("access_token").and_then(Value::as_str);
    let team_id = v.pointer("/team/id").and_then(Value::as_str);
    let (Some(token), Some(team_id)) = (token, team_id) else {
        return Err(IntegrationError::OAuth(
            "Failed to complete Slack OAuth".into(),
        ));
    };
    Ok(SlackInstall {
        bot_token: SecretString::from(token.to_owned()),
        slack_team_id: team_id.to_owned(),
        team_name: v
            .pointer("/team/name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        bot_user_id: v
            .get("bot_user_id")
            .and_then(Value::as_str)
            .map(str::to_owned),
        scopes: v
            .get("scope")
            .and_then(Value::as_str)
            .map(|s| s.split(',').map(str::to_owned).collect())
            .unwrap_or_default(),
    })
}

#[cfg(test)]
mod tests {
    use secrecy::ExposeSecret;

    use super::*;

    #[test]
    fn install_url_has_scopes_and_state() {
        let u = install_url("123.456", "https://relay.example/slack", "st").unwrap();
        let url = url::Url::parse(&u).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.path(), "/oauth/v2/authorize");
        assert_eq!(q["client_id"], "123.456");
        assert_eq!(
            q["scope"],
            "channels:history,channels:read,chat:write,commands,reactions:read"
        );
        assert_eq!(q["state"], "st");
        assert_eq!(q["redirect_uri"], "https://relay.example/slack");
    }

    #[test]
    fn exchange_is_form_encoded() {
        let r = exchange_request("cid", "se&cret", "co de", "https://r/x");
        assert_eq!(
            r.headers.get("content-type"),
            Some("application/x-www-form-urlencoded")
        );
        assert_eq!(
            r.body_text().unwrap(),
            "client_id=cid&client_secret=se%26cret&code=co%20de&redirect_uri=https%3A%2F%2Fr%2Fx"
        );
    }

    #[test]
    fn parses_install_and_errors() {
        let ok = HttpResponse::new(
            200,
            Default::default(),
            r#"{"ok":true,"access_token":"xoxb-1","token_type":"bot","scope":"chat:write,commands","bot_user_id":"U0B","app_id":"A1","team":{"id":"T1","name":"Acme"}}"#,
        );
        let i = parse_install(&ok).unwrap();
        assert_eq!(i.bot_token.expose_secret(), "xoxb-1");
        assert_eq!(i.slack_team_id, "T1");
        assert_eq!(i.team_name, "Acme");
        assert_eq!(i.scopes, ["chat:write", "commands"]);
        assert!(!format!("{i:?}").contains("xoxb-1"));
        let bad = HttpResponse::new(
            200,
            Default::default(),
            r#"{"ok":false,"error":"invalid_code"}"#,
        );
        assert!(
            matches!(parse_install(&bad), Err(IntegrationError::SlackApi { code, .. }) if code == "invalid_code")
        );
        let partial =
            HttpResponse::new(200, Default::default(), r#"{"ok":true,"access_token":"x"}"#);
        assert!(matches!(
            parse_install(&partial),
            Err(IntegrationError::OAuth(_))
        ));
    }
}
