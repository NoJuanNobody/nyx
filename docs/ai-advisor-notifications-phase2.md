# AI Advisor Notifications — Phase 2 Implementation Guide

**Issue:** [#50 — ai advisor notifications enhancement](https://github.com/NoJuanNobody/syncdocs/issues/50)
**Status:** Deferred (post-Phase 1)
**Phase 1 baseline:** Tier 1 notifications (quality analysis + stage guide) are live in `AIAdvisor.tsx`.

---

## Overview

Phase 1 shipped the AI Advisor panel with Tier 1 notifications. Phase 2 completes the full notification spec by adding Tier 2 and Tier 3 notification types, backend infrastructure for server-pushed notifications, UX polish (reply round-trip, AI Chat handoff, suppress-by-type, swipe-to-dismiss), and the full E2E test suite.

---

## Current State (Phase 1 Baseline)

| Layer | File | What exists |
|-------|------|-------------|
| Frontend component | `apps/web/src/components/AIAdvisor.tsx` | Tier 1 quality + stage guide notifications, collapse/expand, clear all, reply UI (no send logic) |
| API client | `apps/web/src/lib/api.ts` | `analyzeSpecQuality`, `editDocumentAI`, `seedNextStage` |
| Backend routes | `apps/api/src/routes/ai.ts` | `/analyze`, `/detect-drift`, `/edit-document`, `/seed-next-stage`, `/generate-ticket`, `/jsx-preview` |
| AI service | `apps/api/src/services/ai.service.ts` | `analyzeSpecQuality`, `detectDrift`, `editDocument`, `seedNextStage` |
| E2E tests | `e2e/ai-advisor-panel.spec.ts` | Tests 1–10 (Tier 1 + panel mechanics) |

---

## Phase 2 Features

### 1. Pre-fill Offer Notification (Tier 2)

**What it does:** When a document stage is set but content is sparse (< 100 chars), show a Tier 2 notification offering to pre-fill the document from the current stage template.

**Backend work required:**

Add a new route to `apps/api/src/routes/ai.ts`:

```typescript
// POST /api/ai/seed-from-stage
// Seeds a blank document with stage-appropriate starter content
app.post('/seed-from-stage', async (request, reply) => {
  const { stage, title } = request.body as { stage: string; title?: string };
  if (!stage) { reply.code(400); return { error: 'stage is required' }; }
  const result = await aiService.seedFromStage(stage, title);
  return result; // { content: string, title: string }
});
```

Add to `apps/api/src/services/ai.service.ts`:

```typescript
async seedFromStage(stage: string, title?: string): Promise<{ content: string; title: string }> {
  // Prompt: "Generate a starter document for the {stage} lifecycle stage..."
  // Returns structured markdown with section headers appropriate for the stage
}
```

Add to `apps/web/src/lib/api.ts`:

```typescript
export async function seedFromStage(
  stage: string,
  title?: string,
): Promise<{ content: string; title: string }>
```

**Frontend integration in `AIAdvisor.tsx`:**

```typescript
// Trigger condition: stage is set AND content.trim().length < 100
// Notification type: 'prefill_offer'
// Tier: 2
// CTAs: "Pre-fill for me" (primary) | "Dismiss" (ghost)
// "Pre-fill for me" onClick: calls seedFromStage(stage, documentTitle), then onApplyEdit(result.content)
```

**Test IDs to add:**

```
[data-testid="advisor-notification-prefill_offer"]
```

---

### 2. Drift Detected Notification (Tier 2)

**What it does:** When a linked GitHub repo pushes code changes, detect drift between spec and code and surface a Tier 2 notification in the editor.

**Backend infrastructure required:**

1. **GitHub webhook handler** — add to `apps/api/src/routes/`:

```typescript
// POST /api/webhooks/github
// Triggered on push events; finds documents linked to the repo,
// runs drift detection, stores result in `timeline_events`
```

2. **Drift event storage** — use the existing `timeline_events` table:

```typescript
// event type: 'drift_detected'
// payload: { hasDrift: boolean, driftScore: number, details: string, suggestions: string[], codeRef: string }
```

3. **Server-Sent Events (SSE) or polling endpoint** for the frontend:

```typescript
// GET /api/documents/:id/events?since=<timestamp>
// Returns recent timeline_events for the document
// Frontend polls every 30s or subscribes via SSE
```

**Frontend integration:**

Use React Query (already in the stack) to poll or subscribe:

```typescript
// In DocumentEditor.tsx or AIAdvisor.tsx:
// useQuery(['document-events', documentId], ..., { refetchInterval: 30_000 })
// On new 'drift_detected' event → inject Tier 2 notification
```

Notification shape:

```typescript
{
  tier: 2,
  type: 'drift_detected',
  title: 'Drift detected',
  body: `Spec may be out of sync with recent code changes.\n${details}`,
  accentColor: 'bg-orange-400',
  ctas: [
    { label: 'View diff', variant: 'primary', onClick: () => { /* open drift diff view */ } },
    { label: 'Dismiss', variant: 'ghost', onClick: () => dismissNotification(id) },
  ],
}
```

**Test IDs to add:**

```
[data-testid="advisor-notification-drift_detected"]
```

---

### 3. Stage Transition Nudge (Tier 2)

**What it does:** When the AI quality score is consistently high (≥ 8) for a given stage, surface a Tier 2 notification suggesting the document is ready to advance to the next stage.

**Backend work required:**

Add a maturity-detection pass to `apps/api/src/services/ai.service.ts`:

```typescript
async checkStageMaturity(
  content: string,
  currentStage: string,
): Promise<{ ready: boolean; nextStage: string | null; rationale: string }>
```

This can run as a secondary debounced call (separate from quality analysis, ~10s debounce) so it doesn't add latency to the quality badge.

Add route to `apps/api/src/routes/ai.ts`:

```typescript
// POST /api/ai/check-maturity
app.post('/check-maturity', async (request, reply) => {
  const { content, stage } = request.body as { content: string; stage: string };
  if (!content || !stage) { reply.code(400); return { error: 'content and stage are required' }; }
  return await aiService.checkStageMaturity(content, stage);
});
```

**Frontend integration in `AIAdvisor.tsx`:**

```typescript
// Second debounce ref: matureDebounceRef (10s)
// Only fires when qualityScore >= 8 (use a ref to track last score)
// Calls checkMaturity(content, stage)
// If result.ready: inject 'stage_transition' Tier 2 notification
// CTAs: "Advance stage" (primary → calls onStageChange(result.nextStage)) | "Not yet" (ghost → dismiss)
```

Notification shape:

```typescript
{
  tier: 2,
  type: 'stage_transition',
  title: `Ready for ${nextStageLabel}?`,
  body: rationale,
  accentColor: 'bg-blue-400',
  ctas: [
    { label: `Advance to ${nextStageLabel}`, variant: 'primary', onClick: () => onStageChange(nextStage) },
    { label: 'Not yet', variant: 'ghost', onClick: () => dismissNotification(id) },
  ],
}
```

**Test IDs to add:**

```
[data-testid="advisor-notification-stage_transition"]
```

---

### 4. Missing Section Alert (Tier 3)

**What it does:** Analyses the document for required sections based on its stage and flags any that are missing.

**Backend work required:**

```typescript
// POST /api/ai/check-sections
// Request: { content: string, stage: string }
// Response: { missingSections: string[], presentSections: string[] }
```

Add `checkMissingSections` to `ai.service.ts`. The prompt should compare document headings against a canonical section list per lifecycle stage (defined in `stages.ts` or a config file).

**Frontend integration:**

- Debounced alongside quality analysis (use the same 3s timer, run in parallel with `analyzeSpecQuality`)
- Only inject notification if `missingSections.length > 0`

Notification shape:

```typescript
{
  tier: 3,
  type: 'missing_sections',
  title: 'Missing required sections',
  body: missingSections.join('\n'),
  accentColor: 'bg-yellow-400',
  ctas: [
    { label: 'Add sections', variant: 'primary', onClick: () => { /* inject section templates */ } },
    { label: 'Dismiss', variant: 'ghost', onClick: () => dismissNotification(id) },
  ],
}
```

**Test IDs to add:**

```
[data-testid="advisor-notification-missing_sections"]
```

---

### 5. Spec Conflict Notification (Tier 3)

**What it does:** Detects when the current document conflicts with other documents in the same workspace (e.g., contradictory requirements across spec and architecture docs).

**Backend work required:**

This requires cross-document retrieval. Suggested approach:

1. Store document content embeddings (add `embedding` column to `documents` table, use `pgvector` extension).
2. On document save, compute embedding and find nearest neighbours.
3. Run a conflict-detection prompt across the top-N related documents.

```typescript
// POST /api/ai/check-conflicts
// Request: { documentId: string, content: string }
// Response: { hasConflict: boolean, conflictingDocuments: Array<{ id: string, title: string, detail: string }> }
```

**Frontend integration:**

- Trigger on manual save (not debounced — expensive call)
- Only surface if `hasConflict: true`

Notification shape:

```typescript
{
  tier: 3,
  type: 'spec_conflict',
  title: 'Spec conflict detected',
  body: conflictingDocuments.map(d => `"${d.title}": ${d.detail}`).join('\n'),
  accentColor: 'bg-red-400',
  ctas: [
    { label: 'Review conflicts', variant: 'primary', onClick: () => { /* navigate to conflict view */ } },
    { label: 'Dismiss', variant: 'ghost', onClick: () => dismissNotification(id) },
  ],
}
```

**Test IDs to add:**

```
[data-testid="advisor-notification-spec_conflict"]
```

---

### 6. Stale Document Notification (Tier 3)

**What it does:** Surfaces a notification when code has been committed to the linked repo but the document hasn't been updated in N days.

**Backend work required:**

1. Track `lastCodeActivityAt` per document (update on webhook push events).
2. Add a scheduled job (cron or background worker) that runs daily:
   - Finds documents where `lastCodeActivityAt > updatedAt + staleness_threshold_days`
   - Creates a `timeline_event` of type `'stale_document'`
3. Frontend polls `GET /api/documents/:id/events` and injects notification on `stale_document` events.

```typescript
// In schema.ts — add to documents table:
lastCodeActivityAt: timestamp('last_code_activity_at'),
```

Notification shape:

```typescript
{
  tier: 3,
  type: 'stale_document',
  title: 'Document may be stale',
  body: `Code was last updated ${daysAgo} days ago but this document hasn't changed.`,
  accentColor: 'bg-slate-400',
  ctas: [
    { label: 'Update now', variant: 'primary', onClick: () => { /* focus editor */ } },
    { label: 'Dismiss', variant: 'ghost', onClick: () => dismissNotification(id) },
  ],
}
```

**Test IDs to add:**

```
[data-testid="advisor-notification-stale_document"]
```

---

## UX Features

### 7. Text Reply → AI Processing (Round-Trip)

**Current state:** `AIAdvisor.tsx:459-464` — "Send" button clears `replyToId` and `replyText` without doing anything.

**What to build:**

Add a reply API endpoint:

```typescript
// POST /api/ai/reply
// Request: { notificationId: string, replyText: string, notificationType: string, documentContent: string }
// Response: { updatedNotification: Partial<AdvisorNotification> } | { content: string } (for edits)
```

In `AIAdvisor.tsx`, wire the Send button:

```typescript
const handleReplySend = async () => {
  if (!replyText.trim() || !replyToId) return;
  const notif = notifications.find(n => n.id === replyToId);
  setNotifStatus(replyToId, 'loading');
  try {
    // For quality notifications: treat reply as an edit instruction
    if (notif?.type === 'quality') {
      const result = await editDocumentAI(content, replyText, conversationHistory);
      onApplyEdit?.(result.content);
      setNotifStatus(replyToId, 'success', 'Applied your instruction — review the proposed changes');
    }
    // For other types: get an updated notification body
    else {
      const result = await replyToAdvisor(replyToId, replyText, notif?.type, content);
      // Update notification body with AI's response
      setNotifications(prev => prev.map(n =>
        n.id === replyToId ? { ...n, body: result.responseText } : n
      ));
    }
  } catch {
    setNotifStatus(replyToId, 'idle');
  }
  setReplyText('');
  setReplyToId(null);
};
```

---

### 8. Handoff to AI Chat

**What to build:**

Add a "Continue in AI Chat →" ghost CTA to notifications where `replyEnabled: true`. The CTA should call `onOpenAIChat` (already in `AIAdvisorProps`) with a serialized context payload:

```typescript
{
  label: 'Continue in AI Chat →',
  variant: 'ghost',
  onClick: () => onOpenAIChat?.({
    notificationType: notif.type,
    notificationBody: notif.body,
    documentContent: content,
    stage,
  }),
}
```

Wire `onOpenAIChat` in `DocumentEditor.tsx` to open the `UnifiedAIPanel` (already exists at `apps/web/src/components/UnifiedAIPanel.tsx`) with the pre-populated context.

**Test IDs to add:**

```
[data-testid="ai-advisor-open-chat"]   // on the CTA button
```

---

### 9. Suppress by Type (Right-Click Context Menu)

**What to build:**

Add a right-click context menu to `NotificationCard` that shows "Stop showing [type] notifications". Store suppressed types in `localStorage`:

```typescript
const SUPPRESSED_KEY = 'ai-advisor-suppressed-types';
const [suppressedTypes, setSuppressedTypes] = useState<string[]>(
  () => JSON.parse(localStorage.getItem(SUPPRESSED_KEY) ?? '[]')
);

