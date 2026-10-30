//! Secret redaction for logs, error messages and diagnostics.
//!
//! Patterns come from the AI-50 repo audit (`docs/oss/repo-audit.md`: `sk-ant-`, `sk-or-v1-`,
//! Stripe-style `sk_live_`, `whsec_`, GitHub `ghp_`/`github_pat_`, Slack `xox*`, `AKIA`, `AIza`,
//! `tvly-`, JWTs, PEM private keys, DB URLs with passwords) plus generic `key=value` and
//! `Authorization` handling. Redaction is best effort and regex based, not entropy based: keep
//! secrets out of log call sites in the first place and use [`Redacted`] for fields.

use std::borrow::Cow;
use std::fmt;
use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

/// Replacement marker.
pub const MASK: &str = "[REDACTED]";

#[allow(clippy::unwrap_used)] // patterns are compile-time constants covered by tests
fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

static PEM: LazyLock<Regex> = LazyLock::new(|| {
    re(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|\z)")
});
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    re(concat!(
        r"\b(?:sk-ant-[A-Za-z0-9_\-]{8,}",
        r"|sk-or-v1-[A-Za-z0-9]{8,}",
        r"|sk-[A-Za-z0-9]{20,}",
        r"|(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}",
        r"|whsec_[A-Za-z0-9]{8,}",
        r"|gh[pousr]_[A-Za-z0-9]{20,}",
        r"|github_pat_[A-Za-z0-9_]{20,}",
        r"|glpat-[A-Za-z0-9_\-]{16,}",
        r"|xox[abpr]-[A-Za-z0-9\-]{10,}",
        r"|AKIA[0-9A-Z]{16}",
        r"|AIza[0-9A-Za-z_\-]{30,}",
        r"|tvly-[A-Za-z0-9]{8,})"
    ))
});
static JWT: LazyLock<Regex> =
    LazyLock::new(|| re(r"\beyJ[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]{5,}\.[A-Za-z0-9_\-]*"));
static AUTH: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}"));
static URL_USERINFO: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b([a-z][a-z0-9+.\-]*://[^\s:/@]+):[^\s@/]+@"));
const SENSITIVE_NAME: &str = r"(?:secret|token|password|passwd|passphrase|api[_\-]?key|apikey|authorization|private[_\-]?key|credential|cookie)";
static KEY_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    re(&format!(
        r#"(?i)\b([A-Za-z0-9_.\-]*{SENSITIVE_NAME}[A-Za-z0-9_.\-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|(?:bearer|basic)\s+[^\s,;&"'}}\]]+|[^\s,;&"'}}\]]+)"#
    ))
});
static SENSITIVE_KEY: LazyLock<Regex> = LazyLock::new(|| re(&format!("(?i){SENSITIVE_NAME}")));

/// Redact secrets in free text. Returns the input unchanged (borrowed) if nothing matched.
#[must_use]
pub fn redact_text(input: &str) -> Cow<'_, str> {
    let mut cur: Cow<'_, str> = Cow::Borrowed(input);
    let steps: [(&Regex, &str); 6] = [
        (&PEM, MASK),
        (&TOKENS, MASK),
        (&JWT, MASK),
        (&URL_USERINFO, "$1:[REDACTED]@"),
        (&KEY_VALUE, "$1$2[REDACTED]"),
        (&AUTH, "$1 [REDACTED]"),
    ];
    for (re, rep) in steps {
        if re.is_match(&cur) {
            cur = Cow::Owned(re.replace_all(&cur, rep).into_owned());
        }
    }
    cur
}

