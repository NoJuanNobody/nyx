# Real-Time Collaboration

**Issue:** #43
**Status:** Planned
**Priority:** P2 — Post-MVP

---

## Overview

SyncDocs currently supports only single-user document editing. This feature adds real-time collaborative editing, allowing multiple users to work on the same document simultaneously with live cursors, presence indicators, and automatic conflict resolution. Edits from all participants merge seamlessly and become part of the existing document version history.

## Goals

- Allow multiple users to edit the same document at the same time without conflicts or data loss
- Show each user where their collaborators are working (cursors, selections, names)
- Handle network interruptions gracefully — offline edits sync when connection is restored
- Integrate with the existing version history so real-time sessions produce trackable versions
- Keep latency low enough that typing feels local (target: <100ms round-trip on the same continent)

---

## Collaboration model: CRDT (decided)

> **Decision:** CRDT via Yjs is the chosen approach. OT is documented below for context only.

Two established approaches exist for merging concurrent edits:

### Operational Transform (OT)

OT sends operations (insert, delete) to a central server that transforms them against concurrent operations before broadcasting to clients. All clients send ops through the server; the server is the source of truth.

**Trade-offs:**

| | OT |
|---|---|
| **Latency** | Every keystroke requires a server round-trip before it can be confirmed |
| **Consistency** | Server-authoritative — single source of truth, no divergence |
| **Complexity** | Transform functions are notoriously hard to implement correctly for rich text |
| **Offline** | Difficult — the server is required to transform ops |
| **Examples** | Google Docs (original), ShareDB |

### CRDT (Conflict-free Replicated Data Type)

CRDTs are data structures where any two replicas can merge without coordination. Each client applies edits locally and syncs state with peers; the merge is deterministic and commutative.

**Trade-offs:**

| | CRDT |
|---|---|
| **Latency** | Local-first — edits apply immediately, sync asynchronously |
| **Consistency** | Eventually consistent — no central authority needed |
| **Complexity** | Library-level complexity hidden from application code (Yjs, Automerge) |
| **Offline** | Native — local edits accumulate and sync on reconnect |
| **Examples** | Figma, Linear, Notion (partial) |

### Recommendation: CRDT via Yjs

**Use Yjs** for the following reasons:

1. **Offline-first fits SyncDocs** — users editing specs in airplanes or spotty connections should not lose work. Yjs accumulates local changes and merges cleanly on reconnect with no server involvement.
2. **Mature ecosystem** — Yjs has first-class bindings for CodeMirror, ProseMirror, and TipTap, as well as a maintained WebSocket provider (`y-websocket`). Since SyncDocs uses a plain markdown `<textarea>` editor, `Y.Text` integration is straightforward without requiring a rich-text editor binding.
3. **No transform complexity** — OT transform functions for rich text are a known source of subtle bugs. Yjs's CRDT semantics make merge correctness a library guarantee.
4. **Horizontal scalability** — WebSocket servers can be stateless coordination layers; the document state lives in the CRDT, not the server.

---

## Technology options

### Yjs (recommended)

- **Package:** `yjs`, `y-websocket`, `y-indexeddb` (offline persistence)
- **Editor binding:** `y-codemirror.next` or `y-prosemirror` depending on editor choice
- **Server:** `y-websocket` server — thin Node.js WebSocket relay, no document logic
- **Persistence:** Yjs updates stored in PostgreSQL as binary blobs; `y-indexeddb` for browser-side offline buffer

### Automerge

- Newer CRDT library from the Ink & Switch research team
- Better typed (TypeScript-first), more readable state inspection
- Smaller ecosystem than Yjs; fewer editor bindings available today
- A viable future alternative but not recommended for MVP-adjacent work

### Custom WebSocket sync

- Building a custom OT or CRDT implementation is strongly discouraged
- Correctness guarantees are extremely difficult to achieve, and production-grade libraries (Yjs) have millions of hours of real-world testing

