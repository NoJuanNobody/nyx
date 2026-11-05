# Nyx System Architecture

## Overview

Nyx is a product versioning platform that keeps technical specs in sync with code as it evolves.
The core model is: **Teams** own **Documents**. Documents live in **Lifecycles** (customizable stage sequences). When code drifts from a document, Nyx opens **Tickets** via GitHub Issues or Jira. Non-technical team members drive change through documents; those changes are pushed as tickets to developer tools.

---

## Entity-Relationship Diagram

```
teams ─────────────────────────────────────────────────────────────────────────┐
  │                                                                              │
  ├── team_members (role: owner|admin|developer|editor|viewer)                  │
  │     └── users                                                               │
  ├── team_invitations                                                           │
  ├── integrations (github|gitlab|bitbucket|jira|confluence)                   │
  ├── slack_connections                                                          │
  ├── atlassian_connections                                                      │
  ├── team_ai_keys (BYOK — encrypted per provider)                              │
  ├── team_credit_balances                                                       │
  ├── subscriptions → stripe_customers                                           │
  │                                                                              │
  ├── documents ─────────────────────────────────────────────────┐              │
  │     ├── document_versions                                     │              │
  │     ├── document_branches                                     │              │
  │     ├── meeting_documents                                     │              │
  │     ├── deliverables (pdf|markdown|report|jupyter)           │              │
  │     ├── social_posts                                          │              │
  │     ├── doc_chunks (pgvector embeddings)                      │              │
  │     └── tickets ──> change_proposals                         │              │
  │           └── ticket_suggestions                             │              │
  │                                                              │              │
  ├── document_templates ◄────────────────── document_cards ◄───┘              │
  ├── document_categories ◄──────────────────────────────────────               │
  │                                                                              │
  ├── lifecycles                                                                 │
  │     └── lifecycle_stages                                                     │
  │                                                                              │
  ├── agent_sessions                                                             │
  │     └── agent_tool_calls                                                     │
  │                                                                              │
  ├── intake_sessions                                                            │
  ├── snapshots                                                                  │
  ├── background_jobs                                                            │
  ├── approvals                                                                  │
  ├── audit_trail                                                                │
  ├── notifications → notification_preferences                                   │
  │     └── email_delivery_log                                                   │
  ├── user_pipeline_access                                                       │
  ├── feature_requests → feature_request_upvotes / feature_request_comments     │
  └── project_showcases                                                          │
                                                                                 │
users ───────────────────────────────────────────────────────────────────────────┘
  ├── api_keys
  ├── credit_balances
  ├── credit_transactions
  ├── ai_usage_log
  ├── onboarding_progress
  └── waitlist_signups

code_chunks (pgvector, per repo)
pkce_challenges (OAuth PKCE state, TTL-based)
```

---

## Entity Reference

### users

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK, default gen_random_uuid() |
| clerk_id | text | UNIQUE, nullable |
| email | text | NOT NULL, UNIQUE |
| name | text | NOT NULL |
| avatar_url | text | nullable |
| created_at | timestamptz | NOT NULL, default now() |
| updated_at | timestamptz | NOT NULL, default now() |

---

### teams

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| name | text | NOT NULL |
| slug | text | NOT NULL, UNIQUE |
| default_model | text | nullable — platform default when unset |
| fast_model | text | nullable |
| created_at | timestamptz | NOT NULL |
| updated_at | timestamptz | NOT NULL |

---

### documents

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| title | text | NOT NULL |
| content | text | NOT NULL, default '' |
| path | text | NOT NULL, default '/' |
| team_id | uuid | NOT NULL → teams.id |
| created_by_id | uuid | NOT NULL → users.id |
| stage | text | nullable (supports any lifecycle stage slug) |
| lifecycle_id | uuid | nullable → lifecycles.id |
| created_at | timestamptz | NOT NULL |
| updated_at | timestamptz | NOT NULL |
| deleted_at | timestamptz | nullable — NULL = live, non-NULL = soft-deleted |

---

### document_templates

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| stage | text | NOT NULL |
| name | text | NOT NULL |
| description | text | NOT NULL |
| content | text | NOT NULL |
| sort_order | integer | NOT NULL, default 0 |
| team_id | uuid | nullable → teams.id |
| created_by_id | uuid | nullable → users.id |
| lifecycle_id | uuid | nullable → lifecycles.id |
| created_at | timestamptz | NOT NULL |