/// Redact a JSON value: any object field whose NAME looks sensitive is masked wholesale; every
/// other string goes through [`redact_text`].
#[must_use]
pub fn redact_json(v: &Value) -> Value {
    match v {
        Value::String(s) => Value::String(redact_text(s).into_owned()),
        Value::Array(a) => Value::Array(a.iter().map(redact_json).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, val)| {
                    let masked = SENSITIVE_KEY.is_match(k) && !val.is_null();
                    (
                        k.clone(),
                        if masked {
                            Value::String(MASK.into())
                        } else {
                            redact_json(val)
                        },
                    )
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Wrapper whose `Debug`/`Display` never reveal the inner value. Use for secret-bearing fields in
/// structs that derive `Debug` or get logged.
#[derive(Clone, PartialEq, Eq)]
pub struct Redacted<T>(pub T);

impl<T> fmt::Debug for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(MASK)
    }
}
impl<T> fmt::Display for Redacted<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(MASK)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // All values below are synthetic.
    #[test]
    fn known_token_shapes() {
        for s in [
            "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
            "sk-or-v1-0123456789abcdef0123",
            "sk-0123456789abcdef0123456789",
            "sk_live_0123456789abcdef",
            "pk_test_0123456789abcdef",
            "whsec_0123456789abcdef",
            "ghp_0123456789abcdef0123456789abcdef0123",
            "github_pat_11AAAAAAA0_bbbbbbbbbbbbbbbbbbbbb",
            "glpat-0123456789abcdefghij",
            "xoxb-1234567890-abcdefghij",
            "AKIAABCDEFGHIJKLMNOP",
            "AIzaSyA-0123456789abcdefghijklmnopqrstu",
            "tvly-0123456789abcdef",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcDEF123_-",
        ] {
            let input = format!("calling with {s} now");
            let o = redact_text(&input);
            assert_eq!(o, format!("calling with {MASK} now"), "{s}");
        }
    }

    #[test]
    fn headers_urls_and_key_values() {
        assert_eq!(
            redact_text("Authorization: Bearer abcdefghijklmnop"),
            "Authorization: [REDACTED]"
        );
        assert_eq!(redact_text("bearer abcdefghijklmnop"), "bearer [REDACTED]");
        assert_eq!(
            redact_text("postgres://user:hunter2@localhost:5432/db"),
            "postgres://user:[REDACTED]@localhost:5432/db"
        );
        assert_eq!(
            redact_text("ENCRYPTION_SECRET=abc123 PORT=3001"),
            "ENCRYPTION_SECRET=[REDACTED] PORT=3001"
        );
        assert_eq!(
            redact_text(r#"{"api_key": "abc 123", "n": 1}"#),
            r#"{"api_key": [REDACTED], "n": 1}"#
        );
        assert_eq!(redact_text("password: 'p w'"), "password: [REDACTED]");
        assert_eq!(
            redact_text("db_password=x&b=1"),
            "db_password=[REDACTED]&b=1"
        );
    }

    #[test]
    fn pem_blocks_including_truncated() {
        let pem = "a\n-----BEGIN PRIVATE KEY-----\nMIIEvQ\nabc\n-----END PRIVATE KEY-----\nb";
        assert_eq!(redact_text(pem), format!("a\n{MASK}\nb"));
        assert_eq!(
            redact_text("x -----BEGIN RSA PRIVATE KEY-----\nMIIE"),
            format!("x {MASK}")
        );
    }

    #[test]
    fn clean_text_is_borrowed_and_unchanged() {
        let s = "document saved to /tmp/a.md in 12ms; tokens used: 5";
        // "tokens used" has no `=`/`:` directly after a sensitive name.
        assert!(matches!(redact_text(s), Cow::Borrowed(_)));
        assert!(matches!(redact_text("plain"), Cow::Borrowed(_)));
    }

    #[test]
    fn json_redaction() {
        let v = json!({
            "name": "doc",
            "apiKey": "abc",
            "nested": {"Authorization": "Bearer xyz", "note": "see sk_live_0123456789abcdef"},
            "list": ["ghp_0123456789abcdef0123456789abcdef0123", "ok"],
            "token": null,
            "n": 3
        });
        let r = redact_json(&v);
        assert_eq!(r["name"], "doc");
        assert_eq!(r["apiKey"], MASK);
        assert_eq!(r["nested"]["Authorization"], MASK);
        assert_eq!(r["nested"]["note"], format!("see {MASK}"));
        assert_eq!(r["list"][0], MASK);
        assert_eq!(r["list"][1], "ok");
        assert!(r["token"].is_null());
        assert_eq!(r["n"], 3);
    }

    #[test]
    fn redacted_wrapper() {
        let r = Redacted("hunter2".to_string());
        assert_eq!(format!("{r:?} {r}"), "[REDACTED] [REDACTED]");
    }
}