const suppressType = (type: string) => {
  const updated = [...suppressedTypes, type];
  setSuppressedTypes(updated);
  localStorage.setItem(SUPPRESSED_KEY, JSON.stringify(updated));
  setNotifications(prev => prev.filter(n => n.type !== type));
};
```

Filter incoming notifications against `suppressedTypes` before adding to state.

Add a "Manage notifications" link in the panel footer to allow unsuppressing types.

**Test IDs to add:**

```
[data-testid="advisor-notification-context-menu"]     // right-click menu
[data-testid="advisor-suppress-type"]                 // "Stop showing these" button
[data-testid="ai-advisor-manage-notifications"]       // manage link
```

---

### 10. Auto-Expand Suppression — Cross-Document Persistence

**Current state:** `AIAdvisor.tsx:175-176` — `collapseCountRef` and `lastCollapseTimeRef` are in-component refs, reset on every document navigation.

**What to build:**

Persist the collapse counter to `sessionStorage` keyed by `documentId`:

```typescript
const COLLAPSE_KEY = (docId: string) => `ai-advisor-collapse-${docId}`;

// On mount: restore from sessionStorage
useEffect(() => {
  if (!documentId) return;
  const stored = sessionStorage.getItem(COLLAPSE_KEY(documentId));
  if (stored) {
    const { count, lastTime } = JSON.parse(stored);
    collapseCountRef.current = count;
    lastCollapseTimeRef.current = lastTime;
  }
}, [documentId]);

