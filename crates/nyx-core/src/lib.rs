//! Nyx core: pure Rust, no UI. Shared by the desktop shell, CLI and MCP server.

pub mod error;
pub mod ledger;
pub mod model;
pub mod store;

pub use error::{Error, Result};

/// Crate version, for `--version` style output in front-ends.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Minimal smoke-test entry point used by the Tauri hello-world.
#[must_use]
pub fn hello() -> String {
    format!("nyx-core {VERSION}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn hello_mentions_version() {
        assert!(super::hello().contains(super::VERSION));
    }
}
