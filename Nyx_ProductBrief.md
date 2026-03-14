# PRODUCT BRIEF

## Nyx

### The Product Versioning Platform

**Unified documentation, code, and team workflow — always in sync**

Prepared by: Alejandro Londono
Version: 1.0 | February 2026

---

## 1. Executive Summary

Nyx is a product versioning platform that unifies technical documentation, code, and team workflow into a single source of truth. In AI-assisted development, the document has become the starting point — developers write specs and AI tools generate code from them. Yet no tool keeps those specs in sync with the code as it evolves, or allows non-technical stakeholders to initiate changes that flow automatically through to the codebase.

Nyx solves both problems. It helps teams write better AI-ready technical specs, watches for drift between documentation and code, and provides a git-like version history across the entire product surface — docs, tickets, and code simultaneously.

## 2. The Problem

### 2.1 The Documentation-Code Gap

In traditional development, code came first and documentation was an afterthought. In AI-assisted development, the spec or PRD is the starting point — it drives the AI code generation. But as code evolves through AI assistance, the original spec becomes stale almost immediately. There is no feedback loop.

### 2.2 The Stakeholder Translation Tax

Every time a non-technical stakeholder wants a change, there is a costly translation chain: stakeholder tells a PM, PM writes a ticket, developer interprets it, code gets written, and documentation is never updated. This process is slow, lossy, and leaves no traceable history.

### 2.3 No Version Control for Intent

Git solved version control for code in the 1990s. Nothing has solved it cleanly for the broader product surface — the specs, requirements, and decisions that explain why the code is the way it is. When you need to roll back, you can revert code but you lose the context.

## 3. The Solution

Nyx provides a two-way bridge between intent (documentation) and implementation (code), with a collaboration layer that connects both technical and non-technical team members.

| Core Capability | What It Does |
| --- | --- |
| **AI-Ready Spec Editor** | Helps users write structured technical documents optimized for AI code generation. Provides templates, prompts, and real-time feedback on spec quality. Supports branch-based collaboration — multiple users can edit their own draft branches of a document simultaneously, then merge changes through the approval flow. |
| **Live Sync Engine** | Monitors the codebase via GitHub integration and surfaces drift between documentation and code. Flags when a spec no longer reflects the implementation. |
| **Non-Dev Change Flow** | Non-technical users can edit documentation. Nyx AI analyzes accumulated changes and suggests how to group them into tickets — splitting large changes or combining related small ones. A human reviews and adjusts the grouping before tickets are pushed to GitHub Issues, Jira, or other integrated platforms. Full traceability from edit to ticket to code change. |
| **Product Version Control** | Full git-like history across docs, tickets, and code. Includes diff view, unified timeline, named product snapshots, full rollback (including cross-platform actions in GitHub and Jira), doc branching with approval flows, and blame/attribution tracing changes from stakeholder edit through ticket to code. |
| **Coding Agent Integrations** | Dedicated integrations with Cursor, Copilot, and Claude Code so that specs and documentation flow directly into the developer's AI coding workflow — no copy-pasting or context-switching required. |
| **Agile / Kanban Board** | Aggregates and syncs ticket status from external project management tools — GitHub Projects, Jira boards, and others — into a unified view. Nyx does not replace these tools; it provides a single dashboard so teams can see the full picture across all integrated platforms. |
| **Onboarding & Portability** | Scans and imports an existing codebase to bootstrap documentation for teams already in flight. Full documentation export in standard formats (Markdown, PDF) ensures teams are never locked in. |

## 4. Target Users

### Primary: Small-to-mid engineering teams (5–50 developers)

Teams using AI-assisted development tools like Cursor, Copilot, or Claude Code who struggle to keep their specs and documentation aligned with rapidly evolving codebases. Node.js / React teams are the initial focus, matching the founder's expertise.

### Secondary: Product Managers and non-technical stakeholders

PMs, designers, and clients who need to communicate requirements without going through a ticket-writing intermediary. Nyx gives them a structured way to initiate changes that developers can trust.

### Tertiary: Freelancers and solo developers

Independent developers managing multiple client projects who need lightweight documentation and project management without the overhead of Jira + Confluence.

## 5. Competitive Landscape

| Competitor | Key Weakness vs. Nyx |
| --- | --- |
| **Mintlify** | One-time doc generation; no ongoing sync with code changes; no stakeholder workflow. |
| **Swimm** | Developer-only; no non-tech stakeholder flow; no full version history. |
| **Confluence + Jira** | No code sync; expensive; complex setup; not AI-native. Nyx integrates with these tools rather than replacing them — pushing tickets to Jira and linking docs in Confluence — turning a potential competitor into a complementary integration. |
| **GitBook** | Documentation platform only; no code integration or ticket workflow. |
| **Raw ChatGPT / Claude** | Free but no persistence, versioning, team collaboration, or code sync. |

Key differentiator: Nyx is the only tool that closes the full loop — from non-dev intent through documentation, ticketing, AI code generation, and version history — in a single platform.

## 6. MVP Scope

The MVP validates the core hypothesis: teams will pay for a tool that keeps documentation in sync with code and lets non-devs initiate changes. The smallest version that tests this is:

