# Implementation Plan — Manage Repos Button (Issue #237)

**Feature doc:** [`docs/features/manage-repos-button.md`](../features/manage-repos-button.md)

---

## 1. Summary

This is a focused frontend change. No backend work is required — all necessary API endpoints and the `RepoPickerModal` component already exist. The work is:

1. Import `RepoPickerModal` into `Repositories.tsx`
2. Add `showRepoPicker` state
3. Add the "Manage Repos" button to the page header (two render paths: empty-state header and main loaded-state header)
4. Update the empty-state card to use the modal button instead of a `/settings` link
5. Render the modal when state is set
6. Add/update E2E tests

**Estimated diff size:** ~40–50 lines changed in `Repositories.tsx`, ~20–30 lines added in `e2e/repositories.spec.ts`.

---

## 2. Files to Change

| File | Change type | Description |
|---|---|---|
| `apps/web/src/pages/Repositories.tsx` | Modify | Add button + modal wiring |
| `e2e/repositories.spec.ts` | Modify | Add tests for new button |

No other files need to change.

---

## 3. Step-by-Step Implementation

### 3.1 `apps/web/src/pages/Repositories.tsx`

#### Step 1 — Import `RepoPickerModal`

Add to the existing import block at the top of the file:

```diff
-import { ScanRepositoryModal, ScanResultView } from '../components/ScanRepositoryModal';
+import { ScanRepositoryModal, ScanResultView } from '../components/ScanRepositoryModal';
+import { RepoPickerModal } from '../components/RepoPickerModal';
```

#### Step 2 — Add `showRepoPicker` state

Inside the `Repositories` component, alongside the existing `useState` declarations
(around line 173–176):

```diff
 const [scanTarget, setScanTarget] = useState<{ owner: string; repo: string } | null>(null);
 const [scanResult, setScanResult] = useState<{ owner: string; repo: string; result: ScanResult } | null>(null);
+const [showRepoPicker, setShowRepoPicker] = useState(false);
```

#### Step 3 — Add "Manage Repos" button to the empty-state header (lines 264–280)

The empty-state render path has its own header. Add the button here too so it's
always reachable:

```diff
 {githubIntegration && (
   <button
     type="button"
     onClick={() => setShowCreateModal(true)}
     className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
     data-testid="create-repo-button"
   >
     + New Repository
   </button>
 )}
```

Change to a button group:

```diff
 {githubIntegration && (
-  <button
-    type="button"
-    onClick={() => setShowCreateModal(true)}
-    className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
-    data-testid="create-repo-button"
-  >
-    + New Repository
-  </button>
+  <div className="flex items-center gap-2">
+    <button
+      type="button"
+      onClick={() => setShowRepoPicker(true)}
+      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors"
+      data-testid="manage-repos-button"
+    >
+      Manage Repos
+    </button>
+    <button
+      type="button"
+      onClick={() => setShowCreateModal(true)}
+      className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
+      data-testid="create-repo-button"
+    >
+      + New Repository
+    </button>
+  </div>
 )}
```

#### Step 4 — Update the empty-state card body (lines 282–297)

Replace the `/settings` navigation link with an in-place modal trigger:

```diff
-<p className="mt-1 text-xs text-slate-500">
-  Select repositories to monitor from Settings, or create a new one.
-</p>
-<div className="mt-4 flex justify-center gap-3">
-  <Link
-    to="/settings"
-    className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
-  >
-    Manage Repos
-  </Link>
-</div>
+<p className="mt-1 text-xs text-slate-500">
+  Select repositories to sync with Nyx, or create a new one.
+</p>
+<div className="mt-4 flex justify-center gap-3">
+  <button
+    type="button"
+    onClick={() => setShowRepoPicker(true)}
+    className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
+    data-testid="manage-repos-button"
+  >
+    Manage Repos
+  </button>
+</div>
```

Note: The `Link` import from `react-router-dom` can be removed if it is no longer used
elsewhere in the file. Check the rest of `Repositories.tsx` — currently `Link` is only
used in this empty-state and in the no-integration empty state (line 234). It is still
needed for the "Go to Integrations" link, so keep the import.

#### Step 5 — Add "Manage Repos" button to the main header (lines 322–331)

The main loaded-state header currently has only the `+ New Repository` button:

```diff
 {githubIntegration && (
-  <button
-    type="button"
-    onClick={() => setShowCreateModal(true)}
-    className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
-    data-testid="create-repo-button"
-  >
-    + New Repository
-  </button>
+  <div className="flex items-center gap-2">
+    <button
+      type="button"
+      onClick={() => setShowRepoPicker(true)}
+      className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors"
+      data-testid="manage-repos-button"
+    >
+      Manage Repos
+    </button>
+    <button
+      type="button"
+      onClick={() => setShowCreateModal(true)}
+      className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-slate-800 transition-colors"
+      data-testid="create-repo-button"
+    >
+      + New Repository
+    </button>
+  </div>
 )}
```

#### Step 6 — Render `RepoPickerModal` at the bottom of the component return

Add after the existing `ScanResultView` modal block (around line 464):

