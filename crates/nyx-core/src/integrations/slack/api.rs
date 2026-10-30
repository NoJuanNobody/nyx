//! Slack Web API: request builders, response parsers and [`SlackClient`].
//!
//! Slack answers HTTP 200 with `{"ok": false, "error": "..."}` for most failures, so parsing goes
//! through [`parse_envelope`], which maps error codes onto [`IntegrationError`]: auth problems to
//! `Unauthorized`, `ratelimited` / HTTP 429 to `RateLimited`, everything else to `SlackApi`.
//! Port of `sendSlackChannelMessage` and `sendSlackResponse`.

use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use url::Url;

use super::blocks::MAX_BLOCKS;
use crate::git_provider::util::query;
use crate::integrations::http::{classify, parse_json, retry_after_secs, Http};
use crate::integrations::{HttpMethod, HttpRequest, HttpResponse, IntegrationError, Result};
use crate::profile::{Provider, SecretKey, SecretStore};

/// Display name used in errors.
pub const PROVIDER: &str = "Slack";
/// Web API base.
pub const API_BASE: &str = "https://slack.com/api";
/// Slack rejects `text` longer than this.
pub const MAX_TEXT_CHARS: usize = 40_000;
const MAX_CHANNEL_PAGES: usize = 10;

/// Secret key of the bot token.
#[must_use]
pub fn bot_token_key() -> SecretKey {
    SecretKey::access_token(Provider::Slack)
}

/// Secret key of the app's signing secret (verifies incoming requests).
#[must_use]
pub fn signing_secret_key() -> SecretKey {
    SecretKey::api_key(Provider::Slack)
}

/// A message to post.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PostMessage {
    /// Channel id (or name for public channels).
    pub channel: String,
    /// Message text; with `blocks` it is the notification fallback.
    pub text: String,
    /// Block Kit blocks (see [`super::blocks`]).
    pub blocks: Vec<Value>,
    /// Reply in this thread.
    pub thread_ts: Option<String>,
}

/// Result of `chat.postMessage`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PostedMessage {
    /// Channel id the message landed in.
    pub channel: String,
    /// Message timestamp (its id within the channel).
    pub ts: String,
}

/// A channel from `conversations.list`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SlackChannel {
    /// Channel id.
    pub id: String,
    /// Name without `#`.
    #[serde(default)]
    pub name: String,
    /// Private channel.
    #[serde(default)]
    pub is_private: bool,
    /// Archived.
    #[serde(default)]
    pub is_archived: bool,
    /// Whether the bot is a member.
    #[serde(default)]
    pub is_member: bool,
    /// Member count when provided.
    #[serde(default)]
    pub num_members: Option<u64>,
}

/// One page of channels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelPage {
    /// Channels.
    pub channels: Vec<SlackChannel>,
    /// Cursor for the next page, `None` when done.
    pub next_cursor: Option<String>,
}

/// `auth.test` identity.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct AuthInfo {
    /// Workspace id.
    pub team_id: String,
    /// Workspace name.
    #[serde(default)]
    pub team: String,
    /// Bot user id.
    #[serde(default)]
    pub user_id: String,
    /// Bot id.
    #[serde(default)]
    pub bot_id: Option<String>,
}

