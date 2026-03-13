# Feature Specification

## Feature: Synced GitHub Repositories View

**Issue:** #77
**Stage:** Definition
**Status:** Draft

### Summary

A dedicated view where users can see all GitHub repositories connected to their SyncDocs workspace, along with per-repo sync status, webhook health, linked document count, and last push activity. Accessible from **Settings → Integrations** (expanded section beneath the GitHub integration card) or as a standalone **Repositories** page reachable from the sidebar.

---

### User Flow

1. User connects GitHub via **Settings → Integrations → Connect**.
2. User picks repositories via the **Manage Repos** modal.
3. User clicks **View synced repos** (new link/button on the GitHub integration card) or navigates to **/repositories** in the sidebar.
4. The Repositories view loads a list of all repos stored in `integration.config.selectedRepos`.
5. For each repo, the view shows: name, sync status, webhook health, linked document count, and last push timestamp.
6. User can click **View documents** to navigate to the Documents list filtered to that repo.
7. User can click **Remove** to disconnect a single repo (deregisters its webhook and removes it from `selectedRepos`).
8. If no repos are connected, an empty state is shown with a CTA to **Connect GitHub**.

---

### UI/UX Requirements

#### Entry Points

- **Settings → Integrations tab** — add a "View synced repos (N)" link below the GitHub integration card when at least one repo is selected.
- **Sidebar** — optional "Repositories" nav item (can be a sub-item under Integrations or a top-level item; decide during design).

#### Repository List Table

Each row displays:

| Column | Description |
|--------|-------------|
| **Repository** | `owner/name`, linked to the repo's GitHub URL. |
| **Sync status** | `active` (webhook registered and recently received events), `webhook error` (webhook registered but no event in the last 7 days), or `disconnected` (no webhook ID on record). |
| **Last push** | Timestamp of the most recent `code_push` timeline event for any document in this team, filtered by `payload.repoFullName`. `—` if never received. |
| **Webhook health** | Visual indicator: green (active), amber (stale > 7 days), red (no webhook ID). |
| **Linked documents** | Count of documents that have `repoFullName` recorded in their document-repo link record. Clicking navigates to filtered Documents list. |
| **Actions** | **Remove** button (disconnects repo + deletes webhook). |

#### Empty State

When no repos are connected:
- Illustration or icon (e.g. GitHub octocat / plug icon).
- Heading: "No repositories synced yet."
- Body: "Connect GitHub and select repositories to start detecting documentation drift."
- CTA button: "Connect GitHub" → triggers the GitHub OAuth flow.

#### Remove Confirmation

Clicking **Remove** on a repo shows an inline confirmation:
> "Remove `owner/repo`? This will deregister the webhook and stop drift detection for this repository. Documents will not be deleted."
>
> [Cancel] [Remove]

---

### Data Requirements

#### What already exists

- `integrations.config.selectedRepos` — array of `{ owner, name, fullName }` (source of truth for connected repos).
- `integrations.config.webhookIds` — map of `fullName → webhookId` (used to check webhook registration).
- Timeline events with `type: 'code_push'` and `payload.changedFiles`, `payload.ref` — used to compute last push timestamp.

#### What is missing / needs to be added

1. **`payload.repoFullName` on timeline events** — the current webhook handler creates `code_push` timeline events but does not record `repoFullName` in the payload. Add this field so the Repositories view can query last-push timestamps per repo.

2. **Document → repo association** — currently, all team documents receive a `code_push` event for every push to any connected repo. There is no explicit per-document/per-repo link. To show "linked documents" count accurately, either:
   - **Option A (lightweight):** Count all team documents as linked to every selected repo (reflects current behaviour; honest but coarse).
   - **Option B (explicit links):** Add a `document_repos` join table (`document_id`, `integration_id`, `repo_full_name`) populated when a user tags a document to a specific repo. This is the correct long-term model and aligns with drift detection scoping.
   - **Recommendation:** Ship with Option A for MVP. Model Option B in the schema and migrate later.

3. **Webhook last-received timestamp** — the current schema has no `last_webhook_at` field. Derive this from the most recent `code_push` timeline event's `createdAt` for now.

---

### API Changes

