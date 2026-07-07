# Nyx — Ad Campaign v1 (Google Search + kickbacks.ai)

> Goal: acquire first paying teams. Format: paste-ready. You run the ad accounts; the
> landing page + conversion tracking are built separately (see #466, plus landing/tracking tasks).

## Positioning (the one message)

**Nyx keeps your product specs in sync with your code — and turns doc changes into dev tickets automatically.**

Supporting angles (pick per ad group):
- Detects when docs drift from code (GitHub) and flags it.
- Non-technical teammates propose changes in docs → pushed as GitHub/Jira tickets.
- Specs flow straight into Cursor / Copilot / Claude Code.
- Version history + diff for every spec. Full export, no lock-in.

Audience: eng leads, tech leads, staff engineers, PMs at small–mid software teams (5–50 eng).

---

## Channel 1 — Google Search (primary: high intent)

**Structure:** 1 campaign, 3 tight ad groups by intent theme. Exact + phrase match only.
Start ~$25/day total. Manual CPC or Maximize Clicks with a low cap while learning.

### Ad group A — "doc/code drift"
Keywords:
- [spec drift detection]
- [keep docs in sync with code]
- "documentation out of sync with code"
- "detect outdated documentation"
- [doc code drift]

### Ad group B — "docs → tickets / non-dev workflow"
Keywords:
- "turn documentation into jira tickets"
- [create github issues from docs]
- "non technical team update specs"
- "product spec to engineering ticket"

### Ad group C — "Confluence/Notion alternative for engineering specs"
Keywords:
- "confluence alternative for engineering"
- [engineering spec tool]
- "living documentation tool for developers"
- "notion alternative for technical specs"

### Negative keywords (avoid junk clicks)
free, jobs, salary, tutorial, meaning, definition, template, resume, api documentation generator, swagger, student, course

### Responsive Search Ad copy (mix & match — Google assembles)
Headlines (30 char max each):
1. Keep Specs in Sync With Code
2. Docs Drift? Nyx Catches It
3. Specs That Match Your Codebase
4. Turn Docs Into Dev Tickets
5. Living Docs for Eng Teams
6. Non-Devs Ship Changes, Safely
7. GitHub Drift Detection
8. Specs → Cursor, Copilot, Claude
9. Version History for Every Spec
10. Start Free — Nyx

Descriptions (90 char max each):
1. Nyx flags when your docs drift from code and pushes changes as GitHub/Jira tickets.
2. Let non-technical teammates propose spec changes that flow straight to your devs.
3. Specs that stay accurate and feed Cursor, Copilot & Claude Code. Version history built in.
4. Detect doc-code drift automatically. Full export, no lock-in. Start free today.

Final URL: dedicated landing page (NOT the app homepage) with one CTA → "Start free".
Add sitelinks: "Pricing", "How drift detection works", "Integrations", "Start free".

---

## Channel 2 — kickbacks.ai (experimental: on-audience awareness)

Sponsored status line shown in Claude Code / Codex while the agent is "thinking." Format is
~5 words, glanceable, low-intent. Treat as cheap brand awareness to *exactly* our audience
(devs using AI agents). Small budget test; measure with a dedicated tracked URL.

Sponsored-line variants (short, curiosity/utility):
1. `Nyx — keep specs synced with code →`
2. `Your docs lie. Nyx catches it →`
3. `Specs that match your codebase →`
4. `Turn docs into dev tickets — Nyx →`
5. `Living docs for your AI agents →`

Use a unique short link (e.g. nyx.link/kb) → the same landing page with `?utm_source=kickbacks`
so conversions are attributable. Start at/near the $1 / 1,000-impression floor; watch CTR before scaling.

---

## Measurement (non-negotiable)

Every channel points at the landing page with UTM params:
- Google: auto-tagging on (gclid) + `utm_source=google&utm_medium=cpc&utm_campaign=search_v1`
- kickbacks: `utm_source=kickbacks&utm_medium=statusline&utm_campaign=kb_v1`

Fire two conversion events (built in the tracking task):
1. **Signup** (account created)
2. **Upgrade** (checkout completed — the money event)

Judge channels on **cost per signup** and **cost per upgrade**, not clicks. Kill any ad group
with clicks but zero signups after ~1 week. Do not scale anything until one channel shows a
repeatable signup→upgrade path.

---

## Prerequisite (why this waits on #466)

A paid click that lands, signs up, and then hits a dead-end (no team → can't checkout) wastes
100% of spend. Ship the signup → default-team → checkout fix first, then turn ads on.
