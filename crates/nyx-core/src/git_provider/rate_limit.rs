//! Rate-limit header parsing for the three providers.

use super::transport::Headers;
use super::ProviderKind;

/// Normalised rate-limit snapshot.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RateLimit {
    /// Window quota.
    pub limit: Option<u64>,
    /// Requests left in the window.
    pub remaining: Option<u64>,
    /// Unix epoch seconds when the window resets.
    pub reset_epoch: Option<u64>,
    /// Seconds to wait (`Retry-After`).
    pub retry_after_secs: Option<u64>,
}

impl RateLimit {
    /// True when the quota is known to be exhausted or a retry delay was requested.
    #[must_use]
    pub fn is_exhausted(&self) -> bool {
        self.remaining == Some(0) || self.retry_after_secs.is_some()
    }

    /// Seconds to wait relative to `now_epoch`: `Retry-After` wins, else time to reset.
    #[must_use]
    pub fn wait_secs(&self, now_epoch: u64) -> Option<u64> {
        self.retry_after_secs
            .or_else(|| self.reset_epoch.map(|r| r.saturating_sub(now_epoch)))
    }
}

fn num(h: &Headers, name: &str) -> Option<u64> {
    h.get(name).and_then(|v| v.trim().parse().ok())
}

/// Parse rate-limit headers for `kind`; `None` when the response carried none.
///
/// - GitHub: `x-ratelimit-{limit,remaining,reset}`, `retry-after`.
/// - GitLab: `ratelimit-{limit,remaining,reset}` (reset is epoch seconds), `retry-after`.
/// - Bitbucket: only `retry-after` is sent on 429s.
#[must_use]
pub fn parse(kind: ProviderKind, h: &Headers) -> Option<RateLimit> {
    let rl = match kind {
        ProviderKind::GitHub => RateLimit {
            limit: num(h, "x-ratelimit-limit"),
            remaining: num(h, "x-ratelimit-remaining"),
            reset_epoch: num(h, "x-ratelimit-reset"),
            retry_after_secs: num(h, "retry-after"),
        },
        ProviderKind::GitLab => RateLimit {
            limit: num(h, "ratelimit-limit"),
            remaining: num(h, "ratelimit-remaining"),
            reset_epoch: num(h, "ratelimit-reset"),
            retry_after_secs: num(h, "retry-after"),
        },
        ProviderKind::Bitbucket => RateLimit {
            retry_after_secs: num(h, "retry-after"),
            ..RateLimit::default()
        },
    };
    (rl != RateLimit::default()).then_some(rl)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_headers() {
        let h = Headers::from_pairs([
            ("X-RateLimit-Limit", "5000"),
            ("X-RateLimit-Remaining", "0"),
            ("X-RateLimit-Reset", "1700000100"),
        ]);
        let rl = parse(ProviderKind::GitHub, &h).unwrap();
        assert_eq!(rl.limit, Some(5000));
        assert!(rl.is_exhausted());
        assert_eq!(rl.wait_secs(1_700_000_000), Some(100));
        assert_eq!(rl.wait_secs(1_700_000_500), Some(0));
    }

    #[test]
    fn gitlab_headers_and_retry_after_wins() {
        let h = Headers::from_pairs([
            ("RateLimit-Limit", "600"),
            ("RateLimit-Remaining", "12"),
            ("RateLimit-Reset", "1700000100"),
            ("Retry-After", "30"),
        ]);
        let rl = parse(ProviderKind::GitLab, &h).unwrap();
        assert_eq!(rl.remaining, Some(12));
        assert_eq!(rl.wait_secs(0), Some(30));
        assert!(rl.is_exhausted());
    }

    #[test]
    fn bitbucket_only_retry_after() {
        assert!(parse(ProviderKind::Bitbucket, &Headers::new()).is_none());
        let h = Headers::from_pairs([("Retry-After", "7")]);
        assert_eq!(
            parse(ProviderKind::Bitbucket, &h).unwrap().retry_after_secs,
            Some(7)
        );
    }

    #[test]
    fn garbage_values_ignored() {
        let h = Headers::from_pairs([("x-ratelimit-remaining", "abc")]);
        assert!(parse(ProviderKind::GitHub, &h).is_none());
    }
}