#### New endpoint: `GET /api/integrations/:id/github/repos/status`

Returns the enriched list of repos for a connected GitHub integration, including sync status computed server-side.

**Response shape:**

```json
{
  "repos": [
    {
      "owner": "acme",
      "name": "api",
      "fullName": "acme/api",
      "githubUrl": "https://github.com/acme/api",
      "webhookId": 123456789,
      "syncStatus": "active",
      "lastPushAt": "2026-03-10T14:22:00Z",
      "linkedDocumentCount": 4
    }
  ]
}
```

`syncStatus` values:
- `"active"` — webhook registered (`webhookId` present) and a `code_push` event received within the last 7 days.
- `"stale"` — webhook registered but no push in more than 7 days.
- `"disconnected"` — no `webhookId` on record (webhook was never created or was deleted externally).

#### New endpoint: `DELETE /api/integrations/:id/github/repos/:repoFullName`

Disconnects a single repository:
1. Deregisters the GitHub webhook for that repo (`githubService.deleteWebhook`).
2. Removes the repo from `config.selectedRepos`.
3. Removes the entry from `config.webhookIds`.

**Authorization:** `admin` role (same as `PUT /:id/github/repos`).

---

### Frontend Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `RepositoriesPage` | `apps/web/src/pages/Repositories.tsx` | Full-page view, or panel within Settings |
| `RepoStatusTable` | `apps/web/src/components/RepoStatusTable.tsx` | Table of repos with status columns and actions |
| `RepoStatusBadge` | `apps/web/src/components/RepoStatusBadge.tsx` | Coloured badge for `active` / `stale` / `disconnected` |
| `RepoEmptyState` | inline or sub-component | Empty state with CTA |

**Data fetching:** `useQuery` calling `GET /api/integrations/:id/github/repos/status`, polling every 60 seconds or on manual refresh.

---

### Business Rules

- Only users with `admin` or higher role can remove a repo.
- Viewers and developers can view the Repositories page (read-only).
- If GitHub OAuth token is expired or revoked, repos still show in the list with `syncStatus: "disconnected"` (token error surfaced separately in the integration card).
- Removing the last repo does not disconnect the GitHub integration itself (use the "Disconnect" button on the integration card for that).

---

### Edge Cases

| Scenario | Expected Behavior |
|----------|------------------|
| Webhook deregistration fails (e.g. repo deleted on GitHub) | Log the error, still remove repo from `selectedRepos`. Show a toast: "Webhook could not be deregistered — it may have already been removed on GitHub." |
| GitHub token expired when loading repo list | Show an error banner: "GitHub token expired. Reconnect GitHub to refresh repo data." |
| Zero documents in team | Linked document count shows `0` for all repos. |
| Repo renamed on GitHub | `fullName` in `selectedRepos` becomes stale. Surface a warning badge: "Repo may have been renamed or deleted." (Future work; flag in backlog.) |
| User has `viewer` role | Remove button hidden. View is read-only. |

---

### Dependencies

- `RepoPickerModal` (already exists) — no changes needed for this feature.
- `githubService.deleteWebhook` (already exists in `apps/api/src/services/github.service.ts`).
- Timeline events (`code_push`) — minor payload addition (`repoFullName` field) required.
- React Router — add `/repositories` route or embed in Settings.

---

### Acceptance Criteria

- [ ] Page/section lists all repos from `integration.config.selectedRepos` for the current team.
- [ ] Each row shows: repo name (linked to GitHub), sync status badge, last push timestamp, linked document count.
- [ ] Sync status reflects webhook registration and recency of last push event.
- [ ] User with `admin` role can remove a repo; removal deregisters the webhook and updates `selectedRepos`.
- [ ] Empty state is shown when no repos are connected, with a "Connect GitHub" CTA.
- [ ] Viewers can see the list but cannot remove repos.
- [ ] If GitHub token is missing/expired, an appropriate error state is shown rather than a crash.

---

### Out of Scope (for this feature)

- Per-document → per-repo explicit tagging (document-repo join table) — tracked separately as a follow-up.
- Webhook delivery log / event history per repo.
- Re-registering a broken webhook without removing and re-adding the repo.
- Renaming / renamed-repo detection.
