# Fix: Document Stage Persistence

**Issue:** #245
**Status:** Draft
**Author:** @NoJuanNobody

---

## Overview

Documents in Nyx have a `stage` field that tracks where the document sits in its lifecycle pipeline (e.g., `conception → definition → architecture → implementation → execution`). Some documents that previously had a stage assigned to them have lost their stage value — the field appears empty or unset, and there is no visible indication to the user that this happened.

This document identifies the root causes, describes the full data flow for stage changes, and provides a detailed implementation plan to fix each problem and restore affected records.

---

## 1. Background & Data Flow

### 1.1 Where Stage Lives

```
documents table (PostgreSQL)
  └── stage text   ← nullable; stores any lifecycle stage slug as free-form text
                     (formerly a pg enum; converted to text in a prior migration)
```

The `stage` column is a **nullable `text` field** (`schema.ts:135`). It accepts any string value, or `null` to mean "no stage assigned." The old `documentStageEnum` type (`'conception' | 'definition' | 'architecture' | 'implementation' | 'execution'`) still defines the *default* stage order used by the gatekeeper service but is no longer enforced at the database level.

### 1.2 Stage Change Flow — Frontend → API → Database

```
User selects a new stage in DocumentEditor or FileTree
  │
  ├─ DocumentEditor (DocumentEditor.tsx:159)
  │     handleStageChange(newStage) → saveMutation.mutate({ stage: newStage })
  │
  └─ FileTree (FileTree.tsx:761)
        updateStageMutation.mutate({ id, stage })   ← also handles "Remove stage" → null

         │
         ▼
  updateDocument(id, { stage }) → PUT /api/documents/:id
         │
         ▼
  API: routes/documents.ts:215
    if (body.stage !== undefined) {
      gatekeeperService.evaluateGate(current, body.stage as string)
      → 422 if failed
    }
    if (body.stage !== undefined) updates.stage = body.stage
    → DB UPDATE documents SET stage = $1 WHERE id = $2
```

### 1.3 Paths That Do NOT Touch Stage

The following operations are **safe** — they never include `stage` in their update payload, so the `if (body.stage !== undefined)` guard in the API preserves the existing stage value:

| Operation | Code Location | Stage Included? |
|---|---|---|
| Auto-save on title/content change | `DocumentEditor.tsx:110-120` | No — only `title` + `content` |
| Version restore | `DocumentEditor.tsx:459-462` | No — only `content` |
| AI-generated content apply | `DocumentEditor.tsx:132-138` | No — only `title` + `content` |
| AI Edit Review approve | `DocumentEditor.tsx:144-148` | No — only `title` + `content` |

---

## 2. Root Cause Analysis

Three distinct bugs have been identified, ordered from highest to lowest likelihood of causing the reported data loss:

### 2.1 (Primary) Schema Migration: Enum → Text Column Conversion

**Likelihood: High**

The `stage` column schema comment reads:
```typescript
stage: text('stage'),  // nullable text — was enum, now supports any lifecycle stage
```

At some point the column was converted from a PostgreSQL enum type (`documentStageEnum`) to a plain `text` type. If this migration was implemented using a destructive pattern — **drop the column and re-add it as `text`** — all existing stage values in the database would have been wiped out silently.

A safe migration would have been:
```sql
ALTER TABLE documents
  ALTER COLUMN stage TYPE text USING stage::text;
DROP TYPE document_stage_enum CASCADE;
```

A destructive migration (which loses data) would have been:
```sql
ALTER TABLE documents DROP COLUMN stage;
ALTER TABLE documents ADD COLUMN stage text;
```

Because Drizzle ORM uses `drizzle-kit push --force` in CI (noted in `CLAUDE.md`), rather than versioned migration files, there is elevated risk of data-destructive schema changes being applied without an explicit migration script that preserves existing data.

**Impact**: All documents that had a stage assigned before the migration ran now have `stage = NULL`.

---

### 2.2 (Secondary) Gatekeeper Incorrectly Blocks Stage Removal

**Likelihood: High — confirmed code bug**

**File:** `apps/api/src/routes/documents.ts:215-238`
**File:** `apps/api/src/services/gatekeeper.service.ts:38-106`

When a user removes a document's stage (sets it to `null`), the frontend sends:
```json
{ "stage": null }
```

The API route checks `if (body.stage !== undefined)` — since `null !== undefined` is `true`, the gatekeeper runs with `targetStage = null`.

In the gatekeeper:
```typescript
const targetIndex = stageOrder.indexOf(null);  // → -1 (null is not in the array)
if (targetIndex === -1) {
  validTransition = false;
  transitionReason = `Target stage "${null}" is not a recognized stage`;
}
```

