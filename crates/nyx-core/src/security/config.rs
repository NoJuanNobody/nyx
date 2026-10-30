//! Runtime hardening checks, ported from the `superRefine` block in `lib/config.ts` and the
//! `DEV_AUTH_BYPASS` production guard in `middleware/auth.ts`.
//!
//! The desktop app has no hosted auth, so the Clerk-specific checks are dropped. What survives:
//! a development bypass flag must never be honoured in a release build, secrets must not be
//! placeholders or trivially short, and wildcard CORS is refused. Call [`validate_environment`]
//! once at start-up (desktop, CLI and MCP) and abort on `Err`.

use crate::{Error, Result};

/// Env vars that disable a security control. Fatal in release builds.
pub const DANGEROUS_FLAGS: [&str; 3] = [
    "DEV_AUTH_BYPASS",
    "NYX_DEV_AUTH_BYPASS",
    "NYX_INSECURE_ALLOW_ANY_PATH",
];

/// Env vars holding encryption secrets (checked only when set).
pub const SECRET_VARS: [&str; 2] = ["ENCRYPTION_SECRET", "BYOK_ENCRYPTION_SECRET"];

/// Minimum length for a secret supplied through the environment.
pub const MIN_SECRET_LEN: usize = 16;

/// True for obvious placeholders (`sk_test_*` style keys, `changeme`, `REPLACE_WITH_*`, `xxx`).
/// Port of the "reject test-mode keys in production" guard.
#[must_use]
pub fn is_placeholder_secret(v: &str) -> bool {
    let l = v.trim().to_ascii_lowercase();
    l.is_empty()
        || l.starts_with("sk_test_")
        || l.starts_with("replace_with")
        || l.starts_with("your_")
        || l.contains("changeme")
        || l.contains("placeholder")
        || l.contains("example")
        || l.chars().all(|c| c == 'x' || c == '*' || c == '0')
}

fn truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

/// Validate the process environment through `get`. All problems are reported in one error.
/// `release` is `!cfg!(debug_assertions)` in production callers.
pub fn validate_environment(release: bool, get: impl Fn(&str) -> Option<String>) -> Result<()> {
    let mut problems: Vec<String> = Vec::new();
    if release {
        for f in DANGEROUS_FLAGS {
            if get(f).as_deref().is_some_and(truthy) {
                problems.push(format!("{f} must not be set in a release build"));
            }
        }
    }
    for v in SECRET_VARS {
        if let Some(val) = get(v) {
            if val.len() < MIN_SECRET_LEN {
                problems.push(format!("{v} must be at least {MIN_SECRET_LEN} characters"));
            } else if release && is_placeholder_secret(&val) {
                problems.push(format!("{v} looks like a placeholder"));
            }
        }
    }
    if let Some(origins) = get("CORS_ORIGINS") {
        if origins.split(',').any(|o| o.trim() == "*") {
            problems.push("CORS_ORIGINS must not contain `*`".into());
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(Error::Invalid(format!(
            "insecure configuration: {}",
            problems.join("; ")
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn bypass_flags_fatal_only_in_release() {
        let e = env(&[("DEV_AUTH_BYPASS", "true")]);
        assert!(validate_environment(true, &e).is_err());
        assert!(validate_environment(false, &e).is_ok());
        assert!(validate_environment(true, env(&[("DEV_AUTH_BYPASS", "false")])).is_ok());
        assert!(validate_environment(true, env(&[("NYX_INSECURE_ALLOW_ANY_PATH", "1")])).is_err());
    }

    #[test]
    fn secrets_checked() {
        assert!(validate_environment(false, env(&[("ENCRYPTION_SECRET", "short")])).is_err());
        assert!(validate_environment(
            true,
            env(&[("ENCRYPTION_SECRET", "changeme-changeme-changeme")])
        )
        .is_err());
        assert!(validate_environment(
            false,
            env(&[("ENCRYPTION_SECRET", "changeme-changeme-changeme")])
        )
        .is_ok());
        assert!(validate_environment(
            true,
            env(&[("BYOK_ENCRYPTION_SECRET", "k3j9fh28dh2ksl2910sd")])
        )
        .is_ok());
        assert!(validate_environment(true, env(&[])).is_ok());
    }

    #[test]
    fn wildcard_cors_refused_and_messages_aggregate() {
        let e = validate_environment(
            true,
            env(&[("CORS_ORIGINS", "http://a, *"), ("DEV_AUTH_BYPASS", "1")]),
        )
        .unwrap_err()
        .to_string();
        assert!(e.contains("CORS_ORIGINS") && e.contains("DEV_AUTH_BYPASS"));
    }

    #[test]
    fn placeholders() {
        for p in [
            "",
            "sk_test_abc",
            "REPLACE_WITH_KEY",
            "xxxxxxxx",
            "your_key_here",
            "0000",
        ] {
            assert!(is_placeholder_secret(p), "{p}");
        }
        assert!(!is_placeholder_secret("k3j9fh28dh2ksl2910sd"));
    }
}
