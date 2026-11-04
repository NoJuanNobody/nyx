# Dependency and license inventory (AI-51)

Generated 2026-10-30 from the npm workspace (`pnpm install --offline`, installed `node_modules/*/package.json`). Machine-readable copy: [dependency-inventory.json](dependency-inventory.json). Rust crate licenses come from `cargo info` (crates.io metadata); re-verify with `cargo deny check licenses` once the Cargo workspace exists.

## Summary

- 92 direct dependency entries across 7 manifests (root, apps/api, apps/web, packages/cli, harness-core, mcp-server, shared).
- Licenses: Apache-2.0 10, MIT 74, (project) 5, BSD-2-Clause 1, Unlicense 1, (MPL-2.0 OR Apache-2.0) 1.
- Dispositions: keep 39, drop 27, rust 26. (`rust` = replaced by a Rust crate or in-repo Rust port; `drop` = removed with no equivalent; `keep` = stays in the web/test toolchain.)
- **Copyleft / non-OSI / unknown among direct deps: none.** Nothing blocks Apache-2.0 or MIT distribution. The license choice itself remains pending (AI-79).

## Flags

| Item | License | Assessment |
|---|---|---|
| dompurify (apps/web) | MPL-2.0 OR Apache-2.0 | Dual; elect Apache-2.0. Compatible with both candidates. |
| postgres (apps/api) | Unlicense | Public-domain dedication; compatible. Dropped with the API. |
| dotenv (apps/api) | BSD-2-Clause | Permissive. |
| jszip (transitive via docx) | MIT OR GPL-3.0-or-later | Elect MIT. Disappears when docx is replaced. |
| lightningcss (transitive via @tailwindcss/vite) | MPL-2.0 | File-level copyleft, build-time only, not in shipped output. Fine. |
| edge-runtime packages (transitive via vercel) | MPL-2.0 | Dropped with vercel. |
| caniuse-lite (transitive) | CC-BY-4.0 | Data, build-time only. Attribution if redistributed. |
| @bufbuild/protobuf, @bytecodealliance/preview2-shim | Apache-2.0 AND BSD-3-Clause / Apache-2.0 WITH LLVM-exception | Permissive (transitive, via vercel tooling). |

Rust side: every proposed crate is MIT, Apache-2.0 or MIT OR Apache-2.0. Caveats: bundled SQLite is public domain; tree-sitter language grammars must be license-checked per grammar if tree-sitter is adopted; check transitive crates (cargo deny) after the workspace is created.

## Dropped (SaaS / agent-only)

stripe, fastify-raw-body (Stripe webhooks), @clerk/backend, @clerk/mcp-tools, @clerk/clerk-react, @anthropic-ai/sdk, openai, @hashbrownai/{anthropic,core,react}, @ag-ui/{core,encoder}, @sentry/node, @fastify/cookie, vercel, concurrently, form-data, and the `@types/*` and test tooling that only served apps/api.

## Rust additions not present in the npm workspace

| Crate | Version | License | Use |
|---|---|---|---|
| tauri | 2.x | Apache-2.0 OR MIT | Desktop shell (crates.io license verified on the current 3.0 alpha; 2.x same dual license) |
| tokio | 1.x | MIT | Async runtime |
| tracing | 0.1 | MIT | Logging |
| thiserror | 2.x | MIT OR Apache-2.0 | Errors |
| anyhow | 1.x | MIT OR Apache-2.0 | Errors in binaries |
| uuid | 1.x | Apache-2.0 OR MIT | IDs |
| tree-sitter | 0.27 | MIT | Only if code scanning (codebase-scanner.service) is ported; currently implemented without it, grammar crates are individually MIT in most cases and must be checked per language |
| syntect | 5.x | MIT | Optional native syntax highlighting; frontend uses shiki (MIT) |
| keyring | 4.x | MIT OR Apache-2.0 | OS keychain for stored secrets |

## Open decisions

- Database: this inventory assumes embedded SQLite (rusqlite) replaces Postgres/Drizzle. Confirm.
- HTTP server (axum et al.): only needed if the core exposes a local HTTP API beyond Tauri IPC, MCP and CLI.
- PDF crate: printpdf is the default; krilla or genpdf are alternatives if layout needs grow.