The gatekeeper returns `passed: false`, and the API returns `422 Unprocessable Entity`:
```json
{
  "error": "Stage transition blocked by gatekeeper",
  "checks": [{ "name": "valid_stage_transition", "passed": false, "reason": "Target stage \"null\" is not a recognized stage" }]
}
```

The frontend handles this error in `saveMutation.onError`, which sets `saveState('unsaved')` but **shows no error message to the user**. The stage dropdown in `DocumentEditor` is controlled by `doc?.stage ?? null` from the React Query cache. Since the mutation failed and the cache was not updated, the dropdown correctly reverts to the previous stage value — but only if the query re-renders.

If the component re-renders before the React Query cache is re-synced, the UI may briefly flash "No stage" and then snap back, creating a confusing UX. More critically, this bug makes the **"Remove stage"** context menu in `FileTree` completely non-functional — it always 422s, and the user sees no error.

---

### 2.3 (Tertiary) Silent 422 Errors Not Surfaced to the User

**Likelihood: Medium**

Any failed stage mutation (including the gatekeeper failures above, or failed network requests) is silently swallowed. The `saveMutation.onError` handler in `DocumentEditor.tsx:97` sets `saveState('unsaved')` but never shows the user what went wrong.

This means:
- Users who attempt to change stage and hit a 422 see "Unsaved changes" in the toolbar but no explanation.
- Users may attempt the same action repeatedly, further confusing the state.
- Developers have no visibility into how frequently stage mutations are failing.

---

### 2.4 (Possible) Repo Scan Feature Overwrites Stage

**Likelihood: Low-Medium — requires investigation**

