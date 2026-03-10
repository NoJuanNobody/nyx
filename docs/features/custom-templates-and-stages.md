# Custom Templates & Custom Stages (#48)

**TODO item:** #48
**Status:** TODO
**Priority:** P4 — Post-MVP

---

## Overview

Allow teams to create their own document templates (assigned to any stage) and define custom lifecycle stages beyond the default five. This gives teams full control over their documentation workflow while preserving the opinionated default model for new users.

## Custom Templates

### What teams can do

- Create, edit, and delete templates scoped to their team
- Assign each template to a lifecycle stage (system or custom)
- Set template name, description, and starter content (markdown)
- Reorder templates within a stage via drag-and-drop or sort order

### Where it lives

- **Settings > Templates** tab — CRUD interface for team templates
- Templates appear alongside system templates in the FileTree context menu and TemplatePicker modal
- Team templates are visually distinguished (e.g., team icon or "Custom" badge) so users know which are system-provided vs. team-created

### Data model

| Field | Type | Notes |
|-------|------|-------|
| `id` | uuid | Primary key |
| `teamId` | uuid | Owning team (null = system template) |
| `stage` | text | Stage ID this template belongs to |
| `name` | text | Display name |
| `description` | text | Short description shown in menus/pickers |
| `content` | text | Markdown starter content |
| `sortOrder` | int | Ordering within stage |
| `createdById` | uuid | User who created it |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

The existing `document_templates` table already has most of these fields. Adding `teamId` (nullable) and `createdById` columns extends it for team-scoped templates. System templates have `teamId = null`.

### API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/templates?teamId=X` | Returns system templates + team templates merged |
| `POST` | `/api/templates` | Create a team template (requires `teamId`) |
| `PUT` | `/api/templates/:id` | Update a team template (owner team only) |
| `DELETE` | `/api/templates/:id` | Delete a team template (owner team only) |

System templates are read-only — teams cannot edit or delete them.

### Permissions

- **Admin / Owner** can create, edit, and delete team templates
- **Editor+** can use templates to create documents
- **Viewer** can see templates but not create from them

## Custom Stages

### What teams can do

- Add custom stages to the lifecycle (e.g., "QA Review", "Compliance", "Localization")
- Customize stage metadata: label, abbreviation (2 chars), subtitle, color, description, role hints
- Reorder stages via drag-and-drop to define their team's workflow
- Disable (hide) default stages they don't use — but not delete them, so the system model remains recoverable
- Assign custom stages to documents and templates just like system stages

### Where it lives

- **Settings > Stages** tab — list of active stages with inline editing, add/reorder/disable controls
- Custom stages appear in all stage-aware UI: FileTree context menu, stage filter dropdown, TemplatePicker tabs, document stage badges, AI quality panel

### Data model

| Field | Type | Notes |
|-------|------|-------|
| `id` | text | Slug identifier (e.g., `qa-review`) |
| `teamId` | uuid | Owning team (null = system stage) |
| `label` | text | Display name |
| `abbreviation` | text | 2-char code |
| `subtitle` | text | One-liner |
| `color` | text | Tailwind bg class |
| `textColor` | text | Tailwind text class |
| `dotColor` | text | Tailwind dot bg class |
| `hex` | text | Hex color for custom styling |
| `who` | text | Role hint |
| `description` | text | Purpose description |
| `sortOrder` | int | Position in the lifecycle |
| `enabled` | boolean | Whether stage is active for this team |
| `createdAt` | timestamp | |

New `team_stages` table. System stages are defined in code (`stages.ts`) and merged with team custom stages at runtime. The effective stage list for a team = system stages (filtered by enabled) + custom stages, ordered by `sortOrder`.

### API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/teams/:id/stages` | Returns merged system + custom stages for the team |
| `POST` | `/api/teams/:id/stages` | Create a custom stage |
| `PUT` | `/api/teams/:id/stages/:stageId` | Update a custom stage or toggle enabled on a system stage |
| `DELETE` | `/api/teams/:id/stages/:stageId` | Delete a custom stage (cannot delete system stages) |
| `PATCH` | `/api/teams/:id/stages/reorder` | Bulk update sort orders |

### Frontend changes

- `stages.ts` — export a hook `useTeamStages(teamId)` that fetches the merged stage list via React Query, replacing the static `STAGES` array in stage-aware components
- All components that reference `STAGES` or `STAGE_MAP` must switch to the hook-provided list
- Stage filter dropdown, context menu, TemplatePicker tabs, document badges — all dynamically rendered from the team's stage list

## Open questions

- **Stage-specific AI prompts** — when teams add custom stages, should they also be able to configure the AI suggestions and quality analysis criteria for that stage? Or should AI behavior only apply to the 5 system stages?
- **Stage migration** — if a team disables a system stage, what happens to documents already assigned to it? Options: keep the stage assignment (shown as greyed-out badge), auto-clear it, or prompt user to reassign.
- **Cross-team templates** — should there be a "template gallery" where teams can publish templates for other teams to discover? Or keep templates strictly team-private?

