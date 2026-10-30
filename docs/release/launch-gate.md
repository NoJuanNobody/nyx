# Launch gate: v0.1 public release + nyx-creative.com update (AI-82)

Status: **blocked on the owner.** Nothing in this document has been executed. The swarm prepared
the evidence; flipping visibility, tagging, publishing and changing the website each need
Alejandro's explicit OK.

## Decisions only the owner can make

| # | Decision | Where the analysis is |
|---|----------|----------------------|
| 1 | License (Apache-2.0 alone, MIT OR Apache-2.0, other) and DCO vs CLA | `docs/oss/license-decision.md`, apply steps in `docs/oss/license-apply-checklist.md` |
| 2 | Copyright holder of existing code; whether trademark policy for "Nyx" is wanted | `docs/oss/license-decision.md` |
| 3 | New logo: pick one concept (recommended: 02 Constellation N) | `docs/brand/README.md`, `docs/brand/designer-brief.md` |
| 4 | History: publish as-is, scrub history, or squash into a fresh repo | `docs/oss/repo-audit.md` |
| 5 | Keep or drop process docs: `swarm-notes/`, `.agentpolicy/`, `.claude/skills/`, `CLAUDE.md`, `Nyx_ProductBrief.md` (contains a personal email) | `docs/oss/repo-audit.md` |
| 6 | Retire hosted deployment? `railway.toml` and `vercel.json` were deliberately kept | PR description |
| 7 | Credits defaults: first-run grant of 1000, agent auto-allocation, legacy balance import | `docs/credits/utility-tokens-spec.md` |
| 8 | Accept the `proc-macro-error` advisory ignore and the CDLA-Permissive-2.0 allow-list entry | `deny.toml` |

## Blockers before the repository goes public

1. Delete the old `db-backup-*` GitHub Actions artifacts (they contain production database dumps).
2. Rotate or delete the `DATABASE_PUBLIC_URL` and `GH_PAT` repository secrets; rotate the keys in the
   "rotate before public" list in `docs/oss/repo-audit.md` as a precaution.
3. Run `gitleaks` and `trufflehog` once as an independent second opinion (the audit used regex scans).
4. Fill the placeholders: enforcement contact in `CODE_OF_CONDUCT.md`, fallback contact in
   `SECURITY.md`, updater `pubkey` in `apps/desktop/src-tauri/tauri.conf.json`.
5. Generate the Tauri updater keypair and set signing secrets (`TAURI_SIGNING_PRIVATE_KEY`,
   password, `APPLE_*`; Windows signing option still undecided). See `docs/release/`.
6. Replace the placeholder desktop icon once the logo is chosen.
7. Remove hardcoded `nyx-creative.com` hosts, the Google Analytics fallback id and ad-tech CSP
   entries from the legacy web app if it ships (listed in the audit).
8. Confirm the new CI (`rust.yml`, `release.yml`) is green on GitHub; it has never run.
9. Build and smoke-test installers on Windows and Linux (only macOS was ever built here).

## Release steps once the owner approves (do not run before)

1. Apply the license per the checklist; commit LICENSE, NOTICE, Cargo and package license fields.
2. Merge the integration PR; tag `v0.1.0`; the release workflow creates a **draft** GitHub Release.
3. Review the draft, attach notes, publish.
4. Update nyx-creative.com copy and links (separate change, owner-driven).
5. Announce.