The `ScanRepositoryModal` component exists and there is a recent commit (#233) adding UI to scan repos and generate docs. If the document creation path invoked by this feature uses a bulk-insert or upsert that doesn't preserve the `stage` field on existing documents, it could overwrite existing stage values with `null` for any document whose path matches a scanned file.

This path needs verification by reading the scan-related API endpoint.

---

## 3. Existing Architecture Assessment

### What Is Working Correctly

- **API guard (`if (body.stage !== undefined)`)**: The PUT endpoint correctly distinguishes between "stage not in payload" (preserve existing) and "stage explicitly set to null" (clear it). Auto-saves that only include `title`/`content` never corrupt the stage.
- **Gatekeeper sequential enforcement**: The gatekeeper correctly prevents users from skipping stages or moving backward, which is the intended business logic.
- **Frontend stage selector**: The `<select>` in `DocumentEditor` is correctly controlled via `docStage ?? ''` and dispatches the right value on change.
- **`lifecycleId` FK**: Documents can reference a specific lifecycle, allowing custom stage pipelines beyond the default five-stage order.

### What Is Broken

1. **Gatekeeper does not handle `null` as a valid target** (stage removal path).
2. **No user-visible error message on failed stage mutations**.
3. **Possible data loss in production from enum→text migration**.
4. **Repo scan feature may not preserve existing stage values** (to be confirmed).

---

## 4. Acceptance Criteria

| # | Criterion |
|---|---|
| AC-1 | Setting a document's stage to `null` via the stage dropdown or FileTree context menu succeeds (the API accepts `null` as a valid stage target and skips the gatekeeper for null). |
| AC-2 | Stage transitions between valid stages continue to be enforced by the gatekeeper. |
| AC-3 | A failed stage mutation (422 or network error) shows a user-visible error message identifying the reason. |
| AC-4 | Auto-saves (title/content changes) never affect the `stage` field. |
| AC-5 | Existing documents that lost their stage are recoverable via a data recovery script (where version history is available) or via a manual admin restore endpoint. |
| AC-6 | New E2E and unit tests cover the stage removal path and the gatekeeper 422 error-surfacing path. |
| AC-7 | The repo scan feature is verified to not overwrite existing stage values. |

---

## 5. Implementation Plan

### Phase 1 — Fix the Gatekeeper: Stage Removal

**Files:**
- `apps/api/src/routes/documents.ts`
- `apps/api/src/services/gatekeeper.service.ts`
- `apps/api/src/services/__tests__/gatekeeper.service.test.ts` (new)

**Change 1A — API route: skip gatekeeper when removing stage (setting to null)**

In `apps/api/src/routes/documents.ts`, the gatekeeper should only run when the target stage is a **non-null string**. Setting stage to `null` is an intentional removal action, not a lifecycle progression, and should bypass gatekeeper checks.

Current code (`routes/documents.ts:215-238`):
```typescript
if (body.stage !== undefined) {
  const [current] = await db.select().from(documents).where(eq(documents.id, id));
  if (!current) { ... }
  const effectiveContent = body.content !== undefined ? body.content : current.content;
  const gateResult = gatekeeperService.evaluateGate(
    { content: effectiveContent, stage: current.stage },
    body.stage as string,
  );
  if (!gateResult.passed) {
    reply.code(422);
    return { error: 'Stage transition blocked by gatekeeper', checks: ... };
  }
}
```

Proposed change:
```typescript
if (body.stage !== undefined && body.stage !== null) {
  // Only enforce gatekeeper when assigning a new stage (not when removing it)
  const [current] = await db.select().from(documents).where(eq(documents.id, id));
  if (!current) { ... }
  const effectiveContent = body.content !== undefined ? body.content : current.content;
  const gateResult = gatekeeperService.evaluateGate(
    { content: effectiveContent, stage: current.stage },
    body.stage,
  );
  if (!gateResult.passed) {
    reply.code(422);
    return { error: 'Stage transition blocked by gatekeeper', checks: ... };
  }
} else if (body.stage !== undefined && body.stage === null) {
  // Removing stage: no gatekeeper needed, but we still need the document to exist
  const [current] = await db.select().from(documents).where(eq(documents.id, id));
  if (!current) {
    reply.code(404);
    return { error: 'Document not found' };
  }
}
```

Note: the `if (body.stage !== undefined) updates.stage = body.stage` line (line 247) already handles `null` correctly — it will set `stage = NULL` in the database.

**Change 1B — Gatekeeper: Fix the type signature to reflect that null is not a valid target**

In `apps/api/src/services/gatekeeper.service.ts`, update the `evaluateGate` signature to make clear that `targetStage` must be a non-null string (the caller is now responsible for not passing null):

```typescript
// Before:
evaluateGate(
  document: { content: string; stage: string | null },
  targetStage: string,
  stageOrder: string[] = DEFAULT_STAGE_ORDER,
): GateResult

// After: targetStage is explicitly required to be non-null
evaluateGate(
  document: { content: string; stage: string | null },
  targetStage: string,   // Must be a valid stage slug; callers must not pass null
  stageOrder: string[] = DEFAULT_STAGE_ORDER,
): GateResult
```

No logic change is needed in the gatekeeper body — the type-level fix and the call-site guard in the route handler are sufficient.

---

### Phase 2 — Surface Stage Mutation Errors to the User

**Files:**
- `apps/web/src/pages/DocumentEditor.tsx`
- `apps/web/src/components/FileTree.tsx`

**Change 2A — DocumentEditor: show error toast/message on stage mutation failure**

In `DocumentEditor.tsx`, the `saveMutation` `onError` handler currently only sets `saveState('unsaved')`. Add a stage-change-specific error path.

Because `saveMutation` is shared between content saves and stage changes, the cleanest fix is to create a **dedicated `stageMutation`** for stage changes that has its own error handling:

```typescript
// New dedicated mutation for stage changes
const stageMutation = useMutation({
  mutationFn: (newStage: DocumentStage | null) =>
    updateDocument(id!, { stage: newStage }),
  onMutate: () => setSaveState('saving'),
  onSuccess: (updated) => {
    setSaveState('saved');
    queryClient.setQueryData(['document', id], updated);
    queryClient.setQueriesData<Document[]>(
      { queryKey: ['documents'] },
      (old) => old?.map((d) => (d.id === updated.id ? updated : d)),
    );
  },
  onError: (err: unknown) => {
    setSaveState('saved'); // revert — stage was not changed
    // Extract the gatekeeper reason if available
    const message = extractApiError(err) ?? 'Failed to update stage. Please try again.';
    setStageError(message);  // new local state: string | null
  },
});

const handleStageChange = (newStage: DocumentStage | null) => {
  setStageError(null);
  stageMutation.mutate(newStage);
};
```

Add a small error banner below the stage dropdown:
```tsx
{stageError && (
  <div className="mt-1 rounded-md bg-red-50 border border-red-200 px-2 py-1 text-xs text-red-700">
    {stageError}
    <button onClick={() => setStageError(null)} className="ml-2 text-red-400 hover:text-red-600">✕</button>
  </div>
)}
```

Also add a utility `extractApiError(err)` in `apps/web/src/lib/api.ts`:
```typescript
export function extractApiError(err: unknown): string | null {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'error' in err) {
    return String((err as { error: unknown }).error);
  }
  return null;
}
```

**Change 2B — FileTree: surface stage mutation errors**

In `FileTree.tsx`, `updateStageMutation.onError` should similarly show an error notification. Use the existing notification system or a simple `console.error` + toast if a toast library is available:

```typescript
const updateStageMutation = useMutation({
  mutationFn: ({ id, stage }: { id: string; stage: DocumentStage | null }) =>
    updateDocument(id, { stage }),
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['documents', teamId] });
  },
  onError: (err: unknown) => {
    const message = extractApiError(err) ?? 'Failed to update stage';
    // surface to user — exact mechanism depends on notification system
    console.error('[FileTree] Stage update failed:', message);
  },
});
```

---

### Phase 3 — Data Recovery

This phase restores stage values for documents that lost them due to the enum→text migration.

**Change 3A — Recovery via version history**

Document version history (`document_versions` table) stores `content` snapshots but not the `stage` field. If stage was stored in version history, it can be recovered directly.

Check whether `documentVersions` schema includes stage:
```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'document_versions';
```

If `stage` is present in `document_versions`, write a recovery migration:
```sql
-- Restore stage from most recent version for documents where stage is NULL
UPDATE documents d
SET stage = (
  SELECT dv.stage
  FROM document_versions dv
  WHERE dv.document_id = d.id
    AND dv.stage IS NOT NULL
  ORDER BY dv.version DESC
  LIMIT 1
)
WHERE d.stage IS NULL
  AND EXISTS (
    SELECT 1 FROM document_versions dv2
    WHERE dv2.document_id = d.id AND dv2.stage IS NOT NULL
  );
```

**Change 3B — Recovery via audit log**

The `auditService.recordEvent` is called on every document update with `eventType: 'doc_edit'` and `metadata: { fields: [...] }`. If the audit log records the `stage` field value (not just the field name), it can be used to recover last-known stage values.

Check the `audit_log` table schema and the `metadata` JSONB field contents to determine whether stage values were stored.

**Change 3C — Admin recovery endpoint (if needed)**

If automated recovery is not possible, add an admin-only endpoint that accepts a JSON mapping of document IDs to stage values, allowing an operator to restore stages manually:

```
POST /api/admin/documents/restore-stages
Authorization: admin-only (requireRole({ minimumRole: 'admin' }))

Body:
{
  "restorations": [
    { "documentId": "uuid-1", "stage": "definition" },
    { "documentId": "uuid-2", "stage": "architecture" }
  ]
}
```

This endpoint bypasses gatekeeper checks (admin action) and writes the stage values directly.

---

### Phase 4 — Verify Repo Scan Does Not Overwrite Stage

**Files:**
- `apps/api/src/routes/` — locate the repo scan endpoint
- The route that creates/updates documents from scanned code

**Change 4A — Audit the scan endpoint**

Read the scan repository API handler. For any `INSERT ... ON CONFLICT DO UPDATE` (upsert) statement that creates or updates documents, verify that the `stage` column is excluded from the `SET` clause when a document already exists:

```sql
-- Safe upsert that preserves existing stage:
INSERT INTO documents (id, title, content, path, team_id, ...)
VALUES (...)
ON CONFLICT (path, team_id) DO UPDATE SET
  title = EXCLUDED.title,
  content = EXCLUDED.content,
  updated_at = now()
  -- stage is intentionally NOT in SET clause — preserve existing value
;
```

If the upsert currently includes `stage = EXCLUDED.stage` or `stage = NULL`, fix it to preserve the existing value.

**Change 4B — Add a test for scan + stage preservation**

Add a Vitest integration test that:
1. Creates a document with a stage set.
2. Triggers the repo scan path for a file at the same path.
3. Asserts the document's stage is unchanged after the scan.

---

### Phase 5 — Tests

**5.1 Unit tests for gatekeeper (Vitest)**

File: `apps/api/src/services/__tests__/gatekeeper.service.test.ts`

```typescript
describe('gatekeeperService.evaluateGate', () => {
  it('passes for valid sequential transition', () => { ... });
  it('fails when moving backward', () => { ... });
  it('fails when skipping a stage', () => { ... });
  it('fails when document content is empty', () => { ... });
  it('fails when document content is below min length', () => { ... });
  it('passes when document has no current stage and target is the first stage', () => { ... });
  it('fails when document has no current stage and target is not the first stage', () => { ... });
  it('passes for custom lifecycle stages not in the default order', () => { ... });
});
```

**5.2 API integration tests for stage removal (Vitest)**

File: `apps/api/src/routes/__tests__/documents.stage.test.ts`

Key test cases:
- `PUT /documents/:id` with `{ stage: null }` on a document with a stage → succeeds (200) with `stage: null` in response.
- `PUT /documents/:id` with `{ stage: null }` on a document without a stage → succeeds (200).
- `PUT /documents/:id` with `{ stage: 'definition' }` on a document at `conception` with sufficient content → succeeds.
- `PUT /documents/:id` with `{ stage: 'architecture' }` on a document at `conception` (skipping) → 422.
- `PUT /documents/:id` with `{ stage: 'definition' }` on a document at `conception` with insufficient content → 422.

**5.3 E2E tests (Playwright)**

File: `e2e/document-stage.spec.ts`

```gherkin
Scenario: User removes a stage from a document
  Given a document exists with stage = "conception"
  When the user selects "No stage" from the stage dropdown
  Then the stage dropdown shows "No stage"
  And the document is saved (save indicator shows "Saved")
  And reloading the page shows "No stage" (stage is null in DB)

Scenario: User is shown an error when gatekeeper blocks stage change
  Given a document exists with stage = "conception" and content < 100 chars
  When the user attempts to change stage to "definition"
  Then an error message is shown: "Document content must be at least 100 characters"
  And the stage dropdown reverts to "conception"

Scenario: Stage persists through content auto-save
  Given a document exists with stage = "architecture"
  When the user edits the document content
  And waits for the auto-save (500ms debounce)
  Then the document's stage is still "architecture" after the save
```

---

## 6. Migration Risk & Rollback Plan

### Forward Migration

No schema changes are required to fix this bug. The `stage text` column already exists and supports `null`. The fixes are purely at the application layer.

The data recovery script in Phase 3 modifies data but is additive (restores NULL stage values to non-NULL) and can be wrapped in a transaction with a `DRY_RUN` mode flag that only reports what would be changed without applying it.

### Rollback

- Phase 1 (API/gatekeeper fix): Revert the `if (body.stage !== undefined && body.stage !== null)` change. Risk: stage removal breaks again.
- Phase 2 (error surfacing): Revert the `stageMutation` split. Risk: errors are silently swallowed again.
- Phase 3 (data recovery): Irreversible once applied. Run in a transaction and verify row counts before committing.

---

## 7. File Change Summary

| File | Change Type | Description |
|---|---|---|
| `apps/api/src/routes/documents.ts` | Bug fix | Skip gatekeeper when `body.stage === null` (stage removal) |
| `apps/api/src/services/gatekeeper.service.ts` | Clarification | No logic change — type/comment clarification only |
| `apps/web/src/pages/DocumentEditor.tsx` | Bug fix + UX | Split `saveMutation` into `saveMutation` (content) + `stageMutation` (stage); surface 422 errors |
| `apps/web/src/components/FileTree.tsx` | UX fix | Surface stage mutation errors to user |
| `apps/web/src/lib/api.ts` | Utility | Add `extractApiError` helper |
| `apps/api/src/services/__tests__/gatekeeper.service.test.ts` | New file | Unit tests for gatekeeper |
| `apps/api/src/routes/__tests__/documents.stage.test.ts` | New file | Integration tests for stage update/removal API |
| `e2e/document-stage.spec.ts` | New file | E2E tests for stage persistence and error surfacing |
| `drizzle/` | Investigation | Check whether `document_versions` includes `stage`; write recovery script if so |
| Scan API route (TBD) | Audit + fix | Ensure upsert does not overwrite stage on existing documents |

---

## 8. Open Questions

1. **Does `document_versions` store the `stage` field?** This determines whether automated recovery is possible or if manual admin restoration is needed.
2. **Was there an explicit Drizzle migration for the enum→text change?** Check `drizzle/` directory for a migration file. If none exists, the schema change was applied via `drizzle-kit push --force`, confirming destructive data loss.
3. **How many documents are affected?** Run `SELECT COUNT(*) FROM documents WHERE stage IS NULL AND created_at < '<migration-date>'` to quantify scope.
4. **Does the repo scan feature upsert existing documents?** Read `apps/api/src/routes/` to find the scan endpoint and check its upsert logic.
5. **Is there a toast/notification system in the frontend?** Determines the best UX mechanism for surfacing stage mutation errors.

---

## References

- `apps/api/src/routes/documents.ts` — Document CRUD API including the PUT route with gatekeeper integration
- `apps/api/src/services/gatekeeper.service.ts` — Stage transition enforcement rules
- `apps/api/src/db/schema.ts:123-139` — `documents` table schema; stage column definition
- `apps/web/src/pages/DocumentEditor.tsx` — Document editor; stage dropdown and save mutation
- `apps/web/src/components/FileTree.tsx` — File tree; stage update and "Remove stage" context menu
- `apps/web/src/lib/api.ts` — `updateDocument` API client function
- `docs/lifecycle-stages.md` — Lifecycle stage pipeline documentation
