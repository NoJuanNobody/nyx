//! Incoming Slack traffic: request signature verification, Events API and slash command parsing,
//! and the routing rules from `routes/slack.ts`.
//!
//! Always verify the signature over the RAW body before parsing it (the TS route re-serialised the
//! parsed JSON for the events endpoint, which can break verification when key order or spacing
//! differs; this port takes the original bytes).
//!
//! The TS `processSlackMessage` only builds a summary string (full intake through the AI was a
//! "future enhancement"); [`process_slack_message`] does the same, and [`intake_for_event`] decides
//! which events feed it.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::git_provider::util::{ct_eq, hmac_sha256};
use crate::git_provider::Headers;
use crate::integrations::{IntegrationError, Result};

/// Requests older (or newer) than this many seconds are rejected as replays.
pub const MAX_SKEW_SECS: i64 = 300;

/// Verify `X-Slack-Signature` for `body` (port of `verifySlackSignature`).
///
/// `now_secs` is the current unix time. Returns `false` for an empty secret, an unparsable
/// timestamp (TS let `NaN` slip past the replay check), a stale timestamp, or a wrong signature.
#[must_use]
pub fn verify_signature(
    signing_secret: &str,
    timestamp: &str,
    body: &[u8],
    signature: &str,
    now_secs: i64,
) -> bool {
    if signing_secret.is_empty() {
        return false;
    }
    let Ok(ts) = timestamp.trim().parse::<i64>() else {
        return false;
    };
    if (now_secs - ts).abs() > MAX_SKEW_SECS {
        return false;
    }
    let mut base = format!("v0:{}:", timestamp.trim()).into_bytes();
    base.extend_from_slice(body);
    let expected = format!(
        "v0={}",
        hex::encode(hmac_sha256(signing_secret.as_bytes(), &base))
    );
    ct_eq(
        signature.trim().to_ascii_lowercase().as_bytes(),
        expected.as_bytes(),
    )
}

/// Header-based wrapper: reads `X-Slack-Signature` and `X-Slack-Request-Timestamp`.
///
/// # Errors
/// [`IntegrationError::Webhook`] with `Missing Slack signature headers` or `Invalid Slack
/// signature` (the TS 401 messages).
pub fn verify_request(
    signing_secret: &str,
    headers: &Headers,
    body: &[u8],
    now_secs: i64,
) -> Result<()> {
    let (Some(sig), Some(ts)) = (
        headers.get("x-slack-signature"),
        headers.get("x-slack-request-timestamp"),
    ) else {
        return Err(IntegrationError::Webhook(
            "Missing Slack signature headers".into(),
        ));
    };
    if verify_signature(signing_secret, ts, body, sig, now_secs) {
        Ok(())
    } else {
        Err(IntegrationError::Webhook("Invalid Slack signature".into()))
    }
}

// ── Events API ──────────────────────────────────────

/// An Events API event we understand.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SlackEvent {
    /// `reaction_added`.
    ReactionAdded {
        /// Emoji name without colons.
        reaction: String,
        /// Author of the reacted-to message.
        item_user: String,
        /// Channel of the reacted-to message.
        channel: String,
    },
    /// `message` (any channel the bot can see).
    Message {
        /// Channel id.
        channel: String,
        /// Sender user id (empty for some bot/system messages).
        user: String,
        /// Text.
        text: String,
        /// Set when a bot posted the message.
        bot_id: Option<String>,
        /// Message subtype (`message_changed`, `bot_message`, ...).
        subtype: Option<String>,
    },
    /// Any other event type.
    Other(String),
}

/// A parsed Events API delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InboundEvent {
    /// Endpoint verification: answer with `{"challenge": ...}`.
    UrlVerification {
        /// Value to echo back.
        challenge: String,
    },
    /// `event_callback`.
    Event {
        /// Slack workspace id (matches `slack_connections.slack_team_id`).
        team_id: String,
        /// The event.
        event: SlackEvent,
    },
    /// Other envelope types, or callbacks without an event: acknowledge with `{ok: true}`.
    Ignored,
}

#[derive(Deserialize)]
struct Envelope {
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(default)]
    challenge: Option<String>,
    #[serde(default)]
    team_id: Option<String>,
    #[serde(default)]
    event: Option<Value>,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_owned()
}

