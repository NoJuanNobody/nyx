# Confluence Integration (#33)

**Issue:** #33
**Status:** Planned
**Priority:** P2 — MVP
**Depends on:** Jira/Confluence OAuth (#40)

---

## Overview

SyncDocs integrates with Confluence to let teams pull their existing documentation into SyncDocs and keep it as the living source of truth. The sync strategy is **pull-only**: Confluence pages are imported into SyncDocs, where they become first-class documents that can be edited, versioned, and linked to code. Changes made in SyncDocs do not push back to Confluence.

> **"Bring your existing docs into SyncDocs"** — the Confluence integration is an onramp, not a mirror.

This positions SyncDocs as the authoritative, structured documentation layer while Confluence remains the historical source that teams already know. Once imported, SyncDocs docs can be exported at any time (Markdown, PDF), preserving the no-vendor-lock-in guarantee.

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Page import** | Pull a Confluence page (or a full space) into SyncDocs as a new document |
| **Space browsing** | Browse and search Confluence spaces/pages from within SyncDocs to select what to import |
| **Linked source** | Imported docs retain a reference to their Confluence origin (URL + page ID) |
| **One-time or recurring pull** | Import can be a single snapshot or scheduled to re-pull and surface diffs |
| **Rich content mapping** | Confluence storage format → SyncDocs Markdown (tables, headings, code blocks, images) |
| **Audit trail** | Every pull is logged in the unified timeline with timestamp, importer, and source URL |

### Out of scope (v1)

- **Push to Confluence** — SyncDocs does not write back to Confluence pages
- **Real-time sync** — no webhooks from Confluence in v1; pulls are on-demand or scheduled
- **Attachment sync** — binary files (images embedded in pages) are linked by URL, not copied

---

## Confluence REST API Endpoints Used

Authentication is via OAuth 2.0 (3LO) as defined in #40. All requests are scoped to the connected user's Confluence account.

| Operation | Endpoint | Notes |
|---|---|---|
| List accessible spaces | `GET /wiki/rest/api/space` | Paginated; filter by `type=global` |
| Browse pages in a space | `GET /wiki/rest/api/space/{spaceKey}/content/page` | Paginated by `start` + `limit` |
| Get page with body | `GET /wiki/rest/api/content/{id}?expand=body.storage,version,space,ancestors` | Returns Confluence storage format XML |
| Search pages | `GET /wiki/rest/api/content/search?cql=...` | CQL query for title/space search |
| Get page children | `GET /wiki/rest/api/content/{id}/child/page` | For recursive space import |
| Get current user | `GET /wiki/rest/api/user/current` | For validating the connected account |

### Required OAuth Scopes

```
read:confluence-space.summary
read:confluence-content.all
read:confluence-content.summary
read:confluence-user
```

---

## How SyncDocs Documents Map to Confluence Pages

```
Confluence                          SyncDocs
─────────────────────────────────   ──────────────────────────────────
Space                        →      Folder / tag group (not a doc)
Page (top-level)             →      SyncDocs Document
Child pages                  →      Linked child Documents (tree preserved)
Page title                   →      Document title
Page body (storage format)   →      Document content (Markdown)
Page version                 →      Import snapshot version
Page URL                     →      `confluenceSourceUrl` metadata field
Space key                    →      `confluenceSpaceKey` metadata field
Page ID                      →      `confluencePageId` metadata field
```

### Metadata stored on imported documents

```typescript
interface ConfluenceDocMetadata {
  confluencePageId: string;
  confluenceSpaceKey: string;
  confluenceSourceUrl: string;
  confluenceLastPulledAt: Date;
  confluenceLastPulledVersion: number;
  importedByUserId: string;
}
```

This metadata is stored in the `documents` table (or a `document_integrations` join table) and used to:
- Show the Confluence source link in the document header
- Support re-pulling and diffing against the latest Confluence version
- Build the audit trail entry

---

## Sync Strategy: Pull Only

### Why pull-only

SyncDocs is the structured, spec-grade layer on top of teams' existing tools. Confluence is where historical docs live; SyncDocs is where living specs are written and kept in sync with code. Pushing changes from SyncDocs back into Confluence would:

1. Create two competing sources of truth, defeating the purpose of using SyncDocs
2. Require complex conflict resolution (Confluence has its own concurrent edit model)
3. Risk overwriting formatting/macros that Confluence users depend on
4. Complicate the OAuth scope model (write scopes require higher trust)

Pull-only keeps the integration simple, predictable, and safe. Users who want their updated specs in Confluence can export from SyncDocs at any time.

### Pull trigger options

| Mode | Description | When to use |
|---|---|---|
| **Manual pull** | User clicks "Sync from Confluence" in the document header | Ad-hoc refresh |
| **Scheduled pull** | Team admin sets a cron (e.g., daily, weekly) for a space | Long-running projects where Confluence is still edited |
| **Onboarding import** | Part of the onboarding flow — scan and import an entire space | Initial migration |

### Pull flow

```
User selects Confluence page(s) to import
          │
          ▼
confluence.service.ts fetches page via REST API
          │
          ▼
Content converter: Confluence storage XML → Markdown
          │
          ▼
Create/update SyncDocs document with imported content
          │
          ▼
Write ConfluenceDocMetadata to DB
          │
          ▼
Log import event to unified timeline (audit trail)
          │
          ▼
Notify importer (toast + timeline entry)
```

### Drift detection on re-pull

When a document is re-pulled, SyncDocs compares the incoming Confluence version against:
1. The `confluenceLastPulledVersion` — did Confluence change since last pull?
2. The current SyncDocs document content — has the SyncDocs doc been edited since import?

If both sides changed, the user sees a diff view and chooses:
- **Keep SyncDocs version** (discard incoming Confluence changes)
- **Replace with Confluence version** (overwrite SyncDocs edits)
- **Merge manually** (open both in a split view; SyncDocs version wins on save)

There is no automatic merge. The user resolves the conflict manually.

---

## Service Architecture

### `confluence.service.ts`

Location: `backend/src/services/confluence.service.ts`

```typescript
export class ConfluenceService {
  // OAuth token management (delegates to oauth.service.ts / #40)
  async getAccessToken(userId: string): Promise<string>

  // Space and page discovery
  async listSpaces(userId: string): Promise<ConfluenceSpace[]>
  async listPages(userId: string, spaceKey: string, parentId?: string): Promise<ConfluencePage[]>
  async searchPages(userId: string, query: string): Promise<ConfluencePage[]>

  // Content fetch
  async fetchPage(userId: string, pageId: string): Promise<ConfluencePageContent>

  // Import / pull
  async importPage(userId: string, pageId: string, targetFolderId?: string): Promise<Document>
  async rePullPage(userId: string, documentId: string): Promise<PullResult>
  async importSpace(userId: string, spaceKey: string, targetFolderId?: string): Promise<ImportBatch>

  // Scheduled pulls (invoked by job runner)
  async runScheduledPulls(): Promise<void>
}
```

### Content conversion

Location: `backend/src/utils/confluence-to-markdown.ts`

Converts Confluence storage format (XHTML-based) to Markdown. Handled elements:

| Confluence | Markdown output |
|---|---|
| `<h1>` – `<h6>` | `#` – `######` |
| `<p>` | Paragraph |
| `<ul>`, `<ol>`, `<li>` | List items |
| `<table>` | GFM table |
| `<code>`, `<pre>` | Inline code / fenced code block |
| `<ac:image>` | `![alt](url)` (remote URL, not copied) |
| `<ac:link>` | Markdown link |
| Confluence macros | Stripped with a `> [Confluence macro not supported]` note |

### Database schema additions

```sql
-- Added to the documents table or as a separate join table
ALTER TABLE documents ADD COLUMN confluence_page_id TEXT;
ALTER TABLE documents ADD COLUMN confluence_space_key TEXT;
ALTER TABLE documents ADD COLUMN confluence_source_url TEXT;
ALTER TABLE documents ADD COLUMN confluence_last_pulled_at TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN confluence_last_pulled_version INTEGER;

-- integration_type already supports 'confluence' per existing DB schema
```

---

## Integration with Ticket Service and Audit Trail

### Audit trail events

Every Confluence action is logged to the `integration_events` table and surfaced in the unified timeline.

| Event | Actor | Description |
|---|---|---|
| `confluence.page_imported` | User | "Imported from Confluence: [Page Title]" |
| `confluence.page_repulled` | User or system | "Re-pulled from Confluence — [N lines changed]" |
| `confluence.conflict_detected` | System | "Confluence conflict: both sides changed since last pull" |
| `confluence.conflict_resolved` | User | "Conflict resolved: kept SyncDocs version / replaced with Confluence" |
| `confluence.space_import_started` | User | "Space import started: [Space Key] ([N] pages)" |
| `confluence.space_import_completed` | System | "Space import complete: [N] pages imported" |

### Ticket service integration

Confluence integration does not directly create tickets. However:
- When a re-pull detects drift between SyncDocs and Confluence, the drift event is surfaced in the unified timeline — the same surface where GitHub drift events appear
- A user or team admin can then create a ticket from the drift event (via the existing ticket service) if the drift needs to be resolved by an engineer

---

## How Confluence Links Appear in the Unified Timeline

The unified timeline (document activity feed) shows Confluence events alongside code events and ticket events:

```
Timeline entry format:

  [Confluence icon]  Imported from Confluence
                     Space: PROD-DOCS · Page: "API Authentication Guide"
                     Imported by Ana García · March 10, 2026
                     [View source in Confluence ↗]

  [Confluence icon]  Re-pull detected drift
                     Confluence version 14 → 17 (+3 versions since last pull)
                     SyncDocs doc also edited (by Ben Chen, March 9)
                     [Resolve conflict →]
```

### Document header badge

Imported documents display a persistent badge in the editor header:

```
[Confluence ↗ Source]   Last pulled: March 10, 2026 · v14   [Sync from Confluence]
```

The badge links to the original Confluence page. The "Sync from Confluence" button triggers a manual re-pull.

---

## E2E Testing

### Critical user flows

1. **Import a single Confluence page** — user browses spaces, selects a page, imports it, and sees the resulting SyncDocs document with correct metadata and timeline entry
2. **Import a Confluence space** — user triggers a full space import; multiple documents are created with parent–child relationships preserved
3. **Manual re-pull (no conflict)** — Confluence page is updated externally; user clicks "Sync from Confluence"; document content updates and timeline shows the re-pull event
4. **Manual re-pull (conflict)** — both Confluence page and SyncDocs doc are edited since last pull; conflict UI is shown; user resolves by keeping SyncDocs version
5. **Scheduled pull** — a scheduled pull job runs; pages with Confluence changes get re-pulled; audit events are logged
6. **OAuth connection failure** — user attempts import with expired/revoked Confluence token; error is shown and user is prompted to reconnect

### Test scenarios (Given / When / Then)

#### Scenario 1: Import a single page

```
Given: A user has connected their Confluence account via OAuth
  And: The Confluence space "DOCS" contains a page "Getting Started" (page ID: 12345)

When: The user navigates to "Import from Confluence"
  And: Selects the "Getting Started" page
  And: Clicks "Import"

Then: A new SyncDocs document is created with title "Getting Started"
  And: The document content matches the Confluence page body (converted to Markdown)
  And: The document metadata includes confluencePageId = "12345"
  And: A "confluence.page_imported" event appears in the document timeline
  And: The document header shows the Confluence source badge with a link to the original page
```

#### Scenario 2: Re-pull with no conflict

```
Given: A SyncDocs document was imported from Confluence page "API Guide" at version 5
  And: The SyncDocs document has not been edited since import
  And: The Confluence page has been updated to version 8

When: The user clicks "Sync from Confluence" in the document header

Then: The document content is updated to match Confluence version 8
  And: confluenceLastPulledVersion is updated to 8
  And: confluenceLastPulledAt is updated to now
  And: A "confluence.page_repulled" event appears in the timeline (showing "3 versions updated")
  And: No conflict UI is shown
```

#### Scenario 3: Re-pull with conflict

```
Given: A SyncDocs document was imported from Confluence page "API Guide" at version 5
  And: The SyncDocs document has been edited by a user since import
  And: The Confluence page has also been updated to version 6

When: The user clicks "Sync from Confluence"

Then: A conflict banner appears in the document editor
  And: The user is presented with three options: "Keep SyncDocs version", "Replace with Confluence", "Merge manually"
  And: A "confluence.conflict_detected" event is logged in the timeline

When: The user selects "Keep SyncDocs version"

Then: The document content is unchanged
  And: confluenceLastPulledVersion is updated to 6 (acknowledging the pull without overwriting)
  And: A "confluence.conflict_resolved" event is logged with resolution = "kept_syncdocs"
```

#### Scenario 4: OAuth token expired during import

```
Given: A user's Confluence OAuth token has expired

When: The user attempts to import a Confluence page

Then: The import fails gracefully with an error message
  And: The user is prompted to reconnect their Confluence account
  And: No partial document is created
  And: No timeline event is logged
```

### Integration boundaries: mock vs. live

| Dependency | In unit/integration tests | In E2E tests |
|---|---|---|
| Confluence REST API | **Mock** (MSW or nock) | **Mock** (dedicated Confluence sandbox or WireMock) |
| Confluence OAuth flow | **Mock** (inject test token) | **Mock** (bypass OAuth, inject token via env var) |
| PostgreSQL | Test DB (Docker) | Test DB (Docker) |
| SyncDocs backend | Real | Real (running against test DB) |
| SyncDocs frontend | N/A | Real (Playwright browser) |

> Note: Do not test against a live Confluence instance in CI. Rate limits, flaky external state, and credential management make live Confluence tests unreliable. Use a stubbed API server.

### Test data requirements

```typescript
// Seed data needed for E2E tests (fixtures/confluence.ts)

const confluenceFixtures = {
  // Simulate an authenticated Confluence connection for testUser
  oauthConnection: {
    userId: 'test-user-id',
    provider: 'confluence',
    accessToken: 'test-confluence-token',
    cloudId: 'test-cloud-id',
    siteUrl: 'https://test-company.atlassian.net',
  },

  // Mock Confluence space
  space: {
    key: 'DOCS',
    name: 'Documentation',
    type: 'global',
  },

  // Mock Confluence pages (returned by MSW/WireMock)
  pages: [
    {
      id: '12345',
      title: 'Getting Started',
      version: { number: 5 },
      body: { storage: { value: '<p>Welcome to our product.</p>' } },
      _links: { webui: '/wiki/spaces/DOCS/pages/12345' },
    },
    {
      id: '12346',
      title: 'API Reference',
      version: { number: 8 },
      body: { storage: { value: '<h1>API</h1><p>Endpoints listed below.</p>' } },
      _links: { webui: '/wiki/spaces/DOCS/pages/12346' },
    },
  ],
};
```

### Playwright test file locations

```
tests/e2e/
├── confluence/
│   ├── confluence-import.spec.ts        # Single page import, space import
│   ├── confluence-repull.spec.ts        # Re-pull without conflict, re-pull with conflict
│   ├── confluence-conflict.spec.ts      # Conflict resolution flows (all 3 resolution options)
│   ├── confluence-oauth.spec.ts         # Auth connection, token expiry, disconnect
│   └── confluence-timeline.spec.ts      # Timeline event display and linking
└── fixtures/
    └── confluence.ts                    # Shared fixture data and MSW handlers
```

### CI considerations

```yaml
# In .github/workflows/ci.yml — E2E job additions for Confluence tests

jobs:
  e2e-confluence:
    name: E2E — Confluence Integration
    runs-on: ubuntu-latest
    needs: build
    if: github.event_name == 'pull_request'

    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpassword
          POSTGRES_DB: syncdocs_test
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
          --health-timeout 5s
          --health-retries 5

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium

      - name: Start WireMock (Confluence API stub)
        run: docker run -d -p 8080:8080 wiremock/wiremock
          # Load fixtures from tests/e2e/fixtures/confluence-wiremock/

      - name: Run Confluence E2E tests
        run: npx playwright test tests/e2e/confluence/
        env:
          BASE_URL: ${{ env.VERCEL_PREVIEW_URL }}
          DATABASE_URL: postgres://postgres:testpassword@localhost:5432/syncdocs_test
          CONFLUENCE_TEST_TOKEN: ${{ secrets.CONFLUENCE_TEST_TOKEN }}
          CONFLUENCE_MOCK_API_URL: http://localhost:8080
```

**Required CI secrets:**

| Secret | Purpose |
|---|---|
| `CONFLUENCE_TEST_TOKEN` | Pre-authorized OAuth token for a Confluence sandbox (injected into test sessions to bypass OAuth flow) |

**Note:** `CONFLUENCE_TEST_TOKEN` should be a token for a dedicated test Atlassian account, not a real user's credentials. Rotate it on a schedule.

---

## Open Questions

- **Space import depth** — should space import be recursive (all child pages) or just top-level pages? Recursive imports can be very large for big Confluence spaces.
- **Rate limiting** — Confluence REST API has per-user rate limits. For large space imports, do we queue page fetches with a delay, or fetch in parallel and handle 429s?
- **Image handling** — Confluence images are stored in Confluence and require auth to access. The current plan (link by URL) means images break if the Confluence page is moved or deleted. Should we copy images to SyncDocs storage instead?
- **Scheduled pull granularity** — scheduled pulls operate at the space level in v1. Should users be able to schedule individual page pulls?
- **#45 impact** — if issue #45 involves the OAuth connection flow or the integration settings UI, the pull-only strategy simplifies the required OAuth scopes to read-only (`read:confluence-content.all`), which affects the OAuth consent screen and the scope list defined in #45.
