# License apply checklist (AI-79)

Status: license applied. The owner chose MIT OR Apache-2.0. See [license-decision.md](./license-decision.md).

1. [x] Add `LICENSE-MIT` and `LICENSE-APACHE` (copyright 2026 Alejandro Londono / NoJuanNobody). `NOTICE` was not required for this change.
2. [x] Every `Cargo.toml` sets `license = "MIT OR Apache-2.0"`. `docs/rust-workspace.md` matches.
3. [x] `"license": "MIT OR Apache-2.0"` in `package.json` at the root, `apps/api`, `apps/web`, and `packages/*`. `pnpm-lock.yaml` unchanged.
4. [x] Tauri bundle metadata in `apps/desktop/src-tauri/tauri.conf.json`: `bundle.copyright` and `bundle.license` (`MIT OR Apache-2.0`). No single `licenseFile`, so the bundle metadata does not pick one license.
5. [x] `README.md` License section uses the standard Rust dual-license wording, including the contribution clause. The "no license is granted" sentence is gone.
6. [ ] Add `TRADEMARKS.md`, `CONTRIBUTING.md` with the DCO (or CLA) section, and a DCO check.
7. [ ] Add `deny.toml` (`cargo deny check licenses`) and a JS license check in CI (CI changes belong to the workflow ticket).
8. [ ] Confirm copyright ownership and that no third-party assets or customer data are in the tree (see open questions in the memo).
9. [ ] Only after the above and the history/secrets pre-launch checklist in [repo-audit.md](./repo-audit.md), flip visibility (owner action).