## root

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| @playwright/test | dev | ^1.58.2 | 1.58.2 | Apache-2.0 | keep | - | E2E tests against the webview/UI |
| @typescript-eslint/eslint-plugin | dev | ^8 | 8.56.1 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| @typescript-eslint/parser | dev | ^8 | 8.56.1 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| eslint | dev | ^9 | 9.39.3 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| prettier | dev | ^3 | 3.8.1 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| turbo | dev | ^2 | 2.8.11 | MIT | keep | - | JS task runner for the web frontend; can be dropped if tauri/cargo scripts suffice |
| typescript | dev | ^5.7 | 5.9.3 | Apache-2.0 | keep | - | JS/TS tooling for the web frontend and remaining TS packages |

## apps/api

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| @ag-ui/core | prod | ^1.0.3 | 1.0.3 | MIT | drop | - | Agent chat streaming protocol; chat sidebar removed |
| @ag-ui/encoder | prod | ^1.0.3 | 1.0.3 | MIT | drop | - | Agent chat streaming protocol; chat sidebar removed |
| @anthropic-ai/sdk | prod | ^0.39 | 0.39.0 | MIT | drop | reqwest (MIT OR Apache-2.0); genai (MIT OR Apache-2.0) | In-app agent removed; external agents call Nyx over MCP/CLI. If an LLM client is ever needed: reqwest or genai |
| @clerk/backend | prod | ^3 | 3.11.5 | MIT | drop | - | Hosted auth; desktop app is local single-user |
| @clerk/mcp-tools | prod | ^0.5.0 | 0.5.0 | MIT | drop | - | Hosted auth for MCP; local MCP needs no accounts |
| @fastify/cookie | prod | ^11 | 11.0.2 | MIT | drop | - | Session cookies tied to hosted auth |
| @fastify/cors | prod | ^11 | 11.2.0 | MIT | rust | tower-http (cors feature) (MIT) |  |
| @fastify/helmet | prod | ^13.0.2 | 13.0.2 | MIT | rust | tower-http (set-header feature) (MIT) | Security headers |
| @fastify/multipart | prod | ^9.4.0 | 9.4.0 | MIT | rust | axum (multipart feature) (MIT) |  |
| @fastify/rate-limit | prod | ^10.3.0 | 10.3.0 | MIT | rust | governor (MIT); tower_governor (MIT OR Apache-2.0) | Likely unnecessary on loopback; credit metering is app-level |
| @fastify/websocket | prod | ^11.2.0 | 11.2.0 | MIT | rust | axum (ws feature) / tokio-tungstenite (MIT) |  |
| @hashbrownai/anthropic | prod | 0.7.0 | 0.7.0 | MIT | drop | - | Agent UI glue removed |
| @modelcontextprotocol/sdk | prod | ^1.0.0 | 1.27.1 | MIT | rust | rmcp (Apache-2.0) | MCP server/transport |
| @nyx/harness-core | prod | workspace:* | workspace | (project) | rust | nyx-core (new, in-repo) (project license) | Port to Rust core crate |
| @nyx/shared | prod | workspace:* | workspace | (project) | rust | nyx-core (new, in-repo) (project license) | Shared types become part of the core crate |
| @sentry/node | prod | ^10.47.0 | 10.47.0 | MIT | drop | sentry (MIT) | Server telemetry; optional opt-in crash reporting could use sentry crate |
| @types/tar-stream | prod | ^3.1.4 | 3.1.4 | MIT | drop | - | TS types for dropped API |
| archiver | prod | ^7.0.1 | 7.0.1 | MIT | rust | zip (MIT) | ZIP export |
| docx | prod | ^9.6.1 | 9.6.1 | MIT | rust | docx-rs (MIT) | DOCX export |
| dotenv | prod | ^16 | 16.6.1 | BSD-2-Clause | rust | dotenvy (MIT); keyring (MIT OR Apache-2.0) | Env loading; desktop uses config file + OS keyring |
| drizzle-orm | prod | ^0.38 | 0.45.2 | Apache-2.0 | rust | rusqlite (bundled) (MIT); sqlx (alt) (MIT OR Apache-2.0) | Postgres to embedded SQLite for desktop (decision: SQLite assumed) |
| fastify | prod | ^5 | 5.7.4 | MIT | rust | axum (MIT) | HTTP server; only needed if core exposes a local HTTP API |
| fastify-raw-body | prod | ^5.0.0 | 5.0.0 | MIT | drop | - | Only needed for Stripe webhook signature verification |
| openai | prod | ^6.32.0 | 6.32.0 | Apache-2.0 | drop | - | In-app agent removed |
| pdfkit | prod | ^0.16 | 0.16.0 | MIT | rust | printpdf (MIT); krilla (alt) (MIT OR Apache-2.0); genpdf (alt) (Apache-2.0 OR MIT) | PDF export |
| postgres | prod | ^3 | 3.4.8 | Unlicense | rust | rusqlite (bundled; libsqlite3-sys MIT, SQLite public domain) (MIT) | Postgres driver; replaced by embedded SQLite FLAG: Unlicense: public-domain dedication, not OSI-approved by name but OSI-listed; compatible. Dropped with API anyway. |
| stripe | prod | ^20.4.1 | 20.4.1 | MIT | drop | - | Billing removed; credits become non-sold agent utility tokens |
| tar-stream | prod | ^3.1.8 | 3.1.8 | MIT | rust | tar (MIT OR Apache-2.0); flate2 (MIT OR Apache-2.0) | Tar export/import |
| zod | prod | ^3 | 3.25.76 | MIT | rust | serde (MIT OR Apache-2.0); serde_json (MIT OR Apache-2.0); schemars (MIT); validator (MIT) | Schema validation / shared types |
| @types/archiver | dev | ^7.0.0 | 7.0.0 | MIT | drop | - | TS types for dropped API |
| @types/form-data | dev | ^2.5.2 | 2.5.2 | MIT | drop | - | TS types for dropped API |
| @types/node | dev | ^22 | 22.19.11 | MIT | drop | - | API removed |
| @types/pdfkit | dev | ^0.13 | 0.13.9 | MIT | drop | - | TS types for dropped API |
| @types/ws | dev | ^8.18.1 | 8.18.1 | MIT | drop | - | TS types for dropped API |
| @vitest/coverage-v8 | dev | ^3 | 3.2.4 | MIT | drop | - | API removed |
| concurrently | dev | ^9.2.1 | 9.2.1 | MIT | drop | - | Dev-script runner for API+web; replaced by tauri dev |
| drizzle-kit | dev | ^0.30 | 0.30.6 | MIT | rust | rusqlite_migration (Apache-2.0) | Migrations |
| form-data | dev | ^4.0.5 | 4.0.5 | MIT | drop | - | API test helper |
| tsx | dev | ^4 | 4.21.0 | MIT | drop | - | API removed |
| typescript | dev | ^5.7 | 5.9.3 | Apache-2.0 | drop | - | API removed |
| vitest | dev | ^3 | 3.2.4 | MIT | drop | - | API removed |

