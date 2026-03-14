# Implementation Plan: Custom Document Templates

**Feature doc:** `docs/features/custom-templates.md`
**Issue:** #96
**Date:** 2026-03-14

---

## Overview

This plan breaks the custom templates feature into four sequential milestones. Each milestone is independently shippable and can be reviewed as its own PR.

---

## Milestone 1 — Database & API

**Goal:** Extend the data model and expose CRUD endpoints. No UI changes yet — the existing TemplatePicker continues to work unchanged.

### 1.1 — DB Migration

**File:** `drizzle/migrations/<timestamp>_custom_templates.sql`

Add four columns to `document_templates`:

```sql
ALTER TABLE document_templates
  ADD COLUMN team_id     uuid REFERENCES teams(id) ON DELETE CASCADE,
  ADD COLUMN created_by_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN category    text,
  ADD COLUMN is_personal boolean NOT NULL DEFAULT false,
  ADD COLUMN updated_at  timestamp with time zone NOT NULL DEFAULT now();
```

Update the unique index to scope uniqueness to teams:

```sql
-- Drop existing global unique index
DROP INDEX document_templates_stage_name_idx;

-- System templates: unique by (stage, name) where team_id IS NULL
CREATE UNIQUE INDEX document_templates_system_idx
  ON document_templates (stage, name)
  WHERE team_id IS NULL;

-- Team templates: unique by (team_id, name)
CREATE UNIQUE INDEX document_templates_team_idx
  ON document_templates (team_id, name)
  WHERE team_id IS NOT NULL;
```

**Schema update:** `apps/api/src/db/schema.ts`

