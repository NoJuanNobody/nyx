//! Secret detection (`SECRET_PATTERNS` / `detectSecrets` in `governance.service.ts`).

use std::sync::OnceLock;

use regex::Regex;

/// Pattern sources, identical in meaning to the TS list. `(?i)` mirrors the JS `/i` flag.
const SOURCES: &[&str] = &[
    r#"(?i)(?:api[_-]?key|apikey)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]"#,
    r#"(?i)(?:secret|token|password|passwd|pwd)\s*[:=]\s*['"][^'"]{8,}['"]"#,
    r"(?:sk|pk)[-_](?:live|test)[-_][A-Za-z0-9]{20,}",
    r"ghp_[A-Za-z0-9]{36,}",
    r"xoxb-[A-Za-z0-9\-]+",
    r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}",
    r"AKIA[0-9A-Z]{16}",
    r"-----BEGIN (?:RSA |EC )?PRIVATE KEY-----",
];

fn patterns() -> &'static [(&'static str, Regex)] {
    static CELL: OnceLock<Vec<(&'static str, Regex)>> = OnceLock::new();
    CELL.get_or_init(|| {
        SOURCES
            .iter()
            // The sources are compile-time constants covered by tests; skip rather than panic.
            .filter_map(|s| Regex::new(s).ok().map(|r| (*s, r)))
            .collect()
    })
}

/// One violation message per matching secret pattern (never echoes the matched text).
#[must_use]
pub fn detect_secrets(content: &str) -> Vec<String> {
    patterns()
        .iter()
        .filter(|(_, re)| re.is_match(content))
        .map(|(src, _)| format!("Content matches secret pattern: {src}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert_eq!(patterns().len(), SOURCES.len());
    }

    #[test]
    fn detects_the_ts_cases() {
        assert_eq!(
            detect_secrets(r#"api_key = "abcdefghijklmnop1234""#).len(),
            1
        );
        assert_eq!(detect_secrets("key AKIAIOSFODNN7EXAMPLE").len(), 1);
        assert_eq!(detect_secrets(&format!("ghp_{}", "a".repeat(36))).len(), 1);
        assert_eq!(detect_secrets("xoxb-123-456-abc").len(), 1);
        assert_eq!(detect_secrets("-----BEGIN RSA PRIVATE KEY-----").len(), 1);
        let jwt = format!(
            "eyJ{}.{}.{}",
            "a".repeat(25),
            "b".repeat(25),
            "c".repeat(25)
        );
        assert_eq!(detect_secrets(&jwt).len(), 1);
        assert_eq!(
            detect_secrets("just a normal sentence about tokens").len(),
            0
        );
    }
}