// In handleCollapse: persist
const handleCollapse = () => {
  setExpanded(false);
  const now = Date.now();
  lastCollapseTimeRef.current = now;
  collapseCountRef.current += 1;
  if (documentId) {
    sessionStorage.setItem(COLLAPSE_KEY(documentId), JSON.stringify({
      count: collapseCountRef.current,
      lastTime: now,
    }));
  }
};
```

---

### 11. Swipe-to-Dismiss Gesture

**What to build:**

Add touch event handlers to `NotificationCard` for swipe-left-to-dismiss:

```typescript
const touchStartX = useRef<number | null>(null);

const handleTouchStart = (e: React.TouchEvent) => {
  touchStartX.current = e.touches[0].clientX;
};

const handleTouchEnd = (e: React.TouchEvent) => {
  if (touchStartX.current === null) return;
  const delta = touchStartX.current - e.changedTouches[0].clientX;
  if (delta > 60) onDismiss(); // swipe left > 60px
  touchStartX.current = null;
};
```

Add a CSS transition on `transform: translateX` controlled by a `dragging` state for visual feedback.

---

## E2E Test Coverage (Phase 2)

The following tests should be added to `e2e/ai-advisor-panel.spec.ts` once the infrastructure above is in place. Tests are grouped by feature.

### Tier 2 Notifications (Tests 11–20)

| # | Scenario | Trigger | Expected |
|---|----------|---------|----------|
| 11 | Pre-fill offer appears on sparse + staged doc | Set stage, clear content | `advisor-notification-prefill_offer` visible |
| 12 | Pre-fill offer → "Pre-fill for me" populates editor | Click CTA | Editor content updated, notification auto-dismisses |
| 13 | Pre-fill offer dismissed | Click X | Notification removed |
| 14 | Drift detected notification on mock webhook push | Mock `GET /api/documents/:id/events` response | `advisor-notification-drift_detected` visible, panel auto-expands |
| 15 | Drift "View diff" CTA opens drift view | Click CTA | Drift view panel opens |
| 16 | Drift notification dismissed | Click X | Notification removed |
| 17 | Stage transition nudge on high-score doc | Mock `/api/ai/check-maturity` → `{ ready: true }` | `advisor-notification-stage_transition` visible |
| 18 | Stage transition "Advance stage" updates stage | Click CTA | Stage selector updates to next stage |
| 19 | Stage transition "Not yet" dismisses | Click "Not yet" | Notification removed, stage unchanged |
| 20 | Tier 2 notifications auto-expand panel | Inject Tier 2 notification | Panel expands automatically |

### Tier 3 Notifications (Tests 21–27)

| # | Scenario | Trigger | Expected |
|---|----------|---------|----------|
| 21 | Missing section alert with incomplete doc | Mock `/api/ai/check-sections` → missing sections | `advisor-notification-missing_sections` visible |
| 22 | "Add sections" CTA inserts section templates | Click CTA | Editor content gains section headings |
| 23 | Spec conflict notification | Mock `/api/ai/check-conflicts` → `{ hasConflict: true }` | `advisor-notification-spec_conflict` visible |
| 24 | Spec conflict "Review conflicts" opens conflict view | Click CTA | Conflict view opens |
| 25 | Stale document notification | Mock `stale_document` timeline event | `advisor-notification-stale_document` visible |
| 26 | Stale "Update now" focuses editor | Click CTA | Editor focused |
| 27 | Tier 3 notifications do NOT auto-expand panel | Inject Tier 3 notification | Panel stays collapsed |

### Reply Round-Trip (Tests 31–34)

| # | Scenario | Trigger | Expected |
|---|----------|---------|----------|
| 31 | Reply input opens on "Reply" click | Click Reply on quality notification | `ai-advisor-reply-input` visible |
| 32 | Sending reply to quality notification triggers edit | Type reply, click Send | Editor content updated, notification shows success |
| 33 | Reply to non-edit notification updates notification body | Type reply, click Send | Notification body updates with AI response |
| 34 | Send button disabled when reply input is empty | Open reply input, leave empty | Send button disabled / no-op |

### UX Polish (Tests 39–45)

| # | Scenario | Trigger | Expected |
|---|----------|---------|----------|
| 39 | "Continue in AI Chat →" opens unified panel | Click CTA | `UnifiedAIPanel` opens with pre-populated context |
| 40 | Right-click shows "Stop showing these" context menu | Right-click notification | Context menu appears |
| 41 | Suppress type hides current + future notifications of that type | Click "Stop showing these" | All notifications of that type removed; new ones blocked |
| 42 | Manage notifications shows suppressed types | Click "Manage notifications" | Suppression preferences visible |
| 43 | Collapse count persists across document navigation | Collapse 2×, navigate away and back | Collapse count restored, suppression respects persisted count |
| 44 | Swipe-left gesture dismisses notification | Simulate touch swipe | Notification dismissed |
| 45 | Partial swipe does not dismiss notification | Simulate short swipe (< 60px) | Notification stays |

---

## Implementation Order (Recommended)

1. **Pre-fill offer** — backend is a small new endpoint (`seed-from-stage`); frontend is a straightforward Tier 2 injection. Good entry point.
2. **Reply round-trip** — unblocks the existing UI scaffolding and is self-contained.
3. **Stage transition nudge** — new backend endpoint but isolated; no webhook infra needed.
4. **Missing section alert** — new backend endpoint, runs in parallel with quality analysis.
5. **Auto-expand suppression (persistence)** + **suppress by type** — pure frontend, no backend.
6. **Swipe-to-dismiss** — pure frontend, touch event handlers.
7. **Handoff to AI Chat** — wires existing `onOpenAIChat` prop; depends on `UnifiedAIPanel` API.
8. **Drift detected** — requires GitHub webhook handler + SSE/polling; most complex.
9. **Spec conflict** — requires pgvector + cross-doc analysis; most complex.
10. **Stale document** — requires cron/background job + schema change.
11. **E2E tests for Tier 2/3** — implement in lockstep with each feature above.

---

## Schema Changes Required

```sql
-- Add to documents table
ALTER TABLE documents ADD COLUMN last_code_activity_at TIMESTAMPTZ;

