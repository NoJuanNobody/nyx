# Nyx license decision memo (AI-52)

Status: PROPOSED. Decision owner: Alejandro. No LICENSE file has been added; nothing below is applied until he says yes.

## Context

Nyx is moving from a paid SaaS to an open-source, agent-native Rust desktop app (Tauri 2 plus a pure-Rust core crate shared by the CLI and MCP server). Credits stay, reframed as agent-native utility tokens that are metered and spent by external agents and never sold. The in-app agent, chat sidebar and Stripe are removed. The goal is maximum adoption by agent builders and contributors, with minimal legal friction. Blocking closed forks is not a stated goal (AI-52 says AGPL only if he wants that).

## Comparison

| Criterion | Apache-2.0 | MIT | Dual MIT OR Apache-2.0 | MPL-2.0 | AGPL-3.0 |
|---|---|---|---|---|---|
| Express patent grant (with retaliation on suit) | Yes | No (implied at best) | Yes, if the user picks Apache | Yes (per-file scope) | Yes |
| Rust ecosystem norm | Common (Tauri, many apps) | Common | The de facto standard for Rust libraries (rustc, tokio ecosystem) | Rare (some Mozilla crates) | Rare, disliked by crate consumers |
| Hosted-competitor / closed-fork risk | Allowed | Allowed | Allowed | Modified files must stay open; rest can be closed | Network clause forces source release for hosted modified versions |
| Contributor friction | Low (inbound = outbound, DCO is enough) | Lowest | Low | Low to medium | Medium; many companies ban AGPL contributions |
| Dependency compatibility | Compatible with MIT/Apache/BSD deps. One-way incompatible with GPLv2-only (not GPLv3) | Compatible with all permissive | Compatible with both camps | Compatible with permissive; file-level copyleft | Can absorb permissive deps, but the whole binary becomes AGPL, blocking permissive reuse of core crate |
| Library reuse (core crate embedded by other agents/tools) | Easy | Easiest | Easiest | Easy | Hard; viral for embedders |
| Notice overhead | LICENSE plus optional NOTICE, state changes | Minimal | Two license files | Per-file headers | Heavy |

### Patent grant
Apache-2.0 and MPL-2.0 give an explicit patent license from each contributor, terminated if the licensee sues over the work. MIT gives none explicitly. For an agent/credits system where patent trolling is plausible and corporate users will adopt the core crate, the grant matters. Dual MIT/Apache keeps the grant for anyone who picks Apache while letting GPLv2-only or MIT-only-policy users pick MIT.

### Rust ecosystem norms
Rust libraries conventionally ship `MIT OR Apache-2.0` (Cargo `license = "MIT OR Apache-2.0"`). Applications and larger projects often choose Apache-2.0 alone. Tauri itself is dual Apache-2.0 / MIT, so either choice is compatible. The dual route is mainly valuable for crates intended as libraries; Nyx's core crate may be consumed that way.

### Hosted-competitor risk
Nyx's moat as a desktop, local-first, agent-native tool is not the code alone. A permissive license lets anyone host a Nyx fork as a service. Mitigations that do not require copyleft: trademark policy (below), the credits network/service being the thing agents want (any hosted credit ledger is operated by whoever runs it), and speed of development. AGPL-3.0 is the only option here that directly blocks closed hosted forks, at the cost of adoption: corporate legal teams commonly forbid AGPL dependencies, and it makes the core crate hard to embed in other agent tooling, which contradicts the "shared core crate for CLI/MCP" goal. MPL-2.0 is a middle path (file-level copyleft) but is unusual in Rust and adds compliance confusion for little protection against hosting.

Note: relicensing later is easy from permissive to copyleft only for code the owner holds copyright on or has a CLA/relicense grant for. Contributions accepted under Apache-2.0 inbound cannot be moved to AGPL without contributor consent. Decide now if a stricter license might ever be wanted.

### Contributor friction: DCO vs CLA
- DCO (sign-off with `git commit -s`, enforced by a bot or CI check): near zero friction, standard for Linux/CNCF-style projects, inbound = outbound. Recommended.
- CLA: needed only if Alejandro wants the right to relicense (e.g. to AGPL or a commercial license) or run a dual commercial offering. Adds friction and a signing flow and deters casual contributors.
- Since Nyx was Alejandro's own paid SaaS, existing code is his (or his contractors', see open questions). A CLA is only worth it if a future relicense is a real possibility.

### Trademark policy for the Nyx name
Apache-2.0 section 6 explicitly does not grant trademark rights; MIT is silent but also grants none. The license covers code, not the Nyx name or logo (AI-52 acceptance criterion). Recommended: add a short `TRADEMARKS.md` stating that forks must rename and remove the logo, that accurate "compatible with Nyx" statements are fine, and that official builds/credits services are the only ones that may use the name. The new logo (separate ticket) should be released as a brand asset under the trademark policy, not under the code license, unless Alejandro decides otherwise. Registering the mark (USPTO) is optional but strengthens enforcement.

