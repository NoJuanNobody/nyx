# AI Advisor Panel (#49)

**TODO item:** #49
**Status:** TODO
**Priority:** P3 — MVP

---

## Overview

Replace the current `AIQualityPanel` (bottom strip below the editor) with a richer **AI Advisor** panel — a full-width bottom rail that serves as the single surface for all proactive AI notifications, recommendations, and quick interactions. It slides up when the AI has something to say and collapses to a thin status bar when idle, giving writers 100% vertical space until the AI earns their attention.

## Why this matters

- **Single notification surface** — today, AI recommendations are scattered: quality scores live in the bottom panel, pre-fill suggestions don't exist yet, drift alerts show up in timeline events, and stage nudges aren't surfaced at all. The AI Advisor unifies all proactive AI communication into one predictable location.
- **Non-intrusive by default** — the panel is collapsed (or shows a minimal status bar) when the user is writing. It expands only when there's something actionable. The user is never interrupted mid-sentence.
- **Contextual response mechanisms** — different notifications need different responses. A pre-fill offer needs a Yes/No button. A quality suggestion might need a "Fix it" CTA. A drift alert might need a text reply explaining intent. The panel supports all three interaction patterns: CTA buttons, inline text input, and dismiss.

## Current state

| Aspect | Today |
|--------|-------|
| **AIQualityPanel** | Collapsible bottom strip. Shows quality score (x/10) and bullet-point suggestions. Auto-analyzes on content change with 3s debounce. Collapse state is local. |
| **Drift alerts** | Timeline events only — user must open the Timeline drawer tab to see them. No proactive surfacing. |
| **Stage suggestions** | Stage guide banner at top of editor shows static metadata. No AI-driven stage recommendations. |
| **Pre-fill offers** | Don't exist yet. Planned for lifecycle stages feature (#35). |

## Proposed design

### Panel states

The AI Advisor has three visual states:

#### 1. Idle (status bar)

A thin, single-line bar at the bottom of the editor area. Always visible.

```
┌────────────────────────────────────────────────────────────────────┐
│  ✦ AI Advisor                                          Score: 7/10│
└────────────────────────────────────────────────────────────────────┘
```

- Left: "AI Advisor" label with a subtle sparkle icon
- Right: latest quality score badge (if available), clickable to expand
- Clicking anywhere on the bar expands the panel
- No vertical space wasted — just ~28px tall

#### 2. Notification (expanded, auto-triggered)

When the AI has a recommendation, the panel slides up to show a notification card. Multiple notifications stack vertically, newest at top.

```
┌────────────────────────────────────────────────────────────────────┐
│  ✦ AI Advisor                                    ▾ Collapse   ✕   │
│ ─────────────────────────────────────────────────────────────────  │
│                                                                    │
│  ┌── Pre-fill suggestion ───────────────────────────────────────┐  │
│  │  This is a new Architecture doc. You have 3 Definition docs  │  │
│  │  that could seed a starting outline.                         │  │
│  │                                                              │  │
│  │            [ Generate outline ]   [ Dismiss ]                │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│  ┌── Quality analysis ──────────────────────────────────────────┐  │
│  │  Score: 7/10                                                 │  │
│  │  • Missing success metrics — add measurable outcomes         │  │
│  │  • User stories section is thin — expand with edge cases     │  │
│  │                                                              │  │
│  │  [ Fix these ]   [ Dismiss ]                                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- Max height: 40% of the editor area (scrollable if more notifications)
- Each notification card is independently dismissible
- Panel auto-collapses back to status bar when all notifications are dismissed

#### 3. Conversational (text input active)

Some notifications invite a freeform response. When the user clicks a "Reply" or text-input CTA, a lightweight input area appears at the bottom of the panel.

```
┌────────────────────────────────────────────────────────────────────┐
│  ✦ AI Advisor                                    ▾ Collapse   ✕   │
│ ─────────────────────────────────────────────────────────────────  │
│                                                                    │
│  ┌── Drift detected ───────────────────────────────────────────┐  │
│  │  Code in auth-service.ts has diverged from the              │  │
│  │  Authentication spec (Section 3.2). 4 functions changed,    │  │
│  │  2 new endpoints added.                                     │  │
│  │                                                              │  │
│  │  [ Update spec to match code ]  [ View diff ]  [ Reply ]    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                    │
│ ┌──────────────────────────────────────────────────────── Send ┐   │
│ │ The auth changes are intentional — we added OAuth2 support.  │   │
│ │ Update the spec but keep the old session-based flow as a...  │   │
│ └──────────────────────────────────────────────────────────────┘   │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

