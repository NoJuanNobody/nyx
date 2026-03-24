# Manage Repos Button — Repositories Page

**Issue:** [#237](https://github.com/NoJuanNobody/nyx/issues/237)
**Category:** UX Improvement
**Status:** Planned

---

## 1. Overview

Users want to add, remove, or change which GitHub repositories are synced with Nyx without leaving the Repositories page. Currently the only path to the repository picker modal is through **Settings → Integrations → Manage Repos**, a two-step detour from where the user is already looking at their repos.

This feature adds a **"Manage Repos"** button to the Repositories page header that opens the `RepoPickerModal` in-place.

---

## 2. Problem Statement

### Current Behavior

| Location | What exists |
|---|---|
| `/repositories` (has repos) | `+ New Repository` button only |
| `/repositories` (no repos, empty state) | Text link navigating away to `/settings` |
| `/settings` → Integrations | `Manage Repos` button → opens `RepoPickerModal` |

Users land on the Repositories page to work with their repos. When they want to add or remove a repo from sync, they must navigate to Settings, locate the GitHub integration card, click "Manage Repos", make changes, save, then navigate back. This context-switching creates friction and is non-obvious — the Settings page is not where users expect to find repository selection.

### User Pain Point

> "Select repositories to monitor from Settings" — the current empty-state prompt
> requires users to leave the page they are on and find the right card in Settings.

---

## 3. Proposed Solution

Add a secondary **"Manage Repos"** button to the Repositories page header that opens the existing `RepoPickerModal` directly, without any page navigation.

### Placement

The button appears in the page header, to the **left** of the existing `+ New Repository` button, as a secondary action (outlined style vs. the primary filled style of `+ New Repository`).

```
┌──────────────────────────────────────────────────────────┐
│ Repositories                [Manage Repos] [+ New Repo]  │
│ View and manage your synced GitHub repositories.         │
└──────────────────────────────────────────────────────────┘
```

### States where the button appears

| Page state | Button shown? | Notes |
|---|---|---|
| No GitHub integration connected | No | Nothing to manage; "Go to Integrations" link shown instead |
| GitHub token expired | No | `GitHubReconnectBanner` is the only relevant action |
| GitHub connected, no repos selected (empty state) | Yes | Replaces the text link to `/settings` in the empty state card; also appears in header |
| GitHub connected, repos loaded (main view) | Yes | Primary use case — appears alongside `+ New Repository` |
| Loading | Button rendered but disabled / hidden | Prevents acting before integration ID is known |

### Empty State Change

The existing empty-state card contains:

```
"Select repositories to monitor from Settings, or create a new one."
[Manage Repos link → /settings]
```

This becomes:

```
"Select repositories to sync with Nyx, or create a new one."
[Manage Repos button → opens RepoPickerModal]
```

The user stays on the page, makes their selection, saves, and the repo list immediately populates. No navigation required.

---

## 4. Interaction Design

### Modal flow

1. User clicks **"Manage Repos"**
2. `RepoPickerModal` opens, pre-populated with currently-synced repos
3. User checks/unchecks repos, optionally filters by name
4. User clicks **"Save"**
5. Modal closes, `synced-repos` query is invalidated, repo list refreshes in-place

### Button styling

The button uses the existing secondary style already applied to the "Manage Repos" button in Settings:

```
rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium
text-slate-600 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600 transition-colors
```

This visually distinguishes it from the primary `+ New Repository` button (`bg-slate-900 text-white`).

---

## 5. Acceptance Criteria

- [ ] A "Manage Repos" button is visible in the Repositories page header when GitHub is connected
- [ ] Clicking the button opens `RepoPickerModal` directly (no page navigation)
- [ ] The modal is pre-populated with the currently-synced repositories
- [ ] Saving in the modal refreshes the repo list without a full page reload
- [ ] The button is not shown when GitHub is not connected or the token has expired
- [ ] The empty-state "Manage Repos" link to `/settings` is replaced by a button that opens the modal
- [ ] The empty-state helper text is updated to no longer direct users to Settings
- [ ] Existing "+ New Repository" button behavior is unchanged
- [ ] `data-testid="manage-repos-button"` is present for E2E testability

---

## 6. Out of Scope

- Inline repo management (adding/removing repos without a modal) — the modal pattern is already established and consistent with Settings
- Creating repos from within the picker — that flow is handled by the separate `CreateRepoModal` / `+ New Repository` button
- Any changes to the `RepoPickerModal` component itself — it already works correctly; this feature only adds the trigger
- Mobile-specific layout changes

---

## 7. Related Files

| File | Role |
|---|---|
| `apps/web/src/pages/Repositories.tsx` | Page to modify — add button + modal trigger |
| `apps/web/src/components/RepoPickerModal.tsx` | Existing modal to reuse (no changes needed) |
| `apps/web/src/pages/Settings.tsx` | Existing "Manage Repos" button for reference |
| `e2e/repositories.spec.ts` | E2E tests to extend |