- Structured document editor with markdown support and AI-assisted spec writing
- GitHub integration that watches a connected repo and detects doc-code drift
- Ticket creation from document changes via GitHub Issues or Jira integration, with two-way status syncing back into Nyx
- Product version control with the following capabilities:
  - **Diff view:** Side-by-side comparison of any two document versions with highlighted changes
  - **Unified timeline:** Single chronological stream showing doc edits, ticket activity, and linked code commits
  - **Product snapshots:** Named points in time capturing the full state of docs, tickets, and code references (e.g., "v1.0 launch", "pre-refactor")
  - **Rollback:** Revert documents or the entire product state to a prior snapshot, with cross-platform actions — reopening Jira tickets, creating revert PRs in GitHub, and reverting linked external state
  - **Doc branching & approval:** Draft versions of documents that go through a review flow before merging into the live version — pull requests for documentation
  - **Blame & attribution:** Full audit trail tracing who changed what, when, and why — from stakeholder edit through ticket creation to code change
- Team access with role-based permissions (dev vs. non-dev)
- Initial coding agent integration with at least one major agent (e.g., Claude Code), with Cursor and Copilot integrations planned for fast follow-up
- Onboarding flow that scans an existing codebase to bootstrap initial documentation
- Documentation export in standard formats (Markdown, PDF) for portability

Out of scope for MVP: native IDE plugin, mobile app, enterprise SSO, advanced analytics.

Estimated build time for solo developer: 4–6 months to shippable MVP.

## 7. Proposed Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend** | React + TypeScript (Alejandro's core expertise) |
| **Backend** | Node.js + Express or Fastify |
| **Database** | PostgreSQL (document storage, version history) |
| **AI Layer** | Anthropic Claude API (spec quality analysis, drift detection, ticket generation). Supports BYOK (Bring Your Own Key) — teams can connect their own Anthropic API key to offset AI costs. |
| **Code Integration** | GitHub API + Webhooks |
| **Agent Integrations** | Cursor extension, GitHub Copilot extension, Claude Code MCP/CLI integration |
| **Project Management** | GitHub Issues API, Jira REST API, Confluence REST API (ticket creation, status sync, and page linking) |
| **Auth** | Auth0 or Clerk |
| **Hosting** | Vercel (frontend) + Railway or Render (backend) |

## 8. Business Model

| | |
| --- | --- |
| **Model** | SaaS — monthly subscription per team |
| **Free Tier** | 1 project, 1 user, limited history — for solo devs and evaluation. AI features included (Nyx-managed). |
| **Starter — $29/mo** | Up to 5 users, 5 projects, full version history. AI features included with usage cap. |
| **Team — $99/mo** | Up to 20 users, unlimited projects, non-dev seats, priority support. BYOK option available — teams can connect their own Anthropic API key for unlimited AI usage. |
| **Enterprise** | Custom pricing, SSO, SLA, dedicated support. BYOK included. |

### AI Cost Strategy — BYOK (Bring Your Own Key)

Nyx uses a hybrid approach to manage AI costs:

- **Default (Nyx-managed):** Free and Starter tiers include AI features out of the box with a usage cap. No setup friction — it just works. AI costs are baked into the subscription price.
- **BYOK option (Team & Enterprise):** Teams can connect their own Anthropic API key. Their AI usage (drift detection, spec analysis, ticket generation) bills directly to their Anthropic account. This eliminates Nyx' biggest variable cost at scale and gives larger teams cost control and compliance flexibility.

Revenue target: 100 paying teams at Starter tier = $2,900 MRR within 12 months of launch.

## 9. Go-To-Market Strategy

### Phase 1 — Validation (Month 1–2)

- Post in developer communities (Reddit r/webdev, Hacker News, X/Twitter) asking about doc-code sync pain
- Interview 10–15 developers and PMs to validate willingness to pay
- Build a landing page with waitlist and price anchor

### Phase 2 — Build & Beta (Month 2–5)

- Build MVP with 3–5 design partners who have committed to paying
- Iterate weekly based on direct feedback from design partners
- Launch on Product Hunt and developer newsletters

### Phase 3 — Growth (Month 6+)

- Content marketing: write about AI-assisted development workflows
- Developer community sponsorships and presence
- Referral program: one free month for each paying team referred

## 10. Key Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Developers don't feel doc-code drift is painful enough to pay for | Validate before building. Waitlist + price anchor test in month 1. |
| Large players (GitHub, Linear) add this feature natively | Focus on the non-dev stakeholder flow — unlikely for dev-first tools to prioritize this. |
| AI output quality is not good enough to trust | Human stays in the loop; AI surfaces issues, humans resolve them. |
| Solo build takes too long, market moves | Strict MVP scope. Ship something chargeable in 6 months, not a full product. |

## 11. Immediate Next Steps

- **Week 1:** Post validation question in 3 developer communities. Target 20 responses.
- **Week 2:** Conduct 5 interviews with developers who responded. Ask about pain and willingness to pay.
- **Week 3:** Build landing page with waitlist. Set a price. Aim for 50 signups.
- **Week 4:** Begin scaffolding the project in Claude Code using this brief as context.
- **Month 2:** Have a working prototype to show design partners.

---

alondono11@gmail.com | github.com/nojuannobody