- Text input is a single auto-resizing textarea with a Send button
- Replying sends the message to the AI, which processes it and may produce a follow-up notification (e.g., a proposed spec edit)
- The input disappears after sending — this is not a persistent chat. For extended conversation, the user should use the AI Chat in the DocDrawer.

## Notification catalog

### Tier 1 — Always present (passive)

| Notification | Trigger | Response type | CTAs |
|-------------|---------|---------------|------|
| **Quality score** | Content change (3s debounce, same as today) | CTA buttons | `Fix these` (sends suggestions to AI for auto-edit) · `Dismiss` |
| **Stage guide** | Document has a stage assigned | Informational | `Dismiss` (replaces the current top banner, consolidating it here) |

### Tier 2 — Contextual (event-driven)

| Notification | Trigger | Response type | CTAs |
|-------------|---------|---------------|------|
| **Pre-fill offer** | New blank document created with a stage, and prior-stage docs exist | CTA buttons | `Generate outline` (calls `POST /ai/seed-from-stage`) · `Dismiss` |
| **Drift detected** | Webhook push event triggers `detectDrift()` and finds divergence | CTA buttons + text reply | `Update spec to match code` · `View diff` (opens diff in editor) · `Reply` (opens text input to explain intent; AI uses reply to generate a targeted spec update) |
| **Stage transition nudge** | AI determines the document content has matured beyond its current stage (e.g., a Conception doc now reads like a full Definition spec) | CTA buttons | `Move to {next stage}` (updates stage) · `Keep current stage` · `Why?` (expands explanation) |
| **Template suggestion** | New blank document with no template; AI detects the content matches a known template pattern | CTA buttons | `Apply template` (reformats content) · `Dismiss` |

### Tier 3 — Proactive (AI-initiated)

| Notification | Trigger | Response type | CTAs |
|-------------|---------|---------------|------|
| **Missing section alert** | AI notices the document is missing sections typical for its stage (e.g., Architecture doc with no "System Design" heading) | CTA buttons | `Add section` (AI generates and inserts it) · `Dismiss` |
| **Spec conflict** | Two documents in the same team make contradictory claims (detected during quality analysis) | CTA buttons + text reply | `View conflict` (highlights both docs) · `Reply` (explain which doc is correct; AI proposes edits to the other) |
| **Stale document** | Document hasn't been updated in N days but related code has changed | CTA buttons | `Review changes` (shows code diff summary) · `Mark as current` · `Dismiss` |

## Response mechanisms

Each notification card can use one or more of these interaction patterns:

### 1. CTA buttons (most common)

Used when the action is well-defined and doesn't need user input.

```
[ Primary action ]   [ Secondary action ]   [ Dismiss ]
```

- **Primary** — solid button, stage-colored or blue. Triggers the main AI action (generate, fix, update).
- **Secondary** — outlined button. Opens a view, provides more context, or offers an alternative.
- **Dismiss** — ghost/text button. Removes the notification without action.

After clicking a primary CTA, the notification card shows a loading state, then either:
- Replaces itself with a success message (auto-dismisses after 3s)
- Transitions to a diff review (for content-modifying actions) using the existing `AIEditReview` component in the editor area

### 2. Text reply

Used when the AI needs context from the user to proceed — typically for drift resolution, conflict explanation, or freeform instructions.

- A `Reply` button on the notification card opens the bottom text input
- The text input is scoped to that specific notification (shown as a reply thread)
- After sending, the AI processes the reply and either resolves the notification or posts a follow-up
- If the user needs a longer conversation, a `Continue in AI Chat →` link opens the DocDrawer AI tab with the conversation context carried over

### 3. Inline selection

Used when the user needs to choose between options the AI has identified.