---

## Presence indicators

### What to show

Each connected user is represented by:

- **Live cursor** — colored caret at their current insertion point in the editor
- **Selection highlight** — translucent colored range overlay for any selected text
- **Name tooltip** — user display name shown above or beside the cursor, auto-hiding after 3s of inactivity
- **Avatar cluster** — compact row of user avatars in the document header showing who is currently viewing or editing
- **Connection status badge** — dim avatar with "reconnecting…" label for users with disrupted connections

### Design

```
┌──────────────────────────────────────────────────────────────┐
│  Auth Spec                                     👤 Maria  👤 Dev│
│ ─────────────────────────────────────────────────────────────│
│  ## Authentication Flow                                       │
│                                                               │
│  Users authenticate via OAuth2 with JWT tokens.              │
│                                          ▲                    │
│                                      ┌──┴──┐                 │
│                                      │Maria│  ← name tooltip │
│  Session tokens expire after 24 hou|rs and...                 │
│                                     ↑                         │
│                            blue caret (Dev's cursor)          │
└──────────────────────────────────────────────────────────────┘
```

- Each user gets a stable color assigned at session start (from a palette of 8 accessible colors, cycling on overflow)
- Colors persist for the document session — the same user always has the same color within a session
- Cursor and avatar colors match

### Presence data

Presence is transmitted via Yjs awareness protocol — lightweight per-client state (user name, color, cursor position, selection range) broadcast to all connected peers. No presence data is stored in the database; it is ephemeral and lives only in active WebSocket sessions.

---

## Conflict resolution strategy

Yjs CRDT semantics handle concurrent edits automatically:

| Scenario | Resolution |
|----------|-----------|
| Two users insert text at the same position | Both insertions are preserved; Yjs uses deterministic tie-breaking (client ID) to order them |
| User A deletes a range while User B edits inside it | B's edits are preserved within the surviving text; A's delete wins for the surrounding content |
| Two users delete the same range | Idempotent — the result is deleted once |
| Network partition — users edit offline | Edits accumulate locally; on reconnect, Yjs merges all updates without manual conflict resolution |

For **structural conflicts** (e.g., two users simultaneously deleting the same section and inserting different content), the CRDT will merge both edits mechanically. This may produce unexpected results. To address this:

- Show a **merge notification** via the AI Advisor panel when a large divergence is detected after reconnect (>50 concurrent characters changed in the same section)
- Allow users to trigger a manual diff review of changes made while they were offline

There are no manual conflict resolution dialogs for character-level edits — the CRDT handles these automatically and the result is always deterministic.

---

## Architecture

### Component overview

```
┌─────────────────────┐        ┌──────────────────────────┐
│   Browser (User A)  │        │   Browser (User B)        │
│                     │        │                           │
│  ┌───────────────┐  │        │  ┌────────────────────┐  │
│  │ Editor        │  │        │  │ Editor             │  │
│  │ (Yjs binding) │  │        │  │ (Yjs binding)      │  │
│  └──────┬────────┘  │        │  └────────┬───────────┘  │
│         │ Y.Doc     │        │           │ Y.Doc         │
│  ┌──────▼────────┐  │        │  ┌────────▼───────────┐  │
│  │ y-websocket   │  │        │  │ y-websocket        │  │
│  │ provider      │  │        │  │ provider           │  │
│  └──────┬────────┘  │        │  └────────┬───────────┘  │
│         │           │        │           │               │
│  ┌──────▼────────┐  │        │           │               │
│  │ y-indexeddb   │  │        │           │               │
│  │ (offline buf) │  │        │           │               │
│  └───────────────┘  │        │           │               │
└─────────┬───────────┘        └───────────┬───────────────┘
          │                                │
          │  WebSocket (wss://)            │
          └──────────────┬─────────────────┘
                         │
              ┌──────────▼──────────┐
              │  Collaboration      │
              │  Server             │
              │  (y-websocket)      │
              │                     │
              │  - Routes updates   │
              │    between clients  │
              │  - Persists Y.Doc   │
              │    snapshots to DB  │
              │  - Broadcasts       │
              │    awareness state  │
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  PostgreSQL         │
              │                     │
              │  - Y.Doc binary     │
              │    snapshots        │
              │  - Version history  │
              └─────────────────────┘
```

