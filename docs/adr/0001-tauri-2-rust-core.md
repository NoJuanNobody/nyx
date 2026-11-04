# ADR 0001: Tauri 2 shell with a pure-Rust core crate

- Status: Accepted (Linear AI-59)
- Date: 2026-10-30

## Context

Nyx is becoming an open-source, agent-native desktop app. The in-app agent, chat
sidebar and Stripe are being removed; credits stay as agent-native utility tokens
spent by external agents through MCP and CLI. The product logic must be rebuilt in
Rust and be usable from three front-ends without duplication: the desktop app, a
CLI, and an MCP server.

The UI is heavy: a markdown editor, diff views, an impact graph and a file tree.
A React implementation already exists in `apps/web`.

## Options

| Criterion | Tauri 2 | egui | Iced | Dioxus (desktop) |
|---|---|---|---|---|
| Reuse existing React UI (`apps/web`) | Yes, incrementally | No, full rewrite | No, full rewrite | No (Rust RSX), partial concept reuse only |
| Markdown / rich-text editor | Mature web editors (CodeMirror, ProseMirror, Milkdown) | No production rich-text editor; build from scratch | Same; text editor widget is basic | Web editors usable via webview/JS interop, awkward |
| Diff views, impact graph, file tree | Web libs available (diff viewers, d3, cytoscape, react-flow) | Hand-built, immediate-mode | Hand-built | Web libs via interop, or hand-built |
| Packaging, signing, auto-update | First-party bundler (dmg, msi, deb, AppImage), signing, updater plugin | DIY (cargo-bundle, cargo-packager, custom updater) | DIY | `dx bundle` exists, updater/signing less mature |
| Accessibility | Inherits webview a11y (screen readers, native text input, IME) | Weak; AccessKit support partial | Weak; early AccessKit work | Webview a11y, same as Tauri |
| Binary size | Small (system webview, roughly 5-15 MB) | Small (about 5-10 MB), no webview | Small | Small (system webview) |
| Team skills | Rust core plus existing TypeScript/React skills | Rust only | Rust only | Rust only, React skills unused |
| Maturity / ecosystem | Stable 2.x, large community | Stable, mostly tools/inspectors | Pre-1.0, API churn | Pre-1.0 for desktop, fast moving |
| Delivery risk | Lowest | High (rebuild every UI surface) | High | Medium |

## Decision

Use **Tauri 2** for the desktop shell and a **pure-Rust `nyx-core` crate** that holds
all logic (model, storage, ledger, and later sync/git/diff). The Tauri crate is a thin
adapter exposing `nyx-core` through Tauri commands. `nyx-cli` and `nyx-mcp` depend on
the same `nyx-core`, so behaviour is identical across desktop, terminal and agents.

The React UI from `apps/web` is ported incrementally onto Tauri commands while logic
moves to Rust. Dioxus remains a candidate for a possible v2 if we later want zero
JavaScript; because the core has no UI dependency, that switch would not touch it.

## Consequences

Positive:
- Fastest route to feature parity; mature editor and graph libraries are reusable.
- One source of truth for logic; CLI and MCP come almost for free.
- Built-in bundling, signing and updater reduce release engineering.
- Core is UI-agnostic, keeping the shell replaceable.

Negative / risks:
- Two languages (Rust core, TypeScript UI) and an IPC boundary to maintain.
- System webview differences across OSes (WebKitGTK on Linux, WKWebView, WebView2) need cross-platform testing.
- Linux builds need system packages (webkit2gtk, etc.); CI must install them for the desktop crate.
- Keep the IPC surface small and typed to avoid logic leaking into the UI.

Open items:
- Verify the hello-world desktop build on macOS, Windows and Linux in CI (acceptance criterion; only macOS has been checked locally so far).
- License is not yet chosen; all crates use `license = "LicenseRef-TBD"`.

## Crate layout

```
Cargo.toml                workspace (resolver 2, shared package metadata and lints)
crates/nyx-core           pure-Rust library: model, store, ledger, error
crates/nyx-cli            binary `nyx` (clap)
crates/nyx-mcp            binary `nyx-mcp` (MCP server stub)
apps/desktop/src-tauri    Tauri 2 shell (crate nyx-desktop), frontend in apps/desktop/ui
```

Dependency direction: `nyx-cli`, `nyx-mcp`, `nyx-desktop` -> `nyx-core`. `nyx-core`
never depends on a front-end or UI crate. See `docs/rust-workspace.md`.