```
┌── Spec conflict ───────────────────────────────────────────┐
│  Contradictory authentication method:                       │
│                                                             │
│  ○ Auth Spec (Definition): "JWT with refresh tokens"        │
│  ○ API Design (Architecture): "Session-based with cookies"  │
│                                                             │
│  Which is correct?                                          │
│                                                             │
│  [ Use JWT approach ]   [ Use session approach ]   [ Reply ]│
└─────────────────────────────────────────────────────────────┘
```

## Notification lifecycle

```
  Trigger event
       │
       ▼
  ┌─────────┐    auto if panel    ┌───────────┐
  │ Queued  │───── is idle ──────▶│ Displayed │
  └─────────┘                     └─────┬─────┘
                                        │
                         ┌──────────────┼──────────────┐
                         ▼              ▼              ▼
                   ┌──────────┐  ┌───────────┐  ┌──────────┐
                   │ Acted on │  │ Replied to│  │ Dismissed│
                   └────┬─────┘  └─────┬─────┘  └────┬─────┘
                        │              │              │
                        ▼              ▼              ▼
                   ┌──────────┐  ┌───────────┐       │
                   │ Resolved │  │ Follow-up │       │
                   └────┬─────┘  │ posted    │       │
                        │        └─────┬─────┘       │
                        ▼              ▼              ▼
                      ┌────────────────────────────────┐
                      │        Removed from panel      │
                      └────────────────────────────────┘
```

- **Queued** — notification created but panel is collapsed. Status bar shows a badge count (e.g., "2 new"). Panel auto-expands for Tier 2+ notifications. Tier 1 (quality) stays passive and only shows on expand.
- **Displayed** — visible in the panel. User can interact.
- **Acted on** — user clicked a CTA. Shows loading → result → auto-dismiss.
- **Replied to** — user sent a text reply. AI processes and may post a follow-up notification.
- **Dismissed** — user clicked Dismiss. Notification removed immediately.
- Notifications older than the current editing session are cleared on page load. No persistence across sessions.

## Clearing and canceling notifications

Every notification is clearable — the user is never forced to engage.

### Individual clear
- Every notification card has an `✕` button in its top-right corner. One click removes it immediately, no confirmation.
- Swiping left on a notification card (trackpad gesture) also dismisses it.

### Clear all
- The panel header shows a **"Clear all"** text button when 2+ notifications are visible. Clears the entire stack and collapses the panel back to the status bar.

```
┌────────────────────────────────────────────────────────────────────┐
│  ✦ AI Advisor (3)                        Clear all  ▾ Collapse    │
│ ─────────────────────────────────────────────────────────────────  │
```

### Suppress by type
- Right-clicking (or long-pressing) a notification's `✕` button shows a mini-menu: **"Dismiss"** and **"Stop showing these"**. The latter suppresses that notification type for the current document session. A "Paused notifications" indicator in the status bar lets the user re-enable them.

### Auto-expand suppression
- If the user collapses the panel manually, it will not auto-expand again for **30 seconds** — respecting the user's intent to focus. New notifications queue silently and update the badge count in the status bar.
- If the user has collapsed the panel **3 times** in a session without engaging with any notification, the panel stops auto-expanding entirely for that session. Only the badge count updates. The user can always click to expand manually.

## Notification priority and stacking

When multiple notifications arrive:

1. **Tier 2 and 3** notifications auto-expand the panel and appear at the top
2. **Tier 1** (quality score) stays at the bottom — it's always-present context, not urgent
3. Max **3 notification cards** visible at once; overflow is scrollable
4. If the user is actively typing (keystroke within last 2s), new notifications queue silently — the panel does not auto-expand mid-typing. The status bar badge count updates instead.
5. Duplicate notifications (same type + same trigger) replace the previous one rather than stacking

## Relationship to existing components