### WebSocket server

- Runs as a separate process (or sidecar) alongside the main Express/Fastify API
- Authenticates connections using the same JWT tokens issued by the main API — no separate auth
- Each document has its own WebSocket room identified by `documentId`
- The server does not parse or understand CRDT operations; it relays Yjs binary update messages between clients
- Stateless routing: any server instance can handle any client for the same document (updates are broadcast to all peers in the room)

### Connection lifecycle

```
Client connects
      │
      ▼
Authenticate JWT (HTTP upgrade headers)
      │
      ├─ Invalid token ──▶ Close with 4001 Unauthorized
      │
      ▼
Join document room (documentId)
      │
      ▼
Server sends full Y.Doc state (binary snapshot from DB)
      │
      ▼
Client merges server state with local IndexedDB state
      │
      ▼
Two-way update stream: client ↔ server ↔ all other clients
      │
      ▼
Client disconnects (tab close, network drop, idle timeout)
      │
      ▼
Server flushes pending updates to DB snapshot
Server broadcasts awareness update (user left)
```

### Reconnection handling

- `y-websocket` provider handles reconnection automatically with exponential backoff
- While disconnected, `y-indexeddb` buffers all local edits
- On reconnect: client sends all buffered updates → server merges and broadcasts → other clients receive the delta
- If a client is offline for more than 24 hours, a "You were offline" banner prompts the user to review changes since their last sync

### Scaling

- For MVP: a single `y-websocket` process handles all rooms
- For scale: use a Redis pub/sub adapter so multiple `y-websocket` instances can share document rooms across pods
- Maximum concurrent editors per document: **5 (free tier) / 10 (paid tier)** (enforced at the WebSocket room join step; users over the limit see a read-only markdown preview)

---

## Integration with document versioning

Real-time editing sessions must produce trackable versions in the existing history.

### Session-to-version conversion

1. **Autosave** — every 30 seconds during an active session, the current Y.Doc state is serialized to a PostgreSQL row as a draft autosave (not a formal version)
2. **Session end** — when the last collaborator disconnects from a document room, the server creates a formal version snapshot. This version appears in the document history timeline as `"Collaborative session — N contributors"`
3. **Explicit save** — users can click "Save version" at any time during collaboration to create a named checkpoint (equivalent to a git commit during a pairing session)
4. **Version attribution** — each version stores a list of all user IDs who contributed during the session. The blame/attribution view shows per-character attribution where Yjs tracking supports it

### Relationship to diff view

The existing diff view compares any two stored versions. Real-time sessions produce versions, so:
- Users can diff "before collaboration" vs "after session" to see the aggregate change
- Individual autosave snapshots are stored but hidden from the main timeline by default (accessible via "Show autosaves" toggle)

---

## Performance

### Latency targets

| Operation | Target |
|-----------|--------|
| Local keystroke visible in editor | <16ms (synchronous, no network) |
| Keystroke visible to collaborators (same region) | <100ms |
| Keystroke visible to collaborators (cross-continent) | <300ms |
| Cursor position update | <50ms same region |
| Reconnect and sync (small delta, <10KB) | <2s |
| Reconnect and sync (large offline delta, <1MB) | <10s |

### Max concurrent editors

- **Free tier: up to 5 simultaneous editors** — enforced at the WebSocket room join; users beyond this limit are connected in read-only markdown preview mode (no editor interface, markdown rendered as preview)
- **Paid tier: up to 10 simultaneous editors** — above this, cursor noise degrades the editing experience; additional users are connected in read-only markdown preview mode
- Read-only users can still view others' cursors but cannot type or make edits

