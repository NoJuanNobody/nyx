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

## Open questions

- **Notification frequency** — how aggressively should Tier 3 (proactive) notifications fire? Too many and the panel becomes noisy. Should there be a daily/session cap, or a user-configurable "AI verbosity" setting?
- **Notification history** — should dismissed notifications be recoverable? A "recent notifications" dropdown in the status bar could let users revisit things they dismissed too quickly.
- **Sound/visual alert** — should high-priority notifications (drift detected) produce a subtle visual pulse on the status bar when the user is scrolled away from the panel? Or is the badge count sufficient?
- **Handoff to AI Chat** — when a user clicks "Continue in AI Chat →", how much context transfers? Just the notification text, or the full conversation thread (notification + reply + follow-up)?