**Indexes:** UNIQUE(stage, name, team_id)

---

### document_categories

Lightweight team-scoped groupings for documents and cards.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| team_id | uuid | NOT NULL → teams.id ON DELETE CASCADE |
| name | text | NOT NULL — display name |
| slug | text | NOT NULL — URL-safe identifier |
| description | text | NOT NULL, default '' |
| color | text | NOT NULL, default '#6366f1' — hex colour for UI |
| created_by | uuid | NOT NULL → users.id |
| created_at | timestamptz | NOT NULL |
| updated_at | timestamptz | NOT NULL |

**Indexes:** UNIQUE(team_id, slug)

---

### document_cards

Shareable published views of a spec. Non-technical stakeholders can browse
published cards (with artwork and description) without full app access. Maps
to the Card entity definition in the original System Architecture Document
spec (issue #396).

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| title | text | NOT NULL |
| description | text | NOT NULL, default '' |
| category_id | uuid | nullable → document_categories.id ON DELETE SET NULL |
| template_id | uuid | nullable → document_templates.id ON DELETE SET NULL |
| artwork_urls | text[] | NOT NULL, default [] — ordered cover images |
| is_published | boolean | NOT NULL, default false |
| metadata | jsonb | NOT NULL, default {} — arbitrary key/value store |
| created_by | uuid | NOT NULL → users.id |
| team_id | uuid | NOT NULL → teams.id ON DELETE CASCADE |
| created_at | timestamptz | NOT NULL |
| updated_at | timestamptz | NOT NULL |

**Indexes:**
- `document_cards_category_id_idx` on (category_id) — filter by category
- `document_cards_is_published_idx` on (is_published) — public card listing
- `document_cards_team_created_by_idx` on (team_id, created_by) — my cards within a team

**FK relationships:**
- `category_id` → `document_categories.id` (SET NULL on delete — card survives category deletion)
- `template_id` → `document_templates.id` (SET NULL on delete — card survives template deletion)
- `created_by` → `users.id`
- `team_id` → `teams.id` (CASCADE on delete — cards are destroyed when the team is deleted)

---

### document_versions

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| document_id | uuid | NOT NULL → documents.id |
| version | integer | NOT NULL |
| content | text | NOT NULL |
| message | text | nullable |
| created_by_id | uuid | NOT NULL → users.id |
| created_at | timestamptz | NOT NULL |

---

### document_branches

Branch-based collaboration: users draft on their own branch and merge via the
approval flow.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| document_id | uuid | NOT NULL → documents.id |
| name | text | NOT NULL |
| base_version_id | uuid | NOT NULL → document_versions.id |
| content | text | NOT NULL |
| created_by_id | uuid | NOT NULL → users.id |
| status | text | NOT NULL, default 'draft' |
| reviewed_by_id | uuid | nullable → users.id |
| created_at | timestamptz | NOT NULL |
| merged_at | timestamptz | nullable |

---

### lifecycles + lifecycle_stages

Custom stage sequences (e.g. "SaaS Product: Concept → Design → Build →
Launch"). Every document references a lifecycle stage by slug.

**lifecycles**

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| slug | text | NOT NULL, UNIQUE |
| label | text | NOT NULL |
| description | text | NOT NULL |
| icon | text | NOT NULL |
| is_default | boolean | NOT NULL, default false |
| sort_order | integer | NOT NULL, default 0 |
| created_at | timestamptz | NOT NULL |

**lifecycle_stages**

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| lifecycle_id | uuid | NOT NULL → lifecycles.id ON DELETE CASCADE |
| slug | text | NOT NULL |
| sort_order | integer | NOT NULL |
| label | text | NOT NULL |
| abbreviation | text | NOT NULL |
| subtitle | text | NOT NULL |
| color / text_color / dot_color / border_color | text | NOT NULL |
| hex | text | NOT NULL, default '#888888' |
| who / description / icon / ai / output | text | NOT NULL |
| docs | text[] | NOT NULL |

**Indexes:** UNIQUE(lifecycle_id, slug)

---

### tickets + ticket_suggestions

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| team_id | uuid | NOT NULL → teams.id |
| document_id | uuid | nullable → documents.id |
| provider | enum | github\|jira\|gitlab\|bitbucket |
| external_id | text | nullable — provider issue ID |
| title | text | NOT NULL |
| body | text | NOT NULL |
| status | enum | open\|in_progress\|closed |
| created_by_id | uuid | NOT NULL → users.id |
| created_at / updated_at | timestamptz | NOT NULL |

---

### change_proposals

AI-generated or human-authored proposals to push document changes as tickets.

| Column | Type | Constraints |
|--------|------|-------------|
| id | uuid | PK |
| document_id | uuid | NOT NULL → documents.id ON DELETE CASCADE |
| team_id | uuid | NOT NULL → teams.id |
| title / description | text | NOT NULL |
| proposed_content | text | NOT NULL |
| status | enum | pending\|approved\|rejected\|pushed |
| created_by_id | uuid | NOT NULL → users.id |
| reviewed_by_id | uuid | nullable → users.id |
| ticket_id | uuid | nullable → tickets.id |
| created_at / reviewed_at / pushed_at | timestamptz | |

---

### subscriptions + stripe_customers

| Column | Type | Constraints |
|--------|------|-------------|
| team_id | uuid | NOT NULL → teams.id (subscriptions) |
| plan | enum | free\|starter\|pro\|team\|enterprise |
| status | enum | active\|past_due\|canceled\|trialing\|incomplete |
| stripe_customer_id | text | nullable |
| stripe_subscription_id | text | nullable |
| stripe_price_id | text | nullable |
| current_period_start/end | timestamptz | nullable |
| cancel_at_period_end | boolean | NOT NULL, default false |

---

### credit_balances + credit_transactions + team_credit_balances

Per-user and per-team credit ledgers. Credits are consumed by AI operations
and purchased via Stripe.

---

### doc_chunks + code_chunks (pgvector)

Embedding tables for semantic search. Both use HNSW index with cosine
similarity (1536-dimension vectors).

- **doc_chunks** — Nyx document content, linked to `documents`
- **code_chunks** — source code from connected repos, linked to `teams`

---

## Indexing Strategy Summary

| Table | Index | Purpose |
|-------|-------|---------|
| users | UNIQUE(email), UNIQUE(clerk_id) | auth lookups |
| teams | UNIQUE(slug) | URL routing |
| team_members | implied PK | |
| documents | (team_id) via FK | team document list |
| document_templates | UNIQUE(stage, name, team_id) | template deduplication |
| document_categories | UNIQUE(team_id, slug) | slug resolution within team |
| document_cards | (category_id), (is_published), (team_id, created_by) | browsing & filtering |
| doc_chunks | HNSW vector index, (doc_id, version) | semantic search |
| code_chunks | HNSW vector index, (team_id, repo_full_name) | codebase search |
| onboarding_progress | UNIQUE(user_id, step_key) | idempotent step tracking |
| user_pipeline_access | UNIQUE(user_id, pipeline_id) | access deduplication |
| team_ai_keys | UNIQUE(team_id, provider) | one key per provider per team |
| feature_request_upvotes | UNIQUE(feature_request_id, user_id) | one vote per user |

---

## Migration History

| # | Tag | Description |
|---|-----|-------------|
| 0000 | wise_mother_askani | initial schema |
| 0001–0005 | | incremental early tables |
| 0006 | agent_sessions | agent sessions + tool calls |
| 0007 | curvy_cobalt_man | |
| 0008 | document_lifecycle | lifecycle/stage model |
| 0009 | custom_templates | per-team templates |
| 0010 | intake_sessions | guided intake |
| 0011 | slack_connections | Slack integration |
| 0012 | claude_insights | |
| 0013 | multi_lifecycle | multiple lifecycle support |
| 0014 | conversation_id | |
| 0015 | drop_marketplace | removed marketplace tables |
| 0016 | drop_document_status | replaced status enum with soft-delete |
| 0017 | team_model_preferences | per-team LLM defaults |
| 0018 | drop_generated_videos | removed video generation |
| 0019 | drop_podcast_scripts | removed podcast scripts |
| 0020 | extend_ticket_provider | gitlab/bitbucket ticket providers |
| 0021 | team_credit_balances | team-level credit ledger |
| 0022 | stripe_session_id | stripe session tracking |
| 0023 | add_starter_plan | starter subscription tier |
| 0024 | onboarding_progress | per-user onboarding step tracking |
| 0025 | document_cards_categories | Card + Category entities (issue #396) |
