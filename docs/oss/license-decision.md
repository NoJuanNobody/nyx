# Nyx license decision memo (AI-52)

Status: DECIDED. The owner chose dual licensing under MIT OR Apache-2.0, the standard Rust convention. Copyright 2026 Alejandro Londono / NoJuanNobody. Applied in `LICENSE-MIT`, `LICENSE-APACHE`, every `Cargo.toml`, every `package.json`, and the Tauri bundle config. The comparison below is the original analysis. Apache-2.0 alone is not the project license.

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
Rust libraries conventionally ship `MIT OR Apache-2.0` (Cargo `license = "MIT OR Apache-2.0"`). Some applications choose Apache-2.0 alone. Tauri itself is dual Apache-2.0 / MIT, so either choice is compatible. Nyx uses `MIT OR Apache-2.0` for the whole repository, including the app and the core crate.

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

## Decision

**MIT OR Apache-2.0** for the repository (app, CLI, MCP server, core crate, and the TypeScript packages).

The owner chose the standard Rust dual license. Either license may be used. The README License section includes the contribution clause: unless a contributor explicitly states otherwise, contributions are dual-licensed on the same terms. Copyright holder on both license files: Alejandro Londono / NoJuanNobody, 2026.

Apache-2.0 alone was the earlier recommendation in this memo. It is not the project license. MIT alone, MPL-2.0, and AGPL-3.0 were not chosen.

## Decision checklist

1. [x] License recorded: `MIT OR Apache-2.0`.
2. [x] `LICENSE-MIT` and `LICENSE-APACHE` at the repo root, copyright 2026 Alejandro Londono / NoJuanNobody.
3. [ ] `NOTICE` only if bundled third-party Apache code needs an extra attribution file. Not added with the license.
4. [x] Every `Cargo.toml` (workspace and crates): `license = "MIT OR Apache-2.0"`.
5. [x] Every `package.json` (root, `apps/api`, `apps/web`, `packages/*`): `"license": "MIT OR Apache-2.0"`.
6. [x] Tauri bundle metadata: `bundle.copyright` and `bundle.license` match.
7. [x] `README.md` License section uses the standard Rust dual-license wording, including the contribution clause.
8. [ ] `TRADEMARKS.md` and a DCO CI check are still open.
9. [ ] Optional SPDX headers in new source: `SPDX-License-Identifier: MIT OR Apache-2.0`. No mass rewrite.
10. [x] `deny.toml` allow-list already includes MIT and Apache-2.0. The JS license check was already in CI.
11. [ ] Audit and remove or replace any dependency or vendored asset (fonts, icons, the old logo, marketing files, `Nyx_Landing.jsx`) whose license is incompatible or that Alejandro does not want released.
12. [ ] Confirm no secrets or private data remain in git history before making the repo public (separate ticket; license does not cover this).
13. [ ] Only then flip repo visibility (owner action, not part of this ticket).

## Open questions only the owner can answer

1. Decided: `MIT OR Apache-2.0`, including for the core crate.
2. Is blocking closed hosted forks a real goal (AGPL / CLA path), or is trademark plus execution speed enough?
3. Could he want a commercial or relicensed edition later? If yes, adopt a CLA instead of DCO now.
4. Copyright line decided: Alejandro Londono / NoJuanNobody, 2026. Contractor or prior-contributor consent, if any, is still an owner follow-up before the repo is public.
5. Are there third-party assets, customer data, fixtures, or marketing materials in the repo that cannot be open-sourced?
6. Should the new logo and the Nyx name be under a strict trademark policy (recommended), and will he register the mark?
7. Credits as utility tokens: any plan for an official hosted credit service? If so, should its terms of service be separate from the code license, and are there legal or regulatory reviews he wants before launch?
8. Any pending patent filings or employer/IP-assignment constraints that affect granting a patent license?
