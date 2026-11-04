//! Keyed fixed-window rate limiter for the local MCP/CLI endpoint.
//!
//! Port of `@fastify/rate-limit` (`max` per `timeWindow`, keyed by user or IP, allow-list for
//! health probes). The desktop key is the caller identity (MCP client id, CLI pid, or "anonymous").
//! Time is injected so tests are deterministic; memory is bounded by [`RateLimiter::max_keys`].

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Result of a [`RateLimiter::check`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    /// Request allowed; `remaining` more in this window.
    Allowed {
        /// Requests left in the current window.
        remaining: u32,
    },
    /// Over the limit; retry after the given delay.
    Limited {
        /// Time until the window resets.
        retry_after: Duration,
    },
}

impl Decision {
    /// True if the request may proceed.
    #[must_use]
    pub fn is_allowed(&self) -> bool {
        matches!(self, Self::Allowed { .. })
    }
}

#[derive(Debug)]
struct Window {
    start: Instant,
    count: u32,
}

/// Fixed-window limiter, `max` requests per `window` per key.
#[derive(Debug)]
pub struct RateLimiter {
    max: u32,
    window: Duration,
    /// Hard cap on tracked keys; beyond it unknown keys share the `__overflow__` bucket
    /// so an attacker cannot exhaust memory by rotating identities.
    pub max_keys: usize,
    allow_list: HashSet<String>,
    state: Mutex<HashMap<String, Window>>,
}

impl RateLimiter {
    /// `max` requests per `window`. The web default was 200/minute.
    #[must_use]
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            max,
            window,
            max_keys: 4096,
            allow_list: HashSet::new(),
            state: Mutex::new(HashMap::new()),
        }
    }

    /// Keys that bypass limiting (the web allow-listed `/health` and webhooks).
    #[must_use]
    pub fn with_allow_list<I: IntoIterator<Item = S>, S: Into<String>>(mut self, keys: I) -> Self {
        self.allow_list = keys.into_iter().map(Into::into).collect();
        self
    }

    /// Check using the real clock.
    pub fn check_now(&self, key: &str) -> Decision {
        self.check(key, Instant::now())
    }

    /// Check at an explicit instant.
    pub fn check(&self, key: &str, now: Instant) -> Decision {
        if self.allow_list.contains(key) {
            return Decision::Allowed {
                remaining: self.max,
            };
        }
        // A poisoned lock means a panic mid-update; failing closed is the safe default.
        let Ok(mut map) = self.state.lock() else {
            return Decision::Limited {
                retry_after: self.window,
            };
        };
        if map.len() >= self.max_keys && !map.contains_key(key) {
            let window = self.window;
            map.retain(|_, w| now.saturating_duration_since(w.start) < window);
        }
        let key = if map.len() >= self.max_keys && !map.contains_key(key) {
            "__overflow__"
        } else {
            key
        };
        let w = map.entry(key.to_string()).or_insert(Window {
            start: now,
            count: 0,
        });
        if now.saturating_duration_since(w.start) >= self.window {
            w.start = now;
            w.count = 0;
        }
        if w.count >= self.max {
            let elapsed = now.saturating_duration_since(w.start);
            return Decision::Limited {
                retry_after: self.window.saturating_sub(elapsed),
            };
        }
        w.count += 1;
        Decision::Allowed {
            remaining: self.max - w.count,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_and_resets() {
        let l = RateLimiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        assert_eq!(l.check("a", t0), Decision::Allowed { remaining: 2 });
        assert_eq!(l.check("a", t0), Decision::Allowed { remaining: 1 });
        assert_eq!(l.check("a", t0), Decision::Allowed { remaining: 0 });
        let d = l.check("a", t0 + Duration::from_secs(10));
        assert_eq!(
            d,
            Decision::Limited {
                retry_after: Duration::from_secs(50)
            }
        );
        assert!(!d.is_allowed());
        assert!(l.check("a", t0 + Duration::from_secs(60)).is_allowed());
    }

    #[test]
    fn keys_are_independent_and_allow_list_bypasses() {
        let l = RateLimiter::new(1, Duration::from_secs(60)).with_allow_list(["health"]);
        let t = Instant::now();
        assert!(l.check("a", t).is_allowed());
        assert!(!l.check("a", t).is_allowed());
        assert!(l.check("b", t).is_allowed());
        for _ in 0..50 {
            assert!(l.check("health", t).is_allowed());
        }
    }

    #[test]
    fn key_rotation_cannot_grow_memory_or_evade() {
        let mut l = RateLimiter::new(1, Duration::from_secs(60));
        l.max_keys = 2;
        let t = Instant::now();
        assert!(l.check("k1", t).is_allowed());
        assert!(l.check("k2", t).is_allowed());
        // New identities now share one overflow bucket.
        assert!(l.check("k3", t).is_allowed());
        assert!(!l.check("k4", t).is_allowed());
        assert!(!l.check("k5", t).is_allowed());
        assert!(l.state.lock().unwrap().len() <= 3);
        // After the window, stale entries are evicted.
        assert!(l.check("k6", t + Duration::from_secs(61)).is_allowed());
    }
}
