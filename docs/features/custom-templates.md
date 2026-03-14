# Feature: Custom Document Templates

**Status:** Proposed
**Issue:** #96
**Author:** Alejandro Londono
**Date:** 2026-03-14

---

## Overview

SyncDocs currently ships with a fixed set of system-defined document templates organized by lifecycle stage (Conception, Definition, Architecture, Implementation, Execution). This feature adds the ability for teams to create, manage, and share their own custom templates — enabling domain-specific workflows like legal drafting, compliance documentation, and standardized contract structures.

---

## Problem

Legal professionals and other domain specialists work with highly standardized document formats that don't map directly to the generic software lifecycle stages SyncDocs currently provides. Asking a lawyer to fit a contract brief into a "Conception" template creates friction and reduces adoption. Without custom templates, every new document starts from scratch, requiring repeated manual formatting.

---

## Goals

1. Allow any team member to save a document (or a portion of it) as a reusable template.
2. Allow templates to be scoped to a team (private to the organization) or marked as personal (visible only to the creator).
3. Allow templates to be organized by category (e.g., "Contracts", "Compliance", "IP") in addition to the existing stage-based filter.
4. Allow team admins to publish templates team-wide and manage the team template library from Settings.
5. Surface custom templates alongside system templates in the TemplatePicker, clearly distinguished by a "Custom" badge.
6. Optionally, allow AI-assisted template generation: describe what you need and Claude drafts a starter template.

---

## Non-Goals

- Cross-organization template marketplace (post-MVP).
- Template versioning / diff (use the existing document version system for template evolution).
- Template locking / approval workflows (out of scope for now).

---

## User Stories

| Role | Story |
|------|-------|
| Legal professional | I want to save a contract brief I wrote as a template so I can reuse it for every new client engagement without reformatting. |
| Team admin | I want to manage which templates are available to my whole team and delete ones that are no longer used. |
| PM | I want to organize templates by practice area (e.g., "Contracts", "M&A", "IP") so they're easy to find. |
| Solo developer | I want to create a personal template for my preferred architecture doc format so I don't have to recreate it every project. |

---

## UX Flow

### Creating a Template

**Path 1 — Save current document as template:**
1. In the DocumentEditor toolbar, user clicks "Save as Template".
2. A modal opens pre-filled with the document's current title and content.
3. User sets: template name, description, category, stage (optional), visibility (personal / team).
4. User clicks "Save Template". Template is created and immediately available in TemplatePicker.

**Path 2 — Create from scratch in Settings:**
1. User navigates to Settings → Templates.
2. Clicks "New Template".
3. A full-screen editor opens (same MarkdownEditor component) with name, description, category, stage, and visibility fields.
4. User writes the template content and clicks "Save".

**Path 3 — AI-assisted template generation (stretch goal):**
1. In the "New Template" flow, user clicks "Generate with AI".
2. User describes the template in natural language (e.g., "NDA template for SaaS vendor agreements").
3. Claude generates a structured markdown draft, which the user can edit before saving.

### Using a Template

1. User opens TemplatePicker (via "New Document" button).
2. A new "Custom" tab appears alongside the stage filter pills when the team has custom templates.
3. Custom templates display a "Custom" badge and, if personal, a lock icon.
4. Selecting a custom template works identically to selecting a system template.

### Managing Templates

1. Settings → Templates page lists all team templates (admins) or personal + team templates (members).
2. Each row shows: name, category, stage, visibility, creator, last updated.
3. Actions: Edit (opens editor), Delete (with confirmation), Duplicate.
4. Admins can promote a personal template to team-wide visibility.

---

## Data Model Changes

### `document_templates` table additions

| Column | Type | Notes |
|--------|------|-------|
| `team_id` | `uuid` nullable | NULL = system template, set = team-custom |
| `created_by_id` | `uuid` nullable | NULL = system template, set = user who created it |
| `category` | `text` nullable | Free-form category label (e.g., "Contracts", "Compliance") |
| `is_personal` | `boolean` default false | If true, only visible to `created_by_id`; if false and `team_id` set, visible to whole team |
| `updated_at` | `timestamp` | Already tracked implicitly; add explicit column |

System-seeded templates remain unchanged (`team_id = NULL`, `created_by_id = NULL`).

---

## API Changes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/templates` | Required | Extended: accepts `teamId` query param to include team-custom and personal templates in results |
| `POST` | `/api/templates` | Required | Create a custom template |
| `PUT` | `/api/templates/:id` | Required | Update a custom template (creator or team admin only) |
| `DELETE` | `/api/templates/:id` | Required | Delete a custom template (creator or team admin only) |

### `GET /api/templates` (extended)

New optional query params:
- `teamId` — when provided, results include: system templates + team-scoped templates + caller's personal templates.
- `category` — filter by category label.
- `includeCustom=true` — opt-in flag (defaults to true when `teamId` is provided).

### `POST /api/templates`

```json
{
  "name": "NDA — SaaS Vendor",
  "description": "Standard non-disclosure agreement for SaaS vendor onboarding",
  "content": "## Non-Disclosure Agreement\n\n...",
  "stage": null,
  "category": "Contracts",
  "isPersonal": false,
  "teamId": "<uuid>"
}
```

Returns: the created `DocumentTemplate` record.

### `PUT /api/templates/:id`

Same shape as POST. Only the creator or a team admin may update.

### `DELETE /api/templates/:id`

No body. Only the creator or a team admin may delete. Returns `204 No Content`.

---

## Frontend Changes

### New / Modified Components

| Component | Change |
|-----------|--------|
| `TemplatePicker` | Add "Custom" filter tab; show custom templates with badge; show "Manage templates" link to Settings |
| `SaveAsTemplateModal` (new) | Modal for saving a document as a template — name, description, category, stage, visibility |
| `TemplateEditorModal` (new) | Full editor for creating/editing templates; reuses `MarkdownEditor` |
| `DocumentEditor` | Add "Save as Template" button to toolbar |
| `Settings` page | Add "Templates" tab listing team templates with edit/delete/duplicate actions |
| `api.ts` | Add `createTemplate`, `updateTemplate`, `deleteTemplate` functions |

### `TemplatePicker` Filter Logic

```
All | [Conception] [Definition] ... [Execution] | Custom
```

- "Custom" pill only appears if the team has at least one custom template.
- When "Custom" is selected, show team templates + caller's personal templates.
- System templates are hidden when "Custom" filter is active.

---

## Permissions

| Action | Owner | Admin | Developer | Editor | Viewer |
|--------|-------|-------|-----------|--------|--------|
| Create personal template | ✓ | ✓ | ✓ | ✓ | ✗ |
| Create team template | ✓ | ✓ | ✗ | ✗ | ✗ |
| Edit own template | ✓ | ✓ | ✓ | ✓ | ✗ |
| Edit any team template | ✓ | ✓ | ✗ | ✗ | ✗ |
| Delete own template | ✓ | ✓ | ✓ | ✓ | ✗ |
| Delete any team template | ✓ | ✓ | ✗ | ✗ | ✗ |
| Use (read) system templates | ✓ | ✓ | ✓ | ✓ | ✓ |
| Use (read) team templates | ✓ | ✓ | ✓ | ✓ | ✓ |

---

## Success Metrics

- At least one custom template created by ≥30% of active teams within 30 days of launch.
- Reduction in "Blank Document" selections in TemplatePicker vs. template selections (target: <50% blank after 60 days).
- No regressions in existing system template load/use flows.

---

## Out-of-Scope Deferral

- Public/marketplace template sharing across organizations.
- Template analytics (usage count per template).
- Template branching and approval flow (defer to doc branching roadmap).