| Component | Change |
|-----------|--------|
| `AIQualityPanel.tsx` | **Replaced** — quality analysis becomes one notification type within the AI Advisor. Analysis logic (debounce, API call) moves into the new component. |
| `DocumentEditor.tsx` | Replace `<AIQualityPanel>` with `<AIAdvisor>`. Remove the stage guide banner (absorbed into Advisor). Wire new callbacks for pre-fill, drift, stage transition. |
| `DocDrawer.tsx` / `AIChatPanel.tsx` | **Unchanged** — the AI Chat remains the place for extended conversations. Advisor can hand off to it via "Continue in AI Chat →". |
| `stages.ts` | **Unchanged** — stage metadata used for notification styling and stage transition nudges. |

## Data flow

```
                    ┌──────────────────┐
                    │  DocumentEditor  │
                    └────────┬─────────┘
                             │ content, stage, documentId
                             ▼
                    ┌──────────────────┐
                    │   AIAdvisor      │
                    │                  │
                    │  ┌────────────┐  │      3s debounce
                    │  │ Quality    │◀─┼──── content change
                    │  │ analyzer   │  │
                    │  └────────────┘  │
                    │                  │
                    │  ┌────────────┐  │      on mount (new doc + stage)
                    │  │ Pre-fill   │◀─┼──── stage + prior docs check
                    │  │ detector   │  │
                    │  └────────────┘  │
                    │                  │
                    │  ┌────────────┐  │      webhook → React Query invalidation
                    │  │ Drift      │◀─┼──── poll or subscribe to drift events
                    │  │ listener   │  │
                    │  └────────────┘  │
                    │                  │
                    │  ┌────────────┐  │      quality analysis detects maturity
                    │  │ Stage      │◀─┼──── score + content heuristics
                    │  │ nudger     │  │
                    │  └────────────┘  │
                    │                  │
                    └──────────────────┘
                             │
                  callbacks: onApplyEdit, onStageChange,
                             onNavigate, onOpenAIChat
                             │
                             ▼
                    ┌──────────────────┐
                    │  DocumentEditor  │
                    └──────────────────┘
```

Each detector runs independently. They push notifications into a local `notifications` state array managed by the AIAdvisor component. No global state needed — the advisor is scoped to the active document.

## Design considerations

### Visual style
- Panel background matches the editor container (white, with a top border separator)
- Notification cards have a left-edge color stripe matching their type: amber for quality, blue for pre-fill, red for drift, purple for stage transitions
- CTA buttons follow the stage color palette when relevant (e.g., a "Move to Architecture" button uses indigo)
- Status bar is minimal: slate-400 text, no background distinction from the editor chrome

### Animation
- Panel expand/collapse: CSS transition on `max-height` (~200ms ease-out)
- New notification cards: fade-in + subtle slide-up (150ms)
- Dismissed cards: fade-out (100ms), remaining cards reflow smoothly
- Status bar badge count: number increment with a brief scale pulse

### Sizing
- Status bar (idle): 28px height
- Expanded panel: auto-height up to 40% of the editor area, then scrollable
- Text input area: single line by default, grows to max 3 lines

## Decisions

- **Notification frequency** — not a concern for now. Ship without throttling and tune later based on real usage.
- **Notification history** — no. Dismissed notifications are gone. Keep the UX simple.
- **Sound/visual alerts** — no sounds or visual pulses. Badge count in the status bar is sufficient.

## Handoff to AI Chat

When a notification thread gets complex, the user can click **"Continue in AI Chat →"** to seamlessly move the conversation into the DocDrawer's AI Chat tab. This bridges the gap between the Advisor's quick-interaction model and the Chat's extended-conversation model.

### What transfers

The full thread context carries over — not just the notification text, but the complete sequence:

1. **Original notification** — the trigger event, AI analysis, and any structured data (e.g., drift diff, quality suggestions, conflicting spec excerpts)
2. **User replies** — any text the user typed in the Advisor's reply input
3. **AI follow-ups** — any follow-up notifications the AI posted in response
4. **Document context** — the current document title, stage, and a content summary so the AI Chat doesn't need to re-analyze

### How it works

1. User clicks "Continue in AI Chat →" on a notification card
2. The Advisor serializes the thread into a structured handoff payload:
   ```json
   {
     "source": "advisor",
     "notificationType": "drift_detected",
     "thread": [
       { "role": "ai", "content": "Code in auth-service.ts has diverged..." },
       { "role": "user", "content": "The auth changes are intentional..." },
       { "role": "ai", "content": "Understood. I can update sections 3.2 and 3.4..." }
     ],
     "metadata": { "documentId": "...", "stage": "architecture", "driftFiles": ["auth-service.ts"] }
   }
   ```