### Message size

- Yjs updates are binary-encoded and typically <1KB per keystroke
- Awareness updates (cursor position) are batched and sent at most every 50ms to avoid flooding

### Database impact

- Autosave writes are batched: at most one write per document per 30 seconds (debounced)
- Y.Doc binary snapshots replace prior snapshots (upsert), not appended — storage is bounded by document size
- Formal version snapshots are immutable and append-only (same as today)

---

## Offline support and sync-on-reconnect

### Offline editing

- `y-indexeddb` persists the Y.Doc locally in IndexedDB
- When offline, the user continues editing normally — all edits apply locally
- A status indicator in the editor header shows "Offline — changes saved locally"
- Other collaborators see the offline user's avatar dimmed with a "reconnecting" label

### Sync-on-reconnect

1. Client reconnects to WebSocket server
2. Client sends all buffered Y.Doc updates (everything since last sync)
3. Server applies updates to the document state and broadcasts the delta to other connected clients
4. Client receives any updates from other users that occurred while offline
5. Yjs merges all changes deterministically — no user action required for character-level edits
6. If a large divergence is detected (>50 concurrent changes in a section), the AI Advisor panel posts a "Merged offline edits — review changes" notification

### Offline limitations

- Presence indicators are not available offline (ephemeral, requires live connection)
- Comments and annotations are not synced offline in v1 (they are stored server-side, not in the Y.Doc)

---

## Impact on existing markdown editor component

The existing `DocumentEditor` component requires the following changes:

| Change | Detail |
|--------|--------|
| **Yjs binding** | Wrap the editor's content model in a `Y.Text` type (the markdown `<textarea>` stays as-is; `Y.Text` maps directly to plain text content). Replace the current `useState` for content with the Yjs-backed model. |
| **Provider wiring** | Add `y-websocket` provider initialization on document open. Provide `documentId` and auth token. |
| **Presence rendering** | Add cursor and selection overlay components. Yjs awareness API provides the raw data; a `CollaboratorCursors` component renders the overlays. |
| **Connection status UI** | Add a header bar element showing collaborator avatars and connection state. |
| **Offline indicator** | Show "Offline" banner when WebSocket provider reports disconnected state. |
| **Version save** | "Save version" button triggers an explicit version snapshot via the existing versioning API plus a Y.Doc binary flush. |
| **Read-only mode** | When document is locked or user is over the tier editor limit, disable all Yjs writes and render the document in markdown preview mode (no editor interface). Keep the provider connected so the user can still see others' cursors. |

---

## Relationship to notifications (#42)

