# Rust workspace

Decision record: `docs/adr/0001-tauri-2-rust-core.md`.

## Crates

| Path | Crate | Kind | Purpose |
|---|---|---|---|
| `crates/nyx-core` | `nyx-core` | lib | Model, store, ledger, errors. No UI. |
| `crates/nyx-cli` | `nyx-cli` | bin `nyx` | Command-line interface (clap). |
| `crates/nyx-mcp` | `nyx-mcp` | bin | MCP server stub (transport TODO). |
| `apps/desktop/src-tauri` | `nyx-desktop` | bin | Tauri 2 shell; calls `nyx-core` via commands. |

`apps/desktop/ui` holds a placeholder static page for the hello-world; the real UI
will come from porting `apps/web`.

## Commands

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo test --workspace
cargo run -p nyx-cli -- --version
```

Plain `cargo build`/`cargo test` use `default-members` (core, CLI, MCP) and skip the
desktop crate, which needs system webview libraries on Linux
(`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, etc.). `--workspace` or `-p nyx-desktop`
includes it. To run the app: `cargo install tauri-cli --version "^2"` then
`cd apps/desktop/src-tauri && cargo tauri dev`.

## Conventions

- Shared version, edition, `rust-version` (MSRV) and lints live in the root `Cargo.toml`.
- `unsafe_code` is forbidden; `unwrap` is denied outside tests.
- Licence is `LicenseRef-TBD` until chosen; do not add a LICENSE file yet.
- `src-tauri/icons/icon.png` is a placeholder until the new logo lands.