```ts
export const documentTemplates = pgTable('document_templates', {
  id:          uuid('id').primaryKey().defaultRandom(),
  stage:       documentStageEnum('stage'),           // now nullable (custom templates may omit stage)
  name:        text('name').notNull(),
  description: text('description').notNull(),
  content:     text('content').notNull(),
  sortOrder:   integer('sort_order').notNull().default(0),
  teamId:      uuid('team_id').references(() => teams.id, { onDelete: 'cascade' }),
  createdById: uuid('created_by_id').references(() => users.id, { onDelete: 'set null' }),
  category:    text('category'),
  isPersonal:  boolean('is_personal').notNull().default(false),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

**Shared types update:** `packages/shared/src/types.ts`

Add `teamId`, `createdById`, `category`, `isPersonal`, `updatedAt` to `DocumentTemplate`.

---

### 1.2 — API Routes

**File:** `apps/api/src/routes/templates.ts`

#### `GET /api/templates` — extend to include custom templates

```ts
app.get('/', { preHandler: [optionalAuth] }, async (request) => {
  const { stage, teamId, category } = request.query as {
    stage?: string;
    teamId?: string;
    category?: string;
  };
  const callerId = request.user?.id ?? null;

  // Build WHERE: system templates always included;
  // team templates included if teamId matches;
  // personal templates included if createdById matches caller.
  const rows = await db.select().from(documentTemplates)
    .where(
      or(
        isNull(documentTemplates.teamId),                          // system
        eq(documentTemplates.teamId, teamId ?? ''),                // team
        and(
          eq(documentTemplates.createdById, callerId ?? ''),
          eq(documentTemplates.isPersonal, true),
        ),                                                         // personal
      )
    )
    .orderBy(documentTemplates.sortOrder, documentTemplates.name);

  // Apply optional filters
  let result = rows;
  if (stage) result = result.filter(t => t.stage === stage);
  if (category) result = result.filter(t => t.category === category);
  return result;
});
```

#### `POST /api/templates` — create custom template

```ts
app.post('/', { preHandler: [requireAuth] }, async (request, reply) => {
  const { name, description, content, stage, category, isPersonal, teamId } =
    request.body as CreateTemplateBody;

  // Validate: caller must be a member of teamId
  await assertTeamMembership(request.user.id, teamId, reply);

  // Enforce permission: only owner/admin can create team-wide templates
  if (!isPersonal) {
    await assertTeamRole(request.user.id, teamId, ['owner', 'admin'], reply);
  }

  const [template] = await db.insert(documentTemplates).values({
    name,
    description,
    content,
    stage: stage ?? null,
    category: category ?? null,
    isPersonal: isPersonal ?? false,
    teamId,
    createdById: request.user.id,
    sortOrder: 100, // custom templates sort after system ones
  }).returning();

  reply.code(201);
  return template;
});
```

#### `PUT /api/templates/:id` — update custom template

- Fetch template; 404 if not found.
- 403 if caller is not creator AND not owner/admin of the team.
- 403 if template is a system template (`teamId IS NULL`).
- Update name, description, content, stage, category, isPersonal.

#### `DELETE /api/templates/:id` — delete custom template

- Same auth checks as PUT.
- Hard delete (no soft-delete needed for templates).
- Return `204 No Content`.

---

### 1.3 — Tests

**File:** `apps/api/src/__tests__/routes/templates.test.ts`

Add test cases for:
- `POST /api/templates` — success (personal), success (team, admin caller), 403 (non-admin creating team template), 403 (not a team member).
- `PUT /api/templates/:id` — success (own template), 403 (other user's template), 403 (system template).
- `DELETE /api/templates/:id` — success, 403.
- `GET /api/templates?teamId=X` — returns system + team + caller's personal templates; excludes other users' personal templates.

---

## Milestone 2 — Frontend: "Save as Template" Flow

**Goal:** Let users save the current document as a custom template without leaving the editor.

### 2.1 — `api.ts` additions

```ts
export function createTemplate(data: {
  name: string;
  description: string;
  content: string;
  stage?: string | null;
  category?: string | null;
  isPersonal: boolean;
  teamId: string;
}): Promise<DocumentTemplate> {
  return request<DocumentTemplate>('/templates', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateTemplate(id: string, data: Partial<{
  name: string; description: string; content: string;
  stage: string | null; category: string | null; isPersonal: boolean;
}>): Promise<DocumentTemplate> {
  return request<DocumentTemplate>(`/templates/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteTemplate(id: string): Promise<void> {
  return request<void>(`/templates/${id}`, { method: 'DELETE' });
}
```

### 2.2 — `SaveAsTemplateModal` component

**File:** `apps/web/src/components/SaveAsTemplateModal.tsx`

Props:
```ts
interface SaveAsTemplateModalProps {
  open: boolean;
  onClose: () => void;
  defaultName: string;
  defaultContent: string;
  defaultStage: DocumentStage | null;
  teamId: string;
}
```

Fields in the modal:
- **Template name** (text input, pre-filled from document title)
- **Description** (text input)
- **Category** (text input with suggestions: "Contracts", "Compliance", "IP", "M&A", "General")
- **Stage** (same select as DocumentEditor, optional)
- **Visibility** (radio: "Personal — only visible to me" / "Team — visible to all team members")

On submit, calls `createTemplate()`, invalidates the `['templates']` React Query cache, shows a toast, and closes.

### 2.3 — `DocumentEditor` toolbar button

**File:** `apps/web/src/pages/DocumentEditor.tsx`

Add a "Save as Template" button next to "Save Version":
```tsx
<button onClick={() => setSaveAsTemplateOpen(true)}>
  Save as Template
</button>

<SaveAsTemplateModal
  open={saveAsTemplateOpen}
  onClose={() => setSaveAsTemplateOpen(false)}
  defaultName={title}
  defaultContent={content}
  defaultStage={docStage}
  teamId={doc.teamId}
/>
```

---

## Milestone 3 — Frontend: TemplatePicker Custom Tab

**Goal:** Surface custom templates in the existing TemplatePicker alongside system templates.

### Changes to `TemplatePicker`

**File:** `apps/web/src/components/TemplatePicker.tsx`

1. Accept a `teamId` prop so the query can request custom templates:
   ```ts
   interface TemplatePickerProps {
     teamId: string;   // new
     onClose: () => void;
     onCreate: (...) => void;
   }
   ```

2. Pass `teamId` to `fetchTemplates`:
   ```ts
   queryFn: () => fetchTemplates(undefined, teamId),
   ```
   Update `fetchTemplates` signature:
   ```ts
   export function fetchTemplates(stage?: DocumentStage, teamId?: string): Promise<DocumentTemplate[]> {
     const params = new URLSearchParams();
     if (stage) params.set('stage', stage);
     if (teamId) params.set('teamId', teamId);
     return request<DocumentTemplate[]>(`/templates?${params}`);
   }
   ```

3. Add a "Custom" filter pill after the stage pills. Only shown when `templates?.some(t => t.teamId)`.

4. When "Custom" is active, filter to `t.teamId !== null`. When any stage is active, filter to `t.stage === selectedStage && t.teamId === null` (system templates only).

5. In the template card, add a "Custom" badge (blue pill, similar to stage badges) for custom templates, and a lock icon for personal ones.

6. Add a "Manage templates →" link at the bottom that navigates to Settings → Templates.

---

## Milestone 4 — Settings: Template Management

**Goal:** Give team admins (and users for personal templates) a UI to manage the template library.

### Settings page — "Templates" tab

**File:** `apps/web/src/pages/Settings.tsx`

Add a "Templates" tab to the Settings nav. The tab renders a `TemplatesSettingsPanel` component.

**File:** `apps/web/src/components/TemplatesSettingsPanel.tsx`

- Fetches `GET /api/templates?teamId=X` (all templates the user can see).
- Renders a table with columns: Name, Category, Stage, Visibility, Created By, Last Updated, Actions.
- Actions per row:
  - **Edit** — opens `TemplateEditorModal`
  - **Duplicate** — calls `createTemplate` with same fields, name prefixed "Copy of …"
  - **Delete** — shows inline confirmation, then calls `deleteTemplate`
- "New Template" button in the header opens `TemplateEditorModal` with empty fields.
- Admins see all team templates; non-admins see only their own personal templates and team templates (read-only for team templates unless they're the creator).

### `TemplateEditorModal` component

**File:** `apps/web/src/components/TemplateEditorModal.tsx`

Full-height modal (similar to `RepoPickerModal` sizing) with:
- Left panel: metadata fields (name, description, category, stage, visibility)
- Right panel: `MarkdownEditor` for template content
- "Save" button calls `createTemplate` or `updateTemplate` depending on mode

---

## Implementation Order & Dependencies

```
Milestone 1 (DB + API)
  └─► Milestone 2 (Save as Template)
  └─► Milestone 3 (TemplatePicker Custom Tab)
        └─► Milestone 4 (Settings Management)
```

Milestones 2 and 3 can be built in parallel once Milestone 1 is done. Milestone 4 depends on Milestone 3 for the "Manage templates →" navigation link but can otherwise be built in parallel.

---

## Key Files to Create / Modify

| File | Action |
|------|--------|
| `drizzle/migrations/<ts>_custom_templates.sql` | Create |
| `apps/api/src/db/schema.ts` | Modify |
| `packages/shared/src/types.ts` | Modify |
| `apps/api/src/routes/templates.ts` | Modify |
| `apps/api/src/__tests__/routes/templates.test.ts` | Modify |
| `apps/web/src/lib/api.ts` | Modify |
| `apps/web/src/components/SaveAsTemplateModal.tsx` | Create |
| `apps/web/src/components/TemplateEditorModal.tsx` | Create |
| `apps/web/src/components/TemplatesSettingsPanel.tsx` | Create |
| `apps/web/src/components/TemplatePicker.tsx` | Modify |
| `apps/web/src/pages/DocumentEditor.tsx` | Modify |
| `apps/web/src/pages/Settings.tsx` | Modify |

---

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Migration changes the unique constraint — may break CI `drizzle-kit push --force` | Test migration locally; verify uniqueness logic handles system vs. team templates correctly before merging |
| `stage` becoming nullable on `documentTemplates` — existing code assumes it's always set | Audit all template consumers; add null-safety guards in `TemplatePicker` stage lookup |
| Personal template visibility leakage | Server-side filtering on every `GET /api/templates` call; never rely on client-side filtering alone |
| Legal users need more nuanced category taxonomy | Launch with free-text category; add predefined category enum in a follow-up if usage data shows need |