-- New table for document-level notification preferences (suppress by type)
CREATE TABLE notification_preferences (
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  document_id  UUID REFERENCES documents(id) ON DELETE CASCADE,
  suppressed_types TEXT[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, document_id)
);
```

If a server-side suppression store is preferred over `localStorage`, migrate the client-side suppression logic to use this table via a preferences API.

---

## New API Endpoints Summary

| Endpoint | Method | Purpose | Blocker |
|----------|--------|---------|---------|
| `/api/ai/seed-from-stage` | POST | Generate starter content from stage | None |
| `/api/ai/check-maturity` | POST | Detect if doc is ready to advance stage | None |
| `/api/ai/check-sections` | POST | Detect missing required sections | None |
| `/api/ai/check-conflicts` | POST | Cross-document conflict detection | pgvector |
| `/api/ai/reply` | POST | Process user reply to a notification | None |
| `/api/webhooks/github` | POST | Receive GitHub push events | GitHub App webhook config |
| `/api/documents/:id/events` | GET | Poll/subscribe to document timeline events | webhook handler |

---

## Open Questions

1. **SSE vs polling** — Server-Sent Events give real-time drift/stale notifications but add connection overhead. Polling every 30s is simpler and sufficient for MVP. Decision needed before building the events endpoint.
2. **pgvector availability** — Spec conflict detection needs `pgvector` in the Postgres instance. Confirm with infra/Railway config before scoping that work.
3. **Notification preferences persistence** — `localStorage` (current suppression) is lost on browser clear. `sessionStorage` (collapse counter above) is lost on tab close. For production, migrate suppression preferences to the DB table above.
4. **Reply conversation history** — The `editDocumentAI` client function accepts a `history` param. Decide whether to thread multi-turn reply conversations per notification or start fresh each time.