fn authed(token: &str, method: HttpMethod, path: &str) -> HttpRequest {
    HttpRequest::new(method, format!("{API_BASE}/{path}"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
}

/// `chat.postMessage`.
pub fn post_message_request(token: &str, msg: &PostMessage) -> Result<HttpRequest> {
    if msg.channel.trim().is_empty() {
        return Err(IntegrationError::Invalid("channel is required".into()));
    }
    if msg.text.trim().is_empty() && msg.blocks.is_empty() {
        return Err(IntegrationError::Invalid(
            "message needs text or blocks".into(),
        ));
    }
    if msg.text.chars().count() > MAX_TEXT_CHARS {
        return Err(IntegrationError::Invalid(format!(
            "message text exceeds {MAX_TEXT_CHARS} characters"
        )));
    }
    if msg.blocks.len() > MAX_BLOCKS {
        return Err(IntegrationError::Invalid(format!(
            "at most {MAX_BLOCKS} blocks per message"
        )));
    }
    let mut body = Map::new();
    body.insert("channel".into(), json!(msg.channel));
    body.insert("text".into(), json!(msg.text));
    if !msg.blocks.is_empty() {
        body.insert("blocks".into(), Value::Array(msg.blocks.clone()));
    }
    if let Some(ts) = &msg.thread_ts {
        body.insert("thread_ts".into(), json!(ts));
    }
    Ok(authed(token, HttpMethod::Post, "chat.postMessage").json(&Value::Object(body)))
}

/// `conversations.list` (GET with a query string).
#[must_use]
pub fn conversations_list_request(
    token: &str,
    types: &str,
    cursor: Option<&str>,
    limit: u32,
) -> HttpRequest {
    let limit = limit.clamp(1, 1000).to_string();
    let mut pairs = vec![
        ("types", types),
        ("exclude_archived", "true"),
        ("limit", limit.as_str()),
    ];
    if let Some(c) = cursor {
        pairs.push(("cursor", c));
    }
    authed(
        token,
        HttpMethod::Get,
        &format!("conversations.list?{}", query(&pairs)),
    )
}

/// `auth.test`.
#[must_use]
pub fn auth_test_request(token: &str) -> HttpRequest {
    authed(token, HttpMethod::Post, "auth.test")
}

/// Reply to a slash command / interaction via its `response_url`. The URL must be an https
/// `hooks.slack.com` address (it comes from an inbound request, so it is untrusted).
pub fn response_url_request(response_url: &str, message: &Value) -> Result<HttpRequest> {
    let u = Url::parse(response_url)
        .map_err(|e| IntegrationError::Invalid(format!("bad response_url: {e}")))?;
    if u.scheme() != "https" || u.host_str() != Some("hooks.slack.com") || u.port().is_some() {
        return Err(IntegrationError::Invalid(
            "response_url must be https://hooks.slack.com/...".into(),
        ));
    }
    Ok(HttpRequest::new(HttpMethod::Post, u.as_str()).json(message))
}

/// Validate a Slack response and return its JSON body.
pub fn parse_envelope(resp: &HttpResponse, method: &'static str) -> Result<Value> {
    if !resp.is_success() {
        return Err(classify(PROVIDER, method, resp));
    }
    let v: Value = parse_json(resp, method)?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        return Ok(v);
    }
    let code = v
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("unknown_error")
        .to_owned();
    Err(match code.as_str() {
        "invalid_auth" | "not_authed" | "token_revoked" | "token_expired" | "account_inactive" => {
            IntegrationError::Unauthorized(PROVIDER)
        }
        "ratelimited" | "rate_limited" => IntegrationError::RateLimited {
            provider: PROVIDER,
            retry_after_secs: retry_after_secs(&resp.headers),
        },
        _ => IntegrationError::SlackApi { method, code },
    })
}

/// Parse a `chat.postMessage` response.
pub fn parse_post_message(resp: &HttpResponse) -> Result<PostedMessage> {
    let v = parse_envelope(resp, "chat.postMessage")?;
    let field = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    match (field("channel"), field("ts")) {
        (Some(channel), Some(ts)) => Ok(PostedMessage { channel, ts }),
        _ => Err(IntegrationError::Parse(
            "chat.postMessage: missing channel/ts".into(),
        )),
    }
}

/// Parse a `conversations.list` response.
pub fn parse_channels(resp: &HttpResponse) -> Result<ChannelPage> {
    let v = parse_envelope(resp, "conversations.list")?;
    let channels = serde_json::from_value(v.get("channels").cloned().unwrap_or(json!([])))
        .map_err(|e| IntegrationError::Parse(format!("conversations.list: {e}")))?;
    let next_cursor = v
        .pointer("/response_metadata/next_cursor")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    Ok(ChannelPage {
        channels,
        next_cursor,
    })
}

/// Parse an `auth.test` response.
pub fn parse_auth_test(resp: &HttpResponse) -> Result<AuthInfo> {
    let v = parse_envelope(resp, "auth.test")?;
    serde_json::from_value(v).map_err(|e| IntegrationError::Parse(format!("auth.test: {e}")))
}

/// Slack Web API client bound to one bot token.
#[derive(Debug)]
pub struct SlackClient {
    http: Http,
    token: SecretString,
}

impl SlackClient {
    /// Client with an explicit token.
    #[must_use]
    pub fn new(http: Http, token: SecretString) -> Self {
        Self { http, token }
    }

    /// Client using the bot token from the secret store.
    ///
    /// # Errors
    /// [`IntegrationError::MissingCredential`] if Slack is not connected.
    pub fn from_secrets(http: Http, secrets: &dyn SecretStore) -> Result<Self> {
        let token = secrets
            .get(&bot_token_key())
            .map_err(|e| IntegrationError::Secrets(e.to_string()))?
            .ok_or(IntegrationError::MissingCredential(PROVIDER))?;
        Ok(Self::new(http, token))
    }

    /// Post a message.
    pub fn post_message(&self, msg: &PostMessage) -> Result<PostedMessage> {
        let r = post_message_request(self.token.expose_secret(), msg)?;
        parse_post_message(&self.http.send(&r)?)
    }

    /// Convenience for plain text (port of `sendSlackChannelMessage`).
    pub fn send_text(&self, channel: &str, text: &str) -> Result<PostedMessage> {
        self.post_message(&PostMessage {
            channel: channel.to_owned(),
            text: text.to_owned(),
            ..PostMessage::default()
        })
    }

    /// All non-archived channels of the given `types` (for example `public_channel,private_channel`),
    /// following cursors up to 10 pages.
    pub fn list_channels(&self, types: &str) -> Result<Vec<SlackChannel>> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_CHANNEL_PAGES {
            let r = conversations_list_request(
                self.token.expose_secret(),
                types,
                cursor.as_deref(),
                200,
            );
            let mut page = parse_channels(&self.http.send(&r)?)?;
            out.append(&mut page.channels);
            if page.next_cursor.is_none() {
                break;
            }
            cursor = page.next_cursor;
        }
        Ok(out)
    }

    /// Identify the token's workspace and bot.
    pub fn auth_test(&self) -> Result<AuthInfo> {
        parse_auth_test(
            &self
                .http
                .send(&auth_test_request(self.token.expose_secret()))?,
        )
    }

    /// Post to a `response_url` (port of `sendSlackResponse`). The reply is not interpreted beyond
    /// the HTTP status.
    pub fn respond(&self, response_url: &str, message: &Value) -> Result<()> {
        let r = response_url_request(response_url, message)?;
        let resp = self.http.send(&r)?;
        if resp.is_success() {
            Ok(())
        } else {
            Err(classify(PROVIDER, "response_url", &resp))
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::git_provider::FakeTransport;
    use crate::integrations::http::{RecordingSleeper, RetryPolicy};
    use crate::profile::MemorySecretStore;

    const POSTED: &str = r#"{"ok":true,"channel":"C123","ts":"1700000000.000100","message":{"text":"hi","type":"message"}}"#;
    const CHANNELS_P1: &str = r#"{"ok":true,"channels":[
      {"id":"C1","name":"general","is_private":false,"is_archived":false,"is_member":true,"num_members":12,"topic":{"value":""}},
      {"id":"G2","name":"secret","is_private":true,"is_member":false}],
      "response_metadata":{"next_cursor":"dGVhbTpD"}}"#;
    const CHANNELS_P2: &str = r#"{"ok":true,"channels":[{"id":"C3","name":"random"}],"response_metadata":{"next_cursor":""}}"#;

    fn client(t: &Arc<FakeTransport>) -> SlackClient {
        SlackClient::new(
            Http::new(t.clone())
                .with_sleeper(Arc::new(RecordingSleeper::new()))
                .with_policy(RetryPolicy::none()),
            SecretString::from("xoxb-secret".to_owned()),
        )
    }
    fn body(r: &HttpRequest) -> Value {
        serde_json::from_str(&r.body_text().unwrap()).unwrap()
    }

    #[test]
    fn post_message_request_shape() {
        let r = post_message_request(
            "xoxb-1",
            &PostMessage {
                channel: "C1".into(),
                text: "fallback".into(),
                blocks: vec![crate::integrations::slack::blocks::divider()],
                thread_ts: Some("1.2".into()),
            },
        )
        .unwrap();
        assert_eq!(r.url, "https://slack.com/api/chat.postMessage");
        assert_eq!(r.headers.get("authorization"), Some("Bearer xoxb-1"));
        let b = body(&r);
        assert_eq!(b["channel"], "C1");
        assert_eq!(b["blocks"][0]["type"], "divider");
        assert_eq!(b["thread_ts"], "1.2");
        assert!(!format!("{r:?}").contains("xoxb-1"));
    }

    #[test]
    fn post_message_validation() {
        let ok = PostMessage {
            channel: "C1".into(),
            text: "x".into(),
            ..PostMessage::default()
        };
        assert!(post_message_request("t", &ok).is_ok());
        assert!(post_message_request(
            "t",
            &PostMessage {
                channel: " ".into(),
                ..ok.clone()
            }
        )
        .is_err());
        assert!(post_message_request(
            "t",
            &PostMessage {
                text: String::new(),
                ..ok.clone()
            }
        )
        .is_err());
        assert!(post_message_request(
            "t",
            &PostMessage {
                text: "x".repeat(40_001),
                ..ok.clone()
            }
        )
        .is_err());
        assert!(post_message_request(
            "t",
            &PostMessage {
                blocks: vec![json!({}); 51],
                ..ok
            }
        )
        .is_err());
        // Blocks alone are fine.
        assert!(post_message_request(
            "t",
            &PostMessage {
                channel: "C".into(),
                blocks: vec![json!({})],
                ..PostMessage::default()
            }
        )
        .is_ok());
    }

    #[test]
    fn envelope_error_mapping() {
        let r = |s, b: &str| HttpResponse::new(s, Default::default(), b);
        assert!(matches!(
            parse_post_message(&r(200, r#"{"ok":false,"error":"channel_not_found"}"#)),
            Err(IntegrationError::SlackApi { code, method: "chat.postMessage" }) if code == "channel_not_found"
        ));
        assert!(matches!(
            parse_post_message(&r(200, r#"{"ok":false,"error":"invalid_auth"}"#)),
            Err(IntegrationError::Unauthorized("Slack"))
        ));
        assert!(matches!(
            parse_post_message(&r(200, r#"{"ok":false,"error":"ratelimited"}"#)),
            Err(IntegrationError::RateLimited { .. })
        ));
        assert!(matches!(
            parse_post_message(&r(500, "oops")),
            Err(IntegrationError::Api { status: 500, .. })
        ));
        assert!(matches!(
            parse_post_message(&r(200, "<html>")),
            Err(IntegrationError::Parse(_))
        ));
        assert!(matches!(
            parse_post_message(&r(200, r#"{"ok":true}"#)),
            Err(IntegrationError::Parse(_))
        ));
        let e: crate::Error = IntegrationError::SlackApi {
            method: "m",
            code: "x".into(),
        }
        .into();
        assert!(e.to_string().contains("slack m failed: x"));
    }

    #[test]
    fn parses_fixtures() {
        let ok = |s: &str| HttpResponse::new(200, Default::default(), s);
        let p = parse_post_message(&ok(POSTED)).unwrap();
        assert_eq!(
            (p.channel.as_str(), p.ts.as_str()),
            ("C123", "1700000000.000100")
        );
        let c = parse_channels(&ok(CHANNELS_P1)).unwrap();
        assert_eq!(c.channels.len(), 2);
        assert!(c.channels[1].is_private);
        assert_eq!(c.channels[0].num_members, Some(12));
        assert_eq!(c.next_cursor.as_deref(), Some("dGVhbTpD"));
        assert_eq!(parse_channels(&ok(CHANNELS_P2)).unwrap().next_cursor, None);
        let a = parse_auth_test(&ok(
            r#"{"ok":true,"url":"https://acme.slack.com/","team":"Acme","user":"nyx","team_id":"T1","user_id":"U1","bot_id":"B1"}"#,
        ))
        .unwrap();
        assert_eq!(a.team_id, "T1");
        assert_eq!(a.bot_id.as_deref(), Some("B1"));
    }

    #[test]
    fn client_posts_and_lists_with_cursor() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], POSTED);
        t.push_json(200, &[], CHANNELS_P1);
        t.push_json(200, &[], CHANNELS_P2);
        let c = client(&t);
        assert_eq!(
            c.send_text("C123", "hello").unwrap().ts,
            "1700000000.000100"
        );
        let chans = c.list_channels("public_channel,private_channel").unwrap();
        assert_eq!(chans.len(), 3);
        let reqs = t.requests();
        assert!(reqs[1]
            .url
            .contains("types=public_channel%2Cprivate_channel"));
        assert!(reqs[1].url.contains("exclude_archived=true"));
        assert!(reqs[2].url.contains("cursor=dGVhbTpD"));
    }

    #[test]
    fn rate_limit_with_retry_after_is_retried() {
        let t = Arc::new(FakeTransport::new());
        t.push_json(
            429,
            &[("Retry-After", "5")],
            r#"{"ok":false,"error":"ratelimited"}"#,
        );
        t.push_json(200, &[], POSTED);
        let sleeper = Arc::new(RecordingSleeper::new());
        let c = SlackClient::new(
            Http::new(t.clone()).with_sleeper(sleeper.clone()),
            SecretString::from("t".to_owned()),
        );
        c.send_text("C1", "x").unwrap();
        assert_eq!(sleeper.waits(), vec![5]);
    }

    #[test]
    fn response_url_must_be_slack_https() {
        let msg = json!({"text": "hi"});
        assert!(response_url_request("https://hooks.slack.com/commands/T1/2/abc", &msg).is_ok());
        for bad in [
            "http://hooks.slack.com/x",
            "https://evil.example/x",
            "https://hooks.slack.com.evil.example/x",
            "https://hooks.slack.com:8443/x",
            "https://127.0.0.1/x",
            "not a url",
        ] {
            assert!(response_url_request(bad, &msg).is_err(), "{bad}");
        }
        let t = Arc::new(FakeTransport::new());
        t.push_json(200, &[], "ok");
        client(&t)
            .respond("https://hooks.slack.com/commands/T1/2/abc", &msg)
            .unwrap();
        assert!(client(&t).respond("https://evil.example/", &msg).is_err());
        assert_eq!(t.requests().len(), 1);
    }

    #[test]
    fn from_secrets() {
        let t = Arc::new(FakeTransport::new());
        let http = || Http::new(t.clone());
        let secrets = MemorySecretStore::new();
        assert!(matches!(
            SlackClient::from_secrets(http(), &secrets),
            Err(IntegrationError::MissingCredential("Slack"))
        ));
        secrets
            .set(&bot_token_key(), SecretString::from("xoxb-1".to_owned()))
            .unwrap();
        t.push_json(
            200,
            &[],
            r#"{"ok":true,"team_id":"T1","team":"A","user_id":"U"}"#,
        );
        let c = SlackClient::from_secrets(http(), &secrets).unwrap();
        assert_eq!(c.auth_test().unwrap().team_id, "T1");
        assert_eq!(
            t.requests()[0].headers.get("authorization"),
            Some("Bearer xoxb-1")
        );
    }
}