### Dependency compatibility
Tauri 2 (Apache-2.0 OR MIT), most of the Rust crates ecosystem, and typical JS dependencies (MIT/ISC/BSD/Apache) are all compatible with Apache-2.0 and MIT. Watch for: GPL-licensed system webviews are not linked (Tauri uses OS webviews, fine); any GPLv2-only dep (incompatible with Apache-2.0); LGPL deps (dynamic linking only); AGPL/SSPL deps (avoid). Run `cargo deny check licenses` and a JS license scan before release to confirm; this has not been run yet because the Rust workspace does not exist at this commit.

## Recommendation

Adopt **Apache-2.0** for the repository (app, CLI, MCP server, core crate).

Reasons: explicit patent grant and retaliation clause, strong fit with Tauri and the Rust ecosystem, easy corporate adoption and embedding of the core crate by third-party agents, DCO is sufficient for inbound contributions, and trademark is handled separately and explicitly in Section 6.

Acceptable alternative: **`MIT OR Apache-2.0` dual**, if Alejandro specifically wants the core crate to be a drop-in Rust library with maximum compatibility. Cost: two license files and slightly more to explain. The practical difference for the app is small.

Not recommended: MIT alone (no patent grant), MPL-2.0 (unusual, little protection), AGPL-3.0 (only if blocking closed hosted forks outweighs adoption; if so, also adopt a CLA now so relicensing stays possible).

Pair the license with: DCO, a `TRADEMARKS.md`, and a clear statement in README that credits are utility tokens spent by agents and not sold.

## Decision checklist (execute only after Alejandro says yes)

Assuming Apache-2.0. For dual MIT/Apache, replace noted items.

1. [ ] Record the decision in Linear AI-52 (acceptance criterion 1) and tick the trademark note.
2. [ ] Add `LICENSE` at repo root: verbatim Apache-2.0 text (dual: `LICENSE-APACHE` and `LICENSE-MIT`, with the copyright holder name and year 2026).
3. [ ] Add `NOTICE` at repo root: "Nyx / Copyright 2026 <owner>" plus attributions required by bundled third-party Apache-licensed code.
4. [ ] Root `Cargo.toml`: `[workspace.package] license = "Apache-2.0"` (dual: `"MIT OR Apache-2.0"`), plus `repository`, `authors`; in each crate `license.workspace = true`.
5. [ ] Every `package.json` (root, `apps/api`, `apps/web`, `packages/*`): add `"license": "Apache-2.0"` (dual: `"MIT OR Apache-2.0"`). Currently none declare a license field. Do not commit `pnpm-lock.yaml` changes.
6. [ ] Tauri config / bundle metadata (`tauri.conf.json` `bundle.copyright`, `bundle.license` or `licenseFile` where supported) to match.
7. [ ] `README.md`: add license badge (`![License](https://img.shields.io/badge/license-Apache--2.0-blue)`), a License section linking `LICENSE`, and a Trademark section linking `TRADEMARKS.md`.
8. [ ] Add `TRADEMARKS.md` (name and logo policy) and `CONTRIBUTING.md` DCO section (`Signed-off-by` requirement); add a DCO check (GitHub DCO app or CI step).
9. [ ] Optional SPDX headers: `// SPDX-License-Identifier: Apache-2.0` in new source files; no mass rewrite needed.
10. [ ] Add `cargo deny` config (`deny.toml`) with an allow-list of licenses, and a JS license check in CI.
11. [ ] Audit and remove or replace any dependency or vendored asset (fonts, icons, the old logo, marketing files, `Nyx_Landing.jsx`) whose license is incompatible or that Alejandro does not want released.
12. [ ] Confirm no secrets or private data remain in git history before making the repo public (separate ticket; license does not cover this).
13. [ ] Only then flip repo visibility (owner action, not part of this ticket).

## Open questions only the owner can answer

1. Apache-2.0 alone, or `MIT OR Apache-2.0`? Does he want the core crate treated as a library for others?
2. Is blocking closed hosted forks a real goal (AGPL / CLA path), or is trademark plus execution speed enough?
3. Could he want a commercial or relicensed edition later? If yes, adopt a CLA instead of DCO now.
4. Who holds copyright in existing code: him personally, a company entity, or contractors/prior contributors? Is anyone's consent needed to release it? Which name goes in the copyright line?
5. Are there third-party assets, customer data, fixtures, or marketing materials in the repo that cannot be open-sourced?
6. Should the new logo and the Nyx name be under a strict trademark policy (recommended), and will he register the mark?
7. Credits as utility tokens: any plan for an official hosted credit service? If so, should its terms of service be separate from the code license, and are there legal or regulatory reviews he wants before launch?
8. Any pending patent filings or employer/IP-assignment constraints that affect granting a patent license?
