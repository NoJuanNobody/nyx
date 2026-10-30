//! The live network edge of Nyx.
//!
//! `nyx-core` never opens a socket: every outbound call is an
//! [`HttpRequest`](nyx_core::net::HttpRequest) handed to an
//! [`HttpTransport`](nyx_core::net::HttpTransport). This crate supplies the real implementations:
//!
//! - [`UreqTransport`]: blocking HTTPS client (`ureq` 3 + rustls/ring, embedded Mozilla roots).
//!   Every URL, including every redirect hop, passes `nyx_core::security::UrlPolicy` (https only,
//!   public addresses only), with DNS answers vetted and pinned. See [`transport`].
//! - [`LoopbackListener`]: the one-shot `127.0.0.1` listener of the desktop OAuth flow. See
//!   [`oauth`].
//! - [`live_services`]: a thin bundle of trait objects for the app crate. See [`services`].
//!
//! Design notes and known gaps: `docs/rust-core/net.md`.

pub mod oauth;
pub mod services;
pub mod transport;

#[cfg(test)]
mod testutil;

pub use oauth::LoopbackListener;
pub use services::{live_services, LiveServices};
pub use transport::{NetConfig, UreqTransport, DEFAULT_MAX_RESPONSE_BYTES};

/// Value of the default `User-Agent`: `nyx/<version>`.
pub const USER_AGENT: &str = concat!("nyx/", env!("CARGO_PKG_VERSION"));