/// Parse an Events API request body (verify the signature first).
///
/// # Errors
/// [`IntegrationError::Webhook`] if the body is not a JSON object.
pub fn parse_events_body(body: &[u8]) -> Result<InboundEvent> {
    let env: Envelope = serde_json::from_slice(body)
        .map_err(|e| IntegrationError::Webhook(format!("invalid Slack event body: {e}")))?;
    if env.kind == "url_verification" {
        return Ok(InboundEvent::UrlVerification {
            challenge: env.challenge.unwrap_or_default(),
        });
    }
    if env.kind != "event_callback" {
        return Ok(InboundEvent::Ignored);
    }
    let Some(ev) = env.event else {
        return Ok(InboundEvent::Ignored);
    };
    let event = match s(&ev, "type").as_str() {
        "reaction_added" => SlackEvent::ReactionAdded {
            reaction: s(&ev, "reaction"),
            item_user: s(&ev, "item_user"),
            channel: ev
                .pointer("/item/channel")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        },
        "message" => SlackEvent::Message {
            channel: s(&ev, "channel"),
            user: s(&ev, "user"),
            text: s(&ev, "text"),
            bot_id: ev.get("bot_id").and_then(Value::as_str).map(str::to_owned),
            subtype: ev.get("subtype").and_then(Value::as_str).map(str::to_owned),
        },
        other => SlackEvent::Other(other.to_owned()),
    };
    Ok(InboundEvent::Event {
        team_id: env.team_id.unwrap_or_default(),
        event,
    })
}

/// Per-workspace routing settings (from `slack_connections`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutingRules {
    /// Reaction that triggers intake (no colons). TS default: `nyx`.
    pub trigger_emoji: String,
    /// Channel ids whose messages are ingested.
    pub monitored_channels: Vec<String>,
}

/// A message routed into Nyx intake.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntakeMessage {
    /// Text to process.
    pub text: String,
    /// Slack user id.
    pub user_id: String,
    /// Slack channel id.
    pub channel_id: String,
}

/// Decide whether an event should be ingested (port of the `/events` handler):
/// - `reaction_added` with the trigger emoji becomes `[Reaction trigger: :emoji:]`;
/// - `message` from a monitored channel, not from a bot, becomes its text.
///
/// Beyond the TS: edit/delete/bot subtypes are skipped (they carry no usable top-level text).
#[must_use]
pub fn intake_for_event(rules: &RoutingRules, event: &SlackEvent) -> Option<IntakeMessage> {
    match event {
        SlackEvent::ReactionAdded {
            reaction,
            item_user,
            channel,
        } if *reaction == rules.trigger_emoji => Some(IntakeMessage {
            text: format!("[Reaction trigger: :{reaction}:]"),
            user_id: item_user.clone(),
            channel_id: channel.clone(),
        }),
        SlackEvent::Message {
            channel,
            user,
            text,
            bot_id: None,
            subtype,
        } if rules.monitored_channels.contains(channel)
            && !matches!(
                subtype.as_deref(),
                Some("message_changed" | "message_deleted" | "bot_message")
            ) =>
        {
            Some(IntakeMessage {
                text: text.clone(),
                user_id: user.clone(),
                channel_id: channel.clone(),
            })
        }
        _ => None,
    }
}

// ── Slash commands ──────────────────────────────────

/// A parsed `application/x-www-form-urlencoded` slash command.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SlashCommand {
    /// For example `/nyx`.
    pub command: String,
    /// Text after the command.
    pub text: String,
    /// Slack workspace id.
    pub team_id: String,
    /// Invoking user id.
    pub user_id: String,
    /// Channel id.
    pub channel_id: String,
    /// URL for delayed replies (validated again by [`super::api::response_url_request`]).
    pub response_url: String,
}

/// Parse a slash command body.
pub fn parse_slash_command(body: &str) -> SlashCommand {
    let mut c = SlashCommand::default();
    for (k, v) in url::form_urlencoded::parse(body.as_bytes()) {
        let v = v.into_owned();
        match k.as_ref() {
            "command" => c.command = v,
            "text" => c.text = v,
            "team_id" => c.team_id = v,
            "user_id" => c.user_id = v,
            "channel_id" => c.channel_id = v,
            "response_url" => c.response_url = v,
            _ => {}
        }
    }
    c
}

/// Result of processing an inbound message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessedMessage {
    /// Human-readable summary.
    pub summary: String,
    /// Always `slack`.
    pub source: &'static str,
}

/// Port of `processSlackMessage`: build the summary for a message (first 120 characters).
#[must_use]
pub fn process_slack_message(text: &str, user_id: &str, channel_id: &str) -> ProcessedMessage {
    let t = text.trim();
    if t.is_empty() {
        return ProcessedMessage {
            summary: "Empty message \u{2014} nothing to process.".into(),
            source: "slack",
        };
    }
    let preview: String = t.chars().take(120).collect();
    ProcessedMessage {
        summary: format!(
            "Slack message from user {user_id} in channel {channel_id}: \"{preview}\""
        ),
        source: "slack",
    }
}