3. The DocDrawer opens to the AI Chat tab
4. The AI Chat renders the thread as prior messages (visually distinguished as "continued from Advisor") and the user can keep typing naturally
5. The original notification in the Advisor is marked as "Continued in Chat" and auto-dismissed

### UX details

- The handoff link appears on any notification that has received at least one user reply, or on any Tier 2/3 notification with a "Reply" CTA
- The link does not appear on simple CTA-only notifications (quality suggestions, pre-fill offers) — those are fully resolvable in the Advisor
- If the AI Chat already has an active conversation, the handoff appends a separator and the new thread below it, preserving both contexts
- The AI Chat's system prompt receives the handoff metadata so it has full context without the user needing to re-explain

---

## E2E Tests

**Test file:** `tests/e2e/ai-advisor-panel.spec.ts`

### Panel states & rendering

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 1 | Status bar visible on document load | Navigate to document editor | AI Advisor status bar visible at bottom (~28px); shows "AI Advisor" label |
| 2 | Status bar shows quality score | Open document with content → wait for analysis (3s debounce) | Status bar right side shows "Score: N/10" badge |
| 3 | Click status bar expands panel | Click on the AI Advisor status bar | Panel expands showing notification cards |
| 4 | Collapse button returns to status bar | Expand panel → click "Collapse" | Panel animates back to status bar |
| 5 | Panel replaces old AIQualityPanel | Open document editor | No `AIQualityPanel` rendered; `AIAdvisor` component in its place |
| 6 | No stage guide banner at top | Open document with stage assigned | No top banner; stage guide info appears as Tier 1 notification in Advisor panel |

### Tier 1 — Quality score notifications

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 7 | Quality analysis triggers on content change | Open document → type new content → wait 3s | Quality notification card appears with score and bullet-point suggestions |
| 8 | "Fix these" CTA triggers AI edit | Expand panel → click "Fix these" on quality card | Loading state on card → AI auto-applies fixes → card shows success message → auto-dismiss after 3s |
| 9 | Dismiss quality notification | Click "Dismiss" on quality card | Card removed immediately; no action taken |
| 10 | Quality re-analyzes on subsequent edits | Dismiss quality card → edit content → wait 3s | New quality card appears with updated score and suggestions |

### Tier 2 — Pre-fill offer

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 11 | Pre-fill offered for new staged doc with prior-stage docs | Create blank Architecture doc (while Definition docs exist) | Panel auto-expands; pre-fill notification: "You have N Definition docs that could seed an outline" with "Generate outline" / "Dismiss" |
| 12 | "Generate outline" populates document | Click "Generate outline" on pre-fill card | Loading state → document content populated with AI-generated outline seeded from prior-stage docs → card auto-dismisses |
| 13 | No pre-fill when no prior-stage docs exist | Create blank Conception doc (first stage, no prior docs) | No pre-fill notification appears |
| 14 | No pre-fill for non-blank documents | Create document from template (has content) | No pre-fill notification — only triggers for blank stage docs |

### Tier 2 — Drift detected

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 15 | Drift notification appears after webhook push | Simulate webhook push that triggers `detectDrift()` with divergence → navigate to affected document | Panel auto-expands; drift card shows affected file(s), divergence summary |
| 16 | "Update spec to match code" CTA | Click "Update spec to match code" on drift card | Loading state → AI updates document content to reflect code changes → diff review shown in editor |
| 17 | "View diff" CTA | Click "View diff" on drift card | Editor switches to diff view showing doc vs code divergence |
| 18 | "Reply" opens text input | Click "Reply" on drift card | Text input appears at bottom of panel, scoped to drift notification |
| 19 | Text reply processed by AI | Type "The auth changes are intentional — update spec to include OAuth2" → Send | Input disappears; AI processes reply; follow-up notification posted with proposed spec update |

