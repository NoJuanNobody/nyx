# License apply checklist (AI-79)

Status: BLOCKED on the owner's decision in [license-decision.md](./license-decision.md). No `LICENSE` file, no `license` fields and no license badge have been added. Run this list in one commit once the choice is made (examples assume Apache-2.0; for dual use `MIT OR Apache-2.0` and two license files).

1. [ ] Add `LICENSE` (verbatim text, correct copyright holder and year) and, if needed, `NOTICE`.
2. [ ] Root `Cargo.toml`: replace `license = "LicenseRef-TBD"` with the SPDX id; each crate already inherits via `license.workspace = true` (verify). Update the "Licence is `LicenseRef-TBD`" line in `docs/rust-workspace.md`.
3. [ ] Add `"license": "<SPDX-ID>"` to `package.json` in the root, `apps/api`, `apps/web`, `packages/*`. Do not commit `pnpm-lock.yaml` changes.
4. [ ] Tauri bundle metadata in `apps/desktop/src-tauri/tauri.conf.json` (`bundle.copyright`, `bundle.license`/`licenseFile`).
5. [ ] `README.md`: replace the `License` section (look for `LICENSE-PLACEHOLDER`) with "Licensed under <SPDX-ID>. See LICENSE.", add a badge, link `TRADEMARKS.md`, and drop the "no license is granted" sentence.
6. [ ] Add `TRADEMARKS.md`, `CONTRIBUTING.md` with the DCO (or CLA) section, and a DCO check.
7. [ ] Add `deny.toml` (`cargo deny check licenses`) and a JS license check in CI (CI changes belong to the workflow ticket).
8. [ ] Confirm copyright ownership and that no third-party assets or customer data are in the tree (see open questions in the memo).
9. [ ] Only after the above and the history/secrets pre-launch checklist in [repo-audit.md](./repo-audit.md), flip visibility (owner action).