---

## E2E Tests

### Custom Templates

**Test file:** `tests/e2e/custom-templates.spec.ts`

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Admin creates a team template | Log in as admin → Settings > Templates → fill name, description, stage, content → Save | Template appears in list with team badge; `POST /api/templates` returns 201 |
| 2 | Team template appears in context menu | Create a template for "Definition" stage → go to FileTree → right-click folder → hover "Definition" | New template appears in submenu alongside system templates, visually distinguished with "Custom" badge |
| 3 | Team template appears in TemplatePicker | Create a template → open TemplatePicker modal → filter by stage | Template appears in grid with team icon |
| 4 | Create document from team template | Right-click folder → stage submenu → click team template | Document created with template's name, content, and stage pre-filled |
| 5 | Edit team template | Settings > Templates → click existing template → change name and content → Save | Template updates; `PUT /api/templates/:id` returns 200; changes reflected in context menu |
| 6 | Delete team template | Settings > Templates → click delete on template → confirm | Template removed from list and no longer appears in context menu or TemplatePicker |
| 7 | Cannot edit system templates | Settings > Templates → locate a system template | No edit or delete controls visible; system templates are read-only |
| 8 | Cannot delete system templates | Attempt `DELETE /api/templates/:systemId` via API | Returns 403 Forbidden |
| 9 | Reorder templates within stage | Settings > Templates → drag template A below template B within same stage → Save | Sort order persists; context menu submenu reflects new order |
| 10 | Editor role can use but not create templates | Log in as editor → FileTree context menu shows templates; Settings > Templates shows no create button | Templates usable for doc creation; no CRUD controls |
| 11 | Viewer cannot create documents from templates | Log in as viewer → right-click folder → hover stage → click template | Action blocked or button disabled; toast shows permission error |
| 12 | Templates scoped to team | Create template as Team A admin → log in as Team B member | Template not visible in Team B's context menu, TemplatePicker, or Settings |
| 13 | GET /api/templates?teamId returns merged list | Call API with teamId parameter | Response includes both system templates (teamId=null) and team templates, properly merged |

### Custom Stages

**Test file:** `tests/e2e/custom-stages.spec.ts`

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 14 | Admin creates a custom stage | Settings > Stages → click "Add stage" → fill label ("QA Review"), abbreviation ("QA"), subtitle, color → Save | Stage appears in list; `POST /api/teams/:id/stages` returns 201 |
| 15 | Custom stage appears in FileTree context menu | Create custom stage → right-click folder in FileTree | New stage appears in context menu alongside the 5 system stages in correct sort order |
| 16 | Custom stage appears in stage filter dropdown | Create custom stage → open stage filter dropdown in FileTree header | Custom stage listed with correct color dot and label |
| 17 | Custom stage appears in TemplatePicker tabs | Create custom stage → open TemplatePicker modal | New tab for custom stage appears |
| 18 | Assign custom stage to document | Create custom stage → right-click document → Set stage → select custom stage | Document shows custom stage badge with correct color |
| 19 | Assign template to custom stage | Create custom stage → create template assigned to it → right-click folder → hover custom stage | Template appears in custom stage's submenu |
| 20 | Edit custom stage metadata | Settings > Stages → click custom stage → change label to "QA Testing" and color → Save | Label and color update everywhere: context menu, filter dropdown, document badges |
| 21 | Delete custom stage | Settings > Stages → delete custom stage → confirm | Stage removed from all UI; documents assigned to it lose their stage (or show greyed badge per decision) |
| 22 | Cannot delete system stages | Settings > Stages → locate "Conception" system stage | No delete button; only disable toggle |
| 23 | Disable system stage | Settings > Stages → toggle off "Execution" | "Execution" hidden from context menu, filter dropdown, and TemplatePicker; existing "Execution" documents retain their badge (greyed) |
| 24 | Re-enable disabled system stage | Settings > Stages → toggle "Execution" back on | Stage reappears in all stage-aware UI in correct sort position |
| 25 | Reorder stages | Settings > Stages → drag "Architecture" above "Definition" → Save | New order reflected in context menu, filter dropdown, and TemplatePicker tabs |
| 26 | Stage order persists after refresh | Reorder stages → refresh page → right-click folder | Custom order maintained |
| 27 | Merged stage list via API | `GET /api/teams/:id/stages` | Returns system stages (filtered by enabled) + custom stages, ordered by sortOrder |
| 28 | Custom stages scoped to team | Create custom stage as Team A → log in as Team B | Custom stage not visible in Team B's UI |
| 29 | Bulk reorder via API | `PATCH /api/teams/:id/stages/reorder` with new sort orders | All stages reflect new order; subsequent GET returns updated list |
