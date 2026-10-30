//! Origin and Host validation for the local HTTP/WebSocket surface (MCP over HTTP, dev server).
//!
//! Port of `lib/cors.ts`: an explicit allow-list, never reflecting an arbitrary `Origin`.
//! Adds the desktop-specific counterpart: a `Host` allow-list that defeats DNS rebinding against
//! `127.0.0.1` listeners (a rebound page sends `Host: evil.example`).
//!
//! Intentional difference: the TS allow-list accepted regex entries for Vercel previews; regexes
//! on security boundaries are error-prone, so only exact origins and `*.suffix` wildcards
//! (single-label-or-more subdomain of an https origin) are supported.

/// Allow-list of origins.
#[derive(Debug, Clone, Default)]
pub struct OriginPolicy {
    exact: Vec<String>,
    wildcard_suffixes: Vec<String>,
}

impl OriginPolicy {
    /// Build from entries like `tauri://localhost`, `http://localhost:5173`,
    /// `https://*.example.com`. Matching is case-insensitive; entries must not have a path.
    #[must_use]
    pub fn new<I: IntoIterator<Item = S>, S: AsRef<str>>(entries: I) -> Self {
        let mut p = Self::default();
        for e in entries {
            let e = e.as_ref().trim().trim_end_matches('/').to_ascii_lowercase();
            if e.is_empty() || e == "*" || (e.contains("://*") && !e.starts_with("https://*.")) {
                continue; // refuse bare `*` and non-https wildcards
            }
            if let Some(rest) = e.strip_prefix("https://*.") {
                p.wildcard_suffixes.push(format!(".{rest}"));
            } else {
                p.exact.push(e);
            }
        }
        p
    }

    /// The desktop shell's own origins (Tauri 2 webview on each platform).
    #[must_use]
    pub fn tauri_default() -> Self {
        Self::new([
            "tauri://localhost",
            "http://tauri.localhost",
            "https://tauri.localhost",
        ])
    }

    /// `None` / empty origin is NOT allowed here (port of `isOriginAllowed`): non-browser clients
    /// (CLI, MCP stdio) never hit this check; callers decide separately whether to skip it.
    #[must_use]
    pub fn is_allowed(&self, origin: Option<&str>) -> bool {
        let Some(o) = origin.map(|o| o.trim().to_ascii_lowercase()) else {
            return false;
        };
        if o.is_empty() || o == "null" {
            return false;
        }
        if self.exact.contains(&o) {
            return true;
        }
        if let Some(host) = o.strip_prefix("https://") {
            let host = host.split(':').next().unwrap_or("");
            return self
                .wildcard_suffixes
                .iter()
                .any(|s| host.ends_with(s.as_str()) && host.len() > s.len());
        }
        false
    }

    /// CORS response header for an allowed origin (never `*`, never reflects a disallowed one).
    #[must_use]
    pub fn cors_allow_origin(&self, origin: Option<&str>) -> Option<String> {
        self.is_allowed(origin)
            .then(|| origin.unwrap_or_default().trim().to_string())
    }
}

/// Allowed `Host` header values for a loopback listener on `port`.
#[must_use]
pub fn is_allowed_loopback_host(host_header: &str, port: u16) -> bool {
    let h = host_header.trim().to_ascii_lowercase();
    [
        format!("127.0.0.1:{port}"),
        format!("localhost:{port}"),
        format!("[::1]:{port}"),
    ]
    .contains(&h)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_and_wildcard() {
        let p = OriginPolicy::new([
            "http://localhost:5173",
            "https://*.Example.com",
            "*",
            "http://*.evil.com",
        ]);
        assert!(p.is_allowed(Some("http://localhost:5173")));
        assert!(p.is_allowed(Some("HTTP://LOCALHOST:5173")));
        assert!(p.is_allowed(Some("https://app.example.com")));
        assert!(p.is_allowed(Some("https://a.b.example.com:8443")));
        assert!(!p.is_allowed(Some("https://example.com")));
        assert!(!p.is_allowed(Some("https://evilexample.com")));
        assert!(!p.is_allowed(Some("https://app.example.com.evil.io")));
        assert!(!p.is_allowed(Some("http://app.example.com")));
        assert!(!p.is_allowed(Some("http://x.evil.com")));
        assert!(!p.is_allowed(Some("http://localhost:5174")));
        assert!(!p.is_allowed(Some("null")));
        assert!(!p.is_allowed(Some("")));
        assert!(!p.is_allowed(None));
    }

    #[test]
    fn cors_header_never_reflects_disallowed() {
        let p = OriginPolicy::tauri_default();
        assert_eq!(
            p.cors_allow_origin(Some("tauri://localhost")).as_deref(),
            Some("tauri://localhost")
        );
        assert_eq!(p.cors_allow_origin(Some("https://evil.io")), None);
        assert_eq!(p.cors_allow_origin(None), None);
    }

    #[test]
    fn host_header_rebinding() {
        assert!(is_allowed_loopback_host("127.0.0.1:7777", 7777));
        assert!(is_allowed_loopback_host("localhost:7777", 7777));
        assert!(is_allowed_loopback_host("[::1]:7777", 7777));
        assert!(!is_allowed_loopback_host("evil.example:7777", 7777));
        assert!(!is_allowed_loopback_host("127.0.0.1:1", 7777));
        assert!(!is_allowed_loopback_host("127.0.0.1", 7777));
        assert!(!is_allowed_loopback_host("localhost.evil.io:7777", 7777));
    }
}
