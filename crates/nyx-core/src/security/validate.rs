//! Input validation and sanitisation primitives.

use crate::{Error, Result};

/// Reject control characters (except `\n`, `\t` when `allow_whitespace_controls`), NUL and over-long text.
pub fn check_text(
    label: &str,
    s: &str,
    max_bytes: usize,
    allow_whitespace_controls: bool,
) -> Result<()> {
    if s.len() > max_bytes {
        return Err(Error::Invalid(format!("{label} exceeds {max_bytes} bytes")));
    }
    let bad = s.chars().any(|c| {
        c == '\0'
            || (c.is_control() && !(allow_whitespace_controls && matches!(c, '\n' | '\t' | '\r')))
    });
    if bad {
        return Err(Error::Invalid(format!(
            "{label} contains control characters"
        )));
    }
    Ok(())
}

/// A non-empty, trimmed, single-line display name (1..=`max_chars` chars).
pub fn check_name(label: &str, s: &str, max_chars: usize) -> Result<String> {
    let t = s.trim();
    if t.is_empty() {
        return Err(Error::Invalid(format!("{label} must not be empty")));
    }
    if t.chars().count() > max_chars {
        return Err(Error::Invalid(format!(
            "{label} exceeds {max_chars} characters"
        )));
    }
    check_text(label, t, max_chars * 4, false)?;
    // Bidi override characters enable spoofing (e.g. `invoice\u{202E}fdp.exe`).
    if t.chars().any(is_bidi_control) {
        return Err(Error::Invalid(format!(
            "{label} contains bidirectional control characters"
        )));
    }
    Ok(t.to_string())
}

fn is_bidi_control(c: char) -> bool {
    matches!(c, '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}')
}

/// Identifier: `[A-Za-z0-9_-]`, 1..=128 chars (covers uuid, slugs, ledger ids).
pub fn check_id(label: &str, s: &str) -> Result<()> {
    let ok = !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(())
    } else {
        Err(Error::Invalid(format!(
            "{label} must be 1-128 chars of [A-Za-z0-9_-]"
        )))
    }
}

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Turn arbitrary text (a document title) into a safe single path component.
///
/// Port of the CLI `sanitizeFilename()` (non-alphanumerics stripped) hardened
/// for Windows: reserved device names, trailing dots/spaces, and length are
/// handled, and the result is never empty, `.` or `..`.
#[must_use]
pub fn sanitize_filename(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut last_dash = true;
    for c in input.chars() {
        if c.is_alphanumeric() || c == '.' || c == '_' {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let mut out = out
        .trim_matches(|c| c == '-' || c == '.' || c == '_')
        .to_string();
    if out.chars().count() > 100 {
        out = out.chars().take(100).collect();
    }
    let stem = out.split('.').next().unwrap_or("").to_ascii_uppercase();
    if out.is_empty() {
        return "untitled".into();
    }
    if RESERVED.contains(&stem.as_str()) {
        out.insert(0, '_');
    }
    out
}

/// User-safe error text: first line only, secrets redacted, capped. Port of the
/// web client's "show `error`, log the rest" rule (#263).
#[must_use]
pub fn public_error_message(raw: &str) -> String {
    let line = raw.lines().next().unwrap_or("").trim();
    let red = super::redact::redact_text(line);
    let mut s: String = red.chars().take(200).collect();
    if s.is_empty() {
        s = "Internal error".into();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_rejects_nul_and_controls() {
        assert!(check_text("t", "ok\nline", 100, true).is_ok());
        assert!(check_text("t", "ok\nline", 100, false).is_err());
        assert!(check_text("t", "a\0b", 100, true).is_err());
        assert!(check_text("t", "\u{1b}[31m", 100, true).is_err());
        assert!(check_text("t", "toolong", 3, true).is_err());
    }

    #[test]
    fn names() {
        assert_eq!(check_name("n", "  Doc  ", 10).unwrap(), "Doc");
        assert!(check_name("n", "   ", 10).is_err());
        assert!(check_name("n", "a\u{202E}b", 10).is_err());
        assert!(check_name("n", "elevenchars", 10).is_err());
    }

    #[test]
    fn ids() {
        assert!(check_id("i", "9f1c-AB_2").is_ok());
        for bad in ["", "a b", "../x", "a/b", "x\0", &"a".repeat(129)] {
            assert!(check_id("i", bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn filenames() {
        assert_eq!(sanitize_filename("My Doc: v2/final"), "My-Doc-v2-final");
        assert_eq!(sanitize_filename("../../etc/passwd"), "etc-passwd");
        assert_eq!(sanitize_filename(".."), "untitled");
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(sanitize_filename("CON"), "_CON");
        assert_eq!(sanitize_filename("nul.txt"), "_nul.txt");
        assert_eq!(sanitize_filename("a\\b"), "a-b");
        assert!(sanitize_filename(&"x".repeat(500)).chars().count() <= 100);
        assert!(!sanitize_filename("name. ").ends_with('.'));
    }

    #[test]
    fn public_errors_hide_details() {
        let m =
            public_error_message("boom sk-ant-api03-abcdefghijklmnopqrstuvwx\n  at stack frame");
        assert!(!m.contains("sk-ant"));
        assert!(!m.contains("stack"));
        assert_eq!(public_error_message(""), "Internal error");
    }
}