The notifications feature (#42) handles system-level alerts. Real-time collaboration generates two categories of events that intersect:

| Event | Handling |
|-------|----------|
| **User joins your document** | Presence indicator in editor (not a notification — too frequent/expected) |
| **User leaves a comment while you're editing** | Notification (#42) — appears in AI Advisor panel as "Maria left a comment on §3" |
| **Offline merge with large divergence** | AI Advisor panel notification (see above) |
| **Collaborator session ends and version is created** | Notification for non-active users: "The auth spec was updated by Maria and Dev" |

In-editor presence (cursors, avatars) is handled by this feature. Cross-session and async notifications are handled by #42.

---

## E2E Testing

### Critical user flows

1. **Two users editing the same document see each other's cursors**
2. **Edits from one user appear in the other user's editor without page refresh**
3. **User goes offline, makes edits, reconnects, and edits sync to other clients**
4. **Third user joining an in-progress session receives the current document state**
5. **Last collaborator disconnecting triggers a version snapshot**
6. **Editor limit is enforced by tier (5 free / 10 paid) — users beyond the limit are read-only in markdown preview mode**
7. **Unauthenticated WebSocket connection is rejected**

---

### Test scenarios

#### Scenario 1 — Basic two-user co-editing

```
Given two authenticated users (Alice and Bob) open the same document
When Alice types "Hello" at the beginning of the document
Then Bob sees "Hello" appear in his editor within 2 seconds
And Alice sees Bob's cursor rendered in the editor
```

#### Scenario 2 — Concurrent edits at different positions

```
Given Alice is editing paragraph 1 and Bob is editing paragraph 3
When both users type simultaneously
Then both users see both sets of edits without either being lost
And the merged document contains all text from both users
```

#### Scenario 3 — Offline edit sync-on-reconnect

```
Given Alice and Bob are co-editing a document
When Alice's network connection drops
And Alice types "offline edit" into the document
And Bob types "online edit" into the document
When Alice's connection is restored
Then Alice sees "online edit" in her editor
And Bob sees "offline edit" in his editor
And the document contains both edits
```

#### Scenario 4 — New user joins in-progress session

```
Given Alice has been editing a document for 5 minutes
When Carol opens the same document
Then Carol's editor loads the full current state (including Alice's edits)
And Alice sees Carol's avatar appear in the presence bar
And Carol sees Alice's cursor in the editor
```

#### Scenario 5 — Version snapshot on session end

```
Given Alice and Bob are co-editing a document
When both users close the document tab (simulated by disconnecting WebSocket)
Then a new version appears in the document history
And the version is attributed to both Alice and Bob
And the version content matches the final merged document state
```

#### Scenario 6 — Editor limit enforcement

```
Given the tier editor limit is reached (5 users on free tier, or 10 users on paid tier)
When an additional user opens the document
Then the additional user sees the document in read-only markdown preview mode (not the editor)
And the user can see other users' cursors but cannot type or make edits
And an informational banner explains "Max editors reached — viewing in read-only mode"
```

#### Scenario 7 — Unauthenticated WebSocket rejection

```
Given a WebSocket connection attempt with no Authorization header
When the connection handshake completes
Then the server closes the connection with code 4001
And the client receives no document data
```

---

### Integration boundaries

| Dependency | Test approach |
|------------|--------------|
| **WebSocket server** | Spin up a real `y-websocket` server instance in the test environment using `TEST_COLLAB_WS_URL` |
| **PostgreSQL** | Use a dedicated test database — seed with fixture documents, verify version snapshot writes |
| **Authentication (JWT)** | Use test JWTs generated by the auth test helper — do not mock the JWT verification path |
| **IndexedDB (offline buffer)** | Use Playwright's `page.context().grantPermissions()` and network interception to simulate offline mode |
| **Other collaborators** | Use multiple Playwright browser contexts (not mocked) — each context acts as a separate user |

Do **not** mock the Yjs library or WebSocket transport in E2E tests — these are the core integration points being validated.

---

### Test data requirements

#### Fixture documents

- `fixture-collab-empty.md` — blank document, used for co-edit-from-scratch tests
- `fixture-collab-populated.md` — document with 500+ words across multiple sections, used for concurrent-edit and offline-sync tests
- `fixture-collab-locked.md` — document with locked status, used to verify read-only enforcement

#### Seed data

- Two standard test users: `alice@test.syncdocs.dev` and `bob@test.syncdocs.dev`
- One additional user for join-in-progress tests: `carol@test.syncdocs.dev`
- Users must be members of the same team and have editor permissions on all fixture documents
- Test JWTs with 1-hour expiry for each test user (generated by `tests/helpers/auth.ts`)

#### Team and integration setup

- A single test team (`collab-test-team`) owns all fixture documents
- No external integrations (GitHub, Jira) required for collaboration E2E tests
- WebSocket server must be running and reachable at `TEST_COLLAB_WS_URL` before tests start

---

### Playwright test file locations

```
tests/
└── e2e/
    └── collaboration/
        ├── co-editing.spec.ts          # Scenarios 1–2: basic two-user co-edit
        ├── offline-sync.spec.ts        # Scenario 3: offline edit and reconnect
        ├── session-join.spec.ts        # Scenario 4: new user joins in-progress session
        ├── version-snapshot.spec.ts    # Scenario 5: version created on session end
        ├── editor-limit.spec.ts        # Scenario 6: read-only enforcement at tier limits (5 free / 10 paid)
        └── auth.spec.ts                # Scenario 7: unauthenticated WebSocket rejection
```

Shared helpers:

```
tests/
└── helpers/
    ├── collab.ts     # openDocumentAsUser(), waitForCursor(), simulateOffline()
    └── auth.ts       # generateTestJWT(), createTestUser() (already exists or to be created)
```

---

### CI considerations

#### Environment variables required

| Variable | Description |
|----------|-------------|
| `TEST_COLLAB_WS_URL` | WebSocket URL of the collaboration server in CI (e.g., `ws://localhost:1234`) |
| `TEST_DATABASE_URL` | PostgreSQL connection string for the test database |
| `TEST_JWT_SECRET` | Secret used to sign test JWTs — must match the collaboration server config |
| `BASE_URL` | Frontend URL (already used by existing E2E tests) |

#### Service containers in CI

The collaboration E2E tests require two service containers in addition to the standard PostgreSQL container:

```yaml
# .github/workflows/ci.yml (additions for collaboration tests)
services:
  postgres:
    # already defined
  collab-server:
    image: node:20
    ports:
      - 1234:1234
    env:
      PORT: 1234
      DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}
      JWT_SECRET: ${{ secrets.TEST_JWT_SECRET }}
    # run: node backend/collab-server.js
```

#### Multi-context Playwright setup

Collaboration tests require multiple browser contexts in a single test. Ensure `playwright.config.ts` does not force single-worker mode globally — collaboration tests must run with `workers: 1` for their own spec files (to avoid port conflicts) but the rest of the suite can parallelize.

```typescript
// tests/e2e/collaboration/co-editing.spec.ts
test('two users see each other edits', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  // ...
});
```

#### Flakiness considerations

- Collaboration E2E tests are inherently timing-sensitive. Use `expect.poll()` with a 3-second timeout when waiting for remote edits to appear, rather than fixed `waitForTimeout`.
- Network simulation (offline mode) via `page.route('**/collab-ws/**', route => route.abort())` is more reliable than `page.context().setOffline()` for WebSocket testing.
- Tag all collaboration specs with `@slow` and run them as a separate job in CI with a 10-minute timeout to avoid blocking the fast feedback loop.

---

## Decisions

- **CRDT over OT** — CRDT (via Yjs) is the chosen collaboration model. OT requires server round-trips for every keystroke and is difficult to implement correctly for rich/plain text; CRDT is offline-first, horizontally scalable, and offloads correctness to the Yjs library.
- **Rich text vs. plain markdown** — The existing markdown `<textarea>` editor is kept for now. Use `Y.Text` for Yjs integration — simpler to wire up than a ProseMirror/TipTap binding and sufficient for plain text collaborative editing.
- **Awareness persistence** — Presence is strictly ephemeral. Cursor positions are not persisted across browser refresh. Presence lives only in active WebSocket sessions via the Yjs awareness protocol.
- **Pricing and limits** — Real-time collaboration has tier-based editor limits: **5 simultaneous editors on the free tier**, **10 on paid**. Users beyond the limit connect in read-only markdown preview mode. This aligns with the familiar Google Docs model while gating power usage to paid plans.
- **Session attribution granularity** — Per-session attribution is sufficient for MVP (all contributing user IDs listed at the version level). Per-character attribution via Yjs client IDs is deferred — it adds storage and query complexity that is not needed now. Revisit post-MVP if blame/annotation features are prioritized.

## Open questions

- **Comment sync** — comments and inline annotations are currently stored server-side. Should they be part of the Y.Doc (synced in real time) or remain async?
