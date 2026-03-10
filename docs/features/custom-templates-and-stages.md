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