### Tier 2 — Stage transition nudge

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 20 | Stage nudge appears when content matures | Write extensive product spec content in a Conception-stage document → wait for analysis | Stage transition card: "This document reads like a Definition spec" with "Move to Definition" / "Keep current stage" / "Why?" |
| 21 | "Move to stage" updates document | Click "Move to Definition" on nudge card | Document stage updated to Definition; badge changes in FileTree; card auto-dismisses |
| 22 | "Keep current stage" dismisses | Click "Keep current stage" | Card dismissed; no stage change |
| 23 | "Why?" expands explanation | Click "Why?" | Card expands with AI explanation of why the content matches the next stage |

### Tier 3 — Missing section alert

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 24 | Missing section detected | Open Architecture doc without "System Design" heading → wait for analysis | Notification: "Missing section: System Design" with "Add section" / "Dismiss" |
| 25 | "Add section" inserts AI content | Click "Add section" | AI generates section content and inserts it into document at appropriate position |

### Tier 3 — Spec conflict

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 26 | Spec conflict surfaced | Two team documents have contradictory claims (e.g., auth method) → analysis detects conflict | Inline selection card showing both conflicting excerpts with radio buttons and "Use X approach" CTAs |
| 27 | Resolve conflict via selection | Select "Use JWT approach" on conflict card | AI proposes edits to the other document; diff review shown |

### Clearing & suppression behavior

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 28 | Individual clear via X button | Click ✕ on any notification card | Card removed immediately; no confirmation |
| 29 | Clear all button | Have 3+ notifications → click "Clear all" | All cards removed; panel collapses to status bar |
| 30 | "Clear all" only shows with 2+ notifications | Have exactly 1 notification visible | "Clear all" button not visible |
| 31 | Suppress notification type | Right-click ✕ on quality card → click "Stop showing these" | Quality notifications suppressed for session; "Paused notifications" indicator in status bar |
| 32 | Re-enable suppressed type | Click "Paused notifications" indicator in status bar | Suppressed type re-enabled; future notifications of that type appear again |
| 33 | Auto-expand suppression (30s cooldown) | Manually collapse panel → new notification arrives within 30s | Panel does NOT auto-expand; badge count updates in status bar |
| 34 | Auto-expand suppression (3 collapses) | Collapse panel 3 times without engaging any notification | Panel stops auto-expanding for entire session; badge count still updates |
| 35 | No expand mid-typing | Start typing in editor → notification arrives during typing | Panel stays collapsed; badge count updates; panel expands only after 2s typing pause |

### Notification stacking & priority

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 36 | Tier 2 notifications appear above Tier 1 | Quality card visible → drift notification arrives | Drift card appears at top; quality card stays at bottom |
| 37 | Max 3 cards visible | 4+ notifications arrive | Only 3 cards visible; remaining accessible via scroll |
| 38 | Duplicate notifications replace previous | Same drift notification fires twice for same trigger | Second notification replaces the first; no duplicate cards |

### Handoff to AI Chat

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 39 | "Continue in AI Chat" link appears after reply | Reply to a drift notification → AI posts follow-up | "Continue in AI Chat →" link visible on the notification |
| 40 | Handoff opens DocDrawer AI tab | Click "Continue in AI Chat →" | DocDrawer opens to AI tab; prior thread (notification + replies + follow-ups) rendered as messages marked "continued from Advisor" |
| 41 | Original notification auto-dismissed after handoff | Click "Continue in AI Chat →" | Notification card in Advisor marked "Continued in Chat" and auto-dismissed |
| 42 | Handoff appends to existing chat | AI Chat already has messages → handoff from Advisor | Separator line added; handed-off thread appended below existing messages |
| 43 | No handoff link on CTA-only notifications | Quality card with only "Fix these" / "Dismiss" | No "Continue in AI Chat →" link visible |

### Session lifecycle

| # | Scenario | Steps | Expected |
|---|----------|-------|----------|
| 44 | Notifications cleared on page load | Have notifications → navigate away → navigate back | No stale notifications from prior session; fresh analysis starts |
| 45 | Panel state resets on document switch | Expand panel on Doc A → switch to Doc B | Panel resets to status bar; new analysis starts for Doc B |