```diff
+{showRepoPicker && githubIntegration && (
+  <RepoPickerModal
+    integrationId={githubIntegration.id}
+    initialSelected={repos.map((r) => ({ owner: r.owner, name: r.name, fullName: r.fullName }))}
+    onClose={() => {
+      setShowRepoPicker(false);
+      queryClient.invalidateQueries({ queryKey: ['synced-repos'] });
+      queryClient.invalidateQueries({ queryKey: ['integrations'] });
+    }}
+  />
+)}
```

**Why invalidate on close?** `RepoPickerModal` calls `saveSelectedRepos` and then
invalidates the `github-repos` query internally. But `Repositories.tsx` needs the
`synced-repos` query refreshed so the table reflects the new selection. Invalidating
on modal close (rather than on save) is safe: if the user dismisses without saving,
the query is still invalidated but the refetch returns the same data.

Alternatively, pass a dedicated `onSaved` callback into `RepoPickerModal`. The
simpler approach (invalidate on close) avoids modifying the modal component, keeping
this change self-contained.

---

### 3.2 `e2e/repositories.spec.ts`

Add the following test cases to the existing describe block:

```typescript
test('manage repos button is visible when GitHub is connected', async ({ authenticatedPage }) => {
  const { page } = authenticatedPage;
  await page.goto('/repositories');
  await expect(page.getByTestId('manage-repos-button')).toBeVisible();
});

test('manage repos button opens repo picker modal', async ({ authenticatedPage }) => {
  const { page } = authenticatedPage;
  await page.goto('/repositories');
  await page.getByTestId('manage-repos-button').click();
  // RepoPickerModal renders a search input as its first interactive element
  await expect(page.getByPlaceholder('Search repositories...')).toBeVisible({ timeout: 5000 });
});

test('manage repos modal can be dismissed', async ({ authenticatedPage }) => {
  const { page } = authenticatedPage;
  await page.goto('/repositories');
  await page.getByTestId('manage-repos-button').click();
  await expect(page.getByPlaceholder('Search repositories...')).toBeVisible({ timeout: 5000 });
  // Press Escape or click backdrop
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Search repositories...')).not.toBeVisible();
});
```

Check the `RepoPickerModal` component for the correct placeholder text and
`data-testid` attributes before finalising these selectors.

---

## 4. Edge Cases and Considerations

### Query invalidation timing

`RepoPickerModal.onClose` is called both when the user saves **and** when they dismiss.
Invalidating on close is correct in both paths — a no-op refetch when nothing changed
costs one lightweight API request but avoids stale state.

If this is considered wasteful, the alternative is to expose an `onSaved` prop on
`RepoPickerModal` and only invalidate there. That would require a one-line change to
`RepoPickerModal.tsx` (adding the optional prop and calling it inside the save
mutation's `onSuccess`).

### `initialSelected` population

`RepoPickerModal` accepts `initialSelected` as
`Array<{ owner: string; name: string; fullName: string }>`.

The `SyncedRepo` type from `fetchSyncedRepos` already has `owner`, `name`, and
`fullName` fields, so `repos.map((r) => ({ owner: r.owner, name: r.name, fullName: r.fullName }))`
works directly. No type changes needed.

### Empty state: both `manage-repos-button` testids

Both the header button and the empty-state card button share `data-testid="manage-repos-button"`.
This is intentional — they are the same action. If E2E tests need to disambiguate,
use `data-testid="manage-repos-button-header"` and `data-testid="manage-repos-button-empty"`
respectively, and update selectors to `page.getByTestId('manage-repos-button-header')`.

### No GitHub integration state

The "Manage Repos" button must **not** appear when `!githubIntegration`. This is already
handled by wrapping the button in `{githubIntegration && ...}` — the same guard used
for the existing `+ New Repository` button.

### Token expired state

The token-expired render path returns early with only `GitHubReconnectBanner`. Since
the button is only rendered in the no-repos and main-loaded paths (both of which require
`githubIntegration` to be truthy and the token to be valid), it will never appear
during the expired-token state.

---

## 5. No Backend Changes Required

All necessary API infrastructure already exists:

| Capability | Endpoint | Already used by |
|---|---|---|
| List user's GitHub repos | `GET /api/integrations/:id/github/repos` | `RepoPickerModal` |
| Save repo selection + register webhooks | `PUT /api/integrations/:id/github/repos` | `RepoPickerModal` |
| Fetch synced repos | `GET /api/integrations/:id/github/synced-repos` | `Repositories.tsx` |

---

## 6. Testing Checklist

Before marking this complete:

- [ ] `pnpm --filter web build` passes (no TypeScript errors)
- [ ] `pnpm exec playwright test e2e/repositories.spec.ts` passes
- [ ] Manual: click "Manage Repos" → modal opens with current repos pre-selected
- [ ] Manual: add a new repo in the modal, save → repo appears in the table without reload
- [ ] Manual: remove a repo in the modal, save → repo disappears from the table
- [ ] Manual: dismiss the modal without saving → no change to the table
- [ ] Manual: verify `+ New Repository` still works correctly
- [ ] Verify the "Manage Repos" button does **not** appear when GitHub is not connected
  (navigate to `/repositories` with no integration set up)
