# Versioning and release checklist

## Versioning

- SemVer. Single source of truth: `[workspace.package] version` in the root `Cargo.toml`.
  `tauri.conf.json` deliberately has no `version`, so Tauri uses the desktop crate
  version (inherited from the workspace). Keep `package.json` versions out of this.
- Tags: `vMAJOR.MINOR.PATCH`, or with a pre-release suffix (`v0.1.0-beta.1`).
  Tags with a suffix are published as GitHub **pre-releases**.
- The tag must equal `v` + workspace version; the workflow fails otherwise.
- Updater compares SemVer, so never reuse or lower a version.

## Checklist

1. Green CI on `main` (`pnpm build/typecheck/test`, `cargo fmt/clippy/test --workspace`).
2. Bump `version` in root `Cargo.toml`; run `cargo check --workspace` so `Cargo.lock` updates.
3. Update changelog / release notes.
4. Confirm `plugins.updater.pubkey` is the real key (not the `REPLACE_WITH_...` placeholder).
5. Confirm required secrets exist (`secrets.md`).
6. Commit `chore: release vX.Y.Z`, tag `vX.Y.Z`, push tag (human action).
7. Workflow builds all platforms and creates a **draft** release with installers,
   `.sig` files and `latest.json`.
8. Smoke test installers on macOS (check `spctl -a -vv Nyx.app` and
   `xcrun stapler validate`), Windows (SmartScreen/signature) and Linux.
9. Test the updater from the previous version against the draft's `latest.json`.
10. Publish the draft. `releases/latest/download/latest.json` now serves the update.
11. Rollback: delete or unpublish the release; clients keep the prior version. Ship a
    higher patch version to fix, never re-tag.