/// Immediate (ephemeral) reply to a slash command.
#[must_use]
pub fn ack_response(text: &str) -> Value {
    json!({"response_type": "ephemeral", "text": format!("Processing your input: \"{text}\"")})
}

/// Reply when the workspace is not linked to a Nyx team.
#[must_use]
pub fn not_connected_response() -> Value {
    json!({
        "response_type": "ephemeral",
        "text": "This Slack workspace is not connected to a Nyx team. Visit Nyx Settings to connect.",
    })
}

/// Delayed in-channel reply carrying the processing summary.
#[must_use]
pub fn result_message(summary: &str) -> Value {
    json!({"response_type": "in_channel", "text": format!("Nyx processed your input:\n> {summary}")})
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "8f742231b10e8888abcd99yyyzzz85a5";

    fn sign(secret: &str, ts: &str, body: &str) -> String {
        format!(
            "v0={}",
            hex::encode(hmac_sha256(
                secret.as_bytes(),
                format!("v0:{ts}:{body}").as_bytes()
            ))
        )
    }

    #[test]
    fn signature_roundtrip_and_failures() {
        let body = "token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1&command=%2Fnyx&text=hello";
        let ts = "1531420618";
        let sig = sign(SECRET, ts, body);
        let now = 1_531_420_618 + 10;
        assert!(verify_signature(SECRET, ts, body.as_bytes(), &sig, now));
        assert!(!verify_signature(SECRET, ts, b"tampered", &sig, now));
        assert!(!verify_signature("other", ts, body.as_bytes(), &sig, now));
        assert!(!verify_signature("", ts, body.as_bytes(), &sig, now));
        assert!(!verify_signature(SECRET, ts, body.as_bytes(), "v0=00", now));
        assert!(!verify_signature(SECRET, ts, body.as_bytes(), "", now));
    }

    #[test]
    fn replay_window_and_bad_timestamp() {
        let (ts, body) = ("1000", "b");
        let sig = sign(SECRET, ts, body);
        assert!(verify_signature(
            SECRET,
            ts,
            body.as_bytes(),
            &sig,
            1000 + 300
        ));
        assert!(!verify_signature(
            SECRET,
            ts,
            body.as_bytes(),
            &sig,
            1000 + 301
        ));
        assert!(!verify_signature(
            SECRET,
            ts,
            body.as_bytes(),
            &sig,
            1000 - 301
        ));
        let sig = sign(SECRET, "abc", body);
        assert!(!verify_signature(
            SECRET,
            "abc",
            body.as_bytes(),
            &sig,
            1000
        ));
    }

    #[test]
    fn header_wrapper_messages() {
        let body = b"{}";
        let sig = sign(SECRET, "1000", "{}");
        let ok = Headers::from_pairs([
            ("X-Slack-Signature", sig.as_str()),
            ("X-Slack-Request-Timestamp", "1000"),
        ]);
        assert!(verify_request(SECRET, &ok, body, 1000).is_ok());
        let e = verify_request(SECRET, &Headers::new(), body, 1000).unwrap_err();
        assert!(e.to_string().contains("Missing Slack signature headers"));
        let bad = Headers::from_pairs([
            ("x-slack-signature", "v0=bad"),
            ("x-slack-request-timestamp", "1000"),
        ]);
        let e = verify_request(SECRET, &bad, body, 1000).unwrap_err();
        assert!(e.to_string().contains("Invalid Slack signature"));
    }

    #[test]
    fn parses_url_verification_and_ignored() {
        let v =
            parse_events_body(br#"{"type":"url_verification","challenge":"3eZbrw1a","token":"x"}"#)
                .unwrap();
        assert_eq!(
            v,
            InboundEvent::UrlVerification {
                challenge: "3eZbrw1a".into()
            }
        );
        assert_eq!(
            parse_events_body(br#"{"type":"app_rate_limited"}"#).unwrap(),
            InboundEvent::Ignored
        );
        assert_eq!(
            parse_events_body(br#"{"type":"event_callback","team_id":"T1"}"#).unwrap(),
            InboundEvent::Ignored
        );
        assert!(parse_events_body(b"nope").is_err());
    }

    #[test]
    fn parses_reaction_and_message_events() {
        let r = br#"{"type":"event_callback","team_id":"T1","event":{"type":"reaction_added","user":"U9","reaction":"nyx","item_user":"U2","item":{"type":"message","channel":"C5","ts":"1.2"},"event_ts":"1.3"}}"#;
        assert_eq!(
            parse_events_body(r).unwrap(),
            InboundEvent::Event {
                team_id: "T1".into(),
                event: SlackEvent::ReactionAdded {
                    reaction: "nyx".into(),
                    item_user: "U2".into(),
                    channel: "C5".into()
                }
            }
        );
        let m = br#"{"type":"event_callback","team_id":"T1","event":{"type":"message","channel":"C5","user":"U1","text":"hello","ts":"1.1"}}"#;
        assert!(matches!(
            parse_events_body(m).unwrap(),
            InboundEvent::Event {
                event: SlackEvent::Message { bot_id: None, .. },
                ..
            }
        ));
        let o = br#"{"type":"event_callback","team_id":"T1","event":{"type":"channel_created"}}"#;
        assert!(matches!(
            parse_events_body(o).unwrap(),
            InboundEvent::Event { event: SlackEvent::Other(t), .. } if t == "channel_created"
        ));
    }

    fn rules() -> RoutingRules {
        RoutingRules {
            trigger_emoji: "nyx".into(),
            monitored_channels: vec!["C5".into()],
        }
    }
    fn msg(channel: &str, bot: Option<&str>, subtype: Option<&str>) -> SlackEvent {
        SlackEvent::Message {
            channel: channel.into(),
            user: "U1".into(),
            text: "hello".into(),
            bot_id: bot.map(str::to_owned),
            subtype: subtype.map(str::to_owned),
        }
    }

    #[test]
    fn routing_rules() {
        let hit = intake_for_event(
            &rules(),
            &SlackEvent::ReactionAdded {
                reaction: "nyx".into(),
                item_user: "U2".into(),
                channel: "C5".into(),
            },
        )
        .unwrap();
        assert_eq!(hit.text, "[Reaction trigger: :nyx:]");
        assert_eq!(
            (hit.user_id.as_str(), hit.channel_id.as_str()),
            ("U2", "C5")
        );
        assert!(intake_for_event(
            &rules(),
            &SlackEvent::ReactionAdded {
                reaction: "thumbsup".into(),
                item_user: "U".into(),
                channel: "C5".into()
            }
        )
        .is_none());
        assert_eq!(
            intake_for_event(&rules(), &msg("C5", None, None))
                .unwrap()
                .text,
            "hello"
        );
        assert!(
            intake_for_event(&rules(), &msg("C9", None, None)).is_none(),
            "unmonitored channel"
        );
        assert!(
            intake_for_event(&rules(), &msg("C5", Some("B1"), None)).is_none(),
            "bot message"
        );
        assert!(intake_for_event(&rules(), &msg("C5", None, Some("message_changed"))).is_none());
        assert!(intake_for_event(&rules(), &msg("C5", None, Some("thread_broadcast"))).is_some());
        assert!(intake_for_event(&rules(), &SlackEvent::Other("x".into())).is_none());
    }

    #[test]
    fn slash_command_form_decoding() {
        let c = parse_slash_command(
            "token=abc&team_id=T1&user_id=U1&channel_id=C1&command=%2Fnyx&text=build+a+%22spec%22%20now&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1%2F2%2Fx&trigger_id=1.2",
        );
        assert_eq!(c.command, "/nyx");
        assert_eq!(c.text, "build a \"spec\" now");
        assert_eq!(c.team_id, "T1");
        assert_eq!(c.response_url, "https://hooks.slack.com/commands/T1/2/x");
        assert_eq!(parse_slash_command("").text, "");
    }

    #[test]
    fn process_message_summary() {
        let p = process_slack_message("  hi there ", "U1", "C1");
        assert_eq!(
            p.summary,
            "Slack message from user U1 in channel C1: \"hi there\""
        );
        assert_eq!(p.source, "slack");
        assert!(process_slack_message("   ", "U", "C")
            .summary
            .starts_with("Empty message"));
        let long = process_slack_message(&"é".repeat(500), "U", "C").summary;
        assert_eq!(long.matches('é').count(), 120);
    }

    #[test]
    fn canned_responses() {
        assert_eq!(ack_response("x")["response_type"], "ephemeral");
        assert_eq!(ack_response("x")["text"], "Processing your input: \"x\"");
        assert!(not_connected_response()["text"]
            .as_str()
            .unwrap()
            .contains("not connected"));
        assert_eq!(
            result_message("s")["text"],
            "Nyx processed your input:\n> s"
        );
    }
}