## apps/web

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| @clerk/clerk-react | prod | ^5.61.3 | 5.61.3 | MIT | drop | - | Hosted auth |
| @hashbrownai/core | prod | 0.7.0 | 0.7.0 | MIT | drop | - | Agent UI glue removed |
| @hashbrownai/react | prod | 0.7.0 | 0.7.0 | MIT | drop | - | Agent UI glue removed |
| @nyx/shared | prod | workspace:* | workspace | (project) | rust | nyx-core (new, in-repo) (project license) | Shared types become part of the core crate |
| @tailwindcss/typography | prod | ^0.5.19 | 0.5.19 | MIT | keep | - | Frontend stays (Tauri webview) |
| @tanstack/react-query | prod | ^5 | 5.90.21 | MIT | keep | - | Frontend stays (Tauri webview) |
| dompurify | prod | ^3.3.3 | 3.3.3 | (MPL-2.0 OR Apache-2.0) | keep | - | Frontend stays (Tauri webview) FLAG: Dual MPL-2.0 OR Apache-2.0; elect Apache-2.0. No conflict. |
| react | prod | ^19 | 19.2.4 | MIT | keep | - | Frontend stays (Tauri webview) |
| react-dom | prod | ^19 | 19.2.4 | MIT | keep | - | Frontend stays (Tauri webview) |
| react-markdown | prod | ^10.1.0 | 10.1.0 | MIT | keep | - | Frontend stays (Tauri webview) |
| react-router-dom | prod | ^7 | 7.13.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| remark-gfm | prod | ^4.0.1 | 4.0.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| shiki | prod | ^4.0.1 | 4.0.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| zustand | prod | ^5 | 5.0.11 | MIT | keep | - | Frontend stays (Tauri webview) |
| @tailwindcss/vite | dev | ^4 | 4.2.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| @testing-library/jest-dom | dev | ^6.9.1 | 6.9.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| @testing-library/react | dev | ^16.3.2 | 16.3.2 | MIT | keep | - | Frontend stays (Tauri webview) |
| @testing-library/user-event | dev | ^14.6.1 | 14.6.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| @types/dompurify | dev | ^3.2.0 | 3.2.0 | MIT | keep | - | Frontend stays (Tauri webview) |
| @types/react | dev | ^19 | 19.2.14 | MIT | keep | - | Frontend stays (Tauri webview) |
| @types/react-dom | dev | ^19 | 19.2.3 | MIT | keep | - | Frontend stays (Tauri webview) |
| @vitejs/plugin-react | dev | ^4 | 4.7.0 | MIT | keep | - | Frontend stays (Tauri webview) |
| @vitest/coverage-v8 | dev | ^3 | 3.2.4 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| jsdom | dev | ^28.1.0 | 28.1.0 | MIT | keep | - | Frontend stays (Tauri webview) |
| tailwindcss | dev | ^4 | 4.2.1 | MIT | keep | - | Frontend stays (Tauri webview) |
| typescript | dev | ^5.7 | 5.9.3 | Apache-2.0 | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| vercel | dev | ^51.4.0 | 51.4.0 | Apache-2.0 | drop | - | Hosted deploy CLI; SaaS hosting removed |
| vite | dev | ^6 | 6.4.2 | MIT | keep | - | Frontend stays (Tauri webview) |
| vitest | dev | ^3 | 3.2.4 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |

## packages/cli

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| commander | prod | ^12.1.0 | 12.1.0 | MIT | rust | clap (MIT OR Apache-2.0) | CLI argument parsing |
| marked | prod | ^17.0.5 | 17.0.5 | MIT | rust | pulldown-cmark (MIT) | Markdown parse for terminal |
| marked-terminal | prod | ^7.3.0 | 7.3.0 | MIT | rust | termimad (MIT) | Terminal markdown rendering |
| tsx | dev | ^4.19.2 | 4.21.0 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| typescript | dev | ^5.7.2 | 5.9.3 | Apache-2.0 | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| vitest | dev | ^3 | 3.2.4 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |

## packages/harness-core

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| @nyx/shared | prod | workspace:* | workspace | (project) | rust | nyx-core (new, in-repo) (project license) | Shared types become part of the core crate |
| typescript | dev | ^5.7.2 | 5.9.3 | Apache-2.0 | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| vitest | dev | ^3 | 3.2.4 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |

## packages/mcp-server

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| @modelcontextprotocol/sdk | prod | ^1.0.0 | 1.27.1 | MIT | rust | rmcp (Apache-2.0) | MCP server/transport |
| @nyx/harness-core | prod | workspace:* | workspace | (project) | rust | nyx-core (new, in-repo) (project license) | Port to Rust core crate |
| tsx | dev | ^4.19.2 | 4.21.0 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| typescript | dev | ^5.7.2 | 5.9.3 | Apache-2.0 | keep | - | JS/TS tooling for the web frontend and remaining TS packages |
| vitest | dev | ^3 | 3.2.4 | MIT | keep | - | JS/TS tooling for the web frontend and remaining TS packages |

## packages/shared

| Dependency | Type | Range | Installed | License | Disposition | Rust equivalent (license) | Notes |
|---|---|---|---|---|---|---|---|
| zod | prod | ^3 | 3.25.76 | MIT | rust | serde (MIT OR Apache-2.0); serde_json (MIT OR Apache-2.0); schemars (MIT); validator (MIT) | Schema validation / shared types |

