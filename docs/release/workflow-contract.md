# Contract for `.github/workflows/release.yml` (owned by AI-81)

The desktop config (AI-62) assumes the following. Names here are the interface.

## Trigger

- `on: push: tags: ['v*']` (plus optional `workflow_dispatch` for dry runs that build but
  do not publish).
- First job validates: tag == `v` + workspace version in root `Cargo.toml`; fails otherwise.
  Tag containing `-` means pre-release.

## Build matrix (use `tauri-apps/tauri-action@v0`, `projectPath: apps/desktop`)

| Runner | Target args | Artifacts |
|---|---|---|
| `macos-latest` | `--target aarch64-apple-darwin` | `.app.tar.gz` (+`.sig`), `.dmg` |
| `macos-13` (or cross) | `--target x86_64-apple-darwin` | same |
| `windows-latest` | (default x64) | NSIS `.exe` + `.msi` (+ updater `.sig`) |
| `ubuntu-22.04` | (default) | `.deb`, `.rpm`, `.AppImage` (+`.sig`) |

Linux deps: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf`.
Frontend: `pnpm install --frozen-lockfile` first (the desktop `ui` is static today, but keep the step).
Rust: stable via `rust-toolchain.toml`, with cargo cache (e.g. `Swatinem/rust-cache`).

## Environment passed to the build step

Secret names from `docs/release/secrets.md`: `TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY`, and either `APPLE_ID`/`APPLE_PASSWORD`/`APPLE_TEAM_ID` or the
API-key trio. Windows signing vars when a cert exists. Missing optional secrets must not
fail the build: unsigned output is allowed for pre-release tags only.
`bundle.createUpdaterArtifacts` is already `true`, so updater `.sig` files are produced
whenever `TAURI_SIGNING_PRIVATE_KEY` is set (it is required on tags).

## Release publishing

- `contents: write` permission; `GITHUB_TOKEN`.
- tauri-action options: `tagName: ${{ github.ref_name }}`, `releaseName: 'Nyx ${{ github.ref_name }}'`,
  `releaseDraft: true`, `prerelease: <tag contains '-'>`, `uploadUpdaterJson: true`
  (so `latest.json` is attached), `includeUpdaterJson: true`.
- `latest.json` must be an asset named exactly `latest.json`: the app endpoint is
  `https://github.com/NoJuanNobody/nyx/releases/latest/download/latest.json`.
- Release stays a draft; a human publishes after smoke tests (`versioning.md`).
- Optional final job: attach `SHA256SUMS`.

## Must NOT

- Print secrets, or run on pull requests from forks with secrets.
- Commit anything back to the repo.
- Change `tauri.conf.json` signing/updater fields except through `--config` overrides
  (e.g. Windows `signCommand`).
