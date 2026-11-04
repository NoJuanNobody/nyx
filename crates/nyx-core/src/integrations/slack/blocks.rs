//! Minimal Block Kit builders. Each function returns a `serde_json::Value` block; text is
//! truncated to Slack's limits so a long Nyx summary can never make `chat.postMessage` fail with
//! `invalid_blocks`.

use serde_json::{json, Value};

/// Max blocks per message.
pub const MAX_BLOCKS: usize = 50;
/// Max characters of a `section` text.
pub const MAX_SECTION_CHARS: usize = 3000;
/// Max characters of a `header` text.
pub const MAX_HEADER_CHARS: usize = 150;

fn cut(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_owned()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('\u{2026}');
        t
    }
}

/// Escape the three characters Slack treats specially in `mrkdwn` (`&`, `<`, `>`), so user text
/// cannot inject links or mentions.
#[must_use]
pub fn escape_mrkdwn(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// `header` block (plain text).
#[must_use]
pub fn header(text: &str) -> Value {
    json!({"type": "header", "text": {"type": "plain_text", "text": cut(text, MAX_HEADER_CHARS), "emoji": true}})
}

/// `section` block with `mrkdwn` text. The text is used as given: escape untrusted input first.
#[must_use]
pub fn section(mrkdwn: &str) -> Value {
    json!({"type": "section", "text": {"type": "mrkdwn", "text": cut(mrkdwn, MAX_SECTION_CHARS)}})
}

/// `divider` block.
#[must_use]
pub fn divider() -> Value {
    json!({"type": "divider"})
}

/// `context` block of small `mrkdwn` snippets (max 10 elements).
#[must_use]
pub fn context(snippets: &[&str]) -> Value {
    let els: Vec<Value> = snippets
        .iter()
        .take(10)
        .map(|s| json!({"type": "mrkdwn", "text": cut(s, MAX_SECTION_CHARS)}))
        .collect();
    json!({"type": "context", "elements": els})
}

/// `actions` block with one link button per `(label, url)` (max 5).
#[must_use]
pub fn link_buttons(buttons: &[(&str, &str)]) -> Value {
    let els: Vec<Value> = buttons
        .iter()
        .take(5)
        .enumerate()
        .map(|(i, (label, url))| {
            json!({
                "type": "button",
                "text": {"type": "plain_text", "text": cut(label, 75)},
                "url": url,
                "action_id": format!("nyx_link_{i}"),
            })
        })
        .collect();
    json!({"type": "actions", "elements": els})
}

/// Standard Nyx notification layout: header, body, optional "Open in Nyx" link.
#[must_use]
pub fn notification(title: &str, body_mrkdwn: &str, link: Option<&str>) -> Vec<Value> {
    let mut b = vec![header(title), section(body_mrkdwn)];
    if let Some(url) = link {
        b.push(link_buttons(&[("Open in Nyx", url)]));
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_slack_specials() {
        assert_eq!(escape_mrkdwn("<!channel> a&b"), "&lt;!channel&gt; a&amp;b");
    }

    #[test]
    fn truncates_with_ellipsis_on_char_boundary() {
        let b = section(&"é".repeat(4000));
        let t = b["text"]["text"].as_str().unwrap();
        assert_eq!(t.chars().count(), MAX_SECTION_CHARS);
        assert!(t.ends_with('\u{2026}'));
        assert_eq!(
            header(&"x".repeat(500))["text"]["text"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            150
        );
    }

    #[test]
    fn notification_layout() {
        let b = notification("Spec ready", "*Done*", Some("https://nyx.io/s/1"));
        let types: Vec<_> = b.iter().map(|x| x["type"].as_str().unwrap()).collect();
        assert_eq!(types, ["header", "section", "actions"]);
        assert_eq!(b[2]["elements"][0]["url"], "https://nyx.io/s/1");
        assert_eq!(notification("t", "b", None).len(), 2);
        assert_eq!(divider()["type"], "divider");
        assert_eq!(
            context(&["a", "b"])["elements"].as_array().unwrap().len(),
            2
        );
    }
}
